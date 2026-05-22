import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EVAL_SESSION_TABLES = [
  "agent_runtime_sessions",
  "agent_sessions",
  "conversation_bindings",
  "agent_session_inputs",
  "post_run_jobs",
  "main_session_event_queue",
  "session_runtime_state",
  "session_messages",
  "subagent_runs",
  "session_output_events",
  "terminal_session_events",
  "terminal_sessions",
  "turn_request_snapshots",
  "turn_results",
  "task_proposals",
  "evolve_skill_candidates",
  "memory_update_proposals",
];

function optionValue(argv, flag) {
  const index = argv.indexOf(flag);
  if (index < 0) {
    return null;
  }
  return argv[index + 1] ?? null;
}

function hasFlag(argv, flag) {
  return argv.includes(flag);
}

export function parseCommonArgs(argv) {
  const workspaceId = optionValue(argv, "--workspace-id") ?? process.env.HOLABOSS_WORKSPACE_ID ?? null;
  if (!workspaceId) {
    throw new Error("--workspace-id is required");
  }
  const workspaceDir = resolveWorkspaceDir({
    workspaceId,
    explicitWorkspaceDir: optionValue(argv, "--workspace-dir"),
  });
  return {
    workspaceId,
    workspaceDir,
    runtimePort: optionValue(argv, "--runtime-port"),
    fixturePath: optionValue(argv, "--fixture"),
    outputPath: optionValue(argv, "--output"),
    scenarioId: optionValue(argv, "--scenario"),
    cleanFirst: hasFlag(argv, "--clean"),
    json: hasFlag(argv, "--json"),
    dryRun: hasFlag(argv, "--dry-run"),
    agentsBaselinePath: optionValue(argv, "--agents-baseline-file"),
  };
}

export function resolveWorkspaceDir(params) {
  if (params.explicitWorkspaceDir) {
    return path.resolve(params.explicitWorkspaceDir);
  }
  const profileRoot =
    process.env.HOLABOSS_PROFILE_ROOT ??
    path.join(os.homedir(), "Library/Application Support/holaboss-local-o1/sandbox-host/workspace");
  return path.join(profileRoot, params.workspaceId);
}

export function runtimeDbPath(workspaceDir) {
  return path.join(workspaceDir, ".holaboss", "state", "runtime.db");
}

export function controlPlaneDbPath(workspaceDir) {
  return path.resolve(workspaceDir, "..", "..", "state", "control-plane.db");
}

export function interactionMemoryDir(workspaceDir) {
  return path.join(workspaceDir, ".holaboss", "memory", "interaction");
}

export function integrationMemoryDir(workspaceDir) {
  return path.join(workspaceDir, ".holaboss", "memory", "integration");
}

export function agentsMdPath(workspaceDir) {
  return path.join(workspaceDir, "AGENTS.md");
}

export function piSessionsDir(workspaceDir) {
  return path.join(workspaceDir, ".holaboss", "pi-sessions");
}

export function legacySessionHistoriesDir(workspaceDir) {
  return path.join(workspaceDir, ".holaboss", "state", "legacy-session-histories");
}

export function readTextIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

