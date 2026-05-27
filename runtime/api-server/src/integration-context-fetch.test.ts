import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { RuntimeStateStore } from "@holaboss/runtime-state-store";

import {
  ComposioApiClientError,
  type ExecuteActionParams,
  type ProxyRequestParams,
} from "./composio-api-client.js";
import { fetchIntegrationContextForConnection } from "./integration-context-fetch.js";
import { countSummaryLikeSemanticIntegrationNodes } from "./integration-memory.js";
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

test("fetchIntegrationContextForConnection ingests Gmail profile and recent threads into the global integration tree", async () => {
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
        if (params.toolSlug === "GMAIL_LIST_THREADS") {
          return {
            data: {
              data: {
                threads: [
                  {
                    snippet: "Agenda draft and next steps.",
                    id: "thread-1",
                    historyId: "hist-thread-1",
                  },
                  {
                    snippet: "Captured the rollback checklist.",
                    id: "thread-2",
                    historyId: "hist-thread-2",
                  },
                ],
              },
            } as TData,
            logId: "log-threads",
          };
        }
        if (params.toolSlug === "GMAIL_FETCH_MESSAGE_BY_THREAD_ID") {
          const threadId = params.arguments && "thread_id" in params.arguments
            ? params.arguments.thread_id
            : null;
          if (threadId === "thread-1") {
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
                      id: "msg-1b",
                      threadId: "thread-1",
                      subject: "Re: Quarterly planning",
                      from: "workspace@example.com",
                      to: "alice@example.com",
                      snippet: "Reviewed and approved.",
                      internalDate: "1716327400000",
                      labelIds: ["SENT"],
                    },
                  ],
                },
              } as TData,
              logId: "log-thread-1",
            };
          }
          if (threadId === "thread-2") {
            return {
              data: {
                data: {
                  messages: [
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
              logId: "log-thread-2",
            };
          };
        }
        throw new Error(`unexpected tool slug: ${params.toolSlug}`);
      },
    },
  });

  assert.deepEqual(calls, [
    "GMAIL_GET_PROFILE",
    "GMAIL_LIST_THREADS",
    "GMAIL_FETCH_MESSAGE_BY_THREAD_ID",
    "GMAIL_FETCH_MESSAGE_BY_THREAD_ID",
  ]);
  assert.equal(result.supported, true);
  assert.equal(result.provider_id, "gmail");
  assert.equal(result.account_key, "workspace@example.com");
  assert.equal(result.account_label, "workspace@example.com");
  assert.equal(result.leaves_created, 4);
  assert.equal(result.messages_seen, 3);
  assert.equal(result.messages_persisted, 3);
  assert.ok(result.tree_id);
  assert.equal(result.summary_nodes, countSummaryLikeSemanticIntegrationNodes({
    store,
    treeId: result.tree_id,
  }));

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
  assert.equal(leaves.length, 4);
  assert.deepEqual(
    leaves.map((leaf) => leaf.subjectKey).sort(),
    ["message:msg-1", "message:msg-1b", "message:msg-2", "profile"],
  );
  assert.deepEqual(
    leaves.map((leaf) => ({
      subjectKey: leaf.subjectKey,
      entityKey: leaf.entityKey,
      branchKey: leaf.branchKey,
    })).sort((left, right) => left.subjectKey.localeCompare(right.subjectKey)),
    [
      { subjectKey: "message:msg-1", entityKey: "thread:thread-1", branchKey: "messages" },
      { subjectKey: "message:msg-1b", entityKey: "thread:thread-1", branchKey: "messages" },
      { subjectKey: "message:msg-2", entityKey: "thread:thread-2", branchKey: "messages" },
      { subjectKey: "profile", entityKey: null, branchKey: "profile" },
    ],
  );

  const semanticNodes = store.listSemanticMemoryNodes({
    category: "integration",
    treeId: trees[0]!.treeId,
    status: "active",
    limit: 100,
    offset: 0,
  });
  assert.ok(semanticNodes.length > 0);

  const memoryRoot = globalMemoryDirForWorkspaceRoot(workspaceRoot);
  for (const leaf of leaves) {
    assert.ok(fs.existsSync(path.join(memoryRoot, leaf.path)));
  }
  for (const node of semanticNodes) {
    assert.ok(fs.existsSync(path.join(memoryRoot, node.path)));
  }

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
  assert.equal(result.leaves_created, 6);
  assert.equal(result.messages_seen, 5);
  assert.equal(result.messages_persisted, 5);
  assert.ok(result.tree_id);
  assert.equal(result.summary_nodes, countSummaryLikeSemanticIntegrationNodes({
    store,
    treeId: result.tree_id,
  }));

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
  assert.equal(leaves.length, 6);
  assert.deepEqual(
    leaves.map((leaf) => leaf.subjectKey).sort(),
    [
      "issue:holaboss-ai/holaOS:128",
      "notification:notif-1",
      "profile",
      "pull:holaboss-ai/holaOS:412",
      "readme:holaboss-ai/holaOS",
      "repository:holaboss-ai/holaOS",
    ],
  );
  assert.deepEqual(
    leaves.map((leaf) => ({
      subjectKey: leaf.subjectKey,
      entityKey: leaf.entityKey,
      branchKey: leaf.branchKey,
    })).sort((left, right) => left.subjectKey.localeCompare(right.subjectKey)),
    [
      { subjectKey: "issue:holaboss-ai/holaOS:128", entityKey: "repo:holaboss-ai/holaOS", branchKey: "issues" },
      { subjectKey: "notification:notif-1", entityKey: "repo:holaboss-ai/holaOS", branchKey: "notifications" },
      { subjectKey: "profile", entityKey: null, branchKey: "profile" },
      { subjectKey: "pull:holaboss-ai/holaOS:412", entityKey: "repo:holaboss-ai/holaOS", branchKey: "pull_requests" },
      { subjectKey: "readme:holaboss-ai/holaOS", entityKey: "repo:holaboss-ai/holaOS", branchKey: "readme" },
      { subjectKey: "repository:holaboss-ai/holaOS", entityKey: "repo:holaboss-ai/holaOS", branchKey: "overview" },
    ],
  );

  const memoryRoot = globalMemoryDirForWorkspaceRoot(workspaceRoot);
  for (const leaf of leaves) {
    assert.ok(fs.existsSync(path.join(memoryRoot, leaf.path)));
  }

  store.close();
});

test("fetchIntegrationContextForConnection skips GitHub notifications when the tool is unavailable", async () => {
  const root = makeTempDir("hb-integration-context-fetch-github-missing-notifications-");
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
          throw new ComposioApiClientError(404, {
            code: "tool_not_found",
            message: "Tool GITHUB_LIST_NOTIFICATIONS not found.",
            slug: "tool_not_found",
          });
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
  assert.equal(result.leaves_created, 5);
  assert.equal(result.messages_seen, 4);
  assert.equal(result.messages_persisted, 4);
  assert.ok(result.tree_id);
  assert.equal(result.summary_nodes, countSummaryLikeSemanticIntegrationNodes({
    store,
    treeId: result.tree_id,
  }));
  assert.ok(result.actions.includes("GITHUB_LIST_NOTIFICATIONS:missing"));

  const trees = store.listIntegrationTrees({
    status: "active",
    limit: 100,
    offset: 0,
  });
  assert.equal(trees.length, 1);

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
      "profile",
      "pull:holaboss-ai/holaOS:412",
      "readme:holaboss-ai/holaOS",
      "repository:holaboss-ai/holaOS",
    ],
  );

  store.close();
});

test("fetchIntegrationContextForConnection skips a GitHub repository README when upstream returns a not-found payload", async () => {
  const root = makeTempDir("hb-integration-context-fetch-github-missing-readme-");
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

  const result = await fetchIntegrationContextForConnection({
    store,
    connectionId: "conn-github-1",
    composioClient: {
      async executeAction<TData = unknown>(params: ExecuteActionParams): Promise<{ data: TData | null; logId: string | null }> {
        if (params.toolSlug === "GITHUB_GET_THE_AUTHENTICATED_USER") {
          return {
            data: {
              data: {
                login: "octocat",
                name: "The Octocat",
                email: "octocat@github.example",
                html_url: "https://github.com/octocat",
              },
            } as TData,
            logId: "log-gh-profile",
          };
        }
        if (params.toolSlug === "GITHUB_LIST_NOTIFICATIONS") {
          return { data: { data: [] } as TData, logId: "log-gh-notifications" };
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
                  },
                ],
              },
            } as TData,
            logId: "log-gh-repos",
          };
        }
        if (params.toolSlug === "GITHUB_GET_A_REPOSITORY_README") {
          throw new ComposioApiClientError(200, {
            code: "composio_execute_failed",
            message: JSON.stringify({
              message: "Not Found",
              documentation_url: "https://docs.github.com/rest/repos/contents#get-a-repository-readme",
              status: "404",
            }),
          });
        }
        if (params.toolSlug === "GITHUB_LIST_PULL_REQUESTS") {
          return { data: { data: [] } as TData, logId: "log-gh-prs" };
        }
        if (params.toolSlug === "GITHUB_LIST_REPOSITORY_ISSUES") {
          return { data: { data: [] } as TData, logId: "log-gh-issues" };
        }
        throw new Error(`unexpected tool slug: ${params.toolSlug}`);
      },
    },
  });

  assert.equal(result.supported, true);
  assert.equal(result.provider_id, "github");
  assert.equal(result.leaves_created, 2);
  assert.equal(result.messages_seen, 1);
  assert.equal(result.messages_persisted, 1);
  assert.ok(
    result.actions.includes("GITHUB_GET_A_REPOSITORY_README:holaboss-ai/holaOS:missing"),
  );

  const trees = store.listIntegrationTrees({
    status: "active",
    limit: 100,
    offset: 0,
  });
  const leaves = store.listIntegrationLeaves({
    treeId: trees[0]!.treeId,
    status: "active",
    limit: 100,
    offset: 0,
  });
  assert.deepEqual(
    leaves.map((leaf) => leaf.subjectKey).sort(),
    [
      "profile",
      "repository:holaboss-ai/holaOS",
    ],
  );

  store.close();
});

