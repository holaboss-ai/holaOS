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
  assert.match(source, /timezone: string \| null/);
  assert.match(source, /applyAuthFallback\(/);
  assert.match(source, /export function createLocalRuntimeUserProfileStore\(/);
  assert.match(source, /controlPlaneDatabasePath: \(\) => string/);
  assert.match(source, /SELECT \* FROM runtime_user_profiles WHERE profile_id = \? LIMIT 1/);
  assert.match(source, /CREATE TABLE IF NOT EXISTS runtime_user_profiles \([\s\S]*timezone TEXT,/);
  assert.match(source, /CREATE TABLE IF NOT EXISTS integration_connections/);
  assert.match(source, /CREATE TABLE IF NOT EXISTS integration_bindings/);
  assert.match(source, /CREATE TABLE IF NOT EXISTS oauth_app_configs/);
  assert.match(source, /CREATE TABLE IF NOT EXISTS app_catalog/);
  assert.match(source, /export interface LocalIntegrationMetadataStore \{/);
  assert.match(source, /export function createLocalIntegrationMetadataStore\(/);
  assert.match(source, /export interface LocalAppCatalogStore \{/);
  assert.match(source, /export function createLocalAppCatalogStore\(/);
  assert.match(source, /DELETE FROM integration_bindings WHERE binding_id = \?/);
  assert.match(source, /DELETE FROM app_catalog WHERE source = \?/);
});

test("electron main delegates control-plane-owned metadata through the local state module", async () => {
  const source = await readFile(MAIN_PATH, "utf8");

  assert.match(
    source,
    /import \{\s*bootstrapLocalControlPlaneDatabase,\s*createLocalAppCatalogStore,\s*createLocalIntegrationMetadataStore,\s*createLocalRuntimeUserProfileStore,\s*createLocalWorkspaceRegistry,\s*\} from "\.\/control-plane-owned-state\.js"/,
  );
  assert.match(
    source,
    /const localRuntimeUserProfileStore = createLocalRuntimeUserProfileStore\(\{\s*controlPlaneDatabasePath: controlPlaneDatabasePath,\s*\}\);/,
  );
  assert.match(
    source,
    /const localIntegrationMetadataStore = createLocalIntegrationMetadataStore\(\{\s*controlPlaneDatabasePath: controlPlaneDatabasePath,\s*\}\);/,
  );
  assert.match(
    source,
    /const localAppCatalogStore = createLocalAppCatalogStore\(\{\s*controlPlaneDatabasePath: controlPlaneDatabasePath,\s*\}\);/,
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
  assert.match(source, /return localRuntimeUserProfileStore\.applyAuthFallback\(name, profileId, timezone\);/);
  assert.match(source, /return localWorkspaceRegistry\.getWorkspaceRecord\(workspaceId\);/);
  assert.match(source, /return localWorkspaceRegistry\.listCachedWorkspaces\(\);/);
  assert.match(source, /return localIntegrationMetadataStore\.listConnections\(params\);/);
  assert.match(source, /return localIntegrationMetadataStore\.createConnection\(payload\);/);
  assert.match(source, /return localIntegrationMetadataStore\.updateConnection\(connectionId, payload\);/);
  assert.match(source, /return localIntegrationMetadataStore\.deleteConnection\(connectionId\);/);
  assert.match(
    source,
    /return localIntegrationMetadataStore\.mergeConnections\(\s*keepConnectionId,\s*removeConnectionIds,\s*\);/,
  );
  assert.match(source, /return localIntegrationMetadataStore\.listOAuthConfigs\(\);/);
  assert.match(source, /return localIntegrationMetadataStore\.upsertOAuthConfig\(providerId, payload\);/);
  assert.match(source, /return localIntegrationMetadataStore\.deleteOAuthConfig\(providerId\);/);
  assert.match(source, /return localAppCatalogStore\.listCatalog\(\{ source: params\.source \}\);/);
  assert.match(
    source,
    /return localAppCatalogStore\.syncCatalog\(\{\s*source: "marketplace",\s*target,\s*entries,\s*\}\);/,
  );
  assert.match(
    source,
    /return localAppCatalogStore\.syncCatalog\(\{\s*source: "local",\s*target,\s*entries,\s*\}\);/,
  );
});

test("electron main no longer reads control-plane-owned connection and catalog records through the singleton runtime client", async () => {
  const source = await readFile(MAIN_PATH, "utf8");

  assert.doesNotMatch(
    source,
    /runtimeClient\.integrations\.(listConnections|createConnection|updateConnection|deleteConnection|mergeConnections|listOAuthConfigs|upsertOAuthConfig|deleteOAuthConfig)\(/,
  );
  assert.doesNotMatch(
    source,
    /runtimeClient\.apps\.(listCatalog|syncCatalog)\(/,
  );
});
