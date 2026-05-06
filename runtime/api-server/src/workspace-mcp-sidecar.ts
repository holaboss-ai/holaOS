import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ensureWorkspaceStateDir } from "./workspace-bundle-paths.js";

const WORKSPACE_MCP_STATE_VERSION = 1;
const WORKSPACE_MCP_READY_POLL_MS = 200;

type SidecarStateEntry = {
  physical_server_id: string;
  url: string;
  pid: number;
  config_fingerprint: string;
  updated_at: string;
};

type WorkspaceMcpSidecarDeps = {
  allocatePort?: () => Promise<number>;
  isReady?: (url: string) => Promise<boolean>;
  now?: () => Date;
  pidAlive?: (pid: number) => boolean;
  terminatePid?: (pid: number) => void;
  spawnProcess?: (
    command: string,
    args: string[],
    options: SpawnOptions
  ) => Pick<ChildProcess, "pid" | "unref">;
};

export interface WorkspaceMcpSidecarCliRequest {
  workspace_dir: string;
  physical_server_id: string;
  expected_fingerprint: string;
  timeout_ms: number;
  readiness_timeout_s: number;
  catalog_json_base64: string;
}

export interface WorkspaceMcpSidecarCliResponse {
  url: string;
  pid: number;
  reused: boolean;
}

type WorkspaceMcpHostCliRequest = {
  workspace_dir: string;
  catalog_json_base64: string;
  host: string;
  port: number;
  server_name: string;
};

function sanitizeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "workspace";
}

function stateDirForWorkspace(workspaceDir: string): string {
  const resolvedWorkspaceDir = path.resolve(workspaceDir);
  return ensureWorkspaceStateDir(resolvedWorkspaceDir);
}

function workspaceMcpStatePath(workspaceDir: string): string {
  return path.join(stateDirForWorkspace(workspaceDir), "workspace-mcp-sidecar-state.json");
}

function workspaceMcpLogPath(workspaceDir: string, physicalServerId: string, stream: "stdout" | "stderr"): string {
  const basename = stream === "stdout" ? "workspace-mcp-sidecar.stdout.log" : "workspace-mcp-sidecar.stderr.log";
  return path.join(stateDirForWorkspace(workspaceDir), `${sanitizeId(physicalServerId)}.${basename}`);
}

function ensureStateDir(workspaceDir: string): string {
  const stateDir = stateDirForWorkspace(workspaceDir);
  fs.mkdirSync(stateDir, { recursive: true });
  return stateDir;
}

function readSidecarStateFile(statePath: string): Record<string, SidecarStateEntry> {
  if (!fs.existsSync(statePath)) {
    return {};
  }
  try {
    const payload = JSON.parse(fs.readFileSync(statePath, "utf8"));
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return {};
    }
    if (Number(payload.version ?? 0) !== WORKSPACE_MCP_STATE_VERSION) {
      return {};
    }
    const rawEntries = payload.sidecars;
    if (!rawEntries || typeof rawEntries !== "object" || Array.isArray(rawEntries)) {
      return {};
    }
    const entries: Record<string, SidecarStateEntry> = {};
    for (const [key, value] of Object.entries(rawEntries)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        continue;
      }
      entries[key] = value as SidecarStateEntry;
    }
    return entries;
  } catch {
    return {};
  }
}

