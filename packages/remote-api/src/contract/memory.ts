import { oc } from "@orpc/contract";
import { z } from "zod";
import { workspaceScoped } from "./shared";

// The memory agent surface is workspace-scoped. Inputs carry camelCase fields
// uniformly with the rest of the contract surface; the runtime adapter maps
// them onto FilesystemMemoryService's snake_case payload. Outputs stay loose
// (FilesystemMemoryService returns Record<string, unknown>); tightening into
// fully-typed results is deferred.
const memoryResult = z.record(z.string(), z.unknown());

const searchInput = workspaceScoped
  .extend({
    query: z.string(),
    maxResults: z.number().int().min(1).optional(),
    minScore: z.number().optional(),
  })
  .catchall(z.unknown());

const getInput = workspaceScoped
  .extend({ path: z.string().min(1).optional() })
  .catchall(z.unknown());

const upsertInput = workspaceScoped
  .extend({
    path: z.string().min(1),
    content: z.string().optional(),
    append: z.boolean().optional(),
  })
  .catchall(z.unknown());

const statusInput = workspaceScoped.catchall(z.unknown());

const syncInput = workspaceScoped.catchall(z.unknown());

// Memory Browser (UI) read surface. Outputs stay loose (the rich tree/graph
// shapes are validated by the runtime; the desktop casts to its payload types).
const browseTreeInput = workspaceScoped;

const readFileInput = workspaceScoped.extend({
  path: z.string().min(1),
});

const readNodeDetailInput = workspaceScoped.extend({
  nodeId: z.string().min(1),
  treeId: z.string().nullish(),
});

const browseGraphInput = workspaceScoped.extend({
  forest: z.literal("workspace"),
  treeId: z.string().nullish(),
  maxLayers: z.number().int().nullish(),
  maxNodes: z.number().int().nullish(),
});

export const memoryContract = {
  search: oc.input(searchInput).output(memoryResult),
  get: oc.input(getInput).output(memoryResult),
  upsert: oc.input(upsertInput).output(memoryResult),
  status: oc.input(statusInput).output(memoryResult),
  sync: oc.input(syncInput).output(memoryResult),
  browseTree: oc.input(browseTreeInput).output(memoryResult),
  readFile: oc.input(readFileInput).output(memoryResult),
  readNodeDetail: oc.input(readNodeDetailInput).output(memoryResult),
  browseGraph: oc.input(browseGraphInput).output(memoryResult),
};