test("fetchIntegrationContextForConnection falls back to owned public GitHub repos when /user/repos is forbidden", async () => {
  const root = makeTempDir("hb-integration-context-fetch-github-owned-public-fallback-");
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
  const proxyCalls: string[] = [];
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
                html_url: "https://github.com/octocat",
              },
            } as TData,
            logId: "log-gh-profile",
          };
        }
        if (params.toolSlug === "GITHUB_LIST_NOTIFICATIONS") {
          return { data: { data: [] } as TData, logId: "log-gh-notifications" };
        }
        if (params.toolSlug === "GITHUB_GET_A_REPOSITORY_README") {
          throw new ComposioApiClientError(404, {
            code: "404",
            message: "Not Found",
          });
        }
        if (params.toolSlug === "GITHUB_LIST_PULL_REQUESTS") {
          return { data: { data: [] } as TData, logId: "log-gh-prs" };
        }
        if (params.toolSlug === "GITHUB_LIST_REPOSITORY_ISSUES") {
          return { data: { data: [] } as TData, logId: "log-gh-issues" };
        }
        throw new Error(`unexpected tool slug: ${params.toolSlug}`);
      },
      async proxyRequest<TData = unknown>(_params: ProxyRequestParams): Promise<{ data: TData | null; status: number; headers: Record<string, string> }> {
        proxyCalls.push(_params.endpoint);
        if (_params.endpoint.startsWith("/user/repos")) {
          throw new ComposioApiClientError(403, {
            code: "403",
            message: JSON.stringify({
              error: {
                code: "403",
                message: "Forbidden",
              },
            }),
          });
        }
        if (_params.endpoint.startsWith("/users/octocat/repos")) {
          return {
            data: [
              {
                id: "repo-1",
                full_name: "octocat/hello-world",
                name: "hello-world",
                description: "A public owned repo.",
                html_url: "https://github.com/octocat/hello-world",
                updated_at: "2026-05-22T09:15:00Z",
                language: "TypeScript",
                default_branch: "main",
              },
            ] as TData,
            status: 200,
            headers: {},
          };
        }
        throw new Error(`unexpected proxy endpoint: ${_params.endpoint}`);
      },
    },
  });

  assert.deepEqual(calls, [
    "GITHUB_GET_THE_AUTHENTICATED_USER",
    "GITHUB_LIST_NOTIFICATIONS",
    "GITHUB_GET_A_REPOSITORY_README",
    "GITHUB_LIST_PULL_REQUESTS",
    "GITHUB_LIST_REPOSITORY_ISSUES",
  ]);
  assert.deepEqual(proxyCalls, [
    `/user/repos?type=owner&sort=updated&direction=desc&per_page=12`,
    `/users/octocat/repos?type=owner&sort=updated&direction=desc&per_page=12`,
  ]);
  assert.equal(result.supported, true);
  assert.equal(result.provider_id, "github");
  assert.equal(result.leaves_created, 2);
  assert.equal(result.messages_seen, 1);
  assert.equal(result.messages_persisted, 1);
  assert.ok(result.actions.includes("GITHUB_PROXY:/user/repos?type=owner:forbidden"));
  assert.ok(result.actions.includes("GITHUB_PROXY:/users/{username}/repos?type=owner"));

  const trees = store.listIntegrationTrees({
    status: "active",
    limit: 100,
    offset: 0,
  });
  const leaves = store.listIntegrationLeaves({
    treeId: trees[0]!.treeId,
    status: "active",
    limit: 100,
    offset: 0,
  });
  assert.deepEqual(
    leaves.map((leaf) => leaf.subjectKey).sort(),
    ["profile", "repository:octocat/hello-world"],
  );

  store.close();
});

test("fetchIntegrationContextForConnection skips forbidden GitHub repo subcalls instead of failing", async () => {
  const root = makeTempDir("hb-integration-context-fetch-github-forbidden-subcalls-");
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

  const result = await fetchIntegrationContextForConnection({
    store,
    connectionId: "conn-github-1",
    composioClient: {
      async executeAction<TData = unknown>(params: ExecuteActionParams): Promise<{ data: TData | null; logId: string | null }> {
        if (params.toolSlug === "GITHUB_GET_THE_AUTHENTICATED_USER") {
          return {
            data: {
              data: {
                login: "octocat",
                name: "The Octocat",
                email: "octocat@github.example",
                html_url: "https://github.com/octocat",
              },
            } as TData,
            logId: "log-gh-profile",
          };
        }
        if (params.toolSlug === "GITHUB_LIST_NOTIFICATIONS") {
          return { data: { data: [] } as TData, logId: "log-gh-notifications" };
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
                  },
                ],
              },
            } as TData,
            logId: "log-gh-repos",
          };
        }
        if (
          params.toolSlug === "GITHUB_GET_A_REPOSITORY_README"
          || params.toolSlug === "GITHUB_LIST_PULL_REQUESTS"
          || params.toolSlug === "GITHUB_LIST_REPOSITORY_ISSUES"
        ) {
          throw new ComposioApiClientError(403, {
            code: "403",
            message: "Forbidden",
          });
        }
        throw new Error(`unexpected tool slug: ${params.toolSlug}`);
      },
    },
  });

  assert.equal(result.supported, true);
  assert.equal(result.provider_id, "github");
  assert.equal(result.leaves_created, 2);
  assert.equal(result.messages_seen, 1);
  assert.equal(result.messages_persisted, 1);
  assert.ok(result.actions.includes("GITHUB_GET_A_REPOSITORY_README:holaboss-ai/holaOS:forbidden"));
  assert.ok(result.actions.includes("GITHUB_LIST_PULL_REQUESTS:holaboss-ai/holaOS:forbidden"));
  assert.ok(result.actions.includes("GITHUB_LIST_REPOSITORY_ISSUES:holaboss-ai/holaOS:forbidden"));

  const trees = store.listIntegrationTrees({
    status: "active",
    limit: 100,
    offset: 0,
  });
  const leaves = store.listIntegrationLeaves({
    treeId: trees[0]!.treeId,
    status: "active",
    limit: 100,
    offset: 0,
  });
  assert.deepEqual(
    leaves.map((leaf) => leaf.subjectKey).sort(),
    [
      "profile",
      "repository:holaboss-ai/holaOS",
    ],
  );

  store.close();
});

