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

test("fetchIntegrationContextForConnection ingests GitHub profile, notifications, and assigned issues into the global integration tree", async () => {
  const root = makeTempDir("hb-integration-context-fetch-github-");
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

  const calls: string[] = [];
  const result = await fetchIntegrationContextForConnection({
    store,
    connectionId: "conn-github-1",
    composioClient: {
      async executeAction<TData = unknown>(params: ExecuteActionParams): Promise<{ data: TData | null; logId: string | null }> {
        calls.push(params.toolSlug);
        if (params.toolSlug === "GITHUB_GET_THE_AUTHENTICATED_USER") {
          return {
            data: {
              data: {
                login: "octocat",
                name: "The Octocat",
                email: "octocat@github.example",
                public_repos: 42,
                followers: 7,
                following: 3,
                html_url: "https://github.com/octocat",
              },
            } as TData,
            logId: "log-gh-profile",
          };
        }
        if (params.toolSlug === "GITHUB_LIST_NOTIFICATIONS") {
          return {
            data: {
              data: [
                {
                  id: "notif-1",
                  unread: true,
                  reason: "mention",
                  updated_at: "2026-05-22T08:30:00Z",
                  subject: {
                    title: "Review rollout checklist",
                    type: "PullRequest",
                  },
                  repository: {
                    full_name: "holaboss-ai/holaOS",
                  },
                },
              ],
            } as TData,
            logId: "log-gh-notifications",
          };
        }
        if (params.toolSlug === "GITHUB_FIND_REPOSITORIES") {
          return {
            data: {
              data: {
                items: [
                  {
                    id: "repo-1",
                    full_name: "holaboss-ai/holaOS",
                    name: "holaOS",
                    description: "Desktop runtime for agentic workflows.",
                    html_url: "https://github.com/holaboss-ai/holaOS",
                    updated_at: "2026-05-22T09:15:00Z",
                    language: "TypeScript",
                    default_branch: "main",
                    topics: ["agents", "desktop"],
                  },
                ],
              },
            } as TData,
            logId: "log-gh-repos",
          };
        }
        if (params.toolSlug === "GITHUB_GET_A_REPOSITORY_README") {
          return {
            data: {
              data: {
                content: Buffer.from(
                  "# holaOS\n\nAgent runtime and desktop shell for workspace memory experiments.\n",
                  "utf8",
                ).toString("base64"),
                encoding: "base64",
              },
            } as TData,
            logId: "log-gh-readme",
          };
        }
        if (params.toolSlug === "GITHUB_LIST_PULL_REQUESTS") {
          return {
            data: {
              data: [
                {
                  id: "pr-1",
                  number: 412,
                  title: "Expand integration context fetch",
                  body: "Adds GitHub and Slack provider-specific harvesting paths.",
                  state: "open",
                  updated_at: "2026-05-22T09:30:00Z",
                  html_url: "https://github.com/holaboss-ai/holaOS/pull/412",
                  labels: [{ name: "integrations" }, { name: "memory" }],
                },
              ],
            } as TData,
            logId: "log-gh-prs",
          };
        }
        if (params.toolSlug === "GITHUB_LIST_REPOSITORY_ISSUES") {
          return {
            data: {
              data: [
                {
                  id: "issue-1",
                  number: 128,
                  title: "Stabilize memory retrieval routing",
                  body: "Track the remaining web-search bypasses in recall flows.",
                  state: "open",
                  updated_at: "2026-05-22T09:00:00Z",
                  html_url: "https://github.com/holaboss-ai/holaOS/issues/128",
                  labels: [{ name: "memory" }, { name: "runtime" }],
                },
              ],
            } as TData,
            logId: "log-gh-issues",
          };
        }
        throw new Error(`unexpected tool slug: ${params.toolSlug}`);
      },
    },
  });

  assert.deepEqual(calls, [
    "GITHUB_GET_THE_AUTHENTICATED_USER",
    "GITHUB_LIST_NOTIFICATIONS",
    "GITHUB_FIND_REPOSITORIES",
    "GITHUB_GET_A_REPOSITORY_README",
    "GITHUB_LIST_PULL_REQUESTS",
    "GITHUB_LIST_REPOSITORY_ISSUES",
  ]);
  assert.equal(result.supported, true);
  assert.equal(result.provider_id, "github");
  assert.equal(result.account_key, "octocat");
  assert.equal(result.account_label, "The Octocat");
  assert.equal(result.leaves_created, 5);
  assert.equal(result.messages_seen, 4);
  assert.equal(result.messages_persisted, 4);
  assert.equal(result.summary_nodes, 1);

  const updatedConnection = store.getIntegrationConnection("conn-github-1");
  assert.equal(updatedConnection?.accountHandle, "octocat");
  assert.equal(updatedConnection?.accountEmail, "octocat@github.example");

  const trees = store.listIntegrationTrees({
    status: "active",
    limit: 100,
    offset: 0,
  });
  assert.equal(trees.length, 1);
  assert.equal(trees[0]?.provider, "github");
  assert.equal(trees[0]?.accountKey, "octocat");

  const leaves = store.listIntegrationLeaves({
    treeId: trees[0]!.treeId,
    status: "active",
    limit: 100,
    offset: 0,
  });
  assert.equal(leaves.length, 5);
  assert.deepEqual(
    leaves.map((leaf) => leaf.subjectKey).sort(),
    [
      "issue:holaboss-ai/holaOS:128",
      "notification:notif-1",
      "profile",
      "pull:holaboss-ai/holaOS:412",
      "repository:holaboss-ai/holaOS",
    ],
  );

  const memoryRoot = globalMemoryDirForWorkspaceRoot(workspaceRoot);
  const treeDir = path.join(memoryRoot, "integration", "accounts", trees[0]!.slug);
  assert.ok(fs.existsSync(path.join(treeDir, "leaves")));

  store.close();
});

