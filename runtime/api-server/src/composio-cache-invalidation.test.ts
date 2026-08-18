import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";

import { composioInlineCachePath } from "../../harnesses/src/composio-inline-cache.js";
import { invalidateComposioInlineToolCache } from "./composio-cache-invalidation.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function seedCache(workspaceDir: string): string {
  const target = composioInlineCachePath(workspaceDir);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify({ version: 1, payload: { tools: [] } }));
  return target;
}

function fakeStore(workspaceIds: string[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hb-composio-invalidate-"));
  tempDirs.push(root);
  return {
    root,
    listWorkspaces: () => workspaceIds.map((id) => ({ id })),
    workspaceDir: (id: string) => path.join(root, id),
  };
}

test("clears every workspace, because connections are user-global", () => {
  const store = fakeStore(["root", "second", "third"]);
  const targets = ["root", "second", "third"].map((id) =>
    seedCache(store.workspaceDir(id)),
  );

  const cleared = invalidateComposioInlineToolCache(store);

  assert.equal(cleared, 3);
  for (const target of targets) {
    assert.equal(fs.existsSync(target), false, `${target} survived invalidation`);
  }
});

test("workspaces with no cache are not an error", () => {
  const store = fakeStore(["root", "never-used"]);
  seedCache(store.workspaceDir("root"));

  assert.equal(invalidateComposioInlineToolCache(store), 1);
});

test("one unreadable workspace does not stop the others", () => {
  const store = fakeStore(["broken", "fine"]);
  const good = seedCache(store.workspaceDir("fine"));
  const throwing = {
    listWorkspaces: store.listWorkspaces,
    workspaceDir: (id: string) => {
      if (id === "broken") throw new Error("workspace dir unavailable");
      return store.workspaceDir(id);
    },
  };

  assert.equal(invalidateComposioInlineToolCache(throwing), 1);
  assert.equal(fs.existsSync(good), false);
});

test("a store that cannot list workspaces is survivable", () => {
  const hostile = {
    listWorkspaces: () => {
      throw new Error("db locked");
    },
    workspaceDir: () => "/nowhere",
  };

  // Invalidation is attached to a user action (connect/disconnect); it must
  // never be the reason that action fails.
  assert.equal(invalidateComposioInlineToolCache(hostile), 0);
});

/**
 * STRUCTURAL guard, and the point of the whole change.
 *
 * The cache's freshness now rests on explicit invalidation rather than a short
 * TTL, so a mutation site that forgets to invalidate leaves a stale tool listing
 * for the *whole* (now much longer) TTL — a worse failure than the 120 s window
 * this replaced. Adding a seventh write site is exactly how that regresses, so
 * pin the set rather than the six known call sites.
 */
test("every integration-connection write invalidates the cache", () => {
  const files = ["integrations.ts", "integration-broker.ts", "oauth-service.ts"];
  const offenders: string[] = [];

  for (const file of files) {
    const lines = fs.readFileSync(path.join(here, file), "utf8").split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      if (
        !/\.(upsertIntegrationConnection|deleteIntegrationConnection)\(/.test(lines[i]!)
      ) {
        continue;
      }
      // The invalidation belongs with the write: look ahead past the end of the
      // call for it, not across the whole function.
      const window = lines.slice(i, i + 30).join("\n");
      if (!window.includes("invalidateComposioInlineToolCache(")) {
        offenders.push(`${file}:${i + 1}`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `these connection writes leave a stale inline tool listing behind:\n${offenders.join("\n")}`,
  );
});
