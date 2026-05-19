import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainSourcePath = path.join(__dirname, "main.ts");

test("desktop browser exposes operator surface context for user and agent spaces", async () => {
  const source = await readFile(mainSourcePath, "utf8");

  assert.match(source, /const reportedOperatorSurfaceContexts = new Map</);
  assert.match(source, /"workspace:setOperatorSurfaceContext"/);
  assert.match(source, /normalizeReportedOperatorSurfaceContext\(context\)/);
  assert.match(source, /pathname === "\/api\/v1\/browser\/operator-surface-context"/);
  assert.match(source, /await ensureBrowserWorkspace\(targetWorkspaceId, "user"\);/);
  assert.match(source, /await ensureBrowserWorkspace\(targetWorkspaceId, "agent"\);/);
  assert.match(source, /writeBrowserServiceJson\(response, 200, operatorSurfaceContextPayload\(targetWorkspaceId\)\);/);
  assert.match(source, /surfaces: \[\.\.\.reportedSurfaces, \.\.\.browserSurfaces\]/);
  assert.match(source, /active_surface_id: activeSurfaceId,/);
  assert.match(source, /surface_id: `browser:\$\{space\}`/);
  assert.match(source, /surface_type: "browser"/);
  assert.match(source, /owner: space === "user" \? "user" : "agent"/);
  assert.match(source, /mutability: space === "agent" \? "agent_owned" : "takeover_allowed"/);
  assert.match(source, /Exclusive control is currently held by agent session/);
  assert.match(source, /It shares the workspace browser session and auth state with the other browser surface\./);
});
