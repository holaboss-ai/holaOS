import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  clearComposioInlineCache,
  composioInlineCachePath,
  readComposioInlineCache,
  writeComposioInlineCache,
} from "./composio-inline-cache.js";

function tmpWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "composio-cache-"));
}

const PAYLOAD = { tools: [{ name: "github_create_a_commit" }] };

test("round-trips a payload for the same workspace", () => {
  const dir = tmpWorkspace();
  writeComposioInlineCache({ workspaceDir: dir, workspaceId: "root", payload: PAYLOAD });
  assert.deepEqual(
    readComposioInlineCache({ workspaceDir: dir, workspaceId: "root" }),
    PAYLOAD,
  );
  assert.ok(fs.existsSync(composioInlineCachePath(dir)));
});

test("misses for a different workspace id (no cross-workspace leakage)", () => {
  const dir = tmpWorkspace();
  writeComposioInlineCache({ workspaceDir: dir, workspaceId: "root", payload: PAYLOAD });
  assert.equal(readComposioInlineCache({ workspaceDir: dir, workspaceId: "other" }), null);
});

test("misses once past the TTL, hits inside it", () => {
  const dir = tmpWorkspace();
  const t0 = 1_000_000;
  // Drive the window off the env override rather than the default, so this
  // keeps testing the BEHAVIOUR when the default moves. It has moved once
  // already (120s → 15min, once explicit invalidation landed) and this test
  // pinned the old number in a comment and a magic offset.
  const ttl = 30_000;
  const env = { HB_COMPOSIO_CACHE_TTL_MS: String(ttl) } as NodeJS.ProcessEnv;
  writeComposioInlineCache({ workspaceDir: dir, workspaceId: "root", payload: PAYLOAD, nowMs: t0, env });
  assert.deepEqual(
    readComposioInlineCache({ workspaceDir: dir, workspaceId: "root", nowMs: t0 + ttl - 1, env }),
    PAYLOAD,
    "inside the TTL",
  );
  assert.equal(
    readComposioInlineCache({ workspaceDir: dir, workspaceId: "root", nowMs: t0 + ttl + 1, env }),
    null,
    "past the TTL",
  );
  // a clock that jumped backwards must not serve a 'future' entry
  assert.equal(
    readComposioInlineCache({ workspaceDir: dir, workspaceId: "root", nowMs: t0 - 5_000, env }),
    null,
  );
});

test("the default TTL spans a realistic inter-turn gap", () => {
  const dir = tmpWorkspace();
  const t0 = 1_000_000;
  writeComposioInlineCache({ workspaceDir: dir, workspaceId: "root", payload: PAYLOAD, nowMs: t0 });

  // The whole point of raising it: at 120s the bootstrap fetch missed on any
  // turn a user took longer than two minutes to send, which is most real
  // conversation. Freshness is now carried by explicit invalidation on connect
  // and disconnect (see composio-cache-invalidation.ts), not by this number.
  assert.deepEqual(
    readComposioInlineCache({ workspaceDir: dir, workspaceId: "root", nowMs: t0 + 5 * 60_000 }),
    PAYLOAD,
    "a five-minute gap between turns must still hit",
  );
  // …but it stays bounded, because a change made OUTSIDE this runtime (the web
  // app, or a revoke at the provider) has no invalidation path here.
  assert.equal(
    readComposioInlineCache({ workspaceDir: dir, workspaceId: "root", nowMs: t0 + 60 * 60_000 }),
    null,
    "an hour-old entry must not be served",
  );
});

test("clear invalidates (the connect/install hook)", () => {
  const dir = tmpWorkspace();
  writeComposioInlineCache({ workspaceDir: dir, workspaceId: "root", payload: PAYLOAD });
  assert.equal(clearComposioInlineCache(dir), true);
  assert.equal(readComposioInlineCache({ workspaceDir: dir, workspaceId: "root" }), null);
  assert.equal(clearComposioInlineCache(dir), false, "second clear reports nothing to remove");
});

test("env kill-switch disables both read and write", () => {
  const dir = tmpWorkspace();
  const off = { HB_COMPOSIO_CACHE: "0" } as NodeJS.ProcessEnv;
  writeComposioInlineCache({ workspaceDir: dir, workspaceId: "root", payload: PAYLOAD, env: off });
  assert.equal(fs.existsSync(composioInlineCachePath(dir)), false, "nothing written");
  writeComposioInlineCache({ workspaceDir: dir, workspaceId: "root", payload: PAYLOAD });
  assert.equal(
    readComposioInlineCache({ workspaceDir: dir, workspaceId: "root", env: off }),
    null,
    "read disabled even when a file exists",
  );
});

test("corrupt or foreign cache files are ignored, never thrown", () => {
  const dir = tmpWorkspace();
  const target = composioInlineCachePath(dir);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "{not json");
  assert.equal(readComposioInlineCache({ workspaceDir: dir, workspaceId: "root" }), null);
  fs.writeFileSync(target, JSON.stringify({ version: 999, workspace_id: "root", fetched_at_ms: Date.now(), payload: PAYLOAD }));
  assert.equal(readComposioInlineCache({ workspaceDir: dir, workspaceId: "root" }), null, "version guard");
});

test("reading a workspace with no cache is a miss, not an error", () => {
  assert.equal(readComposioInlineCache({ workspaceDir: tmpWorkspace(), workspaceId: "root" }), null);
});
