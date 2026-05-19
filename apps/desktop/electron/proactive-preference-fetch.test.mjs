import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const MAIN_PATH = new URL("./main.ts", import.meta.url);

test("control plane json helper does not read an error response body twice", async () => {
  const source = await readFile(MAIN_PATH, "utf8");

  assert.match(source, /let errorDetail = "";/);
  assert.match(source, /errorDetail = await readControlPlaneError\(response\);/);
  assert.match(source, /throw new Error\(errorDetail \|\| \(await readControlPlaneError\(response\)\)\);/);
});

test("deprecated proactive workspace IPC surface is removed from the main process", async () => {
  const source = await readFile(MAIN_PATH, "utf8");

  assert.doesNotMatch(source, /async function requestRemoteTaskProposalGeneration\(/);
  assert.doesNotMatch(source, /async function getProactiveTaskProposalPreference\(/);
  assert.doesNotMatch(source, /async function getProactiveHeartbeatConfig\(/);
  assert.doesNotMatch(source, /async function setProactiveHeartbeatConfig\(/);
  assert.doesNotMatch(source, /async function setProactiveHeartbeatWorkspaceEnabled\(/);
  assert.doesNotMatch(source, /"workspace:getProactiveStatus"/);
  assert.doesNotMatch(source, /"workspace:requestRemoteTaskProposalGeneration"/);
  assert.doesNotMatch(source, /"workspace:getProactiveTaskProposalPreference"/);
  assert.doesNotMatch(source, /"workspace:getProactiveHeartbeatConfig"/);
});

test("workspace-ready proactive heartbeat ingest remains available for internal emits", async () => {
  const source = await readFile(MAIN_PATH, "utf8");

  assert.match(source, /async function ingestWorkspaceHeartbeat\(/);
  assert.match(source, /path: "\/api\/v1\/proactive\/context\/capture"/);
  assert.match(source, /path: "\/api\/v1\/proactive\/ingest"/);
  assert.match(source, /captured_context: bundledContext\.context/);
  assert.match(source, /sourceRef: "workspace-created:ready"/);
  assert.match(source, /workspace_id=\$\{workspaceId\} source=\$\{params\.sourceRef\}/);
});