test("fetchIntegrationContextForConnection does not duplicate unchanged GitHub leaves across repeated fetches", async () => {
  const root = makeTempDir("hb-integration-context-fetch-github-repeat-");
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

  const composioClient = {
    async executeAction<TData = unknown>(params: ExecuteActionParams): Promise<{ data: TData | null; logId: string | null }> {
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
  };

  const first = await fetchIntegrationContextForConnection({
    store,
    connectionId: "conn-github-1",
    composioClient,
  });
  const secondProgressLabels: string[] = [];
  const second = await fetchIntegrationContextForConnection({
    store,
    connectionId: "conn-github-1",
    composioClient,
    onProgress(snapshot) {
      if (snapshot.current_chunk_label) {
        secondProgressLabels.push(snapshot.current_chunk_label);
      }
    },
  });

  assert.equal(first.leaves_created, 6);
  assert.equal(first.leaves_unchanged, 0);
  assert.equal(second.leaves_created, 0);
  assert.equal(second.leaves_superseding, 0);
  assert.equal(second.leaves_unchanged, 6);
  const summaryLabels = secondProgressLabels.filter((label) => label.includes("GitHub context summary"));
  assert.equal(summaryLabels.at(-1), "Reusing GitHub context summary");

  const trees = store.listIntegrationTrees({
    status: "active",
    limit: 100,
    offset: 0,
  });
  const leaves = store.listIntegrationLeaves({
    treeId: trees[0]!.treeId,
    status: "active",
    limit: 100,
    offset: 0,
  });
  assert.equal(leaves.length, 6);

  store.close();
});

test("fetchIntegrationContextForConnection ingests Notion pages, markdown, databases, and rows into the global integration tree", async () => {
  const root = makeTempDir("hb-integration-context-fetch-notion-");
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
    connectionId: "conn-notion-1",
    providerId: "notion",
    ownerUserId: "user-1",
    accountLabel: "Product Docs",
    accountExternalId: "ca_notion_1",
    accountHandle: "product-docs",
    accountEmail: null,
    authMode: "composio",
    grantedScopes: [],
    status: "active",
    secretRef: null,
  });

  const calls: string[] = [];
  const result = await fetchIntegrationContextForConnection({
    store,
    connectionId: "conn-notion-1",
    composioClient: {
      async executeAction<TData = unknown>(params: ExecuteActionParams): Promise<{ data: TData | null; logId: string | null }> {
        calls.push(params.toolSlug);
        if (params.toolSlug === "NOTION_SEARCH_NOTION_PAGE") {
          return {
            data: {
              data: {
                results: [
                  {
                    object: "page",
                    id: "page-1",
                    url: "https://www.notion.so/page-1",
                    last_edited_time: "2026-05-22T10:00:00Z",
                    properties: {
                      Name: {
                        id: "title",
                        type: "title",
                        title: [{ plain_text: "Launch Plan" }],
                      },
                    },
                  },
                  {
                    object: "database",
                    id: "db-1",
                    url: "https://www.notion.so/db-1",
                    title: [{ plain_text: "Roadmap" }],
                    last_edited_time: "2026-05-22T11:00:00Z",
                    properties: {
                      Title: { type: "title", title: {} },
                      Status: { type: "status", status: {} },
                    },
                  },
                ],
              },
            } as TData,
            logId: "log-notion-search",
          };
        }
        if (params.toolSlug === "NOTION_GET_PAGE_MARKDOWN") {
          return {
            data: {
              data: "# Launch Plan\n\n- Finalize GA checklist\n- Review docs cutover",
            } as TData,
            logId: "log-notion-markdown",
          };
        }
        if (params.toolSlug === "NOTION_FETCH_DATABASE") {
          return {
            data: {
              data: {
                object: "database",
                id: "db-1",
                url: "https://www.notion.so/db-1",
                title: [{ plain_text: "Roadmap" }],
                last_edited_time: "2026-05-22T11:00:00Z",
                properties: {
                  Title: { type: "title", title: {} },
                  Status: { type: "status", status: {} },
                  Owner: { type: "people", people: {} },
                },
              },
            } as TData,
            logId: "log-notion-database",
          };
        }
        if (params.toolSlug === "NOTION_QUERY_DATABASE") {
          return {
            data: {
              data: {
                results: [
                  {
                    object: "page",
                    id: "row-1",
                    url: "https://www.notion.so/row-1",
                    last_edited_time: "2026-05-22T12:00:00Z",
                    parent: { database_id: "db-1" },
                    properties: {
                      Title: {
                        type: "title",
                        title: [{ plain_text: "Ship v1 memory graph" }],
                      },
                      Status: {
                        type: "status",
                        status: { name: "In Progress" },
                      },
                    },
                  },
                ],
              },
            } as TData,
            logId: "log-notion-rows",
          };
        }
        throw new Error(`unexpected tool slug: ${params.toolSlug}`);
      },
    },
  });

  assert.deepEqual(calls, [
    "NOTION_SEARCH_NOTION_PAGE",
    "NOTION_GET_PAGE_MARKDOWN",
    "NOTION_FETCH_DATABASE",
    "NOTION_QUERY_DATABASE",
  ]);
  assert.equal(result.supported, true);
  assert.equal(result.provider_id, "notion");
  assert.equal(result.account_key, "product-docs");
  assert.equal(result.account_label, "Product Docs");
  assert.equal(result.messages_seen, 4);
  assert.equal(result.messages_persisted, 4);
  assert.equal(result.leaves_created, 5);
  assert.ok(result.tree_id);
  assert.equal(result.summary_nodes, countSummaryLikeSemanticIntegrationNodes({
    store,
    treeId: result.tree_id,
  }));

  const trees = store.listIntegrationTrees({
    status: "active",
    limit: 100,
    offset: 0,
  });
  assert.equal(trees.length, 1);
  assert.equal(trees[0]?.provider, "notion");

  const leaves = store.listIntegrationLeaves({
    treeId: trees[0]!.treeId,
    status: "active",
    limit: 100,
    offset: 0,
  });
  assert.deepEqual(
    leaves.map((leaf) => ({
      subjectKey: leaf.subjectKey,
      entityKey: leaf.entityKey,
      branchKey: leaf.branchKey,
    })).sort((left, right) => left.subjectKey.localeCompare(right.subjectKey)),
    [
      { subjectKey: "database:db-1", entityKey: "database:db-1", branchKey: "overview" },
      { subjectKey: "page_markdown:page-1", entityKey: "page:page-1", branchKey: "content" },
      { subjectKey: "page:page-1", entityKey: "page:page-1", branchKey: "overview" },
      { subjectKey: "row:db-1:row-1", entityKey: "database:db-1", branchKey: "rows" },
      { subjectKey: "workspace_snapshot", entityKey: null, branchKey: "workspace" },
    ],
  );

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
                      thread_ts: "1716412800.000100",
                      reply_count: 1,
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
        if (params.toolSlug === "SLACK_LIST_ALL_USERS") {
          return {
            data: {
              data: {
                members: [
                  {
                    id: "U123",
                    name: "memory-bot",
                    real_name: "Memory Bot",
                    deleted: false,
                    is_bot: true,
                    profile: { email: "memory-bot@example.com" },
                  },
                  {
                    id: "U456",
                    name: "ada",
                    real_name: "Ada Lovelace",
                    deleted: false,
                    is_bot: false,
                    is_admin: true,
                    profile: { email: "ada@example.com" },
                  },
                ],
              },
            } as TData,
            logId: "log-slack-users",
          };
        }
        if (params.toolSlug === "SLACK_FETCH_MESSAGE_THREAD_FROM_A_CONVERSATION") {
          return {
            data: {
              data: {
                messages: [
                  {
                    ts: "1716412800.000100",
                    user: "U123",
                    text: "Captured the latest memory tree screenshots.",
                    thread_ts: "1716412800.000100",
                  },
                  {
                    ts: "1716412810.000300",
                    user: "U456",
                    text: "Shared the follow-up note in the thread.",
                    thread_ts: "1716412800.000100",
                  },
                ],
              },
            } as TData,
            logId: "log-slack-thread-C111",
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
    "SLACK_LIST_ALL_USERS",
    "SLACK_FETCH_MESSAGE_THREAD_FROM_A_CONVERSATION",
  ]);
  assert.equal(result.supported, true);
  assert.equal(result.provider_id, "slack");
  assert.equal(result.account_key, "T123");
  assert.equal(result.account_label, "Holaboss");
  assert.equal(result.leaves_created, 8);
  assert.equal(result.messages_seen, 7);
  assert.equal(result.messages_persisted, 7);
  assert.ok(result.tree_id);
  assert.equal(result.summary_nodes, countSummaryLikeSemanticIntegrationNodes({
    store,
    treeId: result.tree_id,
  }));

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
  assert.equal(leaves.length, 8);
  assert.deepEqual(
    leaves.map((leaf) => leaf.subjectKey).sort(),
    [
      "channel:C111",
      "channel:C222",
      "message:C111:1716412800.000100",
      "message:C222:1716412900.000200",
      "profile",
      "thread:C111:1716412810.000300",
      "user:U123",
      "user:U456",
    ],
  );

  const semanticNodes = store.listSemanticMemoryNodes({
    category: "integration",
    treeId: trees[0]!.treeId,
    limit: 200,
    offset: 0,
  });
  assert.ok(semanticNodes.some((node) => node.nodeKind === "channels"));
  assert.ok(semanticNodes.some((node) => node.nodeKind === "directory"));

  const memoryRoot = globalMemoryDirForWorkspaceRoot(workspaceRoot);
  for (const leaf of leaves) {
    assert.ok(fs.existsSync(path.join(memoryRoot, leaf.path)));
  }

  store.close();
});

test("fetchIntegrationContextForConnection ingests Google Drive profile and recent files into the global integration tree", async () => {
  const root = makeTempDir("hb-integration-context-fetch-googledrive-");
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
    connectionId: "conn-googledrive-1",
    providerId: "googledrive",
    ownerUserId: "user-1",
    accountLabel: "Google Drive (Managed)",
    accountExternalId: "ca_drive_1",
    accountHandle: null,
    accountEmail: null,
    authMode: "composio",
    grantedScopes: [],
    status: "active",
    secretRef: null,
  });

  const proxyCalls: string[] = [];
  const actionCalls: string[] = [];
  const result = await fetchIntegrationContextForConnection({
    store,
    connectionId: "conn-googledrive-1",
    composioClient: {
      async executeAction<TData = unknown>(params: ExecuteActionParams): Promise<{ data: TData | null; logId: string | null }> {
        actionCalls.push(params.toolSlug);
        if (params.toolSlug === "GOOGLEDRIVE_LIST_SHARED_DRIVES") {
          return {
            data: {
              drives: [
                {
                  id: "drive-1",
                  name: "Product Shared",
                  createdTime: "2026-05-20T10:00:00Z",
                  hidden: false,
                },
              ],
            } as TData,
            logId: "log-drive-shared-drives",
          };
        }
        if (params.toolSlug === "GOOGLEDRIVE_LIST_PERMISSIONS") {
          return {
            data: {
              permissions: [
                {
                  id: "perm-user-1",
                  role: "writer",
                  type: "user",
                  emailAddress: "ada@example.com",
                  displayName: "Ada Lovelace",
                },
                {
                  id: "perm-domain-1",
                  role: "reader",
                  type: "domain",
                  domain: "example.com",
                  allowFileDiscovery: true,
                },
              ],
            } as TData,
            logId: "log-drive-permissions-file-1",
          };
        }
        throw new Error(`unexpected tool slug: ${params.toolSlug}`);
      },
      async proxyRequest<TData = unknown>(params: ProxyRequestParams): Promise<{ data: TData | null; status: number; headers: Record<string, string> }> {
        proxyCalls.push(params.endpoint);
        if (params.endpoint.startsWith("/drive/v3/about")) {
          return {
            data: {
              user: {
                displayName: "Product Ops",
                emailAddress: "ops@example.com",
                permissionId: "perm-1",
              },
              storageQuota: {
                limit: "1000",
                usage: "400",
                usageInDrive: "350",
                usageInDriveTrash: "50",
              },
            } as TData,
            status: 200,
            headers: {},
          };
        }
        if (params.endpoint.startsWith("/drive/v3/files")) {
          return {
            data: {
              files: [
                {
                  id: "file-1",
                  name: "Q2 Plan",
                  mimeType: "application/vnd.google-apps.document",
                  modifiedTime: "2026-05-24T08:30:00Z",
                  webViewLink: "https://drive.google.com/file/d/file-1/view",
                  owners: [{ displayName: "Product Ops", emailAddress: "ops@example.com" }],
                  size: "5120",
                  description: "Planning notes for Q2 launch work.",
                },
                {
                  id: "folder-1",
                  name: "Launch Assets",
                  mimeType: "application/vnd.google-apps.folder",
                  modifiedTime: "2026-05-24T09:00:00Z",
                  webViewLink: "https://drive.google.com/drive/folders/folder-1",
                  owners: [{ displayName: "Product Ops", emailAddress: "ops@example.com" }],
                },
              ],
            } as TData,
            status: 200,
            headers: {},
          };
        }
        throw new Error(`unexpected proxy endpoint: ${params.endpoint}`);
      },
    },
  });

  assert.deepEqual(proxyCalls, [
    "/drive/v3/about?fields=user(displayName,emailAddress,permissionId),storageQuota(limit,usage,usageInDrive,usageInDriveTrash)",
    "/drive/v3/files?pageSize=25&orderBy=modifiedTime%20desc&includeItemsFromAllDrives=true&supportsAllDrives=true&fields=nextPageToken,files(id,name,mimeType,modifiedTime,createdTime,webViewLink,owners(displayName,emailAddress),parents,shared,starred,trashed,size,description)",
  ]);
  assert.deepEqual(actionCalls, [
    "GOOGLEDRIVE_LIST_SHARED_DRIVES",
    "GOOGLEDRIVE_LIST_PERMISSIONS",
  ]);
  assert.equal(result.supported, true);
  assert.equal(result.provider_id, "googledrive");
  assert.equal(result.account_key, "ops@example.com");
  assert.equal(result.account_label, "Product Ops");
  assert.equal(result.leaves_created, 6);
  assert.equal(result.messages_seen, 5);
  assert.equal(result.messages_persisted, 5);
  assert.ok(result.tree_id);
  assert.equal(result.summary_nodes, countSummaryLikeSemanticIntegrationNodes({
    store,
    treeId: result.tree_id,
  }));

  const updatedConnection = store.getIntegrationConnection("conn-googledrive-1");
  assert.equal(updatedConnection?.accountEmail, "ops@example.com");

  const trees = store.listIntegrationTrees({
    status: "active",
    limit: 100,
    offset: 0,
  });
  assert.equal(trees.length, 1);
  assert.equal(trees[0]?.provider, "googledrive");
  assert.equal(trees[0]?.accountKey, "ops@example.com");

  const leaves = store.listIntegrationLeaves({
    treeId: trees[0]!.treeId,
    status: "active",
    limit: 100,
    offset: 0,
  });
  assert.equal(leaves.length, 6);
  assert.deepEqual(
    leaves.map((leaf) => ({
      subjectKey: leaf.subjectKey,
      entityKey: leaf.entityKey,
      branchKey: leaf.branchKey,
      sourceType: leaf.sourceType,
    })).sort((left, right) => left.subjectKey.localeCompare(right.subjectKey)),
    [
      { subjectKey: "file:file-1", entityKey: "file:file-1", branchKey: "overview", sourceType: "googledrive.file" },
      { subjectKey: "file:folder-1", entityKey: "file:folder-1", branchKey: "overview", sourceType: "googledrive.folder" },
      { subjectKey: "permission:file-1:perm-domain-1", entityKey: "file:file-1", branchKey: "permissions", sourceType: "googledrive.permission" },
      { subjectKey: "permission:file-1:perm-user-1", entityKey: "file:file-1", branchKey: "permissions", sourceType: "googledrive.permission" },
      { subjectKey: "profile", entityKey: null, branchKey: "profile", sourceType: "googledrive.profile" },
      { subjectKey: "shared-drive:drive-1", entityKey: null, branchKey: "shared-drives", sourceType: "googledrive.shared-drive" },
    ],
  );

  const semanticNodes = store.listSemanticMemoryNodes({
    category: "integration",
    treeId: trees[0]!.treeId,
    limit: 100,
    offset: 0,
  });
  assert.ok(semanticNodes.some((node) => node.nodeKind === "files"));
  assert.ok(semanticNodes.some((node) => node.nodeKind === "file" && node.title === "Q2 Plan"));
  assert.ok(semanticNodes.some((node) => node.nodeKind === "folder" && node.title === "Launch Assets"));
  assert.ok(semanticNodes.some((node) => node.nodeKind === "permissions"));
  assert.ok(semanticNodes.some((node) => node.nodeKind === "shared-drives"));

  const memoryRoot = globalMemoryDirForWorkspaceRoot(workspaceRoot);
  for (const leaf of leaves) {
    assert.ok(fs.existsSync(path.join(memoryRoot, leaf.path)));
  }

  store.close();
});

