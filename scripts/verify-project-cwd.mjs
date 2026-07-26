#!/usr/bin/env node
/**
 * verify-project-cwd.mjs
 *
 * Pass/fail check for the "project session reports workspace_dir as cwd" bug.
 *
 * The bug surfaces because the pi-coding-agent SDK bakes its `SessionManager.cwd`
 * into the JSONL session file's header at creation time (`{ type: "session",
 * cwd: <value> }`). On every subsequent open, the SDK reads that header back
 * and uses it in the agent's system prompt ("Current working directory: ...")
 * and as the root for Bash and the boundary policy. If any chat in the flow
 * passes workspace_dir as the SDK's `cwd`, the wrong path gets persisted to
 * disk and survives every later run.
 *
 * What this verifies, per workspace:
 *
 *   1. For each cwd-scoped entry in `<ws>/.holaboss/state/harness-session-state.json`
 *      (e.g. `pi@/Users/you/Holaboss/Projects/Test7`), the linked JSONL
 *      file's `cwd` header equals the scoped cwd. Mismatch = bug.
 *
 *   2. The bare-harness `pi` entry's JSONL header `cwd` is either the
 *      workspace dir (legacy General) or the user's HOME (new General). The
 *      script treats anything else as a mismatch.
 *
 * Exits 0 if all checked pi-session headers agree with their declared cwd,
 * 1 otherwise. Designed to be the loop condition for `/goal` iteration.
 *
 * Usage:
 *   node scripts/verify-project-cwd.mjs              # check every workspace
 *   node scripts/verify-project-cwd.mjs <ws-uuid>    # check just one workspace
 *   node scripts/verify-project-cwd.mjs --clean      # delete every scoped
 *                                                    # pi entry + its JSONL
 *                                                    # so the next chat in
 *                                                    # each project starts
 *                                                    # fresh.
 *   node scripts/verify-project-cwd.mjs --clean <ws-uuid>
 *   node scripts/verify-project-cwd.mjs --watch      # clean state, then poll
 *                                                    # harness-session-state
 *                                                    # until a NEW scoped pi
 *                                                    # entry appears; verify
 *                                                    # its JSONL header.
 *                                                    # Exits PASS the moment
 *                                                    # a correct entry shows
 *                                                    # up; FAIL the moment a
 *                                                    # bad one does. Pair
 *                                                    # with a single chat
 *                                                    # message to get the
 *                                                    # closest thing to a
 *                                                    # closed-loop check.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SANDBOX_HOST_ROOT = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "holaboss-local-dev-team-sdk",
  "sandbox-host",
);
const WORKSPACE_ROOT = path.join(SANDBOX_HOST_ROOT, "workspace");

function readJsonOrNull(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function readFirstJsonlEntry(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const firstLine = raw.split("\n").find((line) => line.trim().length > 0);
    return firstLine ? JSON.parse(firstLine) : null;
  } catch {
    return null;
  }
}

function parseScopedKey(key) {
  // harnessSessionMapKey persists `harness@<resolved-path>` (lowercased on
  // some paths via Map insertion, originals on others). We split on the
  // first `@`.
  const atIndex = key.indexOf("@");
  if (atIndex < 0) return { harness: key, scopedCwd: null };
  return {
    harness: key.slice(0, atIndex),
    scopedCwd: key.slice(atIndex + 1),
  };
}

function normalizeForCompare(value) {
  // Case-insensitive comparison: macOS HFS+/APFS are case-insensitive
  // by default, so `/users/you/...` and `/Users/You/...` refer to
  // the same dir. The harness-state key lowercases via Map insertion in
  // some paths; the JSONL header cwd preserves original case.
  return path.resolve(value).toLowerCase();
}

function checkWorkspace(workspaceDir) {
  const statePath = path.join(
    workspaceDir,
    ".holaboss",
    "state",
    "harness-session-state.json",
  );
  const state = readJsonOrNull(statePath);
  if (!state || !state.harness_sessions) {
    return {
      workspaceDir,
      checks: [],
      skipReason: "no harness-session-state.json",
    };
  }

  const homeDir = os.homedir();
  const checks = [];

  for (const [key, entry] of Object.entries(state.harness_sessions)) {
    const sessionId = entry?.session_id;
    if (typeof sessionId !== "string" || !sessionId) continue;

    const { harness, scopedCwd } = parseScopedKey(key);
    if (harness !== "pi") continue;

    const header = readFirstJsonlEntry(sessionId);
    if (!header || header.type !== "session") {
      checks.push({
        key,
        scopedCwd,
        sessionFile: sessionId,
        headerCwd: null,
        status: "MISSING_HEADER",
      });
      continue;
    }

    const headerCwd = typeof header.cwd === "string" ? header.cwd : "";
    let expected;
    if (scopedCwd) {
      expected = scopedCwd;
    } else {
      // Bare-harness entry: accept either the workspace dir (legacy) or HOME
      // (current General default). The user has confirmed General sessions
      // should run from HOME, but pre-existing files may still be workspace-
      // scoped — flag those as a soft warning, not a hard fail.
      expected = homeDir;
    }

    const ok = normalizeForCompare(headerCwd) === normalizeForCompare(expected);
    checks.push({
      key,
      scopedCwd,
      sessionFile: sessionId,
      headerCwd,
      expected,
      status: ok ? "OK" : scopedCwd ? "MISMATCH" : "LEGACY_GENERAL",
    });
  }

  return { workspaceDir, checks };
}

function cleanWorkspace(workspaceDir) {
  // Remove scoped pi entries from harness-session-state and unlink the
  // JSONL files they point at. We deliberately KEEP the bare-harness `pi`
  // entry (General session) so HOME/legacy chats are not disturbed.
  const statePath = path.join(
    workspaceDir,
    ".holaboss",
    "state",
    "harness-session-state.json",
  );
  const state = readJsonOrNull(statePath);
  if (!state?.harness_sessions) {
    return { workspaceDir, removed: [], kept: [] };
  }
  const kept = {};
  const removed = [];
  for (const [key, entry] of Object.entries(state.harness_sessions)) {
    const sessionId = entry?.session_id;
    const { harness, scopedCwd } = parseScopedKey(key);
    if (harness === "pi" && scopedCwd) {
      if (typeof sessionId === "string" && sessionId) {
        try {
          fs.unlinkSync(sessionId);
        } catch {}
      }
      removed.push(key);
    } else {
      kept[key] = entry;
    }
  }
  const next = { ...state, harness_sessions: kept };
  fs.writeFileSync(statePath, JSON.stringify(next), "utf8");
  return { workspaceDir, removed, kept: Object.keys(kept) };
}

function pickWorkspaces(argv) {
  if (argv.length > 0) {
    return argv.map((id) => path.join(WORKSPACE_ROOT, id));
  }
  if (!fs.existsSync(WORKSPACE_ROOT)) return [];
  return fs
    .readdirSync(WORKSPACE_ROOT)
    .filter((name) => name !== "~" && !name.startsWith("."))
    .map((name) => path.join(WORKSPACE_ROOT, name))
    .filter((dir) => {
      try {
        return fs.statSync(dir).isDirectory();
      } catch {
        return false;
      }
    });
}

function shortWorkspace(workspaceDir) {
  return path.basename(workspaceDir);
}

async function watchUntilProjectSession(workspaces, options = {}) {
  // Closed-loop helper. Steps:
  //   1. Wipe all scoped pi entries (and their JSONLs) up-front so we only
  //      observe what the runtime produces after this point.
  //   2. Poll each workspace's harness-session-state.json. The first time
  //      a scoped `pi@<cwd>` entry appears, check the linked JSONL header.
  //   3. Exit immediately on first verdict: PASS if the new entry's header
  //      matches its scoped cwd, FAIL otherwise.
  //
  // The user only needs to type one chat message in a project after invoking
  // this; everything else (cleaning state, watching, verifying) is automated.
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  const timeoutMs = options.timeoutMs ?? 5 * 60_000;
  for (const workspaceDir of workspaces) {
    const result = cleanWorkspace(workspaceDir);
    console.log(
      `cleaned ${shortWorkspace(workspaceDir)}: removed=${result.removed.length}`,
    );
  }
  console.log();
  console.log(
    "Watching. Send ONE chat message in a project, then wait for the verdict.",
  );
  console.log("(Ctrl-C to abort.)");
  console.log();
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    for (const workspaceDir of workspaces) {
      const result = checkWorkspace(workspaceDir);
      const scopedChecks = result.checks.filter((c) => c.scopedCwd);
      if (scopedChecks.length === 0) continue;
      const newest = scopedChecks[scopedChecks.length - 1];
      console.log(`detected ${newest.key}`);
      console.log(`  file=${path.basename(newest.sessionFile)}`);
      console.log(`  headerCwd=${newest.headerCwd ?? "(none)"}`);
      console.log(`  expected=${newest.expected}`);
      if (newest.status === "OK") {
        console.log();
        console.log("RESULT: PASS — header matches scoped cwd.");
        process.exit(0);
      }
      console.log();
      console.log(`RESULT: FAIL — ${newest.status}`);
      process.exit(1);
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  console.log();
  console.log(`RESULT: TIMEOUT — no scoped pi session appeared in ${timeoutMs}ms.`);
  process.exit(3);
}

function main() {
  const argv = process.argv.slice(2);
  const cleanFlag = argv.includes("--clean");
  const watchFlag = argv.includes("--watch");
  const positional = argv.filter((arg) => !arg.startsWith("--"));
  const workspaces = pickWorkspaces(positional);
  if (workspaces.length === 0) {
    console.error("No workspaces found under", WORKSPACE_ROOT);
    process.exit(2);
  }

  if (watchFlag) {
    void watchUntilProjectSession(workspaces);
    return;
  }

  if (cleanFlag) {
    for (const workspaceDir of workspaces) {
      const result = cleanWorkspace(workspaceDir);
      console.log(
        `workspace ${shortWorkspace(workspaceDir)}: removed=${result.removed.length} kept=${result.kept.length}`,
      );
      for (const key of result.removed) {
        console.log(`  - ${key}`);
      }
    }
    console.log();
    console.log("RESULT: CLEANED — start a fresh chat in each project to repopulate.");
    process.exit(0);
  }

  let hardFail = 0;
  let softWarn = 0;
  let okCount = 0;

  for (const workspaceDir of workspaces) {
    const result = checkWorkspace(workspaceDir);
    if (result.skipReason) {
      console.log(`workspace ${shortWorkspace(workspaceDir)}: ${result.skipReason}`);
      continue;
    }
    if (result.checks.length === 0) {
      console.log(`workspace ${shortWorkspace(workspaceDir)}: (no pi sessions)`);
      continue;
    }
    console.log(`workspace ${shortWorkspace(workspaceDir)}:`);
    for (const check of result.checks) {
      const marker =
        check.status === "OK"
          ? "  OK     "
          : check.status === "MISMATCH"
            ? "  FAIL   "
            : check.status === "LEGACY_GENERAL"
              ? "  WARN   "
              : "  ?      ";
      const file = path.basename(check.sessionFile);
      const expectedNote =
        check.expected != null ? `  expected=${check.expected}` : "";
      console.log(
        `${marker}${check.key}\n         file=${file}\n         headerCwd=${check.headerCwd ?? "(none)"}${expectedNote}`,
      );
      if (check.status === "MISMATCH" || check.status === "MISSING_HEADER") {
        hardFail += 1;
      } else if (check.status === "LEGACY_GENERAL") {
        softWarn += 1;
      } else {
        okCount += 1;
      }
    }
  }

  console.log();
  console.log(`summary: ok=${okCount} fail=${hardFail} legacy_general=${softWarn}`);
  if (hardFail > 0) {
    console.log("RESULT: FAIL — at least one project session has the wrong cwd in its JSONL header.");
    process.exit(1);
  }
  console.log("RESULT: PASS — every cwd-scoped pi session matches its declared cwd.");
  process.exit(0);
}

main();