function writeSidecarStateFile(statePath: string, entries: Record<string, SidecarStateEntry>): void {
  if (Object.keys(entries).length === 0) {
    fs.rmSync(statePath, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(
    statePath,
    JSON.stringify(
      {
        version: WORKSPACE_MCP_STATE_VERSION,
        sidecars: entries,
      },
      null,
      2,
    ),
    "utf8",
  );
}

function migrateLegacySidecarArtifactsForWorkspace(workspaceDir: string, physicalServerId: string): void {
  const resolvedWorkspaceDir = path.resolve(workspaceDir);
  const legacySharedDir = path.join(path.dirname(resolvedWorkspaceDir), ".holaboss");
  const legacyStatePath = path.join(legacySharedDir, "workspace-mcp-sidecar-state.json");
  const targetStatePath = workspaceMcpStatePath(resolvedWorkspaceDir);

  const legacyEntries = readSidecarStateFile(legacyStatePath);
  const matchingEntry = legacyEntries[physicalServerId];
  if (matchingEntry) {
    const nextEntries = readSidecarStateFile(targetStatePath);
    if (!nextEntries[physicalServerId]) {
      nextEntries[physicalServerId] = matchingEntry;
      writeSidecarStateFile(targetStatePath, nextEntries);
    }
    delete legacyEntries[physicalServerId];
    writeSidecarStateFile(legacyStatePath, legacyEntries);
  }

  if (fs.existsSync(legacySharedDir) && fs.statSync(legacySharedDir).isDirectory()) {
    for (const stream of ["stdout", "stderr"] as const) {
      const basename = stream === "stdout"
        ? "workspace-mcp-sidecar.stdout.log"
        : "workspace-mcp-sidecar.stderr.log";
      const childName = `${sanitizeId(physicalServerId)}.${basename}`;
      const sourcePath = path.join(legacySharedDir, childName);
      const targetPath = path.join(stateDirForWorkspace(resolvedWorkspaceDir), childName);
      if (fs.existsSync(sourcePath) && !fs.existsSync(targetPath)) {
        fs.renameSync(sourcePath, targetPath);
      }
    }
  }
}

function decodeCliRequest(encoded: string): WorkspaceMcpSidecarCliRequest {
  const trimmed = encoded.trim();
  if (!trimmed) {
    throw new Error("request_base64 is required");
  }
  const raw = Buffer.from(trimmed, "base64").toString("utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("request payload must be an object");
  }
  return parsed as WorkspaceMcpSidecarCliRequest;
}

function readWorkspaceMcpSidecarState(workspaceDir: string): Record<string, SidecarStateEntry> {
  return readSidecarStateFile(workspaceMcpStatePath(workspaceDir));
}

function writeWorkspaceMcpSidecarState(workspaceDir: string, entries: Record<string, SidecarStateEntry>): void {
  ensureStateDir(workspaceDir);
  fs.writeFileSync(
    workspaceMcpStatePath(workspaceDir),
    JSON.stringify(
      {
        version: WORKSPACE_MCP_STATE_VERSION,
        sidecars: entries
      },
      null,
      2
    ),
    "utf8"
  );
}

function workspaceMcpPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function terminateWorkspaceMcpPid(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) {
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // ignore
  }
}

async function workspaceMcpIsReady(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(2000)
    });
    return response.status < 500;
  } catch {
    return false;
  }
}

async function waitForWorkspaceMcpReady(
  url: string,
  timeoutSeconds: number,
  deps: Pick<WorkspaceMcpSidecarDeps, "isReady">
): Promise<void> {
  const isReady = deps.isReady ?? workspaceMcpIsReady;
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    if (await isReady(url)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, WORKSPACE_MCP_READY_POLL_MS));
  }
  throw new Error(`workspace MCP sidecar readiness timed out for ${url}`);
}

async function nextLocalPort(): Promise<number> {
  const server = net.createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to allocate local port");
    }
    return address.port;
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}

function buildSidecarEnv(): NodeJS.ProcessEnv {
  return { ...process.env };
}

function encodeWorkspaceMcpHostRequest(request: WorkspaceMcpHostCliRequest): string {
  return Buffer.from(JSON.stringify(request), "utf8").toString("base64");
}

function workspaceMcpHostEntryPath(): string {
  const currentFile = fileURLToPath(import.meta.url);
  const extension = path.extname(currentFile);
  return path.join(path.dirname(currentFile), `workspace-mcp-host${extension}`);
}

function workspaceMcpHostCommand(request: WorkspaceMcpHostCliRequest): { command: string; args: string[] } {
  const entryPath = workspaceMcpHostEntryPath();
  const encodedRequest = encodeWorkspaceMcpHostRequest(request);
  if (path.extname(entryPath) === ".ts") {
    return {
      command: process.execPath,
      args: ["--import", "tsx", entryPath, "--request-base64", encodedRequest]
    };
  }
  return {
    command: process.execPath,
    args: [entryPath, "--request-base64", encodedRequest]
  };
}

function defaultSpawnProcess(
  command: string,
  args: string[],
  options: SpawnOptions
): Pick<ChildProcess, "pid" | "unref"> {
  return spawn(command, args, options);
}