test("fetchIntegrationContextForConnection ingests Twitter profile and recent posts into the global integration tree", async () => {
  const root = makeTempDir("hb-integration-context-fetch-twitter-");
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
    connectionId: "conn-twitter-1",
    providerId: "twitter",
    ownerUserId: "user-1",
    accountLabel: "Twitter (Managed)",
    accountExternalId: "ca_twitter_1",
    accountHandle: null,
    accountEmail: null,
    authMode: "composio",
    grantedScopes: [],
    status: "active",
    secretRef: null,
  });

  const proxyCalls: string[] = [];
  const actionCalls: string[] = [];
  const result = await fetchIntegrationContextForConnection({
    store,
    connectionId: "conn-twitter-1",
    composioClient: {
      async executeAction<TData = unknown>(params: ExecuteActionParams): Promise<{ data: TData | null; logId: string | null }> {
        actionCalls.push(params.toolSlug);
        if (params.toolSlug === "TWITTER_RECENT_SEARCH") {
          return {
            data: {
              data: [
                {
                  id: "post-mention-1",
                  text: "@holabossai any update on Google Drive context fetch?",
                  author_id: "user-77",
                  conversation_id: "conv-mention-1",
                  created_at: "2026-05-24T09:30:00Z",
                  lang: "en",
                  public_metrics: {
                    like_count: 2,
                    reply_count: 1,
                    retweet_count: 0,
                    quote_count: 0,
                  },
                },
              ],
            } as TData,
            logId: "log-twitter-mentions",
          };
        }
        if (params.toolSlug === "TWITTER_GET_RECENT_DM_EVENTS") {
          return {
            data: {
              data: [
                {
                  id: "dm-1",
                  dm_conversation_id: "dm-conv-1",
                  event_type: "MessageCreate",
                  text: "Can you share the rollout notes?",
                  sender_id: "user-88",
                  created_at: "2026-05-24T09:45:00Z",
                },
              ],
            } as TData,
            logId: "log-twitter-dms",
          };
        }
        throw new Error(`unexpected tool slug: ${params.toolSlug}`);
      },
      async proxyRequest<TData = unknown>(params: ProxyRequestParams): Promise<{ data: TData | null; status: number; headers: Record<string, string> }> {
        proxyCalls.push(params.endpoint);
        if (params.endpoint === "/2/users/me?user.fields=created_at,description,id,location,name,profile_image_url,public_metrics,url,username,verified") {
          return {
            data: {
              id: "user-42",
              username: "holabossai",
              name: "HolaBoss",
              description: "Workspace memory experiments and agent runtime notes.",
              verified: true,
              public_metrics: {
                followers_count: 1200,
                following_count: 18,
                tweet_count: 84,
              },
            } as TData,
            status: 200,
            headers: {},
          };
        }
        if (params.endpoint.startsWith("/2/users/user-42/timelines/reverse_chronological")) {
          return {
            data: {
              data: [
                {
                  id: "post-1",
                  text: "Shipped semantic memory trees for Gmail, GitHub, and Notion.",
                  author_id: "user-42",
                  conversation_id: "conv-1",
                  created_at: "2026-05-24T08:00:00Z",
                  lang: "en",
                  public_metrics: {
                    like_count: 12,
                    reply_count: 2,
                    retweet_count: 3,
                    quote_count: 1,
                  },
                },
                {
                  id: "post-2",
                  text: "Next up is wiring Google Drive and Twitter into context fetch.",
                  author_id: "user-42",
                  conversation_id: "conv-2",
                  created_at: "2026-05-24T09:00:00Z",
                  lang: "en",
                  public_metrics: {
                    like_count: 8,
                    reply_count: 1,
                    retweet_count: 1,
                    quote_count: 0,
                  },
                },
              ],
            } as TData,
            status: 200,
            headers: {},
          };
        }
        throw new Error(`unexpected proxy endpoint: ${params.endpoint}`);
      },
    },
  });

  assert.deepEqual(proxyCalls, [
    "/2/users/me?user.fields=created_at,description,id,location,name,profile_image_url,public_metrics,url,username,verified",
    "/2/users/user-42/timelines/reverse_chronological?max_results=20&exclude=replies&tweet.fields=author_id,conversation_id,created_at,entities,lang,public_metrics,referenced_tweets",
  ]);
  assert.deepEqual(actionCalls, [
    "TWITTER_RECENT_SEARCH",
    "TWITTER_GET_RECENT_DM_EVENTS",
  ]);
  assert.equal(result.supported, true);
  assert.equal(result.provider_id, "twitter");
  assert.equal(result.account_key, "holabossai");
  assert.equal(result.account_label, "HolaBoss (@holabossai)");
  assert.equal(result.leaves_created, 5);
  assert.equal(result.messages_seen, 4);
  assert.equal(result.messages_persisted, 4);
  assert.ok(result.tree_id);
  assert.equal(result.summary_nodes, countSummaryLikeSemanticIntegrationNodes({
    store,
    treeId: result.tree_id,
  }));

  const updatedConnection = store.getIntegrationConnection("conn-twitter-1");
  assert.equal(updatedConnection?.accountHandle, "holabossai");

  const trees = store.listIntegrationTrees({
    status: "active",
    limit: 100,
    offset: 0,
  });
  assert.equal(trees.length, 1);
  assert.equal(trees[0]?.provider, "twitter");
  assert.equal(trees[0]?.accountKey, "holabossai");

  const leaves = store.listIntegrationLeaves({
    treeId: trees[0]!.treeId,
    status: "active",
    limit: 100,
    offset: 0,
  });
  assert.equal(leaves.length, 5);
  assert.deepEqual(
    leaves.map((leaf) => ({
      subjectKey: leaf.subjectKey,
      entityKey: leaf.entityKey,
      branchKey: leaf.branchKey,
      sourceType: leaf.sourceType,
    })).sort((left, right) => left.subjectKey.localeCompare(right.subjectKey)),
    [
      { subjectKey: "dm:dm-1", entityKey: null, branchKey: "direct-messages", sourceType: "twitter.direct-message" },
      { subjectKey: "mention:post-mention-1", entityKey: "post:post-mention-1", branchKey: "mentions", sourceType: "twitter.mention" },
      { subjectKey: "post:post-1", entityKey: "post:post-1", branchKey: "overview", sourceType: "twitter.post" },
      { subjectKey: "post:post-2", entityKey: "post:post-2", branchKey: "overview", sourceType: "twitter.post" },
      { subjectKey: "profile", entityKey: null, branchKey: "profile", sourceType: "twitter.profile" },
    ],
  );

  const semanticNodes = store.listSemanticMemoryNodes({
    category: "integration",
    treeId: trees[0]!.treeId,
    limit: 100,
    offset: 0,
  });
  assert.ok(semanticNodes.some((node) => node.nodeKind === "timeline"));
  assert.ok(semanticNodes.some((node) => node.nodeKind === "post" && node.title.includes("Shipped semantic memory trees")));
  assert.ok(semanticNodes.some((node) => node.nodeKind === "direct-messages"));

  const memoryRoot = globalMemoryDirForWorkspaceRoot(workspaceRoot);
  for (const leaf of leaves) {
    assert.ok(fs.existsSync(path.join(memoryRoot, leaf.path)));
  }

  store.close();
});

