import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const MAIN_PATH = new URL("./main.ts", import.meta.url);
const CONTROL_PLANE_PATH = new URL("./workspace-control-plane.ts", import.meta.url);
const PRELOAD_PATH = new URL("./preload.ts", import.meta.url);
const ELECTRON_D_TS_PATH = new URL("../src/types/electron.d.ts", import.meta.url);

test("workspace control plane source defines the local adapter and open-workspace seam", async () => {
  const source = await readFile(CONTROL_PLANE_PATH, "utf8");

  assert.match(source, /export type WorkspaceLocation = "local" \| "cloud"/);
  assert.match(source, /workspaceRoot: string/);
  assert.match(source, /export interface WorkspaceControlPlane</);
  assert.match(source, /export interface WorkspaceRegistry<WorkspaceListResponse> \{/);
  assert.match(source, /workspaceRegistry: WorkspaceRegistry<WorkspaceListResponse>/);
  assert.match(source, /export class LocalWorkspaceControlPlane</);
  assert.match(source, /async listWorkspaces\(\): Promise<WorkspaceListResponse> \{/);
  assert.match(source, /async listWorkspacesCached\(\): Promise<WorkspaceListResponse> \{/);
  assert.match(source, /async createWorkspace\(/);
  assert.match(source, /async deleteWorkspace\(/);
  assert.match(source, /async activateWorkspaceRecord\(/);
  assert.match(source, /async getWorkspaceLifecycle\(/);
  assert.match(source, /async activateWorkspace\(/);
  assert.match(source, /async openWorkspace\(/);
  assert.match(
    source,
    /return Promise\.resolve\(this\.#deps\.workspaceRegistry\.listCachedWorkspaces\(\)\)/,
  );
  assert.match(source, /return \(await this\.openWorkspace\(workspaceId\)\)\.lifecycle/);
  assert.match(source, /return this\.#deps\.openWorkspace\(workspaceId\)/);
  assert.match(source, /return new LocalWorkspaceControlPlane\(deps\)/);
});

test("workspace IPC handlers delegate through the local workspace control plane", async () => {
  const source = await readFile(MAIN_PATH, "utf8");

  assert.match(source, /const workspaceRuntimeSessionCache = new Map<\s*string,\s*WorkspaceRuntimeSessionPayload\s*>\(\)/);
  assert.match(source, /async function resolveWorkspaceRuntimeSession\(/);
  assert.match(source, /async function requestWorkspaceRuntimeJson<T>\(/);
  assert.match(
    source,
    /const localWorkspaceControlPlane = createLocalWorkspaceControlPlane\(\{\s*listWorkspaces,\s*workspaceRegistry: localWorkspaceRegistry,\s*createWorkspace,\s*deleteWorkspace,\s*activateWorkspaceRecord,\s*getWorkspaceLifecycle,\s*openWorkspace,\s*\}\)/,
  );
  assert.match(
    source,
    /async function openWorkspace\(\s*workspaceId: string,\s*\): Promise<WorkspaceOpenSessionPayload> \{[\s\S]*const session = await resolveWorkspaceRuntimeSession\(safeWorkspaceId, \{\s*refresh: true,\s*\}\);[\s\S]*await requestWorkspaceRuntimeJson<Record<string, unknown>>\(safeWorkspaceId, \{\s*method: "POST",\s*path: "\/api\/v1\/apps\/ensure-running"/,
  );
  assert.match(
    source,
    /"workspace:activate"[\s\S]*localWorkspaceControlPlane\.activateWorkspaceRecord\(workspaceId\)/,
  );
  assert.match(
    source,
    /"workspace:listWorkspaces"[\s\S]*localWorkspaceControlPlane\.listWorkspaces\(\)/,
  );
  assert.match(
    source,
    /"workspace:listWorkspacesCached"[\s\S]*localWorkspaceControlPlane\.listWorkspacesCached\(\)/,
  );
  assert.match(
    source,
    /"workspace:getWorkspaceLifecycle"[\s\S]*localWorkspaceControlPlane\.getWorkspaceLifecycle\(workspaceId\)/,
  );
  assert.match(
    source,
    /"workspace:activateWorkspace"[\s\S]*localWorkspaceControlPlane\.activateWorkspace\(workspaceId\)/,
  );
  assert.match(
    source,
    /"workspace:openWorkspace"[\s\S]*localWorkspaceControlPlane\.openWorkspace\(workspaceId\)/,
  );
  assert.match(
    source,
    /"workspace:getWorkspaceRoot"[\s\S]*resolveLocalWorkspaceRoot\(workspaceId\)/,
  );
  assert.match(
    source,
    /"workspace:createWorkspace"[\s\S]*localWorkspaceControlPlane\.createWorkspace\(payload\)/,
  );
  assert.match(
    source,
    /"workspace:deleteWorkspace"[\s\S]*localWorkspaceControlPlane\.deleteWorkspace\(workspaceId, keepFiles\)/,
  );
});

test("preload and shared Electron types expose the open-workspace session seam", async () => {
  const [preloadSource, electronTypesSource] = await Promise.all([
    readFile(PRELOAD_PATH, "utf8"),
    readFile(ELECTRON_D_TS_PATH, "utf8"),
  ]);

  assert.match(
    preloadSource,
    /openWorkspace: \(workspaceId: string\) =>\s*ipcRenderer\.invoke\("workspace:openWorkspace", workspaceId\) as Promise<WorkspaceOpenSessionPayload>/,
  );
  assert.match(
    electronTypesSource,
    /type WorkspaceLocationPayload = "local" \| "cloud";/,
  );
  assert.match(electronTypesSource, /interface WorkspaceRecordPayload \{\s*id: string;\s*location: WorkspaceLocationPayload;/s);
  assert.match(electronTypesSource, /interface WorkspaceRuntimeSessionPayload \{/);
  assert.match(electronTypesSource, /workspace_root: string;/);
  assert.match(
    electronTypesSource,
    /interface WorkspaceOpenSessionPayload extends WorkspaceRuntimeSessionPayload \{/,
  );
  assert.match(electronTypesSource, /workspace_id: string;/);
  assert.match(electronTypesSource, /runtime_base_url: string;/);
  assert.match(electronTypesSource, /runtime_auth_token: string \| null;/);
  assert.match(electronTypesSource, /lifecycle: WorkspaceLifecyclePayload;/);
  assert.match(
    electronTypesSource,
    /openWorkspace: \(workspaceId: string\) => Promise<WorkspaceOpenSessionPayload>;/,
  );
});
