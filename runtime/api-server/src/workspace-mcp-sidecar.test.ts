import assert from "node:assert/strict";
import type { SpawnOptions } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { runWorkspaceMcpSidecarCli, startWorkspaceMcpSidecar } from "./workspace-mcp-sidecar.js";
import { workspaceStateDir } from "./workspace-bundle-paths.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempWorkspaceRoot(prefix: string): { root: string; workspaceDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const workspaceDir = path.join(root, "workspace");
  fs.mkdirSync(workspaceDir, { recursive: true });
  tempDirs.push(root);
  return { root, workspaceDir };
}

function makeRequest(workspaceDir: string) {
  return {
    workspace_dir: workspaceDir,
    physical_server_id: "workspace-local",
    expected_fingerprint: "fp-1",
    timeout_ms: 45000,
    readiness_timeout_s: 2,
    catalog_json_base64: Buffer.from("{}", "utf8").toString("base64")
  } as const;
}

test("startWorkspaceMcpSidecar reuses a ready persisted sidecar", async () => {
  const { root, workspaceDir } = makeTempWorkspaceRoot("hb-workspace-mcp-reuse-");
  const request = makeRequest(workspaceDir);
  const stateDir = path.join(root, ".holaboss");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "workspace-mcp-sidecar-state.json"),
    JSON.stringify(
      {
        version: 1,
        sidecars: {
          [request.physical_server_id]: {
            physical_server_id: request.physical_server_id,
            url: "http://127.0.0.1:9000/mcp",
            pid: 4321,
            config_fingerprint: request.expected_fingerprint,
            updated_at: "2026-03-25T00:00:00.000Z"
          }
        }
      },
      null,
      2
    ),
    "utf8"
  );
  let spawned = false;

  const result = await startWorkspaceMcpSidecar(request, {
    pidAlive(pid) {
      assert.equal(pid, 4321);
      return true;
    },
    async isReady(url) {
      assert.equal(url, "http://127.0.0.1:9000/mcp");
      return true;
    },
    spawnProcess() {
      spawned = true;
      throw new Error("should not spawn");
    }
  });

  assert.equal(spawned, false);
  assert.deepEqual(result, {
    url: "http://127.0.0.1:9000/mcp",
    pid: 4321,
    reused: true
  });
});

test("startWorkspaceMcpSidecar terminates stale state, spawns, and persists the new sidecar", async () => {
  const { root, workspaceDir } = makeTempWorkspaceRoot("hb-workspace-mcp-spawn-");
  const request = makeRequest(workspaceDir);
  const legacyStateDir = path.join(root, ".holaboss");
  fs.mkdirSync(legacyStateDir, { recursive: true });
  fs.writeFileSync(
    path.join(legacyStateDir, "workspace-mcp-sidecar-state.json"),
    JSON.stringify(
      {
        version: 1,
        sidecars: {
          [request.physical_server_id]: {
            physical_server_id: request.physical_server_id,
            url: "http://127.0.0.1:8000/mcp",
            pid: 111,
            config_fingerprint: "stale-fingerprint",
            updated_at: "2026-03-25T00:00:00.000Z"
          }
        }
      },
      null,
      2
    ),
    "utf8"
  );

  const terminated: number[] = [];
  let spawnCall: { command: string; args: string[]; options: SpawnOptions } | null = null;
  let unrefCalled = false;

  const result = await startWorkspaceMcpSidecar(request, {
    async allocatePort() {
      return 24567;
    },
    pidAlive() {
      return false;
    },
    async isReady(url) {
      assert.equal(url, "http://127.0.0.1:24567/mcp");
      return true;
    },
    terminatePid(pid) {
      terminated.push(pid);
    },
    spawnProcess(command, args, options) {
      spawnCall = { command, args, options };
      return {
        pid: 9876,
        unref() {
          unrefCalled = true;
        }
      };
    },
    now() {
      return new Date("2026-03-25T12:00:00.000Z");
    }
  });

  assert.deepEqual(result, {
    url: "http://127.0.0.1:24567/mcp",
    pid: 9876,
    reused: false
  });
  assert.deepEqual(terminated, [111]);
  assert.equal(unrefCalled, true);
  assert.ok(spawnCall);
  const capturedSpawnCall = spawnCall as { command: string; args: string[]; options: SpawnOptions };
  assert.equal(capturedSpawnCall.command, process.execPath);
  assert.equal(capturedSpawnCall.args.includes("--request-base64"), true);
  const requestIndex = capturedSpawnCall.args.indexOf("--request-base64");
  assert.ok(requestIndex >= 0);
  assert.match(capturedSpawnCall.args[requestIndex - 1] ?? "", /workspace-mcp-host\.(ts|mjs)$/);
  const decodedHostRequest = JSON.parse(Buffer.from(capturedSpawnCall.args[requestIndex + 1] ?? "", "base64").toString("utf8"));
  assert.deepEqual(decodedHostRequest, {
    workspace_dir: path.resolve(workspaceDir),
    catalog_json_base64: request.catalog_json_base64,
    host: "127.0.0.1",
    port: 24567,
    server_name: request.physical_server_id
  });
  assert.equal(capturedSpawnCall.options.cwd, path.resolve(workspaceDir));
  assert.equal(capturedSpawnCall.options.detached, true);
  assert.equal(Array.isArray(capturedSpawnCall.options.stdio), true);

  const stateDir = workspaceStateDir(workspaceDir);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "workspace-mcp-sidecar-state.json"), "utf8"));
  assert.deepEqual(state, {
    version: 1,
    sidecars: {
      [request.physical_server_id]: {
        physical_server_id: request.physical_server_id,
        url: "http://127.0.0.1:24567/mcp",
        pid: 9876,
        config_fingerprint: request.expected_fingerprint,
        updated_at: "2026-03-25T12:00:00.000Z"
      }
    }
  });
  assert.equal(fs.readFileSync(path.join(stateDir, "workspace-local.workspace-mcp-sidecar.stdout.log"), "utf8"), "");
  assert.equal(fs.readFileSync(path.join(stateDir, "workspace-local.workspace-mcp-sidecar.stderr.log"), "utf8"), "");
  assert.equal(fs.existsSync(path.join(legacyStateDir, "workspace-mcp-sidecar-state.json")), false);
});