test("fetchIntegrationContextForConnection ingests Google Calendar profile, calendars, and upcoming events into the global integration tree", async () => {
  const root = makeTempDir("hb-integration-context-fetch-googlecalendar-");
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
    connectionId: "conn-googlecalendar-1",
    providerId: "googlecalendar",
    ownerUserId: "user-1",
    accountLabel: "Google Calendar (Managed)",
    accountExternalId: "ca_calendar_1",
    accountHandle: null,
    accountEmail: null,
    authMode: "composio",
    grantedScopes: [],
    status: "active",
    secretRef: null,
  });

  const calls: Array<{ toolSlug: string; arguments: Record<string, unknown> }> = [];
  const result = await fetchIntegrationContextForConnection({
    store,
    connectionId: "conn-googlecalendar-1",
    composioClient: {
      async executeAction<TData = unknown>(params: ExecuteActionParams): Promise<{ data: TData | null; logId: string | null }> {
        calls.push({
          toolSlug: params.toolSlug,
          arguments: params.arguments ?? {},
        });
        if (params.toolSlug === "GOOGLECALENDAR_LIST_CALENDARS") {
          return {
            data: {
              items: [
                {
                  id: "ops@example.com",
                  summary: "Product Ops",
                  description: "Primary operating calendar.",
                  primary: true,
                  accessRole: "owner",
                  timeZone: "America/Los_Angeles",
                },
                {
                  id: "team@example.com",
                  summary: "Team Calendar",
                  description: "Cross-functional planning calendar.",
                  primary: false,
                  accessRole: "reader",
                  timeZone: "America/New_York",
                },
              ],
            } as TData,
            logId: "log-calendar-list",
          };
        }
        if (params.toolSlug === "GOOGLECALENDAR_EVENTS_LIST" && params.arguments?.calendarId === "ops@example.com") {
          return {
            data: {
              items: [
                {
                  id: "event-1",
                  summary: "Launch sync",
                  description: "Finalize launch checklist and owner handoff.",
                  status: "confirmed",
                  htmlLink: "https://calendar.google.com/calendar/event?eid=event-1",
                  start: { dateTime: "2026-05-24T08:00:00Z" },
                  end: { dateTime: "2026-05-24T08:30:00Z" },
                  organizer: {
                    displayName: "Ada",
                    email: "ada@example.com",
                  },
                  location: "Zoom",
                },
                {
                  id: "event-cancelled",
                  summary: "Cancelled event",
                  status: "cancelled",
                  start: { dateTime: "2026-05-24T09:00:00Z" },
                  end: { dateTime: "2026-05-24T09:30:00Z" },
                },
              ],
            } as TData,
            logId: "log-calendar-events-ops",
          };
        }
        if (params.toolSlug === "GOOGLECALENDAR_EVENTS_LIST" && params.arguments?.calendarId === "team@example.com") {
          return {
            data: {
              items: [
                {
                  id: "event-2",
                  summary: "Team planning",
                  description: "Review next sprint scope.",
                  status: "confirmed",
                  htmlLink: "https://calendar.google.com/calendar/event?eid=event-2",
                  start: { dateTime: "2026-05-24T10:00:00Z" },
                  end: { dateTime: "2026-05-24T11:00:00Z" },
                  organizer: {
                    displayName: "Grace",
                    email: "grace@example.com",
                  },
                },
              ],
            } as TData,
            logId: "log-calendar-events-team",
          };
        }
        if (params.toolSlug === "GOOGLECALENDAR_SETTINGS_LIST") {
          return {
            data: {
              items: [
                { id: "timezone", value: "America/Los_Angeles" },
                { id: "weekStart", value: "1" },
              ],
            } as TData,
            logId: "log-calendar-settings",
          };
        }
        if (params.toolSlug === "GOOGLECALENDAR_LIST_CALENDAR_RESOURCES") {
          return {
            data: {
              items: [
                {
                  resourceId: "room-1",
                  resourceEmail: "room-1@example.com",
                  resourceName: "Sunset Conference Room",
                  resourceCategory: "CONFERENCE_ROOM",
                  buildingId: "hq",
                  capacity: 10,
                },
              ],
            } as TData,
            logId: "log-calendar-resources",
          };
        }
        if (params.toolSlug === "GOOGLECALENDAR_LIST_BUILDINGS") {
          return {
            data: {
              items: [
                {
                  buildingId: "hq",
                  buildingName: "HQ",
                  description: "Headquarters building",
                  floors: [{ floorName: "1" }, { floorName: "2" }],
                },
              ],
            } as TData,
            logId: "log-calendar-buildings",
          };
        }
        throw new Error(`unexpected tool slug: ${params.toolSlug}`);
      },
    },
  });

  assert.equal(calls.length, 6);
  assert.deepEqual(calls[0], {
    toolSlug: "GOOGLECALENDAR_LIST_CALENDARS",
    arguments: {
      max_results: 6,
    },
  });
  assert.equal(calls[1]?.toolSlug, "GOOGLECALENDAR_EVENTS_LIST");
  assert.equal(calls[1]?.arguments.calendarId, "ops@example.com");
  assert.equal(calls[1]?.arguments.maxResults, 8);
  assert.equal(calls[1]?.arguments.singleEvents, true);
  assert.equal(calls[1]?.arguments.orderBy, "startTime");
  assert.equal(typeof calls[1]?.arguments.timeMin, "string");
  assert.equal(calls[2]?.toolSlug, "GOOGLECALENDAR_EVENTS_LIST");
  assert.equal(calls[2]?.arguments.calendarId, "team@example.com");
  assert.equal(calls[2]?.arguments.maxResults, 8);
  assert.equal(calls[2]?.arguments.singleEvents, true);
  assert.equal(calls[2]?.arguments.orderBy, "startTime");
  assert.equal(typeof calls[2]?.arguments.timeMin, "string");
  assert.deepEqual(calls[3], {
    toolSlug: "GOOGLECALENDAR_SETTINGS_LIST",
    arguments: {
      maxResults: 20,
    },
  });
  assert.deepEqual(calls[4], {
    toolSlug: "GOOGLECALENDAR_LIST_CALENDAR_RESOURCES",
    arguments: {
      customer: "my_customer",
      maxResults: 12,
    },
  });
  assert.deepEqual(calls[5], {
    toolSlug: "GOOGLECALENDAR_LIST_BUILDINGS",
    arguments: {
      customer: "my_customer",
      maxResults: 12,
    },
  });
  assert.equal(result.supported, true);
  assert.equal(result.provider_id, "googlecalendar");
  assert.equal(result.account_key, "ops@example.com");
  assert.equal(result.account_label, "Product Ops");
  assert.equal(result.leaves_created, 9);
  assert.equal(result.messages_seen, 8);
  assert.equal(result.messages_persisted, 8);
  assert.ok(result.tree_id);
  assert.equal(result.summary_nodes, countSummaryLikeSemanticIntegrationNodes({
    store,
    treeId: result.tree_id,
  }));

  const updatedConnection = store.getIntegrationConnection("conn-googlecalendar-1");
  assert.equal(updatedConnection?.accountEmail, "ops@example.com");

  const trees = store.listIntegrationTrees({
    status: "active",
    limit: 100,
    offset: 0,
  });
  assert.equal(trees.length, 1);
  assert.equal(trees[0]?.provider, "googlecalendar");
  assert.equal(trees[0]?.accountKey, "ops@example.com");

  const leaves = store.listIntegrationLeaves({
    treeId: trees[0]!.treeId,
    status: "active",
    limit: 100,
    offset: 0,
  });
  assert.equal(leaves.length, 9);
  assert.deepEqual(
    leaves.map((leaf) => ({
      subjectKey: leaf.subjectKey,
      entityKey: leaf.entityKey,
      branchKey: leaf.branchKey,
      sourceType: leaf.sourceType,
    })).sort((left, right) => left.subjectKey.localeCompare(right.subjectKey)),
    [
      { subjectKey: "building:hq", entityKey: null, branchKey: "buildings", sourceType: "googlecalendar.building" },
      { subjectKey: "calendar:ops@example.com", entityKey: "calendar:ops@example.com", branchKey: "overview", sourceType: "googlecalendar.calendar" },
      { subjectKey: "calendar:team@example.com", entityKey: "calendar:team@example.com", branchKey: "overview", sourceType: "googlecalendar.calendar" },
      { subjectKey: "event:ops@example.com:event-1", entityKey: "calendar:ops@example.com", branchKey: "events", sourceType: "googlecalendar.event" },
      { subjectKey: "event:team@example.com:event-2", entityKey: "calendar:team@example.com", branchKey: "events", sourceType: "googlecalendar.event" },
      { subjectKey: "profile", entityKey: null, branchKey: "profile", sourceType: "googlecalendar.profile" },
      { subjectKey: "resource:room-1", entityKey: null, branchKey: "resources", sourceType: "googlecalendar.resource" },
      { subjectKey: "setting:timezone", entityKey: null, branchKey: "settings", sourceType: "googlecalendar.setting" },
      { subjectKey: "setting:weekStart", entityKey: null, branchKey: "settings", sourceType: "googlecalendar.setting" },
    ],
  );

  const semanticNodes = store.listSemanticMemoryNodes({
    category: "integration",
    treeId: trees[0]!.treeId,
    limit: 100,
    offset: 0,
  });
  assert.ok(semanticNodes.some((node) => node.nodeKind === "calendars"));
  assert.ok(semanticNodes.some((node) => node.nodeKind === "calendar" && node.title === "Product Ops"));
  assert.ok(semanticNodes.some((node) => node.nodeKind === "calendar" && node.title === "Team Calendar"));
  assert.ok(semanticNodes.some((node) => node.nodeKind === "settings"));
  assert.ok(semanticNodes.some((node) => node.nodeKind === "resources"));
  assert.ok(semanticNodes.some((node) => node.nodeKind === "buildings"));

  const memoryRoot = globalMemoryDirForWorkspaceRoot(workspaceRoot);
  for (const leaf of leaves) {
    assert.ok(fs.existsSync(path.join(memoryRoot, leaf.path)));
  }

  store.close();
});

