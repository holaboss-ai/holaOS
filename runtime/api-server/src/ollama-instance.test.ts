import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import {
  OLLAMA_BENCH_ENV,
  OllamaInstance,
  OllamaInstanceError,
  benchEnv,
  cleanupOrphanOllama,
  compareOllamaVersions,
  defaultOllamaModelsDir,
  findOllamaBinary,
  leftoverBenchPid,
  ollamaBinaryCandidates,
  parseScutilProxy,
  parseWindowsProxy,
  userLoadedModels,
} from "./ollama-instance.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ollama-instance-"));
  tempDirs.push(dir);
  return dir;
}

/** A stand-in `ollama` executable: serves the few endpoints the instance uses and records its env. */
function fakeOllamaBinary(dir: string, options: { version?: string; pullError?: string } = {}): string {
  const file = path.join(dir, "ollama");
  const script = `#!${process.execPath}
const fs = require("node:fs");
const http = require("node:http");
fs.writeFileSync(${JSON.stringify(path.join(dir, "env.json"))}, JSON.stringify(process.env));
const [host, port] = process.env.OLLAMA_HOST.split(":");
http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.url === "/api/version") return res.end(JSON.stringify({ version: ${JSON.stringify(options.version ?? "0.12.6")} }));
    if (req.url === "/api/tags") return res.end(JSON.stringify({ models: [{ name: "m:q4", model: "m:q4", digest: "abc123" }] }));
    if (req.url === "/api/pull") {
      res.write(JSON.stringify({ status: "pulling manifest" }) + "\\n");
      res.write(JSON.stringify({ status: "downloading", completed: 5, total: 10 }) + "\\n");
      ${options.pullError ? `res.end(JSON.stringify({ error: ${JSON.stringify(options.pullError)} }) + "\\n");` : `res.end(JSON.stringify({ status: "success" }) + "\\n");`}
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
}).listen(Number(port), host);
`;
  fs.writeFileSync(file, script, { mode: 0o755 });
  return file;
}

test("binary candidates cover the official installs on each platform", () => {
  assert.ok(ollamaBinaryCandidates("darwin", {}, "/Users/u").includes("/Applications/Ollama.app/Contents/Resources/ollama"));
  assert.equal(
    ollamaBinaryCandidates("win32", { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }, "C:\\Users\\u")[0],
    "C:\\Users\\u\\AppData\\Local\\Programs\\Ollama\\ollama.exe",
  );
  assert.ok(ollamaBinaryCandidates("linux", {}, "/home/u").includes("/usr/local/bin/ollama"));
  assert.equal(findOllamaBinary(["/a", "/b"], (file) => file === "/b"), "/b");
  assert.equal(findOllamaBinary(["/a"], () => false), null);
});

test("models dir follows OLLAMA_MODELS so the bench shares the user's downloads", () => {
  assert.equal(defaultOllamaModelsDir({}, "/Users/u"), path.join("/Users/u", ".ollama", "models"));
  assert.equal(defaultOllamaModelsDir({ OLLAMA_MODELS: "/Volumes/x/models" }, "/Users/u"), "/Volumes/x/models");
});

test("versions compare numerically and a release sorts after its pre-release", () => {
  assert.equal(compareOllamaVersions("0.12.10", "0.12.9"), 1);
  assert.equal(compareOllamaVersions("0.12.6", "0.12.6"), 0);
  assert.equal(compareOllamaVersions("0.12.6-rc1", "0.12.6"), -1);
  assert.equal(compareOllamaVersions("v1.0", "0.99.99"), 1);
});

test("bench env drops the user's OLLAMA_* settings and pins ours", () => {
  const env = benchEnv(
    { PATH: "/bin", OLLAMA_FLASH_ATTENTION: "0", OLLAMA_KV_CACHE_TYPE: "q8_0", OLLAMA_CONTEXT_LENGTH: "4096" },
    4321,
    "/m",
  );
  assert.equal(env.PATH, "/bin");
  assert.equal(env.OLLAMA_FLASH_ATTENTION, undefined);
  assert.equal(env.OLLAMA_CONTEXT_LENGTH, undefined);
  assert.equal(env.OLLAMA_KV_CACHE_TYPE, "f16");
  assert.equal(env.OLLAMA_HOST, "127.0.0.1:4321");
  assert.equal(env.OLLAMA_MODELS, "/m");
});

test("the OS proxy is read from scutil on macOS and the registry on Windows", () => {
  const scutil = "<dictionary> {\n  HTTPEnable : 1\n  HTTPSEnable : 1\n  HTTPSPort : 7897\n  HTTPSProxy : 127.0.0.1\n}";
  assert.equal(parseScutilProxy(scutil), "http://127.0.0.1:7897");
  assert.equal(parseScutilProxy(scutil.replace("HTTPSEnable : 1", "HTTPSEnable : 0")), null);
  const reg = "\r\n    ProxyEnable    REG_DWORD    0x1\r\n    ProxyServer    REG_SZ    127.0.0.1:7890\r\n";
  assert.equal(parseWindowsProxy(reg), "http://127.0.0.1:7890");
  assert.equal(parseWindowsProxy(reg.replace("127.0.0.1:7890", "http=10.0.0.1:80;https=10.0.0.2:8443")), "http://10.0.0.2:8443");
  assert.equal(parseWindowsProxy(reg.replace("0x1", "0x0")), null);
});

