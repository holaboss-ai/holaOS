import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";

import { composioInlineCachePath } from "../../harnesses/src/composio-inline-cache.js";
import { invalidateComposioInlineToolCache } from "./composio-cache-invalidation.js";
import { WorkspaceIntegrationsService } from "./workspace-integrations.js";

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
 * A class method's body, from its signature to the next sibling method. Scoping
 * to the method (rather than a fixed line window) keeps these guards honest in
 * two directions: a coarser-grained invalidation further down the same method
 * still counts, and an invalidation belonging to a DIFFERENT method never does.
 */
function methodBody(file: string, name: string): string | null {
  const lines = fs.readFileSync(path.join(here, file), "utf8").split("\n");
  const signature = new RegExp(
    `^\\s{2}(?:async\\s+|public\\s+|private\\s+|protected\\s+)*${name}\\s*\\(`,
  );
  const start = lines.findIndex((line) => signature.test(line));
  if (start === -1) return null;

  const sibling = /^\s{2}(?:async\s+|public\s+|private\s+|protected\s+|static\s+)*[\w$]+\s*[(<]/;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (sibling.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

/**
 * STRUCTURAL guard — the agent's own recovery action.
 *
 * `mcp_refresh` is what an agent reaches for when a just-connected integration's
 * tools are missing. It used to clear ONLY the pi MCP cache, but Composio
 * integrations are not MCP servers, so the stale inline listing survived and the
 * next turn re-read it — the tool ended the turn ("send one more message") and
 * changed nothing, once per turn, until the TTL expired.
 */
test("mcp_refresh also drops the Composio inline listing", () => {
  const body = methodBody("runtime-agent-tools.ts", "refreshMcpTools");

  assert.ok(body, "refreshMcpTools not found — did the signature change?");
  assert.ok(
    body.includes("invalidateComposioInlineToolCache("),
    "mcp_refresh clears the pi cache without dropping the integration listing, so a newly connected integration stays invisible",
  );
});

/**
 * STRUCTURAL guard — the workspace-default account binding.
 *
 * The default binding decides which account the toolkit resolver picks, and the
 * listing binds connected_account_id into each tool's execute body — so a stale
 * one makes the agent act as the PREVIOUS account. Neither write goes through
 * upsert/deleteIntegrationConnection, so the connection guard cannot see them.
 *
 * File-wide here (not method-scoped): this file exists only to manage the
 * workspace default, so any binding write in it must invalidate.
 */
test("workspace-default binding writes invalidate the listing", () => {
  const lines = fs
    .readFileSync(path.join(here, "workspace-integrations.ts"), "utf8")
    .split("\n");
  const offenders: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    if (!/\.(upsertIntegrationBinding|deleteIntegrationBinding)\(/.test(lines[i]!)) {
      continue;
    }
    const window = lines.slice(i, i + 30).join("\n");
    if (!window.includes("invalidateComposioInlineToolCache(")) {
      offenders.push(`workspace-integrations.ts:${i + 1}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `these default-account writes leave a stale inline tool listing behind:\n${offenders.join("\n")}`,
  );
});

/**
 * STRUCTURAL guard — the generic binding routes.
 *
 * `PUT/DELETE /api/v1/integrations/bindings/…` accept targetType
 * "workspace_default" (validateTargetType), so they can change the resolved
 * account just like the dedicated service above.
 *
 * Method-scoped on purpose: a file-wide scan would flag `mergeConnections`,
 * whose per-binding writes are correctly covered by ONE invalidation after the
 * whole merge — further away than any fixed line window.
 */
test("the generic binding routes invalidate on workspace_default writes", () => {
  for (const method of ["upsertBinding", "deleteBinding"]) {
    const body = methodBody("integrations.ts", method);
    assert.ok(body, `${method} not found — did the signature change?`);
    assert.ok(
      body.includes("invalidateComposioInlineToolCache("),
      `integrations.${method} can write a workspace_default binding without dropping the stale listing`,
    );
  }
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

/**
 * BEHAVIOURAL, because the structural guards above cannot see polarity: flipping
 * a gate to `targetType === "app"` leaves the token in the body and passes them
 * while defeating the fix entirely. This drives the real service.
 */
function serviceOverFakeStore(store: ReturnType<typeof fakeStore>) {
  const bindings = new Map<string, { bindingId: string; targetType: string }>();
  return new WorkspaceIntegrationsService({
    listWorkspaces: store.listWorkspaces,
    workspaceDir: store.workspaceDir,
    getIntegrationConnection: () => ({
      connectionId: "c1",
      providerId: "gmail",
      status: "active",
    }),
    getIntegrationBindingByTarget: (p: { integrationKey: string }) =>
      bindings.get(p.integrationKey) ?? null,
    upsertIntegrationBinding: (b: { bindingId: string; integrationKey: string; targetType: string }) => {
      bindings.set(b.integrationKey, { bindingId: b.bindingId, targetType: b.targetType });
      return b;
    },
    deleteIntegrationBinding: () => true,
  } as never);
}

test("setWorkspaceDefaultAccount really drops the cached listing", async () => {
  const store = fakeStore(["root"]);
  const cacheFile = seedCache(store.workspaceDir("root"));

  await serviceOverFakeStore(store).setWorkspaceDefaultAccount({
    workspaceId: "root",
    providerId: "gmail",
    connectionId: "c1",
  });

  assert.equal(
    fs.existsSync(cacheFile),
    false,
    "the previous account's tool listing survived a default-account change",
  );
});

test("clearWorkspaceDefaultAccount really drops the cached listing", async () => {
  const store = fakeStore(["root"]);
  const service = serviceOverFakeStore(store);
  await service.setWorkspaceDefaultAccount({
    workspaceId: "root",
    providerId: "gmail",
    connectionId: "c1",
  });
  const cacheFile = seedCache(store.workspaceDir("root"));

  service.clearWorkspaceDefaultAccount({ workspaceId: "root", providerId: "gmail" });

  assert.equal(fs.existsSync(cacheFile), false);
});

/**
 * Polarity guard for the generic binding routes, which are costlier to drive:
 * pin that the invalidation is gated on workspace_default and not its inverse.
 */
test("the generic binding routes gate on workspace_default, not its inverse", () => {
  for (const method of ["upsertBinding", "deleteBinding"]) {
    const body = methodBody("integrations.ts", method);
    assert.ok(body, `${method} not found`);
    assert.match(
      body,
      /===\s*"workspace_default"[\s\S]{0,200}invalidateComposioInlineToolCache\(/,
      `${method} must invalidate UNDER a workspace_default check`,
    );
  }
});
