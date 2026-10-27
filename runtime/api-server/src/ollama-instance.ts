import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import BENCH_CONDITIONS from "./bench-conditions.json";

/** Ollama Runtime Adapter: this module starts, stops and gives evidence; holaeval `bench` invokes and meters. */

export const OLLAMA_DOWNLOAD_URL = "https://ollama.com/download";
export const OLLAMA_USER_BASE_URL = "http://127.0.0.1:11434";

/** Fixed for every bench run and copied into the Run Record; the `hola` CLI reads the same file. Flash attention is left on Ollama's auto. */
// OLLAMA_NOPRUNE: starting a server prunes unreferenced blobs, which would break a pull running in the user's own server.
export const OLLAMA_BENCH_ENV: Readonly<Record<string, string>> = BENCH_CONDITIONS.ollama_env;
/** One port for every bench instance, desktop or CLI, so a second run can't start beside the first. */
export const OLLAMA_BENCH_PORT: number = BENCH_CONDITIONS.private_port;

const READY_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 5000;
const STDERR_TAIL_BYTES = 4000;
const PID_FILE = "ollama-bench.json";

type SpawnImpl = (command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => ChildProcess;

export interface OllamaInstanceDeps {
  binary: string;
  stateDir: string;
  env?: NodeJS.ProcessEnv;
  homedir?: string;
  spawnImpl?: SpawnImpl;
  fetchImpl?: typeof fetch;
  port?: number;
  systemProxy?: () => string | null;
}

export interface OllamaEvidence {
  kind: "local";
  provider: {
    engine: "ollama";
    version: string | null;
    env: Record<string, string>;
    flash_attention: "auto";
    /** Started by holaOS or the CLI under the pinned conditions, not someone's own server; HolaHub publishes only these. */
    managed: boolean;
  };
}

export interface OllamaPullProgress {
  status: string;
  completed?: number;
  total?: number;
}

export interface UserLoadedModel {
  name: string;
  size_vram: number | null;
}

export class OllamaInstanceError extends Error {
  readonly code: "ollama_missing" | "ollama_too_old" | "start_failed" | "pull_failed";

  constructor(code: OllamaInstanceError["code"], message: string) {
    super(message);
    this.name = "OllamaInstanceError";
    this.code = code;
  }
}

export function ollamaBinaryCandidates(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  homedir: string = os.homedir(),
): string[] {
  switch (platform) {
    case "darwin":
      return [
        "/Applications/Ollama.app/Contents/Resources/ollama",
        path.join(homedir, "Applications/Ollama.app/Contents/Resources/ollama"),
        "/opt/homebrew/bin/ollama",
        "/usr/local/bin/ollama",
      ];
    case "win32": {
      const localAppData = env.LOCALAPPDATA || path.win32.join(homedir, "AppData", "Local");
      const programFiles = env.ProgramFiles || "C:\\Program Files";
      return [
        path.win32.join(localAppData, "Programs", "Ollama", "ollama.exe"),
        path.win32.join(programFiles, "Ollama", "ollama.exe"),
      ];
    }
    default:
      return ["/usr/local/bin/ollama", "/usr/bin/ollama", "/snap/bin/ollama"];
  }
}

export function findOllamaBinary(
  candidates: string[] = ollamaBinaryCandidates(),
  exists: (file: string) => boolean = (file) => fs.existsSync(file),
): string | null {
  return candidates.find((file) => exists(file)) ?? null;
}

export function defaultOllamaModelsDir(env: NodeJS.ProcessEnv = process.env, homedir: string = os.homedir()): string {
  return env.OLLAMA_MODELS?.trim() || path.join(homedir, ".ollama", "models");
}

/** Compares dotted numeric versions; a pre-release suffix sorts before its release. */
export function compareOllamaVersions(a: string, b: string): number {
  const parse = (value: string) => {
    const [core, pre] = value.trim().replace(/^v/, "").split("-", 2);
    return { parts: core.split(".").map((part) => Number.parseInt(part, 10) || 0), pre: pre ?? null };
  };
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < Math.max(left.parts.length, right.parts.length); i += 1) {
    const diff = (left.parts[i] ?? 0) - (right.parts[i] ?? 0);
    if (diff !== 0) {
      return Math.sign(diff);
    }
  }
  if (left.pre === right.pre) {
    return 0;
  }
  if (left.pre === null) {
    return 1;
  }
  if (right.pre === null) {
    return -1;
  }
  return left.pre < right.pre ? -1 : 1;
}

/** `scutil --proxy` output → the HTTPS proxy macOS routes through, if enabled. */
export function parseScutilProxy(text: string): string | null {
  const field = (name: string) => text.match(new RegExp(`^\\s*${name}\\s*:\\s*(\\S+)`, "m"))?.[1];
  if (field("HTTPSEnable") !== "1") {
    return null;
  }
  const host = field("HTTPSProxy");
  const port = field("HTTPSPort");
  return host ? `http://${host}${port ? `:${port}` : ""}` : null;
}