test("fetchIntegrationContextForConnection ingests a LinkedIn profile into the global integration tree", async () => {
  const root = makeTempDir("hb-integration-context-fetch-linkedin-");
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
    connectionId: "conn-linkedin-1",
    providerId: "linkedin",
    ownerUserId: "user-1",
    accountLabel: "LinkedIn (Managed)",
    accountExternalId: "ca_linkedin_1",
    accountHandle: null,
    accountEmail: null,
    authMode: "composio",
    grantedScopes: [],
    status: "active",
    secretRef: null,
  });

  const calls: Array<{ toolSlug: string; arguments: Record<string, unknown> }> = [];
  const result = await fetchIntegrationContextForConnection({
    store,
    connectionId: "conn-linkedin-1",
    composioClient: {
      async executeAction<TData = unknown>(params: ExecuteActionParams): Promise<{ data: TData | null; logId: string | null }> {
        calls.push({
          toolSlug: params.toolSlug,
          arguments: params.arguments ?? {},
        });
        if (params.toolSlug === "LINKEDIN_GET_MY_INFO") {
          return {
            data: {
              id: "person-1",
              name: "Ada Lovelace",
              email: "ada@example.com",
              picture: "https://example.com/ada.jpg",
              author: "urn:li:person:person-1",
            } as TData,
            logId: "log-linkedin-me",
          };
        }
        if (params.toolSlug === "LINKEDIN_GET_PERSON") {
          return {
            data: {
              id: "person-1",
              firstName: "Ada",
              lastName: "Lovelace",
              headline: "Founder, Workspace Memory",
            } as TData,
            logId: "log-linkedin-person",
          };
        }
        if (params.toolSlug === "LINKEDIN_GET_COMPANY_INFO") {
          return {
            data: {
              organizations: [
                {
                  id: "org-1",
                  name: "HolaBoss",
                  description: "Agent-native workspace platform.",
                  website: "https://holaboss.ai",
                },
              ],
            } as TData,
            logId: "log-linkedin-company-info",
          };
        }
        if (params.toolSlug === "LINKEDIN_GET_NETWORK_SIZE") {
          return {
            data: {
              network_size: 1280,
            } as TData,
            logId: "log-linkedin-network-size",
          };
        }
        throw new Error(`unexpected tool slug: ${params.toolSlug}`);
      },
    },
  });

  assert.deepEqual(calls, [
    {
      toolSlug: "LINKEDIN_GET_MY_INFO",
      arguments: {},
    },
    {
      toolSlug: "LINKEDIN_GET_PERSON",
      arguments: {
        person_id: "person-1",
      },
    },
    {
      toolSlug: "LINKEDIN_GET_COMPANY_INFO",
      arguments: {},
    },
    {
      toolSlug: "LINKEDIN_GET_NETWORK_SIZE",
      arguments: {
        organization_id: "org-1",
      },
    },
  ]);
  assert.equal(result.supported, true);
  assert.equal(result.provider_id, "linkedin");
  assert.equal(result.account_key, "ada@example.com");
  assert.equal(result.account_label, "Ada Lovelace");
  assert.equal(result.leaves_created, 3);
  assert.equal(result.messages_seen, 2);
  assert.equal(result.messages_persisted, 2);
  assert.ok(result.tree_id);
  assert.equal(result.summary_nodes, countSummaryLikeSemanticIntegrationNodes({
    store,
    treeId: result.tree_id,
  }));

  const updatedConnection = store.getIntegrationConnection("conn-linkedin-1");
  assert.equal(updatedConnection?.accountEmail, "ada@example.com");

  const trees = store.listIntegrationTrees({
    status: "active",
    limit: 100,
    offset: 0,
  });
  assert.equal(trees.length, 1);
  assert.equal(trees[0]?.provider, "linkedin");
  assert.equal(trees[0]?.accountKey, "ada@example.com");

  const leaves = store.listIntegrationLeaves({
    treeId: trees[0]!.treeId,
    status: "active",
    limit: 100,
    offset: 0,
  });
  assert.equal(leaves.length, 3);
  assert.deepEqual(
    leaves.map((leaf) => ({
      subjectKey: leaf.subjectKey,
      entityKey: leaf.entityKey,
      branchKey: leaf.branchKey,
      sourceType: leaf.sourceType,
    })).sort((left, right) => left.subjectKey.localeCompare(right.subjectKey)),
    [
      { subjectKey: "organization:org-1", entityKey: null, branchKey: "organizations", sourceType: "linkedin.organization" },
      { subjectKey: "person:person-1", entityKey: null, branchKey: "person", sourceType: "linkedin.person" },
      { subjectKey: "profile", entityKey: null, branchKey: "profile", sourceType: "linkedin.profile" },
    ],
  );

  const semanticNodes = store.listSemanticMemoryNodes({
    category: "integration",
    treeId: trees[0]!.treeId,
    limit: 100,
    offset: 0,
  });
  assert.ok(semanticNodes.some((node) => node.nodeKind === "profile"));
  assert.ok(semanticNodes.some((node) => node.nodeKind === "person"));
  assert.ok(semanticNodes.some((node) => node.nodeKind === "organizations"));

  const memoryRoot = globalMemoryDirForWorkspaceRoot(workspaceRoot);
  for (const leaf of leaves) {
    assert.ok(fs.existsSync(path.join(memoryRoot, leaf.path)));
  }

  store.close();
});

test("fetchIntegrationContextForConnection ingests Outlook profile, messages, contacts, and events into the global integration tree", async () => {
  const root = makeTempDir("hb-integration-context-outlook-");
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
    connectionId: "conn-outlook-1",
    providerId: "outlook",
    ownerUserId: "user-1",
    accountLabel: "Outlook (Managed)",
    accountExternalId: "ca_outlook_1",
    accountHandle: null,
    accountEmail: null,
    authMode: "composio",
    grantedScopes: [],
    status: "active",
    secretRef: null,
  });

  const calls: Array<{ toolSlug: string; arguments: Record<string, unknown> }> = [];
  const result = await fetchIntegrationContextForConnection({
    store,
    connectionId: "conn-outlook-1",
    composioClient: {
      async executeAction<TData = unknown>(params: ExecuteActionParams): Promise<{ data: TData | null; logId: string | null }> {
        calls.push({
          toolSlug: params.toolSlug,
          arguments: params.arguments ?? {},
        });
        if (params.toolSlug === "OUTLOOK_GET_PROFILE") {
          return {
            data: {
              id: "outlook-user-1",
              displayName: "Ada Lovelace",
              mail: "ada@outlook.example",
              jobTitle: "Founder",
            } as TData,
            logId: "log-outlook-profile",
          };
        }
        if (params.toolSlug === "OUTLOOK_LIST_MESSAGES") {
          return {
            data: {
              value: [
                {
                  id: "msg-1",
                  subject: "Launch checklist",
                  bodyPreview: "Finalized the launch checklist and approvals.",
                  receivedDateTime: "2026-05-24T08:00:00Z",
                  from: { emailAddress: { address: "ops@example.com", name: "Ops" } },
                },
                {
                  id: "msg-2",
                  subject: "Customer escalation",
                  bodyPreview: "Need immediate follow-up from support.",
                  receivedDateTime: "2026-05-24T09:00:00Z",
                  from: { emailAddress: { address: "support@example.com", name: "Support" } },
                },
              ],
            } as TData,
            logId: "log-outlook-messages",
          };
        }
        if (params.toolSlug === "OUTLOOK_LIST_USER_CONTACTS") {
          return {
            data: {
              value: [
                {
                  id: "contact-1",
                  displayName: "Grace Hopper",
                  companyName: "Navy",
                  jobTitle: "Admiral",
                  emailAddresses: [{ address: "grace@example.com", name: "Grace Hopper" }],
                },
              ],
            } as TData,
            logId: "log-outlook-contacts",
          };
        }
        if (params.toolSlug === "OUTLOOK_LIST_EVENTS") {
          return {
            data: {
              value: [
                {
                  id: "event-1",
                  subject: "Board sync",
                  start: { dateTime: "2026-05-24T10:00:00Z" },
                  end: { dateTime: "2026-05-24T10:30:00Z" },
                  location: { displayName: "Zoom" },
                  isCancelled: false,
                },
              ],
            } as TData,
            logId: "log-outlook-events",
          };
        }
        throw new Error(`unexpected tool slug: ${params.toolSlug}`);
      },
    },
  });

  assert.deepEqual(calls, [
    { toolSlug: "OUTLOOK_GET_PROFILE", arguments: {} },
    { toolSlug: "OUTLOOK_LIST_MESSAGES", arguments: { top: 20 } },
    { toolSlug: "OUTLOOK_LIST_USER_CONTACTS", arguments: { top: 20 } },
    { toolSlug: "OUTLOOK_LIST_EVENTS", arguments: { top: 12 } },
  ]);
  assert.equal(result.supported, true);
  assert.equal(result.provider_id, "outlook");
  assert.equal(result.account_key, "ada@outlook.example");
  assert.equal(result.account_label, "Ada Lovelace");
  assert.equal(result.leaves_created, 5);
  assert.equal(result.messages_seen, 4);
  assert.equal(result.messages_persisted, 4);
  assert.ok(result.tree_id);

  const leaves = store.listIntegrationLeaves({
    treeId: result.tree_id!,
    status: "active",
    limit: 100,
    offset: 0,
  });
  assert.deepEqual(
    leaves.map((leaf) => ({ subjectKey: leaf.subjectKey, branchKey: leaf.branchKey, sourceType: leaf.sourceType }))
      .sort((left, right) => left.subjectKey.localeCompare(right.subjectKey)),
    [
      { subjectKey: "contact:contact-1", branchKey: "contacts", sourceType: "outlook.contact" },
      { subjectKey: "event:event-1", branchKey: "events", sourceType: "outlook.event" },
      { subjectKey: "message:msg-1", branchKey: "messages", sourceType: "outlook.message" },
      { subjectKey: "message:msg-2", branchKey: "messages", sourceType: "outlook.message" },
      { subjectKey: "profile", branchKey: "profile", sourceType: "outlook.profile" },
    ],
  );

  const semanticNodes = store.listSemanticMemoryNodes({
    category: "integration",
    treeId: result.tree_id!,
    limit: 100,
    offset: 0,
  });
  assert.ok(semanticNodes.some((node) => node.nodeKind === "profile"));
  assert.ok(semanticNodes.some((node) => node.nodeKind === "messages"));
  assert.ok(semanticNodes.some((node) => node.nodeKind === "contacts"));
  assert.ok(semanticNodes.some((node) => node.nodeKind === "events"));

  store.close();
});

