#!/usr/bin/env node

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  agentsMdPath,
  cleanupWorkspaceMemory,
  controlPlaneDbPath,
  discoverRuntimePort,
  fetchJson,
  matchingTerms,
  parseCommonArgs,
  readTextIfExists,
  runSqlRows,
  runtimeDbPath,
  sanitizeSessionId,
  workspaceMemoryCounts,
} from "./lib/memory-live-utils.mjs";

const DEFAULT_FIXTURE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "memory-eval-phase2.json",
);
const BATCH_CURSOR_KEY_PREFIX = "interaction_memory_batch_processed_count:";
const TURN_RESULT_TIMEOUT_MS = 120000;
const BATCH_CURSOR_TIMEOUT_MS = 90000;
const ENTITY_READY_TIMEOUT_MS = 90000;
const INTEGRATION_FETCH_TIMEOUT_MS = 120000;

function printUsage() {
  console.log(
    [
      "Usage: node scripts/memory-eval.mjs --workspace-id <workspace-id> [options]",
      "",
      "Options:",
      "  --workspace-dir <path>           Override workspace directory",
      "  --runtime-port <port>            Override live runtime port discovery",
      "  --fixture <path>                 Override the evaluation fixture JSON",
      "  --scenario <id>                  Run only one scenario from the fixture",
      "  --output <path>                  Write a JSON report to this file",
      "  --clean                          Reset memory, session history, and AGENTS.md before each scenario",
      "  --agents-baseline-file <path>    Reset AGENTS.md from a baseline file when --clean is used (defaults to empty)",
      "  --json                           Print the final report as JSON",
    ].join("\n"),
  );
}

function sqlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function durationMs(startedAt, completedAt) {
  const start = Date.parse(startedAt ?? "");
  const end = Date.parse(completedAt ?? "");
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return null;
  }
  return Math.max(0, end - start);
}

function average(values) {
  const filtered = values.filter((value) => Number.isFinite(value));
  if (filtered.length === 0) {
    return null;
  }
  return filtered.reduce((sum, value) => sum + value, 0) / filtered.length;
}

function maxValue(values) {
  const filtered = values.filter((value) => Number.isFinite(value));
  if (filtered.length === 0) {
    return null;
  }
  return Math.max(...filtered);
}

function percentile(values, ratio) {
  const filtered = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
  if (filtered.length === 0) {
    return null;
  }
  const index = Math.min(filtered.length - 1, Math.max(0, Math.ceil(filtered.length * ratio) - 1));
  return filtered[index];
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeComparableText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[:.,]/g, " ")
    .replace(/\b(\d+):00\b/g, "$1")
    .replace(/\bp\.?m\.?\b/g, "pm")
    .replace(/\ba\.?m\.?\b/g, "am")
    .replace(/\s+/g, " ")
    .trim();
}

function renderTemplateString(template, context) {
  return String(template ?? "").replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key) => {
    const resolved = context?.[key];
    return resolved == null ? "" : String(resolved);
  });
}

function renderTemplateArray(values, context) {
  if (!Array.isArray(values)) {
    return [];
  }
  return values
    .map((value) => renderTemplateString(value, context))
    .map((value) => String(value ?? "").trim())
    .filter((value) => value.length > 0);
}

function writeReport(report, outputPath) {
  if (!outputPath) {
    return;
  }
  const resolved = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, JSON.stringify(report, null, 2));
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitFor(predicate, params) {
  const timeoutMs = params.timeoutMs ?? 120000;
  const intervalMs = params.intervalMs ?? 1000;
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const value = await predicate();
      if (value) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  const suffix = lastError instanceof Error ? ` (${lastError.message})` : "";
  throw new Error(`${params.description ?? "condition"} timed out after ${timeoutMs}ms${suffix}`);
}

function loadFixture(filePath, scenarioId) {
  const resolvedPath = path.resolve(filePath ?? DEFAULT_FIXTURE_PATH);
  const parsed = JSON.parse(fs.readFileSync(resolvedPath, "utf8"));
  const scenarios = Array.isArray(parsed.scenarios) ? parsed.scenarios : [];
  const selected = scenarioId ? scenarios.filter((scenario) => scenario.id === scenarioId) : scenarios;
  if (selected.length === 0) {
    throw new Error(
      scenarioId
        ? `scenario not found in fixture: ${scenarioId}`
        : `fixture has no scenarios: ${resolvedPath}`,
    );
  }
  return {
    path: resolvedPath,
    name: parsed.name ?? path.basename(resolvedPath),
    description: parsed.description ?? "",
    batchSize: Number(parsed.batch_size ?? 3),
    includeDirectRetrieval: parsed.include_direct_retrieval === true,
    scenarios: selected,
  };
}

function expectedEntitiesForScenario(scenario) {
  if (Array.isArray(scenario.expected_entities) && scenario.expected_entities.length > 0) {
    return scenario.expected_entities;
  }
  if (scenario.expected_entity) {
    return [
      {
        ...scenario.expected_entity,
        expected_active_leaf_count: scenario.expected_active_leaf_count,
        expected_summary_count_min: scenario.expected_summary_count_min,
        expected_memories: scenario.expected_memories ?? [],
      },
    ];
  }
  return [];
}

function activeEntityByExpectation(dbPath, expectedEntity) {
  const canonicalName = typeof expectedEntity.canonical_name === "string"
    ? expectedEntity.canonical_name.trim()
    : "";
  const entityType = typeof expectedEntity.entity_type === "string"
    ? expectedEntity.entity_type.trim()
    : "";
  if (!canonicalName && !entityType) {
    return null;
  }
  const clauses = ["workspace_id IS NOT NULL", "status = 'active'"];
  if (canonicalName) {
    clauses.push(`canonical_name = ${sqlLiteral(canonicalName)}`);
  }
  if (entityType) {
    clauses.push(`entity_type = ${sqlLiteral(entityType)}`);
  }
  const rows = runSqlRows(
    dbPath,
    `
      SELECT entity_id, entity_type, canonical_name, slug, updated_at
      FROM interaction_entities
      WHERE ${clauses.join("\n        AND ")}
      ORDER BY datetime(updated_at) DESC, entity_id DESC
      LIMIT 1;
    `,
  );
  const row = rows[0];
  if (!row) {
    return null;
  }
  return {
    entity_id: row[0],
    entity_type: row[1],
    canonical_name: row[2],
    slug: row[3],
    updated_at: row[4],
  };
}

function resolveEntityRecord(dbPath, expectedEntity) {
  const entityId = typeof expectedEntity.entity_id === "string"
    ? expectedEntity.entity_id.trim()
    : "";
  return activeEntity(dbPath, entityId) ?? activeEntityByExpectation(dbPath, expectedEntity);
}

function resolveEntityTreeId(queryCase, expectedEntities, entityReports) {
  if (typeof queryCase.entity_id === "string" && queryCase.entity_id.trim().length > 0) {
    return queryCase.entity_id.trim();
  }
  if (typeof queryCase.entity_name === "string" && queryCase.entity_name.trim().length > 0) {
    const normalized = queryCase.entity_name.trim().toLowerCase();
    const matchedReport = entityReports.find((entry) => {
      const canonicalName = entry.entity?.canonical_name ?? entry.expected?.canonical_name ?? "";
      return canonicalName.trim().toLowerCase() === normalized;
    });
    return matchedReport?.entity?.entity_id ?? null;
  }
  if (expectedEntities.length === 1) {
    return entityReports[0]?.entity?.entity_id ?? expectedEntities[0]?.entity_id ?? null;
  }
  return null;
}

