import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import {
  readJsonStateFile,
  writeJsonStateFileAtomically,
} from "./json-state-file.js";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hb-json-state-"));
  tempDirs.push(dir);
  return dir;
}

test("a missing file returns the fallback silently", async () => {
  const dir = await tempDir();
  const logged: string[] = [];

  const value = await readJsonStateFile(
    path.join(dir, "absent.json"),
    { profiles: [] },
    { log: (message) => logged.push(message) },
  );

  // First run is not a failure — it must not log or quarantine anything.
  assert.deepEqual(value, { profiles: [] });
  assert.deepEqual(logged, []);
  assert.deepEqual(await fs.readdir(dir), []);
});

test("a corrupt file is preserved, not destroyed", async () => {
  const dir = await tempDir();
  const filePath = path.join(dir, "browser-profiles.json");
  // A truncated write is exactly what a crash mid-writeFile leaves behind.
  await fs.writeFile(filePath, '{"profiles":[{"id":"work"', "utf-8");
  const logged: string[] = [];

  const value = await readJsonStateFile(
    filePath,
    { profiles: [] },
    { log: (message) => logged.push(message) },
  );

  assert.deepEqual(value, { profiles: [] });

  // The caller writes the fallback straight after this read, so the original
  // bytes have to survive somewhere or the user's profiles are gone for good.
  const entries = await fs.readdir(dir);
  const quarantined = entries.filter((name) => name.includes(".corrupt-"));
  assert.equal(quarantined.length, 1, `expected a quarantined copy, saw ${entries}`);
  assert.equal(
    await fs.readFile(path.join(dir, quarantined[0]!), "utf-8"),
    '{"profiles":[{"id":"work"',
    "the quarantined copy must hold the original bytes",
  );
  assert.equal(logged.length, 1);
  assert.match(logged[0]!, /did not parse/);
});

test("round-trips a value", async () => {
  const dir = await tempDir();
  const filePath = path.join(dir, "state.json");

  await writeJsonStateFileAtomically(filePath, { a: 1, b: ["x"] });

  assert.deepEqual(await readJsonStateFile(filePath, null), { a: 1, b: ["x"] });
});

test("writing creates missing parent directories", async () => {
  const dir = await tempDir();
  const filePath = path.join(dir, "nested", "deeper", "state.json");

  await writeJsonStateFileAtomically(filePath, { ok: true });

  assert.deepEqual(await readJsonStateFile(filePath, null), { ok: true });
});

test("overwriting leaves no temp files behind", async () => {
  const dir = await tempDir();
  const filePath = path.join(dir, "state.json");

  await writeJsonStateFileAtomically(filePath, { v: 1 });
  await writeJsonStateFileAtomically(filePath, { v: 2 });

  assert.deepEqual(await readJsonStateFile(filePath, null), { v: 2 });
  // A leaked .tmp per mutation would quietly fill userData, since these files
  // are rewritten on every profile change.
  assert.deepEqual(await fs.readdir(dir), ["state.json"]);
});

test("a reader never observes a partially written file", async () => {
  const dir = await tempDir();
  const filePath = path.join(dir, "state.json");
  const big = { rows: Array.from({ length: 4000 }, (_, i) => ({ i, pad: "x".repeat(64) })) };

  await writeJsonStateFileAtomically(filePath, { rows: [] });

  // Read repeatedly while a large rewrite is in flight. With a plain
  // writeFile the file is truncated in place, so a concurrent read can catch
  // it mid-write and fall back — which is the whole data-loss mechanism.
  const writing = writeJsonStateFileAtomically(filePath, big);
  const observed: number[] = [];
  for (let i = 0; i < 60; i += 1) {
    const value = await readJsonStateFile<{ rows: unknown[] } | null>(filePath, null);
    assert.notEqual(value, null, "read fell back — file was caught mid-write");
    observed.push(value!.rows.length);
  }
  await writing;

  // Every observation must be one of the two committed states, never a
  // half-written one.
  assert.ok(observed.every((n) => n === 0 || n === 4000), `saw partial states: ${[...new Set(observed)]}`);
});

