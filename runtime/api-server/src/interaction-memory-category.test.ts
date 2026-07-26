import assert from "node:assert/strict";
import test from "node:test";

import type { RuntimeStateStore } from "@holaboss/runtime-state-store";

import { readableInteractionSemanticCategory } from "./interaction-memory.js";

test("readableInteractionSemanticCategory migrates legacy workspace interaction semantics on first read", () => {
  const calls: Array<{
    category: "interaction" | "workspace";
    workspaceId?: string | null;
    treeId: string;
  }> = [];
  let migrated = false;
  const store = {
    listSemanticMemoryNodes(params: {
      category: "interaction" | "workspace";
      workspaceId?: string | null;
      treeId: string;
      limit?: number;
      offset?: number;
    }) {
      calls.push({
        category: params.category,
        workspaceId: params.workspaceId ?? null,
        treeId: params.treeId,
      });
      if (params.category === "workspace" && migrated) {
        return [{ nodeId: "semantic:workspace:tree-1:node-1" }];
      }
      return [];
    },
    migrateSemanticMemoryTreeCategory(params: {
      workspaceId: string;
      treeId: string;
      fromCategory: "interaction" | "workspace";
      toCategory: "interaction" | "workspace";
    }) {
      assert.deepEqual(params, {
        workspaceId: "workspace-1",
        treeId: "tree-1",
        fromCategory: "interaction",
        toCategory: "workspace",
      });
      migrated = true;
      return true;
    },
  } as unknown as RuntimeStateStore;

  const cache = new Map<string, "interaction" | "workspace">();
  const category = readableInteractionSemanticCategory({
    store,
    workspaceId: "workspace-1",
    treeId: "tree-1",
    cache,
  });

  assert.equal(category, "workspace");
  assert.deepEqual(calls, [
    {
      category: "workspace",
      workspaceId: "workspace-1",
      treeId: "tree-1",
    },
  ]);
  assert.equal(cache.get("workspace-1:tree-1"), "workspace");
});

test("readableInteractionSemanticCategory keeps control-plane reads on interaction", () => {
  const store = {
    listSemanticMemoryNodes() {
      throw new Error("control-plane reads should not probe workspace semantics");
    },
    migrateSemanticMemoryTreeCategory() {
      throw new Error("control-plane reads should not migrate workspace semantics");
    },
  } as unknown as RuntimeStateStore;

  const category = readableInteractionSemanticCategory({
    store,
    workspaceId: null,
    treeId: "tree-1",
  });

  assert.equal(category, "interaction");
});
