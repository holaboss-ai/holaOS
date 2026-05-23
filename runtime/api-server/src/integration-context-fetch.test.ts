import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { RuntimeStateStore } from "@holaboss/runtime-state-store";

import {
  ComposioApiClientError,
  type ExecuteActionParams,
} from "./composio-api-client.js";
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
  assert.equal(result.summary_nodes, 6);

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

  const summaries = store.listIntegrationSummaryNodes({
    treeId: trees[0]!.treeId,
    status: "active",
    limit: 100,
    offset: 0,
  });
  assert.equal(summaries.length, 6);

  const memoryRoot = globalMemoryDirForWorkspaceRoot(workspaceRoot);
  for (const leaf of leaves) {
    assert.ok(fs.existsSync(path.join(memoryRoot, leaf.path)));
  }
  for (const summary of summaries) {
    assert.ok(fs.existsSync(path.join(memoryRoot, summary.path)));
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
  assert.equal(result.summary_nodes, 8);

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
  assert.equal(result.summary_nodes, 7);
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
  const second = await fetchIntegrationContextForConnection({
    store,
    connectionId: "conn-github-1",
    composioClient,
  });

  assert.equal(first.leaves_created, 6);
  assert.equal(first.leaves_unchanged, 0);
  assert.equal(second.leaves_created, 0);
  assert.equal(second.leaves_superseding, 0);
  assert.equal(second.leaves_unchanged, 6);

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
  assert.ok(result.summary_nodes > 0);

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
  assert.equal(result.summary_nodes, 8);

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
  for (const leaf of leaves) {
    assert.ok(fs.existsSync(path.join(memoryRoot, leaf.path)));
  }

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
    connectionId: "conn-linear-1",
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