test("fetchIntegrationContextForConnection ingests Google Sheets spreadsheets, worksheets, and values into the global integration tree", async () => {
  const root = makeTempDir("hb-integration-context-googlesheets-");
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
    connectionId: "conn-googlesheets-1",
    providerId: "googlesheets",
    ownerUserId: "user-1",
    accountLabel: "Google Sheets (Managed)",
    accountExternalId: "ca_sheets_1",
    accountHandle: null,
    accountEmail: null,
    authMode: "composio",
    grantedScopes: [],
    status: "active",
    secretRef: null,
  });

  const calls: Array<{ toolSlug: string; arguments: Record<string, unknown> }> = [];
  const result = await fetchIntegrationContextForConnection({
    store,
    connectionId: "conn-googlesheets-1",
    composioClient: {
      async executeAction<TData = unknown>(params: ExecuteActionParams): Promise<{ data: TData | null; logId: string | null }> {
        calls.push({
          toolSlug: params.toolSlug,
          arguments: params.arguments ?? {},
        });
        if (params.toolSlug === "GOOGLESHEETS_SEARCH_SPREADSHEETS") {
          return {
            data: {
              spreadsheets: [
                {
                  spreadsheetId: "sheet-1",
                  title: "Launch Tracker",
                  modifiedTime: "2026-05-24T08:00:00Z",
                },
              ],
            } as TData,
            logId: "log-sheets-search",
          };
        }
        if (params.toolSlug === "GOOGLESHEETS_GET_SPREADSHEET_INFO") {
          return {
            data: {
              spreadsheetId: "sheet-1",
              properties: { title: "Launch Tracker" },
              sheets: [{ properties: { title: "Backlog" } }],
            } as TData,
            logId: "log-sheets-info",
          };
        }
        if (params.toolSlug === "GOOGLESHEETS_VALUES_GET") {
          return {
            data: {
              values: [
                ["Task", "Owner"],
                ["Launch review", "Ada"],
              ],
            } as TData,
            logId: "log-sheets-values",
          };
        }
        throw new Error(`unexpected tool slug: ${params.toolSlug}`);
      },
    },
  });

  assert.deepEqual(calls, [
    { toolSlug: "GOOGLESHEETS_SEARCH_SPREADSHEETS", arguments: { query: "" } },
    { toolSlug: "GOOGLESHEETS_GET_SPREADSHEET_INFO", arguments: { spreadsheetId: "sheet-1" } },
    { toolSlug: "GOOGLESHEETS_VALUES_GET", arguments: { spreadsheetId: "sheet-1", range: "Backlog!A1:E10" } },
  ]);
  assert.equal(result.supported, true);
  assert.equal(result.provider_id, "googlesheets");
  assert.equal(result.account_label, "Google Sheets (Managed)");
  assert.equal(result.leaves_created, 4);
  assert.equal(result.messages_seen, 3);
  assert.equal(result.messages_persisted, 3);
  assert.ok(result.tree_id);

  const leaves = store.listIntegrationLeaves({
    treeId: result.tree_id!,
    status: "active",
    limit: 100,
    offset: 0,
  });
  assert.deepEqual(
    leaves.map((leaf) => ({ subjectKey: leaf.subjectKey, branchKey: leaf.branchKey, sourceType: leaf.sourceType }))
      .sort((left, right) => left.subjectKey.localeCompare(right.subjectKey)),
    [
      { subjectKey: "profile", branchKey: "profile", sourceType: "googlesheets.profile" },
      { subjectKey: "spreadsheet:sheet-1", branchKey: "spreadsheets", sourceType: "googlesheets.spreadsheet" },
      { subjectKey: "values:sheet-1:Backlog!A1:E10", branchKey: "values", sourceType: "googlesheets.values" },
      { subjectKey: "worksheet-list:sheet-1", branchKey: "worksheets", sourceType: "googlesheets.worksheets" },
    ],
  );

  const semanticNodes = store.listSemanticMemoryNodes({
    category: "integration",
    treeId: result.tree_id!,
    limit: 100,
    offset: 0,
  });
  assert.ok(semanticNodes.some((node) => node.nodeKind === "spreadsheets"));
  assert.ok(semanticNodes.some((node) => node.nodeKind === "worksheets"));
  assert.ok(semanticNodes.some((node) => node.nodeKind === "values"));

  store.close();
});

test("fetchIntegrationContextForConnection ingests Google Docs documents and plaintext into the global integration tree", async () => {
  const root = makeTempDir("hb-integration-context-googledocs-");
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
    connectionId: "conn-googledocs-1",
    providerId: "googledocs",
    ownerUserId: "user-1",
    accountLabel: "Google Docs (Managed)",
    accountExternalId: "ca_docs_1",
    accountHandle: null,
    accountEmail: null,
    authMode: "composio",
    grantedScopes: [],
    status: "active",
    secretRef: null,
  });

  const calls: Array<{ toolSlug: string; arguments: Record<string, unknown> }> = [];
  const result = await fetchIntegrationContextForConnection({
    store,
    connectionId: "conn-googledocs-1",
    composioClient: {
      async executeAction<TData = unknown>(params: ExecuteActionParams): Promise<{ data: TData | null; logId: string | null }> {
        calls.push({
          toolSlug: params.toolSlug,
          arguments: params.arguments ?? {},
        });
        if (params.toolSlug === "GOOGLEDOCS_SEARCH_DOCUMENTS") {
          return {
            data: {
              documents: [
                {
                  documentId: "doc-1",
                  title: "Rollout Notes",
                  modifiedTime: "2026-05-24T08:00:00Z",
                },
              ],
            } as TData,
            logId: "log-docs-search",
          };
        }
        if (params.toolSlug === "GOOGLEDOCS_GET_DOCUMENT_BY_ID") {
          return {
            data: {
              documentId: "doc-1",
              title: "Rollout Notes",
              revisionId: "rev-1",
            } as TData,
            logId: "log-docs-by-id",
          };
        }
        if (params.toolSlug === "GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT") {
          return {
            data: {
              text: "Captured rollout tasks, launch risks, and owner notes.",
            } as TData,
            logId: "log-docs-plaintext",
          };
        }
        throw new Error(`unexpected tool slug: ${params.toolSlug}`);
      },
    },
  });

  assert.deepEqual(calls, [
    { toolSlug: "GOOGLEDOCS_SEARCH_DOCUMENTS", arguments: { query: "" } },
    { toolSlug: "GOOGLEDOCS_GET_DOCUMENT_BY_ID", arguments: { documentId: "doc-1" } },
    { toolSlug: "GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT", arguments: { documentId: "doc-1" } },
  ]);
  assert.equal(result.supported, true);
  assert.equal(result.provider_id, "googledocs");
  assert.equal(result.leaves_created, 3);
  assert.equal(result.messages_seen, 2);
  assert.equal(result.messages_persisted, 2);
  assert.ok(result.tree_id);

  const leaves = store.listIntegrationLeaves({
    treeId: result.tree_id!,
    status: "active",
    limit: 100,
    offset: 0,
  });
  assert.deepEqual(
    leaves.map((leaf) => ({ subjectKey: leaf.subjectKey, branchKey: leaf.branchKey, sourceType: leaf.sourceType }))
      .sort((left, right) => left.subjectKey.localeCompare(right.subjectKey)),
    [
      { subjectKey: "document_content:doc-1", branchKey: "content", sourceType: "googledocs.content" },
      { subjectKey: "document:doc-1", branchKey: "documents", sourceType: "googledocs.document" },
      { subjectKey: "profile", branchKey: "profile", sourceType: "googledocs.profile" },
    ],
  );

  const semanticNodes = store.listSemanticMemoryNodes({
    category: "integration",
    treeId: result.tree_id!,
    limit: 100,
    offset: 0,
  });
  assert.ok(semanticNodes.some((node) => node.nodeKind === "documents"));
  assert.ok(semanticNodes.some((node) => node.nodeKind === "content"));

  store.close();
});

test("fetchIntegrationContextForConnection ingests HubSpot contacts, companies, and deals into the global integration tree", async () => {
  const root = makeTempDir("hb-integration-context-hubspot-");
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
    connectionId: "conn-hubspot-1",
    providerId: "hubspot",
    ownerUserId: "user-1",
    accountLabel: "HubSpot (Managed)",
    accountExternalId: "ca_hubspot_1",
    accountHandle: null,
    accountEmail: null,
    authMode: "composio",
    grantedScopes: [],
    status: "active",
    secretRef: null,
  });

  const calls: Array<{ toolSlug: string; arguments: Record<string, unknown> }> = [];
  const result = await fetchIntegrationContextForConnection({
    store,
    connectionId: "conn-hubspot-1",
    composioClient: {
      async executeAction<TData = unknown>(params: ExecuteActionParams): Promise<{ data: TData | null; logId: string | null }> {
        calls.push({
          toolSlug: params.toolSlug,
          arguments: params.arguments ?? {},
        });
        if (params.toolSlug === "HUBSPOT_LIST_CONTACTS") {
          return {
            data: {
              results: [
                {
                  id: "contact-1",
                  updatedAt: "2026-05-24T08:00:00Z",
                  properties: {
                    firstname: "Ada",
                    lastname: "Lovelace",
                    email: "ada@example.com",
                    company: "HolaBoss",
                  },
                },
              ],
            } as TData,
            logId: "log-hubspot-contacts",
          };
        }
        if (params.toolSlug === "HUBSPOT_LIST_COMPANIES") {
          return {
            data: {
              results: [
                {
                  id: "company-1",
                  updatedAt: "2026-05-24T08:05:00Z",
                  properties: {
                    name: "HolaBoss",
                    domain: "holaboss.ai",
                    industry: "Software",
                  },
                },
              ],
            } as TData,
            logId: "log-hubspot-companies",
          };
        }
        if (params.toolSlug === "HUBSPOT_LIST_DEALS") {
          return {
            data: {
              results: [
                {
                  id: "deal-1",
                  updatedAt: "2026-05-24T08:10:00Z",
                  properties: {
                    dealname: "Expansion",
                    dealstage: "contractsent",
                    amount: "12000",
                  },
                },
              ],
            } as TData,
            logId: "log-hubspot-deals",
          };
        }
        throw new Error(`unexpected tool slug: ${params.toolSlug}`);
      },
    },
  });

  assert.deepEqual(calls, [
    { toolSlug: "HUBSPOT_LIST_CONTACTS", arguments: { limit: 15 } },
    { toolSlug: "HUBSPOT_LIST_COMPANIES", arguments: { limit: 15 } },
    { toolSlug: "HUBSPOT_LIST_DEALS", arguments: { limit: 15 } },
  ]);
  assert.equal(result.supported, true);
  assert.equal(result.provider_id, "hubspot");
  assert.equal(result.leaves_created, 4);
  assert.equal(result.messages_seen, 3);
  assert.equal(result.messages_persisted, 3);
  assert.ok(result.tree_id);

  const leaves = store.listIntegrationLeaves({
    treeId: result.tree_id!,
    status: "active",
    limit: 100,
    offset: 0,
  });
  assert.deepEqual(
    leaves.map((leaf) => ({ subjectKey: leaf.subjectKey, branchKey: leaf.branchKey, sourceType: leaf.sourceType }))
      .sort((left, right) => left.subjectKey.localeCompare(right.subjectKey)),
    [
      { subjectKey: "company:company-1", branchKey: "companies", sourceType: "hubspot.company" },
      { subjectKey: "contact:contact-1", branchKey: "contacts", sourceType: "hubspot.contact" },
      { subjectKey: "deal:deal-1", branchKey: "deals", sourceType: "hubspot.deal" },
      { subjectKey: "profile", branchKey: "profile", sourceType: "hubspot.profile" },
    ],
  );

  const semanticNodes = store.listSemanticMemoryNodes({
    category: "integration",
    treeId: result.tree_id!,
    limit: 100,
    offset: 0,
  });
  assert.ok(semanticNodes.some((node) => node.nodeKind === "contacts"));
  assert.ok(semanticNodes.some((node) => node.nodeKind === "companies"));
  assert.ok(semanticNodes.some((node) => node.nodeKind === "deals"));

  store.close();
});