test("fetchIntegrationContextForConnection ingests Slack workspace, channels, and recent messages into the global integration tree", async () => {
  const root = makeTempDir("hb-integration-context-fetch-slack-");
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
    connectionId: "conn-slack-1",
    providerId: "slack",
    ownerUserId: "user-1",
    accountLabel: "Slack (Managed)",
    accountExternalId: "ca_slack_1",
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
    connectionId: "conn-slack-1",
    composioClient: {
      async executeAction<TData = unknown>(params: ExecuteActionParams): Promise<{ data: TData | null; logId: string | null }> {
        calls.push(params.toolSlug);
        if (params.toolSlug === "SLACK_TEST_AUTH") {
          return {
            data: {
              data: {
                ok: true,
                url: "https://holaboss.slack.com/",
                team: "Holaboss",
                team_id: "T123",
                user: "memory-bot",
                user_id: "U123",
                bot_id: "B123",
              },
            } as TData,
            logId: "log-slack-auth",
          };
        }
        if (params.toolSlug === "SLACK_LIST_ALL_CHANNELS") {
          return {
            data: {
              data: {
                channels: [
                  {
                    id: "C111",
                    name: "memory-work",
                    is_private: false,
                    is_archived: false,
                    num_members: 9,
                    topic: { value: "Memory experiments" },
                  },
                  {
                    id: "C222",
                    name: "runtime-incidents",
                    is_private: true,
                    is_archived: false,
                    num_members: 5,
                    purpose: { value: "Runtime debugging" },
                  },
                ],
              },
            } as TData,
            logId: "log-slack-channels",
          };
        }
        if (params.toolSlug === "SLACK_FETCH_CONVERSATION_HISTORY") {
          const channelId = String(params.arguments?.channel ?? "");
          return {
            data: {
              data: {
                messages: channelId === "C111"
                  ? [
                    {
                      ts: "1716412800.000100",
                      user: "U123",
                      text: "Captured the latest memory tree screenshots.",
                    },
                  ]
                  : [
                    {
                      ts: "1716412900.000200",
                      user: "U456",
                      text: "Rolled back the runtime after the capability mismatch.",
                    },
                  ],
              },
            } as TData,
            logId: `log-slack-history-${channelId}`,
          };
        }
        throw new Error(`unexpected tool slug: ${params.toolSlug}`);
      },
    },
  });

  assert.deepEqual(calls, [
    "SLACK_TEST_AUTH",
    "SLACK_LIST_ALL_CHANNELS",
    "SLACK_FETCH_CONVERSATION_HISTORY",
    "SLACK_FETCH_CONVERSATION_HISTORY",
  ]);
  assert.equal(result.supported, true);
  assert.equal(result.provider_id, "slack");
  assert.equal(result.account_key, "T123");
  assert.equal(result.account_label, "Holaboss");
  assert.equal(result.leaves_created, 5);
  assert.equal(result.messages_seen, 4);
  assert.equal(result.messages_persisted, 4);
  assert.equal(result.summary_nodes, 1);

  const updatedConnection = store.getIntegrationConnection("conn-slack-1");
  assert.equal(updatedConnection?.accountHandle, "T123");

  const trees = store.listIntegrationTrees({
    status: "active",
    limit: 100,
    offset: 0,
  });
  assert.equal(trees.length, 1);
  assert.equal(trees[0]?.provider, "slack");
  assert.equal(trees[0]?.accountKey, "T123");

  const leaves = store.listIntegrationLeaves({
    treeId: trees[0]!.treeId,
    status: "active",
    limit: 100,
    offset: 0,
  });
  assert.equal(leaves.length, 5);
  assert.deepEqual(
    leaves.map((leaf) => leaf.subjectKey).sort(),
    [
      "channel:C111",
      "channel:C222",
      "message:C111:1716412800.000100",
      "message:C222:1716412900.000200",
      "profile",
    ],
  );

  const memoryRoot = globalMemoryDirForWorkspaceRoot(workspaceRoot);
  const treeDir = path.join(memoryRoot, "integration", "accounts", trees[0]!.slug);
  assert.ok(fs.existsSync(path.join(treeDir, "leaves")));

  store.close();
});

test("fetchIntegrationContextForConnection reports unsupported providers without writing tree state", async () => {
  const root = makeTempDir("hb-integration-context-unsupported-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace-root"),
  });
  store.upsertIntegrationConnection({
    connectionId: "conn-linear-1",
    providerId: "linear",
    ownerUserId: "user-1",
    accountLabel: "Linear (Managed)",
    accountExternalId: "ca_linear_1",
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
