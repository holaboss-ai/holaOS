/**
 * hola — developer CLI for the Hola (pi) harness.
 *
 * Runs the pi brain IN-PROCESS FROM SOURCE against the real root sandbox, reusing
 * the runtime's actual request-build pipeline (`executeTsRunnerRequest`) — so MCP
 * servers, skills, tools, and injected context match a desktop run — and swapping
 * only the harness-host subprocess spawn for an in-process `runPi`. That means
 * breakpoints in `pi.ts` work and there's no build/stage loop.
 *
 * Design decisions (see the design thread): option A (in-process from source) +
 * option 1 (hola OWNS the root runtime — run with the desktop CLOSED). The tool
 * launches a runtime against the chosen root for the HTTP-backed tools
 * (runtime-agent-tools / composio / browser / web-search), or reuses one already
 * serving that root.
 *
 * Run via the api-server's tsx (this file is intentionally outside every package
 * tsconfig so it never pollutes a `tsc --noEmit`):
 *   node --import tsx scripts/hola.ts --sandbox-root <root> --prompt "…"
 * or `npm --prefix runtime/api-server run hola -- --sandbox-root <root> -p "…"`.
 *
 * SAFETY: opening a real root's data.db runs migrations and shares the DB. Do NOT
 * run this while the desktop is live on the same root — the tool refuses if the
 * root's WAL looks hot unless you pass --force.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { RuntimeStateStore } from "@holaboss/runtime-state-store";

import { resolveCanonicalWorkspaceId } from "../runtime/api-server/src/canonical-workspace.js";
import { resolveProductRuntimeConfig } from "../runtime/api-server/src/runtime-config.js";
import { executeTsRunnerRequest } from "../runtime/api-server/src/ts-runner.js";
import type {
  TsRunnerEvent,
  TsRunnerRequest,
} from "../runtime/api-server/src/ts-runner-contracts.js";
import { workspaceDirForId } from "../runtime/api-server/src/ts-runner-session-state.js";
import type { HarnessHostPiRequest } from "../runtime/harness-host/src/contracts.js";
import { defaultPiDeps, runPi } from "../runtime/harness-host/src/pi.js";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — JS launcher helpers, resolved at runtime by tsx.
import {
  resolveRuntimeLauncherPath,
  standaloneRuntimeApiPortForSandboxRoot,
} from "./isolated-runtime-launchers.mjs";

// ── ANSI helpers (no deps) ─────────────────────────────────────────────────
const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  gray: (s: string) => `\x1b[90m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};
function log(line = ""): void {
  process.stderr.write(`${line}\n`);
}
function die(message: string, code = 1): never {
  log(C.red(`hola: ${message}`));
  process.exit(code);
}

// ── args ───────────────────────────────────────────────────────────────────
interface Args {
  sandboxRoot: string;
  prompt: string;
  cwd: string | null;
  model: string | null;
  session: string | null;
  fresh: boolean;
  port: number | null;
  noRuntime: boolean;
  keep: boolean;
  force: boolean;
  printRequest: boolean;
  debug: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    sandboxRoot: (process.env.HB_SANDBOX_ROOT ?? "").trim(),
    prompt: "",
    cwd: null,
    model: null,
    session: null,
    fresh: false,
    port: null,
    noRuntime: false,
    keep: false,
    force: false,
    printRequest: false,
    debug: false,
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = () => {
      const v = argv[++i];
      if (v === undefined) die(`missing value for ${arg}`);
      return v;
    };
    switch (arg) {
      case "--sandbox-root": a.sandboxRoot = next(); break;
      case "-p":
      case "--prompt": a.prompt = next(); break;
      case "--cwd": a.cwd = next(); break;
      case "--model":
      case "-m": a.model = next(); break;
      case "--session":
      case "-s": a.session = next(); break;
      case "--fresh": a.fresh = true; break;
      case "--port": a.port = Number.parseInt(next(), 10); break;
      case "--no-runtime": a.noRuntime = true; break;
      case "--keep": a.keep = true; break;
      case "--force": a.force = true; break;
      case "--print-request": a.printRequest = true; break;
      case "--debug": a.debug = true; break;
      case "-h":
      case "--help": printHelp(); process.exit(0); break;
      default:
        if (arg.startsWith("-")) die(`unknown flag ${arg}`);
        positional.push(arg);
    }
  }
  if (!a.prompt && positional.length > 0) a.prompt = positional.join(" ");
  return a;
}

function printHelp(): void {
  log(`${C.bold("hola")} — run the Hola (pi) brain in-process from source for debugging.

Usage:
  npm --prefix runtime/api-server run hola -- --sandbox-root <root> -p "your prompt"

Options:
  --sandbox-root <path>   The root sandbox-host dir. Default: auto-detected from
                          this checkout's apps/desktop/.env (or HB_SANDBOX_ROOT).
  -p, --prompt <text>     The prompt to send (or pass it positionally).
  --cwd <dir>             Agent working dir. Default: the canonical workspace dir.
  -m, --model <id>        Model override. Default: the runtime's configured model.
  -s, --session <path>    Resume a specific pi session file. Default: continue the
                          workspace's last session (or start fresh if none).
  --fresh                 Force a brand-new session, ignoring the last one (and
                          don't overwrite it). Mutually exclusive with --session.
  --port <n>              Runtime backend port. Default: derived from the root.
  --no-runtime            Don't launch/use a runtime backend (HTTP-backed tools
                          degrade; brain + model + workspace MCP still work).
  --keep                  Leave the launched runtime running on exit.
  --force                 Run even if the root's DB looks hot (a desktop is live).
  --print-request         Build the request, print it, and exit (still opens the DB).
  --debug                 Print raw runner events instead of the pretty stream.

Run with the desktop CLOSED on the same root.`);
}

// ── root + safety ────────────────────────────────────────────────────────────
function listCandidateRoots(): string[] {
  const base = path.join(os.homedir(), "Library", "Application Support");
  if (!fs.existsSync(base)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(base)) {
    const root = path.join(base, entry, "sandbox-host");
    if (fs.existsSync(path.join(root, "state", "control-plane.db"))) out.push(root);
  }
  return out;
}

/** A non-empty -wal alongside a -shm means another process likely has the DB
 *  open (a live desktop). Best-effort heuristic. */
