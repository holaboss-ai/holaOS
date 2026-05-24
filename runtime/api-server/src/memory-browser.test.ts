import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import type {
  IntegrationConnectionRecord,
  IntegrationTreeRecord,
  RuntimeStateStore,
  SemanticMemoryNodeRecord,
} from "@holaboss/runtime-state-store";

import {
  buildMemoryBrowserGraph,
  buildMemoryBrowserTree,
  readMemoryBrowserFile,
} from "./memory-browser.js";
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

test("memory browser exposes semantic integration trees under integration/trees and matches any stable connection identity", () => {
  const root = makeTempDir("hb-memory-browser-integration-");
  const workspaceRoot = path.join(root, "workspace");
  const workspace = {
    id: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
    errorMessage: null,
    onboardingStatus: "idle",
    onboardingState: null,
    onboardingSessionId: null,
    onboardingAlignmentQuestion: null,
    onboardingAlignmentReport: null,
    onboardingVerificationReport: null,
    onboardingCompletedAt: null,
    onboardingCompletionSummary: null,
    onboardingRequestedAt: null,
    onboardingRequestedBy: null,
    createdAt: "2026-05-24T00:00:00.000Z",
    updatedAt: "2026-05-24T00:00:00.000Z",
    deletedAtUtc: null,
    icon: null,
    iconColor: null,
    workspaceRole: "owner",
    sourceWorkspaceId: null,
  };
  const connection: IntegrationConnectionRecord = {
    connectionId: "gmail-1",
    providerId: "gmail",
    ownerUserId: "user-1",
    accountLabel: "Ops Gmail",
    accountHandle: "ops-handle",
    accountEmail: "ops@example.com",
    accountExternalId: "ca_gmail_1",
    contextCronAutoFetchEnabled: true,
    lastContextFetchAttemptedAt: null,
    lastContextFetchCompletedAt: null,
    lastContextFetchStatus: null,
    authMode: "composio",
    grantedScopes: [],
    status: "active",
    secretRef: null,
    createdAt: "2026-05-24T00:00:00.000Z",
    updatedAt: "2026-05-24T00:00:00.000Z",
  };
  const treeRecord: IntegrationTreeRecord = {
    treeId: "integration:gmail:acct-1",
    provider: "gmail",
    ownerUserId: "user-1",
    accountKey: "ops@example.com",
    accountLabel: "Ops Gmail",
    slug: "gmail-ops-example-com-acct-1",
    summary: "Gmail account memory.",
    status: "active",
    createdAt: "2026-05-24T00:00:00.000Z",
    updatedAt: "2026-05-24T00:00:00.000Z",
  };
  const semanticNodes: SemanticMemoryNodeRecord[] = [
    {
      workspaceId: null,
      category: "integration",
      treeId: "integration:gmail:acct-1",
      nodeId: "semantic:integration:integration:gmail:acct-1:connection",
      nodeClass: "semantic",
      nodeKind: "connection",
      sourceLeafId: null,
      path: "semantic/integration/trees/gmail-ops-example-com-acct-1/content.md",
      title: "Ops Gmail",
      summary: "Gmail account memory.",
      bodySha256: "sha-root",
      childCount: 0,
      observedAt: "2026-05-24T00:00:00.000Z",
      status: "active",
      isMaterialized: false,
      metadata: {},
      createdAt: "2026-05-24T00:00:00.000Z",
      updatedAt: "2026-05-24T00:00:00.000Z",
    },
  ];
  const store = {
    workspaceRoot,
    workspaceDir(workspaceId: string) {
      return path.join(workspaceRoot, workspaceId);
    },
    getWorkspace(workspaceId: string) {
      return workspaceId === workspace.id ? workspace : null;
    },
    listInteractionEntities() {
      return [];
    },
    listSemanticMemoryNodes(params: {
      category: "interaction" | "integration";
      treeId?: string | null;
    }) {
      if (params.category === "integration" && params.treeId === treeRecord.treeId) {
        return semanticNodes;
      }
      return [];
    },
    listIntegrationConnections() {
      return [connection];
    },
    listWorkspaceIntegrationOverrides() {
      return [];
    },
    listIntegrationTrees(params: {
      provider?: string | null;
      ownerUserId?: string | null;
      status?: string | null;
    }) {
      return [treeRecord].filter((candidate) =>
        (params.provider == null || candidate.provider === params.provider)
        && (params.ownerUserId == null || candidate.ownerUserId === params.ownerUserId)
        && (params.status == null || candidate.status === params.status)
      );
    },
    listSemanticMemoryChildren() {
      return [];
    },
    listSemanticMemoryRelations() {
      return [];
    },
  } as unknown as RuntimeStateStore;

  try {
    const semanticFilePath = path.join(
      globalMemoryDirForWorkspaceRoot(workspaceRoot),
      "semantic",
      "integration",
      "trees",
      "gmail-ops-example-com-acct-1",
      "content.md",
    );
    fs.mkdirSync(path.dirname(semanticFilePath), { recursive: true });
    fs.writeFileSync(
      semanticFilePath,
      "# Ops Gmail\n\nGmail account memory.\n",
      "utf8",
    );

    const tree = buildMemoryBrowserTree({
      store,
      workspaceId: "workspace-1",
    });
    assert.deepEqual(
      (tree.root.children ?? []).map((child) => child.name),
      ["integration", "interaction"],
    );
    const integrationDirectory = (tree.root.children ?? []).find((child) => child.name === "integration");
    assert.ok(integrationDirectory && integrationDirectory.kind === "directory");
    const treesDirectory = (integrationDirectory.children ?? []).find((child) => child.name === "trees");
    assert.ok(treesDirectory && treesDirectory.kind === "directory");
    const gmailDirectory = (treesDirectory.children ?? []).find((child) => child.name === "gmail-ops-example-com-acct-1");
    assert.ok(gmailDirectory && gmailDirectory.kind === "directory");
    const contentFile = (gmailDirectory.children ?? []).find((child) => child.name === "content.md");
    assert.ok(contentFile && contentFile.kind === "file");
    assert.equal(contentFile.path, "integration/trees/gmail-ops-example-com-acct-1/content.md");

    const file = readMemoryBrowserFile({
      store,
      workspaceId: "workspace-1",
      targetPath: "integration/trees/gmail-ops-example-com-acct-1/content.md",
    });
    assert.match(file.content, /Gmail account memory\./);

    const graph = buildMemoryBrowserGraph({
      store,
      workspaceId: "workspace-1",
      forest: "integrations",
    });
    assert.ok(
      graph.nodes.some(
        (node) =>
          node.tree_id === "integration:gmail:acct-1"
          && node.kind === "tree"
          && node.path === "integration/trees/gmail-ops-example-com-acct-1/content.md",
      ),
    );
  } finally {
    // no-op
  }
});
