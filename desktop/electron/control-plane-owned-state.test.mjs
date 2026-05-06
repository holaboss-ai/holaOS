import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const MAIN_PATH = new URL("./main.ts", import.meta.url);
const CONTROL_PLANE_STATE_PATH = new URL(
  "./control-plane-owned-state.ts",
  import.meta.url,
);

test("control-plane-owned state module owns local workspace registry and runtime profile metadata", async () => {
  const source = await readFile(CONTROL_PLANE_STATE_PATH, "utf8");

  assert.match(source, /export interface LocalWorkspaceRegistry \{/);
  assert.match(source, /getWorkspaceRecord\(workspaceId: string\): WorkspaceRegistryRecord \| null/);
  assert.match(source, /listCachedWorkspaces\(\): WorkspaceRegistryListResponse/);
  assert.match(source, /export function bootstrapLocalControlPlaneDatabase\(/);
  assert.match(source, /export function createLocalWorkspaceRegistry\(/);
  assert.match(source, /new Database\(options\.controlPlaneDatabasePath\(\), \{\s*readonly: true,\s*\}\)/);
  assert.match(source, /SELECT[\s\S]*FROM workspaces/);
  assert.match(source, /export interface LocalRuntimeUserProfileStore \{/);
  assert.match(source, /getProfile\(\): Promise<RuntimeUserProfileRecord>/);
  assert.match(source, /setProfile\(payload: RuntimeUserProfileUpdate\): Promise<RuntimeUserProfileRecord>/);
  assert.match(source, /applyAuthFallback\(/);
  assert.match(source, /export function createLocalRuntimeUserProfileStore\(/);
  assert.match(source, /controlPlaneDatabasePath: \(\) => string/);
  assert.match(source, /SELECT \* FROM runtime_user_profiles WHERE profile_id = \? LIMIT 1/);
});

test("electron main delegates control-plane-owned metadata through the local state module", async () => {
  const source = await readFile(MAIN_PATH, "utf8");

  assert.match(
    source,
    /import \{\s*bootstrapLocalControlPlaneDatabase,\s*createLocalRuntimeUserProfileStore,\s*createLocalWorkspaceRegistry,\s*\} from "\.\/control-plane-owned-state\.js"/,
  );
  assert.match(
    source,
    /const localRuntimeUserProfileStore = createLocalRuntimeUserProfileStore\(\{\s*controlPlaneDatabasePath: controlPlaneDatabasePath,\s*\}\);/,
  );
  assert.match(
    source,
    /const localWorkspaceRegistry = createLocalWorkspaceRegistry\(\{\s*controlPlaneDatabasePath: controlPlaneDatabasePath,\s*location: localWorkspaceLocation\(\),\s*\}\);/,
  );
  assert.match(source, /function bootstrapControlPlaneDatabase\(\) \{/);
  assert.match(source, /bootstrapLocalControlPlaneDatabase\(\{/);
  assert.match(source, /HOLABOSS_CONTROL_PLANE_DB_PATH: controlPlaneDatabasePath\(\),/);
  assert.match(source, /return localRuntimeUserProfileStore\.getProfile\(\);/);
  assert.match(source, /return localRuntimeUserProfileStore\.setProfile\(payload\);/);
  assert.match(source, /return localRuntimeUserProfileStore\.applyAuthFallback\(name, profileId\);/);
  assert.match(source, /return localWorkspaceRegistry\.getWorkspaceRecord\(workspaceId\);/);
  assert.match(source, /return localWorkspaceRegistry\.listCachedWorkspaces\(\);/);
});