test("fetchIntegrationContextForConnection ingests Linear profile, issues, projects, and teams into the global integration tree", async () => {
  const root = makeTempDir("hb-integration-context-linear-");
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

  const calls: Array<{ toolSlug: string; arguments: Record<string, unknown> }> = [];
  const result = await fetchIntegrationContextForConnection({
    store,
    connectionId: "conn-linear-1",
    composioClient: {
      async executeAction<TData = unknown>(params: ExecuteActionParams): Promise<{ data: TData | null; logId: string | null }> {
        calls.push({
          toolSlug: params.toolSlug,
          arguments: params.arguments ?? {},
        });
        if (params.toolSlug === "LINEAR_GET_CURRENT_USER") {
          return {
            data: {
              id: "user-1",
              displayName: "Ada Lovelace",
              email: "ada@linear.example",
            } as TData,
            logId: "log-linear-profile",
          };
        }
        if (params.toolSlug === "LINEAR_LIST_LINEAR_ISSUES") {
          return {
            data: {
              issues: [
                {
                  id: "issue-1",
                  identifier: "MEM-12",
                  title: "Ship memory retrieval v2",
                  description: "Finalize retrieval pack and context fetch improvements.",
                  team: { name: "Platform" },
                },
              ],
            } as TData,
            logId: "log-linear-issues",
          };
        }
        if (params.toolSlug === "LINEAR_LIST_LINEAR_PROJECTS") {
          return {
            data: {
              projects: [
                {
                  id: "project-1",
                  name: "Memory Runtime",
                  description: "Improve memory retrieval and verification.",
                },
              ],
            } as TData,
            logId: "log-linear-projects",
          };
        }
        if (params.toolSlug === "LINEAR_LIST_LINEAR_TEAMS") {
          return {
            data: {
              teams: [
                {
                  id: "team-1",
                  key: "PLAT",
                  name: "Platform",
                  description: "Platform workstream.",
                },
              ],
            } as TData,
            logId: "log-linear-teams",
          };
        }
        throw new Error(`unexpected tool slug: ${params.toolSlug}`);
      },
    },
  });

  assert.deepEqual(calls, [
    { toolSlug: "LINEAR_GET_CURRENT_USER", arguments: {} },
    { toolSlug: "LINEAR_LIST_LINEAR_ISSUES", arguments: { limit: 20 } },
    { toolSlug: "LINEAR_LIST_LINEAR_PROJECTS", arguments: { limit: 10 } },
    { toolSlug: "LINEAR_LIST_LINEAR_TEAMS", arguments: { limit: 10 } },
  ]);
  assert.equal(result.supported, true);
  assert.equal(result.provider_id, "linear");
  assert.equal(result.account_key, "ada@linear.example");
  assert.equal(result.account_label, "Ada Lovelace");
  assert.equal(result.leaves_created, 4);
  assert.equal(result.messages_seen, 3);
  assert.equal(result.messages_persisted, 3);
  assert.ok(result.tree_id);

  const leaves = store.listIntegrationLeaves({
    treeId: result.tree_id!,
    status: "active",
    limit: 100,
    offset: 0,
  });
  assert.deepEqual(
    leaves.map((leaf) => ({ subjectKey: leaf.subjectKey, branchKey: leaf.branchKey, sourceType: leaf.sourceType }))
      .sort((left, right) => left.subjectKey.localeCompare(right.subjectKey)),
    [
      { subjectKey: "issue:issue-1", branchKey: "issues", sourceType: "linear.issue" },
      { subjectKey: "profile", branchKey: "profile", sourceType: "linear.profile" },
      { subjectKey: "project:project-1", branchKey: "projects", sourceType: "linear.project" },
      { subjectKey: "team:team-1", branchKey: "teams", sourceType: "linear.team" },
    ],
  );

  const semanticNodes = store.listSemanticMemoryNodes({
    category: "integration",
    treeId: result.tree_id!,
    limit: 100,
    offset: 0,
  });
  assert.ok(semanticNodes.some((node) => node.nodeKind === "issues"));
  assert.ok(semanticNodes.some((node) => node.nodeKind === "projects"));
  assert.ok(semanticNodes.some((node) => node.nodeKind === "teams"));

  store.close();
});

test("fetchIntegrationContextForConnection ingests Jira profile, projects, and issues into the global integration tree", async () => {
  const root = makeTempDir("hb-integration-context-jira-");
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
    connectionId: "conn-jira-1",
    providerId: "jira",
    ownerUserId: "user-1",
    accountLabel: "Jira (Managed)",
    accountExternalId: "ca_jira_1",
    accountHandle: null,
    accountEmail: null,
    authMode: "composio",
    grantedScopes: [],
    status: "active",
    secretRef: null,
  });

  const calls: Array<{ toolSlug: string; arguments: Record<string, unknown> }> = [];
  const result = await fetchIntegrationContextForConnection({
    store,
    connectionId: "conn-jira-1",
    composioClient: {
      async executeAction<TData = unknown>(params: ExecuteActionParams): Promise<{ data: TData | null; logId: string | null }> {
        calls.push({
          toolSlug: params.toolSlug,
          arguments: params.arguments ?? {},
        });
        if (params.toolSlug === "JIRA_GET_CURRENT_USER") {
          return {
            data: {
              accountId: "jira-user-1",
              displayName: "Ada Lovelace",
              emailAddress: "ada@jira.example",
            } as TData,
            logId: "log-jira-profile",
          };
        }
        if (params.toolSlug === "JIRA_GET_ALL_PROJECTS") {
          return {
            data: {
              values: [
                {
                  id: "project-1",
                  key: "MEM",
                  name: "Memory Runtime",
                  projectTypeKey: "software",
                },
              ],
            } as TData,
            logId: "log-jira-projects",
          };
        }
        if (params.toolSlug === "JIRA_SEARCH_FOR_ISSUES_USING_JQL_GET") {
          return {
            data: {
              issues: [
                {
                  id: "issue-1",
                  key: "MEM-42",
                  fields: {
                    summary: "Fix retrieval regression",
                    description: "Investigate browser-first routing and memory ordering.",
                    status: { name: "In Progress" },
                  },
                },
              ],
            } as TData,
            logId: "log-jira-issues",
          };
        }
        throw new Error(`unexpected tool slug: ${params.toolSlug}`);
      },
    },
  });

  assert.deepEqual(calls, [
    { toolSlug: "JIRA_GET_CURRENT_USER", arguments: {} },
    { toolSlug: "JIRA_GET_ALL_PROJECTS", arguments: { maxResults: 12 } },
    { toolSlug: "JIRA_SEARCH_FOR_ISSUES_USING_JQL_GET", arguments: { jql: "ORDER BY updated DESC", maxResults: 20 } },
  ]);
  assert.equal(result.supported, true);
  assert.equal(result.provider_id, "jira");
  assert.equal(result.account_key, "ada@jira.example");
  assert.equal(result.account_label, "Ada Lovelace");
  assert.equal(result.leaves_created, 3);
  assert.equal(result.messages_seen, 2);
  assert.equal(result.messages_persisted, 2);
  assert.ok(result.tree_id);

  const leaves = store.listIntegrationLeaves({
    treeId: result.tree_id!,
    status: "active",
    limit: 100,
    offset: 0,
  });
  assert.deepEqual(
    leaves.map((leaf) => ({ subjectKey: leaf.subjectKey, branchKey: leaf.branchKey, sourceType: leaf.sourceType }))
      .sort((left, right) => left.subjectKey.localeCompare(right.subjectKey)),
    [
      { subjectKey: "issue:issue-1", branchKey: "issues", sourceType: "jira.issue" },
      { subjectKey: "profile", branchKey: "profile", sourceType: "jira.profile" },
      { subjectKey: "project:project-1", branchKey: "projects", sourceType: "jira.project" },
    ],
  );

  const semanticNodes = store.listSemanticMemoryNodes({
    category: "integration",
    treeId: result.tree_id!,
    limit: 100,
    offset: 0,
  });
  assert.ok(semanticNodes.some((node) => node.nodeKind === "projects"));
  assert.ok(semanticNodes.some((node) => node.nodeKind === "issues"));

  store.close();
});

test("fetchIntegrationContextForConnection reports unsupported providers without writing tree state", async () => {
  const root = makeTempDir("hb-integration-context-unsupported-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace-root"),
  });
  store.upsertIntegrationConnection({
    connectionId: "conn-unsupported-1",
    providerId: "salesforce",
    ownerUserId: "user-1",
    accountLabel: "Salesforce (Managed)",
    accountExternalId: "ca_salesforce_1",
    accountHandle: null,
    accountEmail: null,
    authMode: "composio",
    grantedScopes: [],
    status: "active",
    secretRef: null,
  });

  const result = await fetchIntegrationContextForConnection({
    store,
    connectionId: "conn-unsupported-1",
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