export async function startWorkspaceMcpSidecar(
  request: WorkspaceMcpSidecarCliRequest,
  deps: WorkspaceMcpSidecarDeps = {}
): Promise<WorkspaceMcpSidecarCliResponse> {
  const workspaceDir = path.resolve(request.workspace_dir);
  migrateLegacySidecarArtifactsForWorkspace(workspaceDir, request.physical_server_id);
  const stateEntries = readWorkspaceMcpSidecarState(workspaceDir);
  const stateEntry = stateEntries[request.physical_server_id];
  const pidAlive = deps.pidAlive ?? workspaceMcpPidAlive;
  const terminatePid = deps.terminatePid ?? terminateWorkspaceMcpPid;

  if (stateEntry) {
    if (
      stateEntry.url &&
      stateEntry.config_fingerprint === request.expected_fingerprint &&
      pidAlive(Number(stateEntry.pid ?? 0)) &&
      (await (deps.isReady ?? workspaceMcpIsReady)(stateEntry.url))
    ) {
      return {
        url: stateEntry.url,
        pid: Number(stateEntry.pid ?? 0),
        reused: true
      };
    }
    terminatePid(Number(stateEntry.pid ?? 0));
    delete stateEntries[request.physical_server_id];
    writeWorkspaceMcpSidecarState(workspaceDir, stateEntries);
  }

  ensureStateDir(workspaceDir);
  const port = await (deps.allocatePort ?? nextLocalPort)();
  const url = `http://127.0.0.1:${port}/mcp`;
  const stdoutLogPath = workspaceMcpLogPath(workspaceDir, request.physical_server_id, "stdout");
  const stderrLogPath = workspaceMcpLogPath(workspaceDir, request.physical_server_id, "stderr");
  fs.writeFileSync(stdoutLogPath, "", "utf8");
  fs.writeFileSync(stderrLogPath, "", "utf8");

  const stdoutFd = fs.openSync(stdoutLogPath, "a");
  const stderrFd = fs.openSync(stderrLogPath, "a");
  let child: Pick<ChildProcess, "pid" | "unref">;
  try {
    const hostCommand = workspaceMcpHostCommand({
      workspace_dir: workspaceDir,
      catalog_json_base64: request.catalog_json_base64,
      host: "127.0.0.1",
      port,
      server_name: request.physical_server_id
    });
    child = (deps.spawnProcess ?? defaultSpawnProcess)(
      hostCommand.command,
      hostCommand.args,
      {
        cwd: workspaceDir,
        env: buildSidecarEnv(),
        detached: true,
        stdio: ["ignore", stdoutFd, stderrFd]
      }
    );
  } finally {
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
  }
  child.unref();
  try {
    await waitForWorkspaceMcpReady(url, request.readiness_timeout_s, deps);
  } catch (error) {
    terminatePid(child.pid ?? 0);
    throw error;
  }
  stateEntries[request.physical_server_id] = {
    physical_server_id: request.physical_server_id,
    url,
    pid: child.pid ?? 0,
    config_fingerprint: request.expected_fingerprint,
    updated_at: (deps.now ?? (() => new Date()))().toISOString()
  };
  writeWorkspaceMcpSidecarState(workspaceDir, stateEntries);
  return {
    url,
    pid: child.pid ?? 0,
    reused: false
  };
}

export async function runWorkspaceMcpSidecarCli(
  argv: string[],
  options: {
    io?: { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream };
    startSidecar?: (request: WorkspaceMcpSidecarCliRequest) => Promise<WorkspaceMcpSidecarCliResponse>;
  } = {}
): Promise<number> {
  const io = options.io ?? { stdout: process.stdout, stderr: process.stderr };
  const requestBase64 = argv[0] === "--request-base64" ? argv[1] ?? "" : argv[0] ?? "";
  if (!requestBase64) {
    io.stderr.write("request_base64 is required\n");
    return 2;
  }
  try {
    const request = decodeCliRequest(requestBase64);
    const result = await (options.startSidecar ?? startWorkspaceMcpSidecar)(request);
    io.stdout.write(JSON.stringify(result));
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr.write(`${message}\n`);
    return 1;
  }
}

async function main(): Promise<void> {
  process.exitCode = await runWorkspaceMcpSidecarCli(process.argv.slice(2));
}

// See workspace-runtime-plan.ts for why the usual import.meta.url guard
// isn't sufficient when these files are re-bundled into dist/index.mjs.
const WORKSPACE_MCP_SIDECAR_CLI_BASENAME = "workspace-mcp-sidecar";
if (
  import.meta.url === pathToFileURL(process.argv[1] ?? "").href &&
  path.basename(process.argv[1] ?? "", path.extname(process.argv[1] ?? "")) ===
    WORKSPACE_MCP_SIDECAR_CLI_BASENAME
) {
  await main();
}
