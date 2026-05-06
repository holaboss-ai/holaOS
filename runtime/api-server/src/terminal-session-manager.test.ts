import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, test } from "node:test";

import { RuntimeStateStore } from "@holaboss/runtime-state-store";

import { TerminalSessionManager } from "./terminal-session-manager.js";
import type { RuntimeSentryCaptureOptions } from "./runtime-sentry.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function workspaceDir(root: string, workspaceId: string): string {
  return path.join(root, "workspace", workspaceId);
}

function testCommand(): string {
  if (process.platform === "win32") {
    return "Write-Output 'terminal-ready'; exit 0";
  }
  return "printf 'terminal-ready\\n'; exit 0";
}

class FakePtyProcess {
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>();

  writeCalls: string[] = [];
  resizeCalls: Array<{ cols: number; rows: number }> = [];
  killCalls: string[] = [];

  onData(listener: (data: string) => void): { dispose: () => void } {
    this.dataListeners.add(listener);
    return {
      dispose: () => {
        this.dataListeners.delete(listener);
      },
    };
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose: () => void } {
    this.exitListeners.add(listener);
    return {
      dispose: () => {
        this.exitListeners.delete(listener);
      },
    };
  }

  write(data: string): void {
    this.writeCalls.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resizeCalls.push({ cols, rows });
  }

  kill(signal?: string): void {
    this.killCalls.push(signal ?? "SIGTERM");
    queueMicrotask(() => {
      this.emitExit({ exitCode: 0, signal: signal ? 15 : undefined });
    });
  }

  emitData(data: string): void {
    for (const listener of this.dataListeners) {
      listener(data);
    }
  }

  emitExit(event: { exitCode: number; signal?: number }): void {
    for (const listener of this.exitListeners) {
      listener(event);
    }
  }
}

function requirePty(currentPty: FakePtyProcess | null): FakePtyProcess {
  assert.ok(currentPty);
  return currentPty;
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`condition not met within ${timeoutMs}ms`);
    }
    await sleep(25);
  }
}

test("terminal session manager persists started output and exit events", async () => {
  const root = makeTempDir("hb-terminal-session-manager-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace"),
  });
  store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  fs.mkdirSync(workspaceDir(root, "workspace-1"), { recursive: true });

  let currentPty: FakePtyProcess | null = null;
  const manager = new TerminalSessionManager({
    store,
    spawnImpl: () => {
      currentPty = new FakePtyProcess();
      return currentPty;
    },
  });
  await manager.start();

  const session = await manager.createSession({
    workspaceId: "workspace-1",
    command: testCommand(),
  });

  const ptyProcess = requirePty(currentPty);
  ptyProcess.emitData("terminal-ready\n");
  ptyProcess.emitExit({ exitCode: 0 });

  await waitFor(() => {
    const current = manager.getSession({ workspaceId: "workspace-1", terminalId: session.terminalId });
    return current?.status === "exited";
  });

  const current = manager.getSession({ workspaceId: "workspace-1", terminalId: session.terminalId });
  const events = manager.listEvents({ workspaceId: "workspace-1", terminalId: session.terminalId });

  assert.ok(current);
  assert.equal(current.status, "exited");
  assert.deepEqual(events.map((event) => event.eventType), ["started", "output", "exit"]);
  assert.match(String(events[1]?.payload.data ?? ""), /terminal-ready/);

  await manager.close();
  store.close();
});

