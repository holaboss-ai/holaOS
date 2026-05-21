import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { RuntimeStateStore } from "@holaboss/runtime-state-store";

import type { ExecuteActionParams } from "./composio-api-client.js";
import { fetchIntegrationContextForConnection } from "./integration-context-fetch.js";
import { globalMemoryDirForWorkspaceRoot } from "./workspace-bundle-paths.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

test("fetchIntegrationContextForConnection ingests Gmail profile and recent messages into the global integration tree", async () => {
  const root = makeTempDir("hb-integration-context-fetch-");
  const workspaceRoot = path.join(root, "workspace-root");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot,
  });
  store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  store.upsertIntegrationConnection({
    connectionId: "conn-gmail-1",
    providerId: "gmail",
    ownerUserId: "user-1",
    accountLabel: "Gmail (Managed)",
    accountExternalId: "ca_gmail_1",
    accountHandle: null,
    accountEmail: null,
    authMode: "composio",
    grantedScopes: [],
    status: "active",
    secretRef: null,
  });

  const calls: string[] = [];
  const result = await fetchIntegrationContextForConnection({
    store,
    connectionId: "conn-gmail-1",
    composioClient: {
      async executeAction<TData = unknown>(params: ExecuteActionParams): Promise<{ data: TData | null; logId: string | null }> {
        calls.push(params.toolSlug);
        if (params.toolSlug === "GMAIL_GET_PROFILE") {
          return {
            data: {
              data: {
                emailAddress: "workspace@example.com",
                messagesTotal: 128,
                threadsTotal: 52,
                historyId: "history-1",
              },
            } as TData,
            logId: "log-profile",
          };
        }
        if (params.toolSlug === "GMAIL_FETCH_EMAILS") {
          return {
            data: {
              data: {
                messages: [
                  {
                    id: "msg-1",
                    threadId: "thread-1",
                    subject: "Quarterly planning",
                    from: "alice@example.com",
                    to: "workspace@example.com",
                    snippet: "Agenda draft and next steps.",
                    internalDate: "1716326400000",
                    labelIds: ["INBOX", "CATEGORY_UPDATES"],
                  },
                  {
                    id: "msg-2",
                    threadId: "thread-2",
                    subject: "Production incident notes",
                    from: "bob@example.com",
                    to: "workspace@example.com",
                    snippet: "Captured the rollback checklist.",
                    internalDate: "1716412800000",
                    labelIds: ["INBOX"],
                  },
                ],
              },
            } as TData,
            logId: "log-emails",
          };
        }
        throw new Error(`unexpected tool slug: ${params.toolSlug}`);
      },
    },
  });

  assert.deepEqual(calls, ["GMAIL_GET_PROFILE", "GMAIL_FETCH_EMAILS"]);
  assert.equal(result.supported, true);
  assert.equal(result.provider_id, "gmail");
  assert.equal(result.account_key, "workspace@example.com");
  assert.equal(result.account_label, "workspace@example.com");
  assert.equal(result.leaves_created, 3);
  assert.equal(result.messages_seen, 2);
  assert.equal(result.messages_persisted, 2);
  assert.equal(result.summary_nodes, 1);

  const updatedConnection = store.getIntegrationConnection("conn-gmail-1");
  assert.equal(updatedConnection?.accountEmail, "workspace@example.com");

  const trees = store.listIntegrationTrees({
    status: "active",
    limit: 100,
    offset: 0,
  });
  assert.equal(trees.length, 1);
  assert.equal(trees[0]?.provider, "gmail");
  assert.equal(trees[0]?.accountKey, "workspace@example.com");

  const leaves = store.listIntegrationLeaves({
    treeId: trees[0]!.treeId,
    status: "active",
    limit: 100,
    offset: 0,
  });
  assert.equal(leaves.length, 3);
  assert.deepEqual(
    leaves.map((leaf) => leaf.subjectKey).sort(),
    ["message:msg-1", "message:msg-2", "profile"],
  );

  const summaries = store.listIntegrationSummaryNodes({
    treeId: trees[0]!.treeId,
    status: "active",
    limit: 100,
    offset: 0,
  });
  assert.equal(summaries.length, 1);

  const memoryRoot = globalMemoryDirForWorkspaceRoot(workspaceRoot);
  const treeDir = path.join(memoryRoot, "integration", "accounts", trees[0]!.slug);
  assert.ok(fs.existsSync(path.join(treeDir, "leaves")));
  assert.ok(fs.existsSync(path.join(treeDir, "summaries", "L1", `${summaries[0]!.nodeId}.md`)));

  store.close();
});

test("fetchIntegrationContextForConnection reports unsupported providers without writing tree state", async () => {
  const root = makeTempDir("hb-integration-context-unsupported-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace-root"),
  });
  store.upsertIntegrationConnection({
    connectionId: "conn-github-1",
    providerId: "github",
    ownerUserId: "user-1",
    accountLabel: "GitHub (Managed)",
    accountExternalId: "ca_gh_1",
    accountHandle: null,
    accountEmail: null,
    authMode: "composio",
    grantedScopes: [],
    status: "active",
    secretRef: null,
  });

  const result = await fetchIntegrationContextForConnection({
    store,
    connectionId: "conn-github-1",
    composioClient: {
      async executeAction<TData = unknown>(_params: ExecuteActionParams): Promise<{ data: TData | null; logId: string | null }> {
        throw new Error("should not execute");
      },
    },
  });

  assert.equal(result.supported, false);
  assert.equal(result.reason, "provider_not_supported");
  assert.equal(
    store.listIntegrationTrees({ status: "active", limit: 100, offset: 0 }).length,
    0,
  );

  store.close();
});