/** `reg query …\Internet Settings` output → the proxy Windows routes HTTPS through, if enabled. */
export function parseWindowsProxy(text: string): string | null {
  const field = (name: string) => text.match(new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.+?)\\s*$`, "m"))?.[1];
  if (!/^0x0*1$/i.test(field("ProxyEnable") ?? "")) {
    return null;
  }
  const server = field("ProxyServer");
  if (!server) {
    return null;
  }
  const perScheme = server.includes("=") ? server.split(";").find((part) => part.trim().startsWith("https="))?.split("=")[1] : server;
  const address = perScheme?.trim();
  if (!address) {
    return null;
  }
  return /^[a-z]+:\/\//i.test(address) ? address : `http://${address}`;
}

/** The OS-level HTTPS proxy; apps started from the Dock or Start menu don't see it as HTTPS_PROXY. */
export function systemHttpsProxy(platform: NodeJS.Platform = process.platform): string | null {
  try {
    if (platform === "darwin") {
      return parseScutilProxy(spawnSync("scutil", ["--proxy"], { encoding: "utf8", timeout: 3000 }).stdout ?? "");
    }
    if (platform === "win32") {
      const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
      return parseWindowsProxy(spawnSync("reg", ["query", key], { encoding: "utf8", timeout: 3000 }).stdout ?? "");
    }
  } catch {
    // no proxy information
  }
  return null;
}

export function benchEnv(
  baseEnv: NodeJS.ProcessEnv,
  port: number,
  modelsDir: string,
  proxy: string | null = null,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (!key.startsWith("OLLAMA_")) {
      env[key] = value;
    }
  }
  const hasProxy = Object.keys(env).some((key) => key.toLowerCase() === "https_proxy");
  return {
    ...env,
    ...(proxy && !hasProxy ? { HTTPS_PROXY: proxy } : {}),
    ...OLLAMA_BENCH_ENV,
    OLLAMA_HOST: `127.0.0.1:${port}`,
    OLLAMA_MODELS: modelsDir,
  };
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") {
          resolve(address.port);
        } else {
          reject(new Error("could not allocate a port"));
        }
      });
    });
  });
}

function killTree(pid: number, signal: NodeJS.Signals = "SIGTERM"): void {
  if (process.platform === "win32") {
    // Ollama's model runners are child processes; without /T they outlive the server on Windows.
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(pid, signal);
  } catch {
    // already gone
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readNdjson(response: Response, onLine: (line: Record<string, unknown>) => void): Promise<void> {
  if (!response.body) {
    return;
  }
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        onLine(JSON.parse(line) as Record<string, unknown>);
      }
      newline = buffer.indexOf("\n");
    }
  }
  if (buffer.trim()) {
    onLine(JSON.parse(buffer.trim()) as Record<string, unknown>);
  }
}

export class OllamaInstance {
  private readonly deps: OllamaInstanceDeps;
  private child: ChildProcess | null = null;
  private port: number | null = null;
  private version: string | null = null;
  private stderr = "";

  constructor(deps: OllamaInstanceDeps) {
    this.deps = deps;
  }

  get baseUrl(): string {
    if (this.port === null) {
      throw new Error("Ollama instance is not running");
    }
    return `http://127.0.0.1:${this.port}`;
  }

  private get fetchImpl(): typeof fetch {
    return this.deps.fetchImpl ?? fetch;
  }

  private get pidFile(): string {
    return path.join(this.deps.stateDir, PID_FILE);
  }