test("terminal session manager proxies input resize and close operations", async () => {
  const root = makeTempDir("hb-terminal-session-manager-ops-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace"),
  });
  store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  fs.mkdirSync(workspaceDir(root, "workspace-1"), { recursive: true });

  let currentPty: FakePtyProcess | null = null;
  const manager = new TerminalSessionManager({
    store,
    spawnImpl: () => {
      currentPty = new FakePtyProcess();
      return currentPty;
    },
  });
  await manager.start();

  const session = await manager.createSession({
    workspaceId: "workspace-1",
    command: testCommand(),
  });
  const ptyProcess = requirePty(currentPty);

  await manager.sendInput({ workspaceId: "workspace-1", terminalId: session.terminalId, data: "npm run dev\r" });
  await manager.resize({ workspaceId: "workspace-1", terminalId: session.terminalId, cols: 140, rows: 48 });
  await manager.closeSession({ workspaceId: "workspace-1", terminalId: session.terminalId });

  await waitFor(() => manager.getSession({ workspaceId: "workspace-1", terminalId: session.terminalId })?.status === "closed");

  assert.deepEqual(ptyProcess.writeCalls, ["npm run dev\r"]);
  assert.deepEqual(ptyProcess.resizeCalls, [{ cols: 140, rows: 48 }]);
  assert.deepEqual(ptyProcess.killCalls, ["SIGTERM"]);
  assert.deepEqual(
    manager.listEvents({ workspaceId: "workspace-1", terminalId: session.terminalId }).map((event) => event.eventType),
    ["started", "input", "resize", "signal", "exit"],
  );

  await manager.close();
  store.close();
});

test("terminal session manager reconciles stale running sessions on startup", async () => {
  const root = makeTempDir("hb-terminal-session-manager-reconcile-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace"),
  });
  store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  fs.mkdirSync(workspaceDir(root, "workspace-1"), { recursive: true });
  store.createTerminalSession({
    terminalId: "term-stale",
    workspaceId: "workspace-1",
    status: "running",
    backend: "node_pty",
    owner: "agent",
    cwd: workspaceDir(root, "workspace-1"),
    shell: process.platform === "win32" ? "powershell.exe" : "/bin/bash",
    command: "npm run dev",
  });

  const manager = new TerminalSessionManager({ store });
  await manager.start();

  const stale = manager.getSession({ workspaceId: "workspace-1", terminalId: "term-stale" });
  const events = manager.listEvents({ workspaceId: "workspace-1", terminalId: "term-stale" });

  assert.ok(stale);
  assert.equal(stale.status, "interrupted");
  assert.deepEqual(events.map((event) => event.eventType), ["exit"]);
  assert.equal(events[0]?.payload.reason, "runtime_restarted");

  await manager.close();
  store.close();
});

test("terminal session manager captures output persistence failures instead of crashing", async () => {
  const root = makeTempDir("hb-terminal-session-manager-sentry-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace"),
  });
  store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  fs.mkdirSync(workspaceDir(root, "workspace-1"), { recursive: true });

  const appendTerminalSessionEvent = store.appendTerminalSessionEvent.bind(store);
  store.appendTerminalSessionEvent = ((params) => {
    if (params.eventType === "output") {
      throw new Error("database is locked");
    }
    return appendTerminalSessionEvent(params);
  }) as typeof store.appendTerminalSessionEvent;

  let currentPty: FakePtyProcess | null = null;
  const sentryCaptures: RuntimeSentryCaptureOptions[] = [];
  const manager = new TerminalSessionManager({
    store,
    captureRuntimeException(capture) {
      sentryCaptures.push(capture);
    },
    spawnImpl: () => {
      currentPty = new FakePtyProcess();
      return currentPty;
    },
  });
  await manager.start();

  const session = await manager.createSession({
    workspaceId: "workspace-1",
    command: testCommand(),
  });

  const ptyProcess = requirePty(currentPty);
  assert.doesNotThrow(() => {
    ptyProcess.emitData("terminal-ready\n");
  });

  await waitFor(() => manager.getSession({ workspaceId: "workspace-1", terminalId: session.terminalId })?.status === "closed");

  assert.equal(sentryCaptures.length, 1);
  assert.equal(
    sentryCaptures[0]?.tags?.failure_kind,
    "sqlite_database_locked",
  );
  assert.equal(
    sentryCaptures[0]?.tags?.terminal_event_type,
    "output",
  );
  assert.equal(ptyProcess.killCalls[0], "SIGTERM");

  await manager.close();
  store.close();
});