test("startWorkspaceMcpSidecar migrates only the matching legacy sidecar entry for this workspace", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hb-workspace-mcp-shared-"));
  tempDirs.push(root);
  const workspaceADir = path.join(root, "workspace-a");
  const workspaceBDir = path.join(root, "workspace-b");
  fs.mkdirSync(workspaceADir, { recursive: true });
  fs.mkdirSync(workspaceBDir, { recursive: true });
  const request = makeRequest(workspaceADir);
  const legacyStateDir = path.join(root, ".holaboss");
  fs.mkdirSync(legacyStateDir, { recursive: true });
  fs.writeFileSync(
    path.join(legacyStateDir, "workspace-mcp-sidecar-state.json"),
    JSON.stringify(
      {
        version: 1,
        sidecars: {
          [request.physical_server_id]: {
            physical_server_id: request.physical_server_id,
            url: "http://127.0.0.1:9001/mcp",
            pid: 2001,
            config_fingerprint: request.expected_fingerprint,
            updated_at: "2026-03-25T00:00:00.000Z"
          },
          "workspace-other": {
            physical_server_id: "workspace-other",
            url: "http://127.0.0.1:9002/mcp",
            pid: 2002,
            config_fingerprint: "fp-2",
            updated_at: "2026-03-25T00:00:00.000Z"
          }
        }
      },
      null,
      2
    ),
    "utf8"
  );

  const result = await startWorkspaceMcpSidecar(request, {
    pidAlive(pid) {
      assert.equal(pid, 2001);
      return true;
    },
    async isReady(url) {
      assert.equal(url, "http://127.0.0.1:9001/mcp");
      return true;
    },
    spawnProcess() {
      throw new Error("should not spawn");
    }
  });

  assert.deepEqual(result, {
    url: "http://127.0.0.1:9001/mcp",
    pid: 2001,
    reused: true
  });

  const workspaceAState = JSON.parse(
    fs.readFileSync(path.join(workspaceStateDir(workspaceADir), "workspace-mcp-sidecar-state.json"), "utf8")
  );
  const remainingLegacyState = JSON.parse(
    fs.readFileSync(path.join(legacyStateDir, "workspace-mcp-sidecar-state.json"), "utf8")
  );

  assert.deepEqual(Object.keys(workspaceAState.sidecars), [request.physical_server_id]);
  assert.deepEqual(Object.keys(remainingLegacyState.sidecars), ["workspace-other"]);
  assert.equal(
    fs.existsSync(path.join(workspaceStateDir(workspaceBDir), "workspace-mcp-sidecar-state.json")),
    false,
  );
});

test("startWorkspaceMcpSidecar terminates a spawned sidecar if readiness never succeeds", async () => {
  const { root, workspaceDir } = makeTempWorkspaceRoot("hb-workspace-mcp-timeout-");
  const request = makeRequest(workspaceDir);
  const terminated: number[] = [];

  await assert.rejects(
    startWorkspaceMcpSidecar(request, {
      async allocatePort() {
        return 24568;
      },
      async isReady() {
        return false;
      },
      terminatePid(pid) {
        terminated.push(pid);
      },
      spawnProcess() {
        return {
          pid: 5555,
          unref() {}
        };
      }
    }),
    /readiness timed out/
  );

  assert.deepEqual(terminated, [5555]);
  const statePath = path.join(workspaceStateDir(workspaceDir), "workspace-mcp-sidecar-state.json");
  assert.equal(fs.existsSync(statePath), false);
});

test("runWorkspaceMcpSidecarCli writes JSON response for a valid request", async () => {
  const { workspaceDir } = makeTempWorkspaceRoot("hb-workspace-mcp-cli-");
  const request = makeRequest(workspaceDir);
  let stdout = "";
  let stderr = "";
  const exitCode = await runWorkspaceMcpSidecarCli(
    ["--request-base64", Buffer.from(JSON.stringify(request), "utf8").toString("base64")],
    {
      io: {
        stdout: { write(chunk: string) { stdout += chunk; return true; } } as unknown as NodeJS.WritableStream,
        stderr: { write(chunk: string) { stderr += chunk; return true; } } as unknown as NodeJS.WritableStream
      },
      async startSidecar(parsed) {
        assert.deepEqual(parsed, request);
        return {
          url: "http://127.0.0.1:24567/mcp",
          pid: 9876,
          reused: false
        };
      }
    }
  );

  assert.equal(exitCode, 0);
  assert.equal(stderr, "");
  assert.deepEqual(JSON.parse(stdout), {
    url: "http://127.0.0.1:24567/mcp",
    pid: 9876,
    reused: false
  });
});

test("runWorkspaceMcpSidecarCli returns exit code 2 when request is missing", async () => {
  let stdout = "";
  let stderr = "";
  const exitCode = await runWorkspaceMcpSidecarCli([], {
    io: {
      stdout: { write(chunk: string) { stdout += chunk; return true; } } as unknown as NodeJS.WritableStream,
      stderr: { write(chunk: string) { stderr += chunk; return true; } } as unknown as NodeJS.WritableStream
    }
  });

  assert.equal(exitCode, 2);
  assert.equal(stdout, "");
  assert.equal(stderr, "request_base64 is required\n");
});