function rootLooksHot(root: string): boolean {
  const wal = path.join(root, "state", "data.db-wal");
  try {
    return fs.existsSync(wal) && fs.statSync(wal).size > 0;
  } catch {
    return false;
  }
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Electron's `app.getPath("appData")` base, per platform. */
function appDataBase(): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support");
  }
  if (process.platform === "win32") {
    return process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
  }
  return process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
}

function parseEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(file)) return out;
  for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Derive the checkout's root sandbox-host the same way the desktop computes its
 * userData dir (electron/main.ts `configureStableUserDataPath`):
 *   userData = HOLABOSS_DESKTOP_USER_DATA_PATH ?? <appData>/<HOLABOSS_DESKTOP_USER_DATA_DIR
 *              or "holaboss-local-dev">   (`/` → `_`)
 *   root     = <userData>/sandbox-host
 * Reads apps/desktop/.env so plain `hola -p "…"` just works for this checkout.
 */
function autoDetectRoot(): { root: string; source: string } | null {
  const env = parseEnvFile(path.join(REPO_ROOT, "apps", "desktop", ".env"));
  const explicitPath =
    (process.env.HOLABOSS_DESKTOP_USER_DATA_PATH ?? env.HOLABOSS_DESKTOP_USER_DATA_PATH ?? "").trim();
  let userData: string;
  if (explicitPath) {
    userData = path.resolve(explicitPath);
  } else {
    const dir = (
      (process.env.HOLABOSS_DESKTOP_USER_DATA_DIR ?? env.HOLABOSS_DESKTOP_USER_DATA_DIR ?? "").trim() ||
      "holaboss-local-dev"
    ).replace(/[\\/]+/g, "_");
    userData = path.join(appDataBase(), dir);
  }
  const root = path.join(userData, "sandbox-host");
  return fs.existsSync(path.join(root, "state", "control-plane.db"))
    ? { root, source: "apps/desktop/.env" }
    : null;
}