test("the OS proxy fills HTTPS_PROXY only when the environment has none", () => {
  assert.equal(benchEnv({}, 1, "/m", "http://127.0.0.1:7897").HTTPS_PROXY, "http://127.0.0.1:7897");
  const own = benchEnv({ https_proxy: "http://corp:3128" }, 1, "/m", "http://127.0.0.1:7897");
  assert.equal(own.HTTPS_PROXY, undefined);
  assert.equal(own.https_proxy, "http://corp:3128");
});

test("start, pull, digest and stop a real child process", { skip: process.platform === "win32" }, async () => {
  const dir = tempDir();
  const stateDir = path.join(dir, "state");
  const instance = new OllamaInstance({
    binary: fakeOllamaBinary(dir),
    stateDir,
    env: { PATH: process.env.PATH, OLLAMA_KV_CACHE_TYPE: "q4_0" },
    homedir: dir,
  });
  const { baseUrl, version } = await instance.start();
  try {
    assert.equal(version, "0.12.6");
    assert.match(baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.ok(fs.existsSync(path.join(stateDir, "ollama-bench.json")));
    const childEnv = JSON.parse(fs.readFileSync(path.join(dir, "env.json"), "utf8")) as Record<string, string>;
    for (const [key, value] of Object.entries(OLLAMA_BENCH_ENV)) {
      assert.equal(childEnv[key], value, key);
    }
    assert.equal(childEnv.OLLAMA_MODELS, path.join(dir, ".ollama", "models"));

    const progress: number[] = [];
    await instance.pull("m:q4", (p) => p.completed !== undefined && progress.push(p.completed));
    assert.deepEqual(progress, [5]);
    assert.equal(await instance.digest("m:q4"), "abc123");
    assert.deepEqual(instance.evidence().provider, {
      engine: "ollama",
      version: "0.12.6",
      env: { ...OLLAMA_BENCH_ENV },
      flash_attention: "auto",
      managed: true,
    });
    assert.doesNotThrow(() => instance.assertMinVersion("0.12.0"));
    assert.throws(() => instance.assertMinVersion("0.13.0"), (error: unknown) => {
      return error instanceof OllamaInstanceError && error.code === "ollama_too_old";
    });
  } finally {
    await instance.stop();
  }
  assert.ok(!fs.existsSync(path.join(stateDir, "ollama-bench.json")));
  await assert.rejects(fetch(`${baseUrl}/api/version`, { signal: AbortSignal.timeout(1000) }));
});

test("a pull that streams an error fails", { skip: process.platform === "win32" }, async () => {
  const dir = tempDir();
  const instance = new OllamaInstance({
    binary: fakeOllamaBinary(dir, { pullError: "pull model manifest: file does not exist" }),
    stateDir: path.join(dir, "state"),
    env: { PATH: process.env.PATH },
    homedir: dir,
  });
  await instance.start();
  try {
    await assert.rejects(instance.pull("nope:latest"), /file does not exist/);
  } finally {
    await instance.stop();
  }
});

test("a binary that exits immediately reports start_failed", { skip: process.platform === "win32" }, async () => {
  const dir = tempDir();
  const binary = path.join(dir, "ollama");
  fs.writeFileSync(binary, `#!/bin/sh\necho "Error: listen tcp: address already in use" >&2\nexit 1\n`, { mode: 0o755 });
  const instance = new OllamaInstance({ binary, stateDir: path.join(dir, "state"), env: { PATH: process.env.PATH }, homedir: dir });
  await assert.rejects(instance.start(), (error: unknown) => {
    return error instanceof OllamaInstanceError && error.code === "start_failed" && /address already in use/.test(error.message);
  });
});

test("a bench port another Ollama already answers on is not taken over", { skip: process.platform === "win32" }, async () => {
  const dir = tempDir();
  const first = new OllamaInstance({ binary: fakeOllamaBinary(dir), stateDir: path.join(dir, "a"), env: { PATH: process.env.PATH }, homedir: dir });
  const { baseUrl } = await first.start();
  try {
    const port = Number(new URL(baseUrl).port);
    const second = new OllamaInstance({ binary: fakeOllamaBinary(dir), stateDir: path.join(dir, "b"), env: { PATH: process.env.PATH }, homedir: dir, port });
    await assert.rejects(second.start(), (error: unknown) => {
      return error instanceof OllamaInstanceError && error.code === "start_failed" && /already running on port/.test(error.message);
    });
    assert.ok(!fs.existsSync(path.join(dir, "b", "ollama-bench.json")));
  } finally {
    await first.stop();
  }
});

async function freePortForTest(): Promise<number> {
  return await new Promise((resolve) => {
    const server = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Starts the fake from another process that records it as the runner would, then exits (a crash) or stays (a live run). */
async function startElsewhere(binary: string, stateDir: string, port: number, stay: boolean) {
  const script = `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const [binary, stateDir, port] = process.argv.slice(1);
const child = spawn(binary, ["serve"], { env: { ...process.env, OLLAMA_HOST: "127.0.0.1:" + port }, stdio: "ignore", detached: true });
fs.mkdirSync(stateDir, { recursive: true });
fs.writeFileSync(stateDir + "/ollama-bench.json", JSON.stringify({ pid: child.pid, port: Number(port), started_at: new Date().toISOString(), binary, parent_pid: process.pid }));
const poll = () => fetch("http://127.0.0.1:" + port + "/api/version").then(() => true, () => false);
(async () => {
  while (!(await poll())) await new Promise((r) => setTimeout(r, 100));
  console.log("ready");
  if (${stay}) setInterval(() => {}, 1000); else process.exit(0);
})();
`;
  const helper = spawn(process.execPath, ["-e", script, binary, stateDir, String(port)], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>((resolve) => helper.stdout?.once("data", () => resolve()));
  const record = JSON.parse(fs.readFileSync(path.join(stateDir, "ollama-bench.json"), "utf8")) as { pid: number; parent_pid: number };
  return { helper, record };
}

test("a crashed run's instance on the bench port is stopped and the port reused", { skip: process.platform === "win32" }, async () => {
  const dir = tempDir();
  const stateDir = path.join(dir, "state");
  const binary = fakeOllamaBinary(dir);
  const port = await freePortForTest();
  const { helper, record } = await startElsewhere(binary, stateDir, port, false);
  await new Promise((resolve) => helper.once("exit", resolve));
  assert.ok(alive(record.pid));
  const instance = new OllamaInstance({ binary, stateDir, port, env: { PATH: process.env.PATH }, homedir: dir });
  const started = await instance.start();
  try {
    assert.equal(started.stoppedLeftover, true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.ok(!alive(record.pid));
  } finally {
    await instance.stop();
  }
});

test("a live run started by another process is never touched", { skip: process.platform === "win32" }, async () => {
  const dir = tempDir();
  const stateDir = path.join(dir, "state");
  const binary = fakeOllamaBinary(dir);
  const port = await freePortForTest();
  const { helper, record } = await startElsewhere(binary, stateDir, port, true);
  try {
    const instance = new OllamaInstance({ binary, stateDir, port, env: { PATH: process.env.PATH }, homedir: dir });
    await assert.rejects(instance.start(), (error: unknown) => {
      return error instanceof OllamaInstanceError && error.code === "start_failed" && error.message.includes(`lsof -i :${port}`);
    });
    assert.ok(alive(record.pid));
  } finally {
    helper.kill("SIGKILL");
    process.kill(record.pid, "SIGKILL");
  }
});

test("a recorded pid that now runs something else is not ours", () => {
  const dir = tempDir();
  fs.writeFileSync(
    path.join(dir, "ollama-bench.json"),
    JSON.stringify({ pid: process.pid, port: 11531, binary: "/opt/ollama/bin/ollama", parent_pid: 1 }),
  );
  assert.equal(leftoverBenchPid(dir, 11531), null);
  fs.writeFileSync(path.join(dir, "ollama-bench.json"), JSON.stringify({ pid: process.pid, port: 11531 }));
  assert.equal(leftoverBenchPid(dir, 11531), null);
});

test("orphan cleanup kills a leftover instance that still answers", { skip: process.platform === "win32" }, async () => {
  const dir = tempDir();
  const stateDir = path.join(dir, "state");
  const first = new OllamaInstance({ binary: fakeOllamaBinary(dir), stateDir, env: { PATH: process.env.PATH }, homedir: dir });
  const { baseUrl } = await first.start();
  assert.equal(await cleanupOrphanOllama(stateDir), true);
  await new Promise((resolve) => setTimeout(resolve, 300));
  await assert.rejects(fetch(`${baseUrl}/api/version`, { signal: AbortSignal.timeout(1000) }));
  assert.equal(await cleanupOrphanOllama(stateDir), false);
  await first.stop();
});

test("user loaded models come from the user's /api/ps and tolerate a missing server", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ models: [{ name: "qwen3:8b", size_vram: 5_000_000_000 }] }))) as typeof fetch;
  assert.deepEqual(await userLoadedModels(fetchImpl), [{ name: "qwen3:8b", size_vram: 5_000_000_000 }]);
  const down = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  assert.deepEqual(await userLoadedModels(down), []);
});