  async start(): Promise<{ baseUrl: string; version: string }> {
    const port = this.deps.port ?? (await freePort());
    this.port = port;
    if (this.deps.port !== undefined && (await this.fetchVersion()) !== null) {
      this.port = null;
      throw new OllamaInstanceError(
        "start_failed",
        `Another Ollama is already running on port ${port}, probably a benchmark started elsewhere. Wait for it to finish, then try again.`,
      );
    }
    const env = benchEnv(
      this.deps.env ?? process.env,
      port,
      defaultOllamaModelsDir(this.deps.env, this.deps.homedir),
      (this.deps.systemProxy ?? systemHttpsProxy)(),
    );
    const spawnImpl: SpawnImpl =
      this.deps.spawnImpl ?? ((command, args, options) => spawn(command, args, { ...options, stdio: ["ignore", "ignore", "pipe"] }));
    const child = spawnImpl(this.deps.binary, ["serve"], { env });
    this.child = child;
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-STDERR_TAIL_BYTES);
    });
    let exited = false;
    child.on("exit", () => {
      exited = true;
    });
    child.on("error", (error) => {
      exited = true;
      this.stderr += `\n${error.message}`;
    });
    if (child.pid) {
      fs.mkdirSync(this.deps.stateDir, { recursive: true });
      fs.writeFileSync(this.pidFile, JSON.stringify({ pid: child.pid, port, started_at: new Date().toISOString() }));
    }
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (exited) {
        break;
      }
      const version = await this.fetchVersion();
      if (version) {
        this.version = version;
        return { baseUrl: this.baseUrl, version };
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    await this.stop();
    const tail = this.stderr.trim().split("\n").slice(-3).join(" ");
    throw new OllamaInstanceError("start_failed", `Ollama did not start${tail ? `: ${tail}` : "."}`);
  }

  private async fetchVersion(): Promise<string | null> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/api/version`, { signal: AbortSignal.timeout(1000) });
      if (!response.ok) {
        return null;
      }
      const body = (await response.json()) as { version?: unknown };
      return typeof body.version === "string" ? body.version : null;
    } catch {
      return null;
    }
  }

  assertMinVersion(minVersion: string): void {
    if (this.version && compareOllamaVersions(this.version, minVersion) < 0) {
      throw new OllamaInstanceError(
        "ollama_too_old",
        `Ollama ${this.version} is older than ${minVersion}, the minimum for this benchmark. Update Ollama from ${OLLAMA_DOWNLOAD_URL}.`,
      );
    }
  }

  async pull(model: string, onProgress?: (progress: OllamaPullProgress) => void): Promise<void> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, stream: true }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new OllamaInstanceError("pull_failed", `Pulling ${model} failed (${response.status}) ${text}`.trim());
    }
    let failure: string | null = null;
    let succeeded = false;
    await readNdjson(response, (line) => {
      if (typeof line.error === "string") {
        failure = line.error;
        return;
      }
      const status = String(line.status ?? "");
      succeeded ||= status === "success";
      onProgress?.({
        status,
        completed: typeof line.completed === "number" ? line.completed : undefined,
        total: typeof line.total === "number" ? line.total : undefined,
      });
    });
    if (failure || !succeeded) {
      const reason = failure ?? "the download ended early";
      const hint = /resolves to non-public/.test(reason)
        ? " Your proxy resolves the download host to a private address (fake-ip mode). Turn on your proxy's system proxy, or set its DNS mode to real IP, then try again."
        : "";
      throw new OllamaInstanceError("pull_failed", `Pulling ${model} failed: ${reason}.${hint}`);
    }
  }

  async digest(model: string): Promise<string | null> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/tags`);
    const body = (await response.json()) as { models?: Array<{ name?: string; model?: string; digest?: string }> };
    const entry = body.models?.find((m) => m.name === model || m.model === model);
    return entry?.digest ?? null;
  }

  evidence(): OllamaEvidence {
    return {
      kind: "local",
      provider: { engine: "ollama", version: this.version, env: { ...OLLAMA_BENCH_ENV }, flash_attention: "auto", managed: true },
    };
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      killTree(child.pid);
      const timedOut = await Promise.race([
        exited.then(() => false),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(true), STOP_TIMEOUT_MS)),
      ]);
      if (timedOut) {
        killTree(child.pid, "SIGKILL");
      }
    }
    fs.rmSync(this.pidFile, { force: true });
  }
}

/** Kills a bench instance left behind by a crash, but only if it still answers as Ollama on its recorded port. */
export async function cleanupOrphanOllama(stateDir: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const file = path.join(stateDir, PID_FILE);
  let record: { pid?: unknown; port?: unknown };
  try {
    record = JSON.parse(fs.readFileSync(file, "utf8")) as { pid?: unknown; port?: unknown };
  } catch {
    return false;
  }
  fs.rmSync(file, { force: true });
  if (typeof record.pid !== "number" || typeof record.port !== "number" || !isAlive(record.pid)) {
    return false;
  }
  try {
    const response = await fetchImpl(`http://127.0.0.1:${record.port}/api/version`, { signal: AbortSignal.timeout(1000) });
    if (!response.ok) {
      return false;
    }
  } catch {
    return false;
  }
  killTree(record.pid);
  return true;
}

/** Models the user's own Ollama has in memory; they compete with the bench for VRAM. */
export async function userLoadedModels(
  fetchImpl: typeof fetch = fetch,
  baseUrl: string = OLLAMA_USER_BASE_URL,
): Promise<UserLoadedModel[]> {
  try {
    const response = await fetchImpl(`${baseUrl}/api/ps`, { signal: AbortSignal.timeout(1000) });
    if (!response.ok) {
      return [];
    }
    const body = (await response.json()) as { models?: Array<{ name?: string; size_vram?: number }> };
    return (body.models ?? [])
      .filter((m): m is { name: string; size_vram?: number } => typeof m.name === "string")
      .map((m) => ({ name: m.name, size_vram: typeof m.size_vram === "number" ? m.size_vram : null }));
  } catch {
    return [];
  }
}

export async function unloadUserModel(
  name: string,
  fetchImpl: typeof fetch = fetch,
  baseUrl: string = OLLAMA_USER_BASE_URL,
): Promise<void> {
  await fetchImpl(`${baseUrl}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: name, keep_alive: 0 }),
  });
}