async function postJson(baseUrl, route, payload, init = {}) {
  return await fetchJson(`${baseUrl}${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
    body: JSON.stringify(payload),
  });
}

async function fetchIntegrationContextStatuses(baseUrl, params) {
  const url = new URL(`${baseUrl}/api/v1/integrations/context-fetch`);
  if (Array.isArray(params.connectionIds) && params.connectionIds.length > 0) {
    url.searchParams.set("connection_ids", params.connectionIds.join(","));
  }
  return await fetchJson(url.toString());
}

async function queueTurn(baseUrl, params) {
  return await postJson(baseUrl, "/api/v1/agent-sessions/queue", {
    workspace_id: params.workspaceId,
    session_id: params.sessionId,
    text: params.text,
  });
}

async function waitForTurnResult(baseUrl, params) {
  return await waitFor(async () => {
    const url = new URL(`${baseUrl}/api/v1/agent-sessions/${encodeURIComponent(params.sessionId)}/turn-results`);
    url.searchParams.set("workspace_id", params.workspaceId);
    url.searchParams.set("input_id", params.inputId);
    url.searchParams.set("limit", "1");
    const payload = await fetchJson(url.toString());
    const item = Array.isArray(payload.items) ? payload.items[0] : null;
    if (!item || !item.completed_at) {
      return null;
    }
    return item;
  }, {
    description: `turn result for ${params.sessionId}/${params.inputId}`,
    timeoutMs: TURN_RESULT_TIMEOUT_MS,
  });
}

async function runTurn(baseUrl, params) {
  const queued = await queueTurn(baseUrl, params);
  const result = await waitForTurnResult(baseUrl, {
    workspaceId: params.workspaceId,
    sessionId: queued.session_id,
    inputId: queued.input_id,
  });
  return {
    inputId: queued.input_id,
    sessionId: queued.session_id,
    result,
  };
}

async function retrieveMemory(baseUrl, params) {
  const startedAt = Date.now();
  return await postJson(
    baseUrl,
    "/api/v1/capabilities/runtime-tools/memory/retrieve",
    {
      query: params.query,
      categories: Array.isArray(params.categories) ? params.categories : undefined,
      mode: params.mode ?? "mixed",
      max_results: params.maxResults ?? 8,
      session_id: params.sessionId ?? null,
      input_id: params.inputId ?? null,
      tree_id: params.treeId ?? null,
      node_id: params.nodeId ?? null,
    },
    {
      headers: {
        "x-holaboss-workspace-id": params.workspaceId,
      },
    },
  ).then((payload) => ({
    payload,
    latency_ms: Date.now() - startedAt,
  }));
}

function batchCursorValue(dbPath, sessionId) {
  const rows = runSqlRows(
    dbPath,
    `SELECT value FROM workspace_runtime_metadata WHERE key = ${sqlLiteral(`${BATCH_CURSOR_KEY_PREFIX}${sessionId}`)} LIMIT 1;`,
  );
  return rows[0]?.[0] ?? null;
}

function activeEntity(dbPath, entityId) {
  const rows = runSqlRows(
    dbPath,
    `
      SELECT entity_id, entity_type, canonical_name, slug, updated_at
      FROM interaction_entities
      WHERE workspace_id IS NOT NULL
        AND entity_id = ${sqlLiteral(entityId)}
        AND status = 'active'
      LIMIT 1;
    `,
  );
  const row = rows[0];
  if (!row) {
    return null;
  }
  return {
    entity_id: row[0],
    entity_type: row[1],
    canonical_name: row[2],
    slug: row[3],
    updated_at: row[4],
  };
}

function activeLeavesForEntity(dbPath, entityId) {
  return runSqlRows(
    dbPath,
    `
      SELECT leaf_id, subject_key, title, summary, path, observed_at, updated_at
      FROM interaction_leaves
      WHERE entity_id = ${sqlLiteral(entityId)}
        AND status = 'active'
      ORDER BY observed_at ASC, updated_at ASC, leaf_id ASC;
    `,
  ).map((row) => ({
    leaf_id: row[0],
    subject_key: row[1],
    title: row[2],
    summary: row[3],
    path: row[4],
    observed_at: row[5],
    updated_at: row[6],
  }));
}

function activeSummariesForEntity(dbPath, entityId) {
  return runSqlRows(
    dbPath,
    `
      SELECT node_id, title, summary, level, child_count, path, sealed_at, updated_at
      FROM interaction_summary_nodes
      WHERE entity_id = ${sqlLiteral(entityId)}
        AND status = 'active'
      ORDER BY level ASC, updated_at ASC, node_id ASC;
    `,
  ).map((row) => ({
    node_id: row[0],
    title: row[1],
    summary: row[2],
    level: Number(row[3] ?? 0),
    child_count: Number(row[4] ?? 0),
    path: row[5],
    sealed_at: row[6],
    updated_at: row[7],
  }));
}

function activeIntegrationConnection(dbPath, providerId) {
  const rows = runSqlRows(
    dbPath,
    `
      SELECT connection_id, provider_id, owner_user_id, account_label, account_email, account_external_id, status
      FROM integration_connections
      WHERE provider_id = ${sqlLiteral(providerId)}
        AND lower(status) = 'active'
      ORDER BY datetime(updated_at) DESC, datetime(created_at) DESC, connection_id DESC
      LIMIT 1;
    `,
  );
  const row = rows[0];
  if (!row) {
    return null;
  }
  return {
    connection_id: row[0],
    provider_id: row[1],
    owner_user_id: row[2],
    account_label: row[3],
    account_email: row[4],
    account_external_id: row[5],
    status: row[6],
  };
}

function activeIntegrationTree(dbPath, treeId) {
  const rows = runSqlRows(
    dbPath,
    `
      SELECT tree_id, provider, owner_user_id, account_key, account_label, slug, updated_at
      FROM integration_trees
      WHERE tree_id = ${sqlLiteral(treeId)}
        AND status = 'active'
      LIMIT 1;
    `,
  );
  const row = rows[0];
  if (!row) {
    return null;
  }
  return {
    tree_id: row[0],
    provider: row[1],
    owner_user_id: row[2],
    account_key: row[3],
    account_label: row[4],
    slug: row[5],
    updated_at: row[6],
  };
}

function activeIntegrationLeavesForTree(dbPath, treeId) {
  return runSqlRows(
    dbPath,
    `
      SELECT leaf_id, subject_key, entity_key, entity_label, branch_key, branch_label, title, summary, path, observed_at, updated_at
      FROM integration_leaves
      WHERE tree_id = ${sqlLiteral(treeId)}
        AND status = 'active'
      ORDER BY observed_at ASC, updated_at ASC, leaf_id ASC;
    `,
  ).map((row) => ({
    leaf_id: row[0],
    subject_key: row[1],
    entity_key: row[2],
    entity_label: row[3],
    branch_key: row[4],
    branch_label: row[5],
    title: row[6],
    summary: row[7],
    path: row[8],
    observed_at: row[9],
    updated_at: row[10],
  }));
}

function activeIntegrationSummariesForTree(dbPath, treeId) {
  return runSqlRows(
    dbPath,
    `
      SELECT node_id, title, summary, level, child_count, path, sealed_at, updated_at
      FROM integration_summary_nodes
      WHERE tree_id = ${sqlLiteral(treeId)}
        AND status = 'active'
      ORDER BY level ASC, updated_at ASC, node_id ASC;
    `,
  ).map((row) => ({
    node_id: row[0],
    title: row[1],
    summary: row[2],
    level: Number(row[3] ?? 0),
    child_count: Number(row[4] ?? 0),
    path: row[5],
    sealed_at: row[6],
    updated_at: row[7],
  }));
}

function integrationRelationCounts(dbPath, treeId) {
  const rows = runSqlRows(
    dbPath,
    `
      SELECT relation_type, count(*)
      FROM integration_node_relations
      WHERE tree_id = ${sqlLiteral(treeId)}
      GROUP BY relation_type
      ORDER BY relation_type ASC;
    `,
  );
  return Object.fromEntries(rows.map(([key, value]) => [key, Number(value ?? 0)]));
}

function firstIntegrationLeafByPrefix(leaves, prefix) {
  return leaves.find((leaf) => String(leaf.subject_key ?? "").startsWith(prefix)) ?? null;
}

function buildIntegrationTemplateContext(params) {
  const profileLeaf = params.leaves.find((leaf) => leaf.subject_key === "profile") ?? null;
  const repositoryLeaf = firstIntegrationLeafByPrefix(params.leaves, "repository:");
  const notificationLeaf = firstIntegrationLeafByPrefix(params.leaves, "notification:");
  const pullLeaf = firstIntegrationLeafByPrefix(params.leaves, "pull:");
  const issueLeaf = firstIntegrationLeafByPrefix(params.leaves, "issue:");
  const messageLeaf = firstIntegrationLeafByPrefix(params.leaves, "message:");
  const pageLeaf = firstIntegrationLeafByPrefix(params.leaves, "page:");
  const pageMarkdownLeaf = firstIntegrationLeafByPrefix(params.leaves, "page_markdown:");
  const databaseLeaf = firstIntegrationLeafByPrefix(params.leaves, "database:");
  const rowLeaf = firstIntegrationLeafByPrefix(params.leaves, "row:");
  const firstNonProfileLeaf = params.leaves.find((leaf) => leaf.subject_key !== "profile") ?? null;
  const firstWorkItemLeaf = pullLeaf ?? issueLeaf ?? notificationLeaf ?? null;
  return {
    provider_id: params.fetchResult.provider_id ?? params.providerId,
    connection_id: params.fetchResult.connection_id ?? params.connection.connection_id,
    account_key:
      params.fetchResult.account_key
      ?? params.connection.account_external_id
      ?? params.connection.account_email
      ?? "",
    account_label: params.fetchResult.account_label ?? params.connection.account_label ?? "",
    account_email: params.connection.account_email ?? "",
    account_external_id: params.connection.account_external_id ?? "",
    tree_id: params.tree?.tree_id ?? params.treeId ?? "",
    profile_title:
      profileLeaf?.title
      ?? `${params.providerId.toUpperCase()} profile for ${params.fetchResult.account_label ?? params.connection.account_label ?? ""}`,
    profile_summary: profileLeaf?.summary ?? "",
    first_repository_title: repositoryLeaf?.title ?? "",
    first_repository_summary: repositoryLeaf?.summary ?? "",
    first_repository_subject_key: repositoryLeaf?.subject_key ?? "",
    first_notification_title: notificationLeaf?.title ?? "",
    first_notification_summary: notificationLeaf?.summary ?? "",
    first_pull_title: pullLeaf?.title ?? "",
    first_issue_title: issueLeaf?.title ?? "",
    first_message_title: messageLeaf?.title ?? "",
    first_page_title: pageLeaf?.title ?? "",
    first_page_markdown_title: pageMarkdownLeaf?.title ?? "",
    first_database_title: databaseLeaf?.title ?? "",
    first_row_title: rowLeaf?.title ?? "",
    first_non_profile_title: firstNonProfileLeaf?.title ?? "",
    first_work_item_title: firstWorkItemLeaf?.title ?? "",
    first_work_item_summary: firstWorkItemLeaf?.summary ?? "",
  };
}

function assertIncludesAll(label, haystack, terms) {
  const normalizedTerms = terms.map((term) => normalizeComparableText(term));
  const matched = matchingTerms(normalizeComparableText(haystack), normalizedTerms);
  if (matched.length !== normalizedTerms.length) {
    const missing = terms.filter((term, index) => !matched.includes(normalizedTerms[index]));
    throw new Error(`${label} is missing expected terms: ${missing.join(", ")}`);
  }
}

function hitText(hit) {
  return [hit.title, hit.summary, hit.excerpt, hit.entity_name].filter(Boolean).join("\n");
}

function missingTerms(haystack, terms) {
  const normalizedHaystack = normalizeComparableText(haystack);
  const normalizedTerms = terms.map((term) => normalizeComparableText(term));
  const matched = matchingTerms(normalizedHaystack, normalizedTerms);
  return terms.filter((term, index) => !matched.includes(normalizedTerms[index]));
}

function matchingHitRank(hits, terms) {
  for (let index = 0; index < hits.length; index += 1) {
    if (missingTerms(hitText(hits[index]), terms).length === 0) {
      return index + 1;
    }
  }
  return null;
}

function classifyReaderRetrieval(toolNames, answerCorrect) {
  if (toolNames.includes("memory_retrieve")) {
    return "memory_retrieve";
  }
  if (toolNames.length === 0 && answerCorrect) {
    return "likely_pre_run_recall";
  }
  if (toolNames.length === 0) {
    return "no_tools";
  }
  return "other_tools";
}

async function runInteractionScenario(params) {
  const scenario = params.scenario;
  const startedAt = new Date().toISOString();
  const startedWall = Date.now();
  const scenarioSlug = sanitizeSessionId(`${scenario.id}-${Date.now()}`);
  const writerSessionId = `memory-eval-writer-${scenarioSlug}`;
  const beforeAgents = readTextIfExists(params.agentsPath);
  const failures = [];
  const countsBefore = workspaceMemoryCounts(params.dbPath, params.controlPlaneDbPath);
  const expectedEntities = expectedEntitiesForScenario(scenario);

  if (!Array.isArray(scenario.writer_turns) || scenario.writer_turns.length === 0) {
    return {
      scenario_id: scenario.id,
      status: "failed",
      failures: ["writer_turns is empty"],
      started_at: startedAt,
      completed_at: new Date().toISOString(),
    };
  }
  if (scenario.writer_turns.length % params.batchSize !== 0) {
    failures.push(
      `writer turn count ${scenario.writer_turns.length} is not divisible by batch size ${params.batchSize}`,
    );
  }
  if (expectedEntities.length === 0) {
    failures.push("scenario has no expected_entities");
  }

  const writerTurns = [];
  for (const [index, text] of scenario.writer_turns.entries()) {
    try {
      const turn = await runTurn(params.baseUrl, {
        workspaceId: params.workspaceId,
        sessionId: writerSessionId,
        text,
      });
      writerTurns.push({
        turn_number: index + 1,
        input_id: turn.inputId,
        assistant_text: turn.result.assistant_text,
        tool_usage_summary: turn.result.tool_usage_summary,
        latency_ms: durationMs(turn.result.started_at, turn.result.completed_at),
      });
    } catch (error) {
      failures.push(
        `writer turn ${index + 1} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      break;
    }
  }

  const expectedCursor = String(scenario.writer_turns.length);
  let batchCursor = batchCursorValue(params.dbPath, writerSessionId);
  let batchCursorReadyMs = null;
  if (failures.length === 0) {
    try {
      const cursorStartedAt = Date.now();
      batchCursor = await waitFor(
        async () => {
          const cursor = batchCursorValue(params.dbPath, writerSessionId);
          return cursor === expectedCursor ? cursor : null;
        },
        {
          description: `batch cursor ${expectedCursor} for ${scenario.id}`,
          timeoutMs: Number(scenario.batch_cursor_timeout_ms ?? BATCH_CURSOR_TIMEOUT_MS),
        },
      );
      batchCursorReadyMs = Date.now() - cursorStartedAt;
    } catch (error) {
      failures.push(
        `batch cursor wait failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const entityReports = [];
  for (const expectedEntity of expectedEntities) {
    let entityReady = null;
    try {
      entityReady = await waitFor(
        async () => {
          const entity = resolveEntityRecord(params.dbPath, expectedEntity);
          const treeId = entity?.entity_id ?? null;
          const leaves = treeId ? activeLeavesForEntity(params.dbPath, treeId) : [];
          const summaries = treeId ? activeSummariesForEntity(params.dbPath, treeId) : [];
          if (!entity) {
            return null;
          }
          if (
            typeof expectedEntity.expected_active_leaf_count === "number" &&
            leaves.length < expectedEntity.expected_active_leaf_count
          ) {
            return null;
          }
          if (
            typeof expectedEntity.expected_summary_count_min === "number" &&
            summaries.length < expectedEntity.expected_summary_count_min
          ) {
            return null;
          }
          return { entity, leaves, summaries };
        },
        {
          description: `memory tree materialization for ${expectedEntity.entity_id ?? expectedEntity.canonical_name ?? "expected entity"}`,
          timeoutMs: Number(scenario.entity_ready_timeout_ms ?? ENTITY_READY_TIMEOUT_MS),
        },
      );
    } catch (error) {
      failures.push(
        `entity materialization failed for ${expectedEntity.entity_id ?? expectedEntity.canonical_name ?? "expected entity"}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const entity = entityReady?.entity ?? resolveEntityRecord(params.dbPath, expectedEntity);
    const treeId = entity?.entity_id ?? null;
    const leaves = treeId ? activeLeavesForEntity(params.dbPath, treeId) : [];
    const summaries = treeId ? activeSummariesForEntity(params.dbPath, treeId) : [];
    const entityFailures = [];

    if (!entity) {
      const entityLabel = expectedEntity.entity_id ?? expectedEntity.canonical_name ?? "unknown entity";
      entityFailures.push(`expected entity was not created: ${entityLabel}`);
    } else {
      if (expectedEntity.entity_id && entity.entity_id !== expectedEntity.entity_id) {
        entityFailures.push(
          `expected entity_id ${expectedEntity.entity_id}, got ${entity.entity_id}`,
        );
      }
      if (expectedEntity.entity_type && entity.entity_type !== expectedEntity.entity_type) {
        entityFailures.push(
          `expected entity_type ${expectedEntity.entity_type}, got ${entity.entity_type}`,
        );
      }
      if (expectedEntity.canonical_name && entity.canonical_name !== expectedEntity.canonical_name) {
        entityFailures.push(
          `expected canonical_name ${expectedEntity.canonical_name}, got ${entity.canonical_name}`,
        );
      }
    }

    if (
      typeof expectedEntity.expected_active_leaf_count === "number" &&
      leaves.length !== expectedEntity.expected_active_leaf_count
    ) {
      entityFailures.push(
        `expected ${expectedEntity.expected_active_leaf_count} active leaves, got ${leaves.length}`,
      );
    }
    if (
      typeof expectedEntity.expected_active_leaf_count_min === "number" &&
      leaves.length < expectedEntity.expected_active_leaf_count_min
    ) {
      entityFailures.push(
        `expected at least ${expectedEntity.expected_active_leaf_count_min} active leaves, got ${leaves.length}`,
      );
    }
    if (
      typeof expectedEntity.expected_summary_count_min === "number" &&
      summaries.length < expectedEntity.expected_summary_count_min
    ) {
      entityFailures.push(
        `expected at least ${expectedEntity.expected_summary_count_min} active summaries, got ${summaries.length}`,
      );
    }
    if (new Set(leaves.map((leaf) => leaf.subject_key)).size !== leaves.length) {
      entityFailures.push("active leaves do not have distinct subject_keys");
    }

    const leafSearchCorpus = leaves.map((leaf) =>
      [leaf.title, leaf.summary, leaf.subject_key].filter(Boolean).join("\n"),
    );
    const expectedMemoryResults = [];
    for (const memoryExpectation of expectedEntity.expected_memories ?? []) {
      const terms = Array.isArray(memoryExpectation.all_terms) ? memoryExpectation.all_terms : [];
      const matched = leafSearchCorpus.some((text) => matchingTerms(text, terms).length === terms.length);
      expectedMemoryResults.push({ terms, matched });
      if (!matched) {
        entityFailures.push(`no active leaf matched expected memory: ${terms.join(", ")}`);
      }
    }

    entityReports.push({
      expected: expectedEntity,
      entity,
      status: entityFailures.length === 0 ? "passed" : "failed",
      failures: entityFailures,
      active_leaf_count: leaves.length,
      active_summary_count: summaries.length,
      subject_key_count: new Set(leaves.map((leaf) => leaf.subject_key)).size,
      summary_levels: Array.from(new Set(summaries.map((summary) => summary.level))).sort((a, b) => a - b),
      has_root_summary: summaries.some((summary) => summary.level === 1),
      active_leaves: leaves,
      active_summaries: summaries,
      expected_memories: expectedMemoryResults,
    });
    failures.push(
      ...entityFailures.map((message) => `${expectedEntity.entity_id ?? expectedEntity.canonical_name ?? "expected entity"}: ${message}`),
    );
  }

  const directRetrievals = [];
  const readerQueries = [];
  for (const [index, queryCase] of (scenario.reader_queries ?? []).entries()) {
    const targetEntityId = resolveEntityTreeId(queryCase, expectedEntities, entityReports);
    const treeScope = queryCase.tree_scope ?? "global";
    const retrievalTerms = Array.isArray(queryCase.expected_retrieve_contains)
      ? queryCase.expected_retrieve_contains
      : [];
    const answerTerms = Array.isArray(queryCase.expected_answer_contains)
      ? queryCase.expected_answer_contains
      : [];
    const categories = Array.isArray(queryCase.categories) ? queryCase.categories : null;

    if (params.includeDirectRetrieval) {
      let directPayload = { hits: [] };
      let directLatencyMs = null;
      let directFailure = null;
      try {
        const direct = await retrieveMemory(params.baseUrl, {
          workspaceId: params.workspaceId,
          query: queryCase.query,
          categories,
          treeId: treeScope === "entity" ? targetEntityId : null,
        });
        directPayload = direct.payload;
        directLatencyMs = direct.latency_ms;
      } catch (error) {
        directFailure = error instanceof Error ? error.message : String(error);
        failures.push(`direct retrieval failed for ${scenario.id} query ${index + 1}: ${directFailure}`);
      }
      const directHits = Array.isArray(directPayload.hits) ? directPayload.hits : [];
      const directRank = matchingHitRank(directHits, retrievalTerms);
      if (directFailure == null && directRank == null) {
        failures.push(
          `memory_retrieve did not return a hit containing expected terms for ${scenario.id} query ${index + 1}: ${retrievalTerms.join(", ")}`,
        );
      }
      if (
        directFailure == null &&
        targetEntityId &&
        !directHits.some((hit) => hit.tree_id === targetEntityId)
      ) {
        failures.push(
          `memory_retrieve did not surface the expected tree ${targetEntityId} for ${scenario.id} query ${index + 1}`,
        );
      }
      directRetrievals.push({
        query: queryCase.query,
        tree_scope: treeScope,
        target_entity_id: targetEntityId,
        latency_ms: directLatencyMs,
        top_titles: directHits.slice(0, 5).map((hit) => hit.title),
        top_tree_ids: directHits.slice(0, 5).map((hit) => hit.tree_id),
        matched_hit_rank: directRank,
        failure: directFailure,
      });
    }

    let readerTurn = null;
    let answer = "";
    let answerMissing = answerTerms;
    let readerFailure = null;
    try {
      readerTurn = await runTurn(params.baseUrl, {
        workspaceId: params.workspaceId,
        sessionId: `memory-eval-reader-${scenarioSlug}-${index + 1}`,
        text: queryCase.query,
      });
      answer = String(readerTurn.result.assistant_text ?? "");
      answerMissing = missingTerms(answer, answerTerms);
      if (answerMissing.length > 0) {
        failures.push(
          `reader answer missing expected terms for ${scenario.id} query ${index + 1}: ${answerMissing.join(", ")}`,
        );
      }
    } catch (error) {
      readerFailure = error instanceof Error ? error.message : String(error);
      failures.push(`reader turn failed for ${scenario.id} query ${index + 1}: ${readerFailure}`);
    }
    const toolSummary = readerTurn?.result?.tool_usage_summary ?? {};
    const toolNames = Array.isArray(toolSummary.tool_names) ? toolSummary.tool_names : [];
    readerQueries.push({
      query: queryCase.query,
      input_id: readerTurn?.inputId ?? null,
      answer,
      answer_correct: answerMissing.length === 0 && !readerFailure,
      answer_missing_terms: answerMissing,
      tool_usage_summary: toolSummary,
      tool_names: toolNames,
      retrieval_strategy: classifyReaderRetrieval(toolNames, answerMissing.length === 0 && !readerFailure),
      used_memory_retrieve: toolNames.includes("memory_retrieve"),
      likely_prerun_recall: toolNames.length === 0 && answerMissing.length === 0 && !readerFailure,
      latency_ms: readerTurn
        ? durationMs(readerTurn.result.started_at, readerTurn.result.completed_at)
        : null,
      failure: readerFailure,
    });
  }

  const afterAgents = readTextIfExists(params.agentsPath);
  const agentsTerms = Array.isArray(scenario.agents_terms) ? scenario.agents_terms : [];
  const agentsDeltaTerms = matchingTerms(afterAgents, agentsTerms).filter(
    (term) => !matchingTerms(beforeAgents, [term]).includes(term),
  );
  const agentsPolicy = scenario.agents_policy ?? "ignore";
  if (agentsPolicy === "forbid" && agentsDeltaTerms.length > 0) {
    failures.push(`AGENTS.md gained scenario terms: ${agentsDeltaTerms.join(", ")}`);
  }

  const countsAfter = workspaceMemoryCounts(params.dbPath, params.controlPlaneDbPath);
  const directLatencies = directRetrievals.map((entry) => entry.latency_ms).filter((value) => value != null);
  const readerLatencies = readerQueries.map((entry) => entry.latency_ms).filter((value) => value != null);
  const memoryRetrieveReaders = readerQueries.filter((entry) => entry.used_memory_retrieve).length;
  const prerunRecallReaders = readerQueries.filter((entry) => entry.likely_prerun_recall).length;

  return {
    scenario_id: scenario.id,
    description: scenario.description ?? "",
    kind: "interaction",
    status: failures.length === 0 ? "passed" : "failed",
    failures,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    duration_ms: Date.now() - startedWall,
    counts_before_scenario: countsBefore,
    counts_after_scenario: countsAfter,
    writer_session_id: writerSessionId,
    writer_turns: writerTurns,
    batch_cursor: batchCursor,
    batch_cursor_expected: expectedCursor,
    batch_cursor_ready_ms: batchCursorReadyMs,
    entity_reports: entityReports,
    direct_retrievals: directRetrievals,
    reader_queries: readerQueries,
    agents_policy: agentsPolicy,
    agents_delta_terms: agentsDeltaTerms,
    quality_metrics: {
      expected_entity_count: expectedEntities.length,
      actual_entity_count: entityReports.filter((entry) => entry.entity).length,
      total_active_leaves: entityReports.reduce((sum, entry) => sum + entry.active_leaf_count, 0),
      total_active_summaries: entityReports.reduce((sum, entry) => sum + entry.active_summary_count, 0),
      direct_retrieval_avg_ms: average(directLatencies),
      direct_retrieval_max_ms: maxValue(directLatencies),
      reader_answer_avg_ms: average(readerLatencies),
      reader_answer_max_ms: maxValue(readerLatencies),
      direct_retrieval_success_rate:
        directRetrievals.length === 0
          ? null
          : directRetrievals.filter((entry) => entry.matched_hit_rank != null && !entry.failure).length /
            directRetrievals.length,
      reader_answer_success_rate:
        readerQueries.length === 0
          ? null
          : readerQueries.filter((entry) => entry.answer_correct).length / readerQueries.length,
      reader_memory_retrieve_count: memoryRetrieveReaders,
      reader_prerun_recall_count: prerunRecallReaders,
      reader_other_tool_count: readerQueries.filter(
        (entry) => !entry.used_memory_retrieve && !entry.likely_prerun_recall,
      ).length,
    },
  };
}

async function runIntegrationContextFetchScenario(params) {
  const scenario = params.scenario;
  const startedAt = new Date().toISOString();
  const startedWall = Date.now();
  const scenarioSlug = sanitizeSessionId(`${scenario.id}-${Date.now()}`);
  const failures = [];
  const countsBefore = workspaceMemoryCounts(params.dbPath, params.controlPlaneDbPath);
  const beforeAgents = readTextIfExists(params.agentsPath);
  const providerId = typeof scenario.provider_id === "string" && scenario.provider_id.trim().length > 0
    ? scenario.provider_id.trim().toLowerCase()
    : "gmail";

  const interactionWriterSessionId = `memory-eval-mixed-writer-${scenarioSlug}`;
  const interactionWriterTurns = [];
  let interactionBatchCursor = null;
  let interactionBatchCursorReadyMs = null;
  if (Array.isArray(scenario.interaction_writer_turns) && scenario.interaction_writer_turns.length > 0) {
    if (scenario.interaction_writer_turns.length % params.batchSize !== 0) {
      failures.push(
        `interaction writer turn count ${scenario.interaction_writer_turns.length} is not divisible by batch size ${params.batchSize}`,
      );
    }
    for (const [index, text] of scenario.interaction_writer_turns.entries()) {
      try {
        const turn = await runTurn(params.baseUrl, {
          workspaceId: params.workspaceId,
          sessionId: interactionWriterSessionId,
          text,
        });
        interactionWriterTurns.push({
          turn_number: index + 1,
          input_id: turn.inputId,
          assistant_text: turn.result.assistant_text,
          tool_usage_summary: turn.result.tool_usage_summary,
          latency_ms: durationMs(turn.result.started_at, turn.result.completed_at),
        });
      } catch (error) {
        failures.push(
          `interaction writer turn ${index + 1} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        break;
      }
    }
    if (failures.length === 0) {
      const expectedInteractionCursor = String(scenario.interaction_writer_turns.length);
      try {
        const cursorStartedAt = Date.now();
        interactionBatchCursor = await waitFor(
          async () => {
            const cursor = batchCursorValue(params.dbPath, interactionWriterSessionId);
            return cursor === expectedInteractionCursor ? cursor : null;
          },
          {
            description: `interaction prelude batch cursor ${expectedInteractionCursor} for ${scenario.id}`,
            timeoutMs: Number(scenario.batch_cursor_timeout_ms ?? BATCH_CURSOR_TIMEOUT_MS),
          },
        );
        interactionBatchCursorReadyMs = Date.now() - cursorStartedAt;
      } catch (error) {
        failures.push(
          `interaction prelude batch cursor wait failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        interactionBatchCursor = batchCursorValue(params.dbPath, interactionWriterSessionId);
      }
    }
  }

  const connection = activeIntegrationConnection(params.controlPlaneDbPath, providerId);

  if (!connection) {
    if (scenario.skip_if_unavailable !== false) {
      return {
        scenario_id: scenario.id,
        description: scenario.description ?? "",
        status: "skipped",
        failures: [],
        skip_reason: `no active ${providerId} integration connection found`,
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        counts_before_scenario: countsBefore,
        counts_after_scenario: countsBefore,
        interaction_writer_session_id: interactionWriterSessionId,
        interaction_writer_turns: interactionWriterTurns,
        interaction_batch_cursor: interactionBatchCursor,
        interaction_batch_cursor_ready_ms: interactionBatchCursorReadyMs,
        integration_reports: [],
        direct_retrievals: [],
        reader_queries: [],
        quality_metrics: {},
      };
    }
    return {
      scenario_id: scenario.id,
      description: scenario.description ?? "",
      status: "failed",
      failures: [`no active ${providerId} integration connection found`],
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      counts_before_scenario: countsBefore,
      counts_after_scenario: countsBefore,
      interaction_writer_session_id: interactionWriterSessionId,
      interaction_writer_turns: interactionWriterTurns,
      interaction_batch_cursor: interactionBatchCursor,
      interaction_batch_cursor_ready_ms: interactionBatchCursorReadyMs,
      integration_reports: [],
      direct_retrievals: [],
      reader_queries: [],
      quality_metrics: {},
    };
  }

  let fetchPayload = null;
  try {
    fetchPayload = await postJson(params.baseUrl, "/api/v1/integrations/context-fetch", {
      connection_id: connection.connection_id,
    });
  } catch (error) {
    failures.push(
      `integration context fetch failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let fetchResult = isRecord(fetchPayload?.status) ? fetchPayload.status : {};
  if (fetchPayload?.status?.status === "running" || fetchPayload?.started === true) {
    try {
      fetchResult = await waitFor(
        async () => {
          const payload = await fetchIntegrationContextStatuses(params.baseUrl, {
            connectionIds: [connection.connection_id],
          });
          const statuses = Array.isArray(payload?.statuses) ? payload.statuses : [];
          const status = statuses.find((entry) => entry?.connection_id === connection.connection_id);
          if (!status) {
            return null;
          }
          return status.status === "running" ? null : status;
        },
        {
          description: `integration context fetch completion for ${scenario.id}`,
          timeoutMs: Number(scenario.integration_ready_timeout_ms ?? INTEGRATION_FETCH_TIMEOUT_MS),
        },
      );
    } catch (error) {
      failures.push(
        `integration context fetch completion failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const treeId = typeof fetchResult.tree_id === "string" ? fetchResult.tree_id : null;
  const expectedTree = scenario.expected_tree ?? {};
  let tree = null;
  let leaves = [];
  let summaries = [];
  let relationCounts = {};
  if (treeId) {
    try {
      await waitFor(
        async () => {
          const nextTree = activeIntegrationTree(params.controlPlaneDbPath, treeId);
          const nextLeaves = nextTree ? activeIntegrationLeavesForTree(params.controlPlaneDbPath, treeId) : [];
          const nextSummaries = nextTree ? activeIntegrationSummariesForTree(params.controlPlaneDbPath, treeId) : [];
          if (!nextTree) {
            return null;
          }
          if (
            typeof expectedTree.expected_active_leaf_count_min === "number" &&
            nextLeaves.length < expectedTree.expected_active_leaf_count_min
          ) {
            return null;
          }
          if (
            typeof expectedTree.expected_summary_count_min === "number" &&
            nextSummaries.length < expectedTree.expected_summary_count_min
          ) {
            return null;
          }
          return { tree: nextTree, leaves: nextLeaves, summaries: nextSummaries };
        },
        {
          description: `integration tree materialization for ${scenario.id}`,
          timeoutMs: Number(scenario.integration_ready_timeout_ms ?? INTEGRATION_FETCH_TIMEOUT_MS),
        },
      );
    } catch (error) {
      failures.push(
        `integration tree materialization failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    tree = activeIntegrationTree(params.controlPlaneDbPath, treeId);
    leaves = tree ? activeIntegrationLeavesForTree(params.controlPlaneDbPath, treeId) : [];
    summaries = tree ? activeIntegrationSummariesForTree(params.controlPlaneDbPath, treeId) : [];
    relationCounts = tree ? integrationRelationCounts(params.controlPlaneDbPath, treeId) : {};
  } else if (fetchResult.supported !== false) {
    failures.push("integration context fetch did not return a tree_id");
  }

  const templateContext = buildIntegrationTemplateContext({
    providerId,
    connection,
    fetchResult,
    tree,
    treeId,
    leaves,
  });

  const integrationFailures = [];
  if (fetchResult.supported === false) {
    integrationFailures.push(`provider was reported unsupported: ${providerId}`);
  }
  if (!tree) {
    integrationFailures.push("expected integration tree was not created");
  } else {
    if (expectedTree.provider && tree.provider !== expectedTree.provider) {
      integrationFailures.push(`expected provider ${expectedTree.provider}, got ${tree.provider}`);
    }
    if (
      typeof expectedTree.expected_active_leaf_count_min === "number" &&
      leaves.length < expectedTree.expected_active_leaf_count_min
    ) {
      integrationFailures.push(
        `expected at least ${expectedTree.expected_active_leaf_count_min} active leaves, got ${leaves.length}`,
      );
    }
    if (
      typeof expectedTree.expected_active_leaf_count === "number" &&
      leaves.length !== expectedTree.expected_active_leaf_count
    ) {
      integrationFailures.push(
        `expected ${expectedTree.expected_active_leaf_count} active leaves, got ${leaves.length}`,
      );
    }
    if (
      typeof expectedTree.expected_summary_count_min === "number" &&
      summaries.length < expectedTree.expected_summary_count_min
    ) {
      integrationFailures.push(
        `expected at least ${expectedTree.expected_summary_count_min} active summaries, got ${summaries.length}`,
      );
    }
    const requiredSubjectKeys = Array.isArray(expectedTree.required_subject_keys)
      ? expectedTree.required_subject_keys
      : [];
    for (const subjectKey of requiredSubjectKeys) {
      if (!leaves.some((leaf) => leaf.subject_key === subjectKey)) {
        integrationFailures.push(`missing active integration leaf with subject_key ${subjectKey}`);
      }
    }
    const requiredSubjectKeyPrefixes = Array.isArray(expectedTree.required_subject_key_prefixes)
      ? expectedTree.required_subject_key_prefixes
      : [];
    for (const prefix of requiredSubjectKeyPrefixes) {
      if (!leaves.some((leaf) => String(leaf.subject_key ?? "").startsWith(prefix))) {
        integrationFailures.push(`missing active integration leaf with subject_key prefix ${prefix}`);
      }
    }
    const requiredEntityKeyPrefixes = Array.isArray(expectedTree.required_entity_key_prefixes)
      ? expectedTree.required_entity_key_prefixes
      : [];
    for (const prefix of requiredEntityKeyPrefixes) {
      if (!leaves.some((leaf) => String(leaf.entity_key ?? "").startsWith(prefix))) {
        integrationFailures.push(`missing active integration leaf with entity_key prefix ${prefix}`);
      }
    }
    const requiredBranchKeys = Array.isArray(expectedTree.required_branch_keys)
      ? expectedTree.required_branch_keys
      : [];
    for (const branchKey of requiredBranchKeys) {
      if (!leaves.some((leaf) => String(leaf.branch_key ?? "") === branchKey)) {
        integrationFailures.push(`missing active integration leaf with branch_key ${branchKey}`);
      }
    }
    const requiredRelationTypes = Array.isArray(expectedTree.required_relation_types)
      ? expectedTree.required_relation_types
      : [];
    for (const relationType of requiredRelationTypes) {
      if (Number(relationCounts?.[relationType] ?? 0) <= 0) {
        integrationFailures.push(`missing integration relation type ${relationType}`);
      }
    }
  }
  failures.push(...integrationFailures);

  const directRetrievals = [];
  const readerQueries = [];
  for (const [index, queryCase] of (scenario.reader_queries ?? []).entries()) {
    const query = renderTemplateString(queryCase.query, templateContext);
    const retrievalTerms = renderTemplateArray(
      queryCase.expected_retrieve_contains_templates ?? queryCase.expected_retrieve_contains ?? [],
      templateContext,
    );
    const answerTerms = renderTemplateArray(
      queryCase.expected_answer_contains_templates ?? queryCase.expected_answer_contains ?? [],
      templateContext,
    );
    const categories = Array.isArray(queryCase.categories) ? queryCase.categories : ["integration"];
    const treeScope = queryCase.tree_scope ?? "tree";

    if (params.includeDirectRetrieval) {
      let directPayload = { hits: [] };
      let directLatencyMs = null;
      let directFailure = null;
      try {
        const direct = await retrieveMemory(params.baseUrl, {
          workspaceId: params.workspaceId,
          query,
          categories,
          treeId: treeScope === "tree" ? (tree?.tree_id ?? null) : null,
        });
        directPayload = direct.payload;
        directLatencyMs = direct.latency_ms;
      } catch (error) {
        directFailure = error instanceof Error ? error.message : String(error);
        failures.push(`direct retrieval failed for ${scenario.id} query ${index + 1}: ${directFailure}`);
      }

      const directHits = Array.isArray(directPayload.hits) ? directPayload.hits : [];
      const directRank = matchingHitRank(directHits, retrievalTerms);
      if (directFailure == null && retrievalTerms.length > 0 && directRank == null) {
        failures.push(
          `memory_retrieve did not return a hit containing expected terms for ${scenario.id} query ${index + 1}: ${retrievalTerms.join(", ")}`,
        );
      }
      if (directFailure == null && tree?.tree_id && !directHits.some((hit) => hit.tree_id === tree.tree_id)) {
        failures.push(
          `memory_retrieve did not surface the expected integration tree ${tree.tree_id} for ${scenario.id} query ${index + 1}`,
        );
      }
      directRetrievals.push({
        query,
        tree_scope: treeScope,
        target_tree_id: tree?.tree_id ?? null,
        latency_ms: directLatencyMs,
        top_titles: directHits.slice(0, 5).map((hit) => hit.title),
        top_tree_ids: directHits.slice(0, 5).map((hit) => hit.tree_id),
        matched_hit_rank: directRank,
        failure: directFailure,
      });
    }

    let readerTurn = null;
    let answer = "";
    let answerMissing = answerTerms;
    let readerFailure = null;
    try {
      readerTurn = await runTurn(params.baseUrl, {
        workspaceId: params.workspaceId,
        sessionId: `memory-eval-reader-${sanitizeSessionId(`${scenario.id}-${Date.now()}-${index + 1}`)}`,
        text: query,
      });
      answer = String(readerTurn.result.assistant_text ?? "");
      answerMissing = missingTerms(answer, answerTerms);
      if (answerMissing.length > 0) {
        failures.push(
          `reader answer missing expected terms for ${scenario.id} query ${index + 1}: ${answerMissing.join(", ")}`,
        );
      }
    } catch (error) {
      readerFailure = error instanceof Error ? error.message : String(error);
      failures.push(`reader turn failed for ${scenario.id} query ${index + 1}: ${readerFailure}`);
    }
    const toolSummary = readerTurn?.result?.tool_usage_summary ?? {};
    const toolNames = Array.isArray(toolSummary.tool_names) ? toolSummary.tool_names : [];
    readerQueries.push({
      query,
      input_id: readerTurn?.inputId ?? null,
      answer,
      answer_correct: answerMissing.length === 0 && !readerFailure,
      answer_missing_terms: answerMissing,
      tool_usage_summary: toolSummary,
      tool_names: toolNames,
      retrieval_strategy: classifyReaderRetrieval(toolNames, answerMissing.length === 0 && !readerFailure),
      used_memory_retrieve: toolNames.includes("memory_retrieve"),
      likely_prerun_recall: toolNames.length === 0 && answerMissing.length === 0 && !readerFailure,
      latency_ms: readerTurn
        ? durationMs(readerTurn.result.started_at, readerTurn.result.completed_at)
        : null,
      failure: readerFailure,
    });
  }

  const afterAgents = readTextIfExists(params.agentsPath);
  const agentsTerms = renderTemplateArray(scenario.agents_terms ?? [], templateContext);
  const agentsDeltaTerms = matchingTerms(afterAgents, agentsTerms).filter(
    (term) => !matchingTerms(beforeAgents, [term]).includes(term),
  );
  const agentsPolicy = scenario.agents_policy ?? "ignore";
  if (agentsPolicy === "forbid" && agentsDeltaTerms.length > 0) {
    failures.push(`AGENTS.md gained scenario terms: ${agentsDeltaTerms.join(", ")}`);
  }

  const countsAfter = workspaceMemoryCounts(params.dbPath, params.controlPlaneDbPath);
  const directLatencies = directRetrievals.map((entry) => entry.latency_ms).filter((value) => value != null);
  const readerLatencies = readerQueries.map((entry) => entry.latency_ms).filter((value) => value != null);
  const memoryRetrieveReaders = readerQueries.filter((entry) => entry.used_memory_retrieve).length;
  const prerunRecallReaders = readerQueries.filter((entry) => entry.likely_prerun_recall).length;
  const activeEntityKeys = Array.from(
    new Set(
      leaves
        .map((leaf) => String(leaf.entity_key ?? "").trim())
        .filter((value) => value.length > 0),
    ),
  ).sort();
  const activeBranchKeys = Array.from(
    new Set(
      leaves
        .map((leaf) => String(leaf.branch_key ?? "").trim())
        .filter((value) => value.length > 0),
    ),
  ).sort();

  return {
    scenario_id: scenario.id,
    description: scenario.description ?? "",
    kind: typeof scenario.kind === "string" && scenario.kind.trim().length > 0
      ? scenario.kind.trim()
      : "integration_live_context_fetch",
    status: failures.length === 0 ? "passed" : "failed",
    failures,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    duration_ms: Date.now() - startedWall,
    counts_before_scenario: countsBefore,
    counts_after_scenario: countsAfter,
    interaction_writer_session_id: interactionWriterTurns.length > 0 ? interactionWriterSessionId : null,
    interaction_writer_turns: interactionWriterTurns,
    interaction_batch_cursor: interactionBatchCursor,
    interaction_batch_cursor_ready_ms: interactionBatchCursorReadyMs,
    integration_fetch: fetchResult,
    integration_reports: [
      {
        expected: expectedTree,
        tree,
        status: integrationFailures.length === 0 ? "passed" : "failed",
        failures: integrationFailures,
        active_leaf_count: leaves.length,
        active_summary_count: summaries.length,
        relation_counts: relationCounts,
        active_entity_keys: activeEntityKeys,
        active_branch_keys: activeBranchKeys,
        active_leaves: leaves,
        active_summaries: summaries,
      },
    ],
    direct_retrievals: directRetrievals,
    reader_queries: readerQueries,
    agents_policy: agentsPolicy,
    agents_delta_terms: agentsDeltaTerms,
    quality_metrics: {
      actual_tree_count: tree ? 1 : 0,
      total_active_integration_leaves: leaves.length,
      total_active_integration_summaries: summaries.length,
      direct_retrieval_avg_ms: average(directLatencies),
      direct_retrieval_max_ms: maxValue(directLatencies),
      reader_answer_avg_ms: average(readerLatencies),
      reader_answer_max_ms: maxValue(readerLatencies),
      direct_retrieval_success_rate:
        directRetrievals.length === 0
          ? null
          : directRetrievals.filter((entry) => entry.matched_hit_rank != null && !entry.failure).length /
            directRetrievals.length,
      reader_answer_success_rate:
        readerQueries.length === 0
          ? null
          : readerQueries.filter((entry) => entry.answer_correct).length / readerQueries.length,
      reader_memory_retrieve_count: memoryRetrieveReaders,
      reader_prerun_recall_count: prerunRecallReaders,
      reader_other_tool_count: readerQueries.filter(
        (entry) => !entry.used_memory_retrieve && !entry.likely_prerun_recall,
      ).length,
    },
  };
}

async function runScenario(params) {
  const kind = typeof params.scenario.kind === "string" ? params.scenario.kind.trim().toLowerCase() : "interaction";
  if (kind.startsWith("integration_live_")) {
    return await runIntegrationContextFetchScenario(params);
  }
  return await runInteractionScenario(params);
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printUsage();
    return;
  }

  const args = parseCommonArgs(process.argv.slice(2));
  const fixture = loadFixture(args.fixturePath, args.scenarioId);
  const runtimePort = args.dryRun && !args.runtimePort ? null : await discoverRuntimePort(args.runtimePort);
  const baseUrl = runtimePort == null ? null : `http://127.0.0.1:${runtimePort}`;
  const dbPath = runtimeDbPath(args.workspaceDir);
  const controlPlaneDbPathValue = controlPlaneDbPath(args.workspaceDir);
  const agentsPath = agentsMdPath(args.workspaceDir);

  const cleanup = args.cleanFirst && args.dryRun
    ? cleanupWorkspaceMemory({
        workspaceDir: args.workspaceDir,
        dryRun: args.dryRun,
        agentsBaselinePath: args.agentsBaselinePath,
        includeSessionHistory: true,
        resetAgentsMd: true,
      })
    : null;

  if (args.dryRun) {
    const dryReport = {
      workspace_id: args.workspaceId,
      workspace_dir: args.workspaceDir,
      runtime_port: runtimePort,
      fixture: fixture.path,
      clean: Boolean(args.cleanFirst),
      dry_run: true,
      cleanup,
      scenarios: fixture.scenarios.map((scenario) => scenario.id),
    };
    if (args.outputPath) {
      fs.mkdirSync(path.dirname(path.resolve(args.outputPath)), { recursive: true });
      fs.writeFileSync(path.resolve(args.outputPath), JSON.stringify(dryReport, null, 2));
    }
    console.log(args.json ? JSON.stringify(dryReport, null, 2) : `dry run ready for ${fixture.scenarios.length} scenarios`);
    return;
  }

  const report = {
    workspace_id: args.workspaceId,
    workspace_dir: args.workspaceDir,
    runtime_port: runtimePort,
    fixture: fixture.path,
    fixture_name: fixture.name,
    clean: Boolean(args.cleanFirst),
    cleanup_mode: args.cleanFirst ? "per_scenario" : "none",
    cleanup,
    started_at: new Date().toISOString(),
    initial_counts: workspaceMemoryCounts(dbPath, controlPlaneDbPathValue),
    scenarios: [],
  };

  for (const scenario of fixture.scenarios) {
    const scenarioCleanup = args.cleanFirst
      ? cleanupWorkspaceMemory({
          workspaceDir: args.workspaceDir,
          dryRun: false,
          agentsBaselinePath: args.agentsBaselinePath,
          includeSessionHistory: true,
          resetAgentsMd: true,
        })
      : null;
    const result = await runScenario({
      scenario,
      batchSize: fixture.batchSize,
      includeDirectRetrieval: fixture.includeDirectRetrieval,
      baseUrl,
      workspaceId: args.workspaceId,
      dbPath,
      controlPlaneDbPath: controlPlaneDbPathValue,
      agentsPath,
    }).catch((error) => ({
      scenario_id: scenario.id,
      description: scenario.description ?? "",
      status: "failed",
      failures: [error instanceof Error ? error.message : String(error)],
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      entity_reports: [],
      direct_retrievals: [],
      reader_queries: [],
      quality_metrics: {},
    }));
    if (scenarioCleanup) {
      result.cleanup = scenarioCleanup;
    }
    report.scenarios.push(result);
    writeReport(report, args.outputPath);
  }

  report.completed_at = new Date().toISOString();
  report.final_counts = workspaceMemoryCounts(dbPath, controlPlaneDbPathValue);
  report.status = report.scenarios.some((scenario) => scenario.status === "failed") ? "failed" : "passed";
  report.summary = {
    scenario_count: report.scenarios.length,
    passed_scenarios: report.scenarios.filter((scenario) => scenario.status === "passed").length,
    failed_scenarios: report.scenarios.filter((scenario) => scenario.status === "failed").length,
    skipped_scenarios: report.scenarios.filter((scenario) => scenario.status === "skipped").length,
    total_failures: report.scenarios.reduce(
      (sum, scenario) => sum + (Array.isArray(scenario.failures) ? scenario.failures.length : 0),
      0,
    ),
    average_direct_retrieval_ms: average(
      report.scenarios.flatMap((scenario) =>
        Array.isArray(scenario.direct_retrievals)
          ? scenario.direct_retrievals.map((entry) => entry.latency_ms).filter((value) => value != null)
          : [],
      ),
    ),
    average_reader_answer_ms: average(
      report.scenarios.flatMap((scenario) =>
        Array.isArray(scenario.reader_queries)
          ? scenario.reader_queries.map((entry) => entry.latency_ms).filter((value) => value != null)
          : [],
      ),
    ),
    p95_direct_retrieval_ms: percentile(
      report.scenarios.flatMap((scenario) =>
        Array.isArray(scenario.direct_retrievals)
          ? scenario.direct_retrievals.map((entry) => entry.latency_ms).filter((value) => value != null)
          : [],
      ),
      0.95,
    ),
    p95_reader_answer_ms: percentile(
      report.scenarios.flatMap((scenario) =>
        Array.isArray(scenario.reader_queries)
          ? scenario.reader_queries.map((entry) => entry.latency_ms).filter((value) => value != null)
          : [],
      ),
      0.95,
    ),
    total_direct_queries: report.scenarios.reduce(
      (sum, scenario) => sum + (Array.isArray(scenario.direct_retrievals) ? scenario.direct_retrievals.length : 0),
      0,
    ),
    total_reader_queries: report.scenarios.reduce(
      (sum, scenario) => sum + (Array.isArray(scenario.reader_queries) ? scenario.reader_queries.length : 0),
      0,
    ),
    direct_retrieval_success_rate: (() => {
      const entries = report.scenarios.flatMap((scenario) =>
        Array.isArray(scenario.direct_retrievals) ? scenario.direct_retrievals : [],
      );
      if (entries.length === 0) {
        return null;
      }
      return entries.filter((entry) => entry.matched_hit_rank != null && !entry.failure).length / entries.length;
    })(),
    reader_answer_success_rate: (() => {
      const entries = report.scenarios.flatMap((scenario) =>
        Array.isArray(scenario.reader_queries) ? scenario.reader_queries : [],
      );
      if (entries.length === 0) {
        return null;
      }
      return entries.filter((entry) => entry.answer_correct).length / entries.length;
    })(),
  };

  writeReport(report, args.outputPath);

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    if (report.status !== "passed") {
      process.exitCode = 1;
    }
    return;
  }

  console.log(`fixture: ${fixture.name}`);
  console.log(`workspace: ${args.workspaceDir}`);
  console.log(`runtime: ${baseUrl}`);
  if (cleanup) {
    console.log(`cleanup: ${args.cleanFirst ? "performed" : "skipped"}`);
  }
  console.log("scenarios:");
  for (const scenario of report.scenarios) {
    console.log(
      `  - ${scenario.scenario_id}: status=${scenario.status}, failures=${Array.isArray(scenario.failures) ? scenario.failures.length : 0}, entities=${Array.isArray(scenario.entity_reports) ? scenario.entity_reports.length : 0}, direct_avg_ms=${scenario.quality_metrics?.direct_retrieval_avg_ms ?? "n/a"}, reader_avg_ms=${scenario.quality_metrics?.reader_answer_avg_ms ?? "n/a"}`,
    );
  }
  console.log("final_counts:");
  for (const [key, value] of Object.entries(report.final_counts)) {
    console.log(`  ${key}: ${value}`);
  }
  console.log(`report_status: ${report.status}`);
  if (args.outputPath) {
    console.log(`report_path: ${path.resolve(args.outputPath)}`);
  }
  if (report.status !== "passed") {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