test("concurrent writes to one path never destroy it", async () => {
  const dir = await tempDir();
  const filePath = path.join(dir, "browser-profiles.json");

  // A pid+timestamp temp name collides when two writes land in the same
  // millisecond, and these files are rewritten on every profile mutation. The
  // loser's rename then fails and its cleanup takes the real file with it.
  await Promise.all(
    Array.from({ length: 25 }, (_, i) =>
      writeJsonStateFileAtomically(filePath, { v: i }),
    ),
  );

  const value = await readJsonStateFile<{ v: number } | null>(filePath, null);
  assert.notEqual(value, null, "the state file was destroyed by concurrent writes");
  assert.ok(value!.v >= 0 && value!.v < 25, `unexpected surviving value ${value!.v}`);
  assert.deepEqual(await fs.readdir(dir), ["browser-profiles.json"]);
});

test("a write blocked only on the destination still lands, original discarded", async () => {
  const dir = await tempDir();
  const filePath = path.join(dir, "browser-profiles.json");
  await writeJsonStateFileAtomically(filePath, { profiles: ["work", "personal"] });

  // The Windows case the fallback exists for: renaming ONTO an existing file
  // fails, but moving that file aside works — so once it is out of the way the
  // write completes normally.
  const realRename = fs.rename;
  let blockedOnce = false;
  (fs as { rename: typeof fs.rename }).rename = async (from, to) => {
    if (!blockedOnce && String(to) === filePath) {
      blockedOnce = true;
      throw Object.assign(new Error("EPERM: file is locked"), { code: "EPERM" });
    }
    return realRename(from, to);
  };

  try {
    await writeJsonStateFileAtomically(filePath, { profiles: [] });
  } finally {
    (fs as { rename: typeof fs.rename }).rename = realRename;
  }

  assert.ok(blockedOnce, "the fallback path was never exercised");
  assert.deepEqual(await readJsonStateFile(filePath, null), { profiles: [] });
  // The set-aside copy is cleaned up once the new file is in place.
  assert.deepEqual(await fs.readdir(dir), ["browser-profiles.json"]);
});

test("a write that can never land leaves the old contents on disk", async () => {
  const dir = await tempDir();
  const filePath = path.join(dir, "browser-profiles.json");
  await writeJsonStateFileAtomically(filePath, { profiles: ["work", "personal"] });

  // Nothing can be renamed onto this path, so neither the write nor the
  // restore can land. The old code deleted the destination first and then
  // failed the retry, ending with NO copy of the user's profiles anywhere.
  const realRename = fs.rename;
  (fs as { rename: typeof fs.rename }).rename = async (from, to) => {
    if (String(to) === filePath) {
      throw Object.assign(new Error("EPERM: file is locked"), { code: "EPERM" });
    }
    return realRename(from, to);
  };

  let raised: unknown;
  try {
    await writeJsonStateFileAtomically(filePath, { profiles: [] });
  } catch (error) {
    raised = error;
  } finally {
    (fs as { rename: typeof fs.rename }).rename = realRename;
  }

  assert.ok(raised instanceof Error, "a write that cannot land must throw");
  // Wherever it ended up, the user's data still exists and the error says so.
  const survivors = await Promise.all(
    (await fs.readdir(dir)).map(async (name) => [
      name,
      await fs.readFile(path.join(dir, name), "utf-8"),
    ]),
  );
  const preserved = survivors.filter(([, body]) => body.includes("personal"));
  assert.equal(
    preserved.length,
    1,
    `the previous contents must survive somewhere, saw ${JSON.stringify(survivors.map(([n]) => n))}`,
  );
  assert.match((raised as Error).message, new RegExp(preserved[0]![0]!.replace(/\./g, "\\.")));
});