function resolveRoot(a: Args): string {
  let sandboxRoot = a.sandboxRoot;
  if (!sandboxRoot) {
    const detected = autoDetectRoot();
    if (detected) {
      log(C.dim(`▸ root auto-detected from ${detected.source}`));
      sandboxRoot = detected.root;
    }
  }
  if (!sandboxRoot) {
    log(C.red("hola: could not auto-detect a root from apps/desktop/.env; pass --sandbox-root."));
    const candidates = listCandidateRoots();
    if (candidates.length > 0) {
      log(C.dim("\nCandidate roots on this machine:"));
      for (const c of candidates) {
        log(`  ${rootLooksHot(c) ? C.yellow("[live?] ") : "        "}${c}`);
      }
    }
    process.exit(2);
  }
  const root = path.resolve(sandboxRoot);
  if (!fs.existsSync(path.join(root, "state", "control-plane.db"))) {
    die(`no runtime state at ${root} (expected state/control-plane.db).`);
  }
  if (rootLooksHot(root) && !a.force) {
    die(
      `${root} looks live (hot data.db-wal) — a desktop may be running on it.\n` +
        `Close the desktop, or pass --force to override (risks DB contention).`,
    );
  }
  return root;
}

// ── runtime env ──────────────────────────────────────────────────────────────
function applyRootEnv(root: string, runtimeApiUrl: string | null): void {
  const state = path.join(root, "state");
  process.env.HB_SANDBOX_ROOT = root;
  process.env.HOLABOSS_HOST_STATE_DB_PATH = path.join(state, "host-state.db");
  process.env.HOLABOSS_RUNTIME_DB_PATH = path.join(state, "host-state.db");
  process.env.HOLABOSS_CONTROL_PLANE_DB_PATH = path.join(state, "control-plane.db");
  process.env.HOLABOSS_RUNTIME_CONFIG_PATH = path.join(state, "runtime-config.json");
  process.env.SANDBOX_AGENT_HARNESS = "pi";
  if (runtimeApiUrl) {
    process.env.SANDBOX_RUNTIME_API_URL = runtimeApiUrl;
  }
}

// ── runtime backend (option 1: hola owns it) ─────────────────────────────────
async function runtimeReady(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/api/v1/runtime/status`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.status < 500;
  } catch {
    return false;
  }
}

async function ensureRuntime(
  root: string,
  port: number,
): Promise<{ url: string; stop: () => void }> {
  const url = `http://127.0.0.1:${port}`;
  if (await runtimeReady(url)) {
    log(C.dim(`▸ reusing runtime at ${url}`));
    return { url, stop: () => {} };
  }
  const { launcherPath, bundleState } = await resolveRuntimeLauncherPath({ autoPrepare: true });
  log(C.dim(`▸ launching runtime against root on ${url} …`));
  const child: ChildProcess = spawn(launcherPath, [], {
    cwd: bundleState.runtimeRoot,
    env: {
      ...process.env,
      SANDBOX_AGENT_BIND_HOST: "127.0.0.1",
      SANDBOX_AGENT_BIND_PORT: String(port),
      SANDBOX_RUNTIME_API_PORT: String(port),
    },
    stdio: ["ignore", "ignore", "inherit"],
    detached: false,
  });
  child.on("error", (e) => die(`failed to launch runtime: ${e.message}`));
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) die(`runtime exited early (code ${child.exitCode}).`);
    if (await runtimeReady(url)) {
      log(C.dim(`▸ runtime ready at ${url}`));
      return {
        url,
        stop: () => {
          try {
            child.kill("SIGTERM");
          } catch {
            // already gone
          }
        },
      };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // ignore
  }
  die(`runtime did not become ready at ${url} within 60s.`);
}