export function runSql(dbPath, sql) {
  return execFileSync("sqlite3", [dbPath, sql], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function runSqlRows(dbPath, sql) {
  const output = execFileSync("sqlite3", ["-separator", "\t", dbPath, sql], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  if (!output) {
    return [];
  }
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.split("\t"));
}

function sqliteTableNames(dbPath) {
  return new Set(
    runSqlRows(
      dbPath,
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name ASC;",
    ).map(([name]) => String(name ?? "")),
  );
}

export function workspaceMemoryCounts(runtimeDbPathValue, controlPlaneDbPathValue = null) {
  const interactionRows = runSqlRows(
    runtimeDbPathValue,
    `
      select 'active_entities', count(*) from interaction_entities where status='active'
      union all
      select 'active_leaves', count(*) from interaction_leaves where status='active'
      union all
      select 'active_summaries', count(*) from interaction_summary_nodes where status='active'
    `,
  );
  const integrationRows = controlPlaneDbPathValue
    ? runSqlRows(
        controlPlaneDbPathValue,
        `
      select 'active_integration_trees', count(*) from integration_trees where status='active'
      union all
      select 'active_integration_leaves', count(*) from integration_leaves where status='active'
      union all
      select 'active_integration_summaries', count(*) from integration_summary_nodes where status='active'
    `,
      )
    : [
        ["active_integration_trees", "0"],
        ["active_integration_leaves", "0"],
        ["active_integration_summaries", "0"],
      ];
  return Object.fromEntries([...interactionRows, ...integrationRows].map(([key, value]) => [key, Number(value ?? 0)]));
}

export function interactionMemoryCounts(dbPath, controlPlaneDbPathValue = null) {
  return workspaceMemoryCounts(dbPath, controlPlaneDbPathValue);
}

export function cleanupWorkspaceMemory(params) {
  if (!fs.existsSync(params.workspaceDir)) {
    throw new Error(`workspace dir not found: ${params.workspaceDir}`);
  }
  const dbPath = runtimeDbPath(params.workspaceDir);
  const cpDbPath = controlPlaneDbPath(params.workspaceDir);
  if (!fs.existsSync(dbPath)) {
    throw new Error(`runtime db not found: ${dbPath}`);
  }
  if (!fs.existsSync(cpDbPath)) {
    throw new Error(`control-plane db not found: ${cpDbPath}`);
  }
  if (!params.dryRun) {
    const runtimeTableNames = sqliteTableNames(dbPath);
    const sessionDeletes = params.includeSessionHistory === true
      ? EVAL_SESSION_TABLES.filter((name) => runtimeTableNames.has(name)).map((name) => `DELETE FROM ${name};`)
      : [];
    execFileSync(
      "sqlite3",
      [
        dbPath,
        `
          BEGIN IMMEDIATE;
          ${sessionDeletes.join("\n          ")}
          DELETE FROM interaction_node_embeddings;
          DELETE FROM interaction_tree_edges;
          DELETE FROM interaction_summary_nodes;
          DELETE FROM interaction_leaves;
          DELETE FROM interaction_entities;
          DELETE FROM workspace_runtime_metadata
            WHERE key LIKE 'interaction_memory_batch_%';
          COMMIT;
        `,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    execFileSync(
      "sqlite3",
      [
        cpDbPath,
        `
          BEGIN IMMEDIATE;
          DELETE FROM integration_node_embeddings;
          DELETE FROM integration_node_relations;
          DELETE FROM integration_tree_edges;
          DELETE FROM integration_summary_nodes;
          DELETE FROM integration_leaves;
          DELETE FROM integration_trees;
          COMMIT;
        `,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    fs.rmSync(interactionMemoryDir(params.workspaceDir), { recursive: true, force: true });
    fs.rmSync(integrationMemoryDir(params.workspaceDir), { recursive: true, force: true });
    if (params.includeSessionHistory === true) {
      fs.rmSync(piSessionsDir(params.workspaceDir), { recursive: true, force: true });
      fs.rmSync(legacySessionHistoriesDir(params.workspaceDir), { recursive: true, force: true });
      fs.mkdirSync(piSessionsDir(params.workspaceDir), { recursive: true });
      fs.mkdirSync(legacySessionHistoriesDir(params.workspaceDir), { recursive: true });
    }
    fs.mkdirSync(path.join(interactionMemoryDir(params.workspaceDir), "entities"), { recursive: true });
    fs.mkdirSync(path.join(integrationMemoryDir(params.workspaceDir), "trees"), { recursive: true });

    if (params.resetAgentsMd === true || params.agentsBaselinePath) {
      const baseline = params.agentsBaselinePath
        ? fs.readFileSync(path.resolve(params.agentsBaselinePath), "utf8")
        : "";
      fs.writeFileSync(agentsMdPath(params.workspaceDir), baseline, "utf8");
    }
  }
  return {
    dbPath,
    controlPlaneDbPath: cpDbPath,
    workspaceDir: params.workspaceDir,
    counts: workspaceMemoryCounts(dbPath, cpDbPath),
    agentsPath: agentsMdPath(params.workspaceDir),
    sessionHistoryCleared: params.includeSessionHistory === true,
    agentsReset: params.resetAgentsMd === true || Boolean(params.agentsBaselinePath),
  };
}

export function cleanupInteractionMemory(params) {
  return cleanupWorkspaceMemory(params);
}

export async function discoverRuntimePort(explicitPort) {
  if (explicitPort) {
    return Number(explicitPort);
  }
  for (let port = 40250; port <= 40320; port += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) {
        return port;
      }
    } catch {
      // continue
    }
  }
  throw new Error("no live runtime port found between 40250 and 40320");
}

export async function fetchJson(url, init) {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`request failed (${response.status}) ${url}${body ? `: ${body}` : ""}`);
  }
  return await response.json();
}

export function sanitizeSessionId(value) {
  return value.replace(/[^a-zA-Z0-9._:-]+/g, "-");
}

export function includesAllTerms(haystack, terms) {
  const normalized = String(haystack ?? "").toLowerCase();
  return terms.every((term) => normalized.includes(String(term).toLowerCase()));
}

export function matchingTerms(haystack, terms) {
  const normalized = String(haystack ?? "").toLowerCase();
  return terms.filter((term) => normalized.includes(String(term).toLowerCase()));
}
