import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { cleanupWorkspaceMemory, workspaceMemoryCounts } from "./memory-live-utils.mjs";

function runSql(dbPath, sql) {
  execFileSync("sqlite3", [dbPath, sql], {
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function tableCount(dbPath, tableName) {
  return Number(
    execFileSync("sqlite3", [dbPath, `SELECT COUNT(*) FROM ${tableName};`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim(),
  );
}

test("cleanupWorkspaceMemory clears semantic memory, outputs, and runtime continuity state", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hb-memory-cleanup-"));
  const workspaceDir = path.join(root, "sandbox-host", "workspace", "ws-1");
  const runtimeDb = path.join(workspaceDir, ".holaboss", "state", "runtime.db");
  const controlPlaneDb = path.join(root, "sandbox-host", "state", "control-plane.db");

  fs.mkdirSync(path.dirname(runtimeDb), { recursive: true });
  fs.mkdirSync(path.dirname(controlPlaneDb), { recursive: true });
  fs.mkdirSync(path.join(workspaceDir, ".holaboss", "memory", "interaction", "entities"), { recursive: true });
  fs.mkdirSync(path.join(workspaceDir, ".holaboss", "memory", "integration", "trees"), { recursive: true });
  fs.mkdirSync(path.join(workspaceDir, ".holaboss", "memory", "semantic", "workspace"), { recursive: true });
  fs.mkdirSync(path.join(workspaceDir, ".holaboss", "memory", "runtime", "session-memory"), { recursive: true });
  fs.mkdirSync(path.join(workspaceDir, ".holaboss", "memory", "evolve", "skills", "candidate-1"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(workspaceDir, ".holaboss", "pi-sessions"), { recursive: true });
  fs.mkdirSync(path.join(workspaceDir, ".holaboss", "state", "legacy-session-histories"), {
    recursive: true,
  });

  fs.writeFileSync(path.join(workspaceDir, "AGENTS.md"), "# Workspace Rules\n", "utf8");
  fs.writeFileSync(
    path.join(workspaceDir, ".holaboss", "memory", "runtime", "session-memory", "snapshot.md"),
    "resume snapshot",
    "utf8",
  );
  fs.writeFileSync(
    path.join(workspaceDir, ".holaboss", "memory", "evolve", "skills", "candidate-1", "SKILL.md"),
    "# Generated Skill\n",
    "utf8",
  );

  runSql(
    runtimeDb,
    `
      CREATE TABLE interaction_entities (status TEXT);
      INSERT INTO interaction_entities VALUES ('active');
      CREATE TABLE interaction_leaves (status TEXT);
      INSERT INTO interaction_leaves VALUES ('active');
      CREATE TABLE interaction_node_embeddings (entity_id TEXT);
      INSERT INTO interaction_node_embeddings VALUES ('entity-1');
      CREATE TABLE interaction_tree_edges (id TEXT);
      INSERT INTO interaction_tree_edges VALUES ('edge-1');
      CREATE TABLE semantic_memory_nodes (status TEXT, node_class TEXT, node_kind TEXT);
      INSERT INTO semantic_memory_nodes VALUES ('active', 'semantic', 'tree');
      CREATE TABLE semantic_memory_edges (id TEXT);
      INSERT INTO semantic_memory_edges VALUES ('edge-1');
      CREATE TABLE semantic_memory_relations (id TEXT);
      INSERT INTO semantic_memory_relations VALUES ('rel-1');
      CREATE TABLE semantic_memory_evidence_refs (id TEXT);
      INSERT INTO semantic_memory_evidence_refs VALUES ('ev-1');
      CREATE TABLE semantic_memory_search_docs (status TEXT);
      INSERT INTO semantic_memory_search_docs VALUES ('active');
      CREATE VIRTUAL TABLE semantic_memory_search_fts USING fts5(title);
      INSERT INTO semantic_memory_search_fts (title) VALUES ('builder mode');
      CREATE TABLE outputs (id TEXT);
      INSERT INTO outputs VALUES ('output-1');
      CREATE TABLE output_folders (id TEXT);
      INSERT INTO output_folders VALUES ('folder-1');
      CREATE TABLE agent_sessions (id TEXT);
      INSERT INTO agent_sessions VALUES ('session-1');
      CREATE TABLE session_messages (id TEXT);
      INSERT INTO session_messages VALUES ('message-1');
      CREATE TABLE turn_results (id TEXT);
      INSERT INTO turn_results VALUES ('turn-1');
      CREATE TABLE workspace_runtime_metadata (key TEXT);
      INSERT INTO workspace_runtime_metadata VALUES ('interaction_memory_batch_1');
      INSERT INTO workspace_runtime_metadata VALUES ('workspace_artifact_relation_backfill_v2_complete');
      INSERT INTO workspace_runtime_metadata VALUES ('workspace_output_artifact_tree_backfill_v1_complete');
    `,
  );

  runSql(
    controlPlaneDb,
    `
      CREATE TABLE integration_trees (status TEXT);
      INSERT INTO integration_trees VALUES ('active');
      CREATE TABLE integration_leaves (status TEXT);
      INSERT INTO integration_leaves VALUES ('active');
      CREATE TABLE integration_summary_nodes (status TEXT);
      INSERT INTO integration_summary_nodes VALUES ('active');
      CREATE TABLE integration_node_embeddings (id TEXT);
      INSERT INTO integration_node_embeddings VALUES ('embed-1');
      CREATE TABLE integration_node_relations (id TEXT);
      INSERT INTO integration_node_relations VALUES ('rel-1');
      CREATE TABLE integration_tree_edges (id TEXT);
      INSERT INTO integration_tree_edges VALUES ('edge-1');
    `,
  );

  const before = workspaceMemoryCounts(runtimeDb, controlPlaneDb);
  assert.equal(before.active_entities, 1);
  assert.equal(before.active_leaves, 1);
  assert.equal(before.active_semantic_nodes, 1);
  assert.equal(before.active_semantic_trees, 1);
  assert.equal(before.outputs, 1);
  assert.equal(before.turn_results, 1);
  assert.equal(before.active_integration_trees, 1);

  const cleanup = cleanupWorkspaceMemory({
    workspaceDir,
    includeSessionHistory: true,
  });

  assert.equal(cleanup.sessionHistoryCleared, true);
  assert.equal(cleanup.agentsReset, false);

  const after = workspaceMemoryCounts(runtimeDb, controlPlaneDb);
  assert.equal(after.active_entities, 0);
  assert.equal(after.active_leaves, 0);
  assert.equal(after.active_semantic_nodes, 0);
  assert.equal(after.active_semantic_trees, 0);
  assert.equal(after.active_semantic_relations, 0);
  assert.equal(after.active_semantic_evidence_refs, 0);
  assert.equal(after.active_semantic_search_docs, 0);
  assert.equal(after.outputs, 0);
  assert.equal(after.turn_results, 0);
  assert.equal(after.active_integration_trees, 0);
  assert.equal(after.active_integration_leaves, 0);
  assert.equal(after.active_integration_summaries, 0);

  assert.equal(tableCount(runtimeDb, "outputs"), 0);
  assert.equal(tableCount(runtimeDb, "turn_results"), 0);
  assert.equal(tableCount(runtimeDb, "semantic_memory_nodes"), 0);
  assert.equal(tableCount(runtimeDb, "semantic_memory_relations"), 0);
  assert.equal(tableCount(runtimeDb, "semantic_memory_evidence_refs"), 0);
  assert.equal(tableCount(runtimeDb, "semantic_memory_search_docs"), 0);
  assert.equal(tableCount(runtimeDb, "workspace_runtime_metadata"), 0);
  assert.equal(tableCount(controlPlaneDb, "integration_trees"), 0);
  assert.equal(tableCount(controlPlaneDb, "integration_leaves"), 0);

  assert.equal(fs.existsSync(path.join(workspaceDir, ".holaboss", "memory", "runtime")), false);
  assert.equal(fs.existsSync(path.join(workspaceDir, ".holaboss", "memory", "evolve")), false);
  assert.equal(fs.existsSync(path.join(workspaceDir, ".holaboss", "memory", "interaction", "entities")), true);
  assert.equal(fs.existsSync(path.join(workspaceDir, ".holaboss", "memory", "integration", "trees")), true);
  assert.equal(fs.existsSync(path.join(workspaceDir, ".holaboss", "memory", "semantic", "workspace")), true);
  assert.equal(fs.existsSync(path.join(workspaceDir, ".holaboss", "memory", "semantic", "interaction")), true);
  assert.equal(fs.existsSync(path.join(workspaceDir, ".holaboss", "pi-sessions")), true);
  assert.equal(fs.existsSync(path.join(workspaceDir, ".holaboss", "state", "legacy-session-histories")), true);
  assert.equal(fs.readFileSync(path.join(workspaceDir, "AGENTS.md"), "utf8"), "# Workspace Rules\n");
});