// ── pretty printer ───────────────────────────────────────────────────────────
function makePrinter(debug: boolean) {
  let streaming: "" | "output" | "thinking" = "";
  const endStream = () => {
    if (streaming) {
      process.stdout.write("\n");
      streaming = "";
    }
  };
  const toolName = (p: Record<string, unknown>) =>
    typeof p.tool_name === "string" ? p.tool_name : "tool";
  return (event: TsRunnerEvent): void => {
    if (debug) {
      endStream();
      process.stdout.write(`${JSON.stringify(event)}\n`);
      return;
    }
    const p = event.payload ?? {};
    switch (event.event_type) {
      case "run_started":
        log(C.dim(`▶ pi started`));
        break;
      case "thinking_delta": {
        if (typeof p.delta === "string") {
          if (streaming !== "thinking") {
            endStream();
            process.stdout.write(C.gray("· "));
            streaming = "thinking";
          }
          process.stdout.write(C.gray(p.delta));
        }
        break;
      }
      case "output_delta": {
        if (typeof p.delta === "string") {
          if (streaming !== "output") {
            endStream();
            streaming = "output";
          }
          process.stdout.write(p.delta);
        }
        break;
      }
      case "tool_call": {
        endStream();
        const phase = p.phase === "completed" ? "↳" : "⚙";
        if (p.phase === "completed") {
          const err = p.error ? C.red(" (error)") : "";
          log(C.dim(`  ${phase} ${toolName(p)}${err}`));
        } else {
          const args = p.tool_args !== undefined ? C.dim(` ${truncate(JSON.stringify(p.tool_args), 120)}`) : "";
          log(C.cyan(`${phase} ${toolName(p)}`) + args);
        }
        break;
      }
      case "mcp_server_unavailable":
        endStream();
        log(C.yellow(`⚠ MCP server unavailable: ${truncate(JSON.stringify(p), 200)}`));
        break;
      case "run_completed": {
        endStream();
        log(C.green(`✓ done`));
        if (p.harness_session_id) log(C.dim(`  session: ${p.harness_session_id}`));
        if (p.usage) log(C.dim(`  usage: ${truncate(JSON.stringify(p.usage), 200)}`));
        break;
      }
      case "run_failed":
        endStream();
        log(C.red(`✗ failed: ${typeof p.error === "string" ? p.error : JSON.stringify(p)}`));
        break;
      default:
        break;
    }
  };
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2));
  if (!a.prompt && !a.printRequest) {
    printHelp();
    process.exit(2);
  }
  const root = resolveRoot(a);
  const port = a.port ?? Number(standaloneRuntimeApiPortForSandboxRoot(root));

  // Apply the root env BEFORE launching the runtime child so it inherits
  // HB_SANDBOX_ROOT + the DB paths; otherwise it defaults to /holaboss and
  // dies with "mkdir: /holaboss: Read-only file system".
  applyRootEnv(root, null);

  let runtime: { url: string; stop: () => void } = { url: "", stop: () => {} };
  if (!a.noRuntime && !a.printRequest) {
    runtime = await ensureRuntime(root, port);
    process.env.SANDBOX_RUNTIME_API_URL = runtime.url;
  }

  // Open the store to resolve the canonical (root) workspace + product config.
  const store = new RuntimeStateStore({
    workspaceRoot: path.join(root, "workspace"),
    sandboxRoot: root,
    dbPath: path.join(root, "state", "host-state.db"),
    controlPlaneDbPath: path.join(root, "state", "control-plane.db"),
    sandboxAgentHarness: "pi",
  });

  let workspaceId = "";
  try {
    workspaceId = resolveCanonicalWorkspaceId(store, (ids) =>
      log(C.yellow(`⚠ ${ids.length} workspaces — using the most recent (${ids[0]}).`)),
    );
  } finally {
    store.close();
  }
  if (!workspaceId) {
    die(`no workspace found in ${root} — open it in the desktop once to provision one.`);
  }

  const config = resolveProductRuntimeConfig();
  const workspaceDir = workspaceDirForId(workspaceId);
  const cwd = a.cwd ? path.resolve(a.cwd) : workspaceDir;

  // Session selection:
  //   --session <path> → resume that file (if it exists on disk).
  //   --fresh          → a non-existent sentinel path forces a brand-new session
  //                      (resolveRequestedSessionFile returns null when the
  //                      requested path is missing — it does NOT fall back to the
  //                      persisted one), and ephemeral_harness_session keeps it
  //                      from overwriting the workspace's saved session.
  //   (default)        → no harness_session_id → the pipeline auto-resumes the
  //                      workspace's last pi session.
  let sessionContext: Record<string, unknown> = {};
  if (a.session && a.fresh) {
    die("--session and --fresh are mutually exclusive.");
  } else if (a.session) {
    sessionContext = { harness_session_id: a.session };
  } else if (a.fresh) {
    sessionContext = {
      harness_session_id: path.join(os.tmpdir(), `hola-fresh-${process.pid}-${Date.now()}`),
      ephemeral_harness_session: true,
    };
  }

  const request: TsRunnerRequest = {
    workspace_id: workspaceId,
    agent_cwd: cwd,
    session_id: `hola-dev-${process.pid}`,
    session_kind: "main_session",
    input_id: `hola-dev-${Date.now()}`,
    instruction: a.prompt || "(no prompt)",
    context: {
      _sandbox_runtime_exec_v1: {
        harness: "pi",
        model_proxy_api_key: config.authToken,
        sandbox_id: config.sandboxId,
        run_id: `hola-dev-${Date.now()}`,
        ...sessionContext,
      },
    },
    model: a.model,
    thinking_value: null,
    debug: a.debug,
  };

  log(C.dim(`▸ root: ${root}`));
  log(C.dim(`▸ workspace: ${workspaceId}  cwd: ${cwd}`));
  log(C.dim(`▸ model: ${a.model ?? "(runtime default)"}  runtime: ${runtime.url || "(none)"}`));

  if (a.printRequest) {
    process.stdout.write(`${JSON.stringify(request, null, 2)}\n`);
    return;
  }

  const print = makePrinter(a.debug);
  let exitCode = 0;
  try {
    await executeTsRunnerRequest(request, {
      emitEvent: async (event) => {
        print(event);
        if (event.event_type === "run_failed") exitCode = 1;
      },
      deps: {
        // Swap the harness-host subprocess spawn for an in-process runPi, so the
        // brain runs from source (breakpoints) while every other build stage runs
        // for real. Events forward through the pipeline relay (which persists the
        // harness_session_id for resume) and on to our emitEvent above.
        runHarnessHost: async ({ requestPayload, emitEvent }) => {
          let lastSequence = 0;
          const code = await runPi(requestPayload as HarnessHostPiRequest, {
            ...defaultPiDeps(),
            emitEvent: (req, sequence, event_type, payload) => {
              lastSequence = sequence;
              void emitEvent({
                session_id: req.session_id,
                input_id: req.input_id,
                sequence,
                event_type,
                timestamp: new Date().toISOString(),
                payload,
              });
            },
          });
          return {
            exitCode: code,
            stderr: "",
            sawEvent: true,
            terminalEmitted: true,
            lastSequence,
          };
        },
      },
    });
  } finally {
    if (!a.keep) runtime.stop();
  }
  process.exit(exitCode);
}

main().catch((error) => {
  die(error instanceof Error ? (error.stack ?? error.message) : String(error));
});
