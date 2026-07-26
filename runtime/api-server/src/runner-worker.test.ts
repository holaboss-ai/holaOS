import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  applyPrependedPath,
  buildRunnerEnv,
  currentRuntimeApiUrl,
  executeRunnerRequest,
  NativeRunnerExecutor,
  removeRunnerRequestFile,
  runnerInvocation,
  RunnerExecutorError
} from "./runner-worker.js";
import { quoteShellValue, shellPathDelimiter } from "./runtime-shell.js";

const ORIGINAL_ENV = {
  SANDBOX_AGENT_RUNNER_COMMAND_TEMPLATE: process.env.SANDBOX_AGENT_RUNNER_COMMAND_TEMPLATE,
  SANDBOX_AGENT_RUN_TIMEOUT_S: process.env.SANDBOX_AGENT_RUN_TIMEOUT_S,
  SANDBOX_AGENT_TASK_PROPOSAL_RUN_TIMEOUT_S: process.env.SANDBOX_AGENT_TASK_PROPOSAL_RUN_TIMEOUT_S,
  SANDBOX_AGENT_RUN_IDLE_TIMEOUT_S: process.env.SANDBOX_AGENT_RUN_IDLE_TIMEOUT_S,
  SANDBOX_AGENT_TASK_PROPOSAL_RUN_IDLE_TIMEOUT_S: process.env.SANDBOX_AGENT_TASK_PROPOSAL_RUN_IDLE_TIMEOUT_S,
  SANDBOX_AGENT_RUN_POST_START_GRACE_S: process.env.SANDBOX_AGENT_RUN_POST_START_GRACE_S,
  SANDBOX_AGENT_RUNNER_HEARTBEAT_MS: process.env.SANDBOX_AGENT_RUNNER_HEARTBEAT_MS,
  SANDBOX_RUNTIME_API_URL: process.env.SANDBOX_RUNTIME_API_URL,
  SANDBOX_RUNTIME_API_HOST: process.env.SANDBOX_RUNTIME_API_HOST,
  SANDBOX_RUNTIME_API_PORT: process.env.SANDBOX_RUNTIME_API_PORT,
  SANDBOX_AGENT_BIND_HOST: process.env.SANDBOX_AGENT_BIND_HOST,
  SANDBOX_AGENT_BIND_PORT: process.env.SANDBOX_AGENT_BIND_PORT,
  HOLABOSS_RUNTIME_APP_ROOT: process.env.HOLABOSS_RUNTIME_APP_ROOT,
  HOLABOSS_RUNTIME_ROOT: process.env.HOLABOSS_RUNTIME_ROOT,
  HOLABOSS_RUNTIME_NODE_BIN: process.env.HOLABOSS_RUNTIME_NODE_BIN
};

const TEMP_DIRS: string[] = [];

test("applyPrependedPath updates the Windows 'Path' key in place (no dual PATH key)", () => {
  // Native Windows env: the key is "Path". A plain object is case-sensitive,
  // so a naive `env.PATH = …` would miss it and create a competing "PATH" key,
  // dropping ~/.local/bin from the child's effective PATH.
  const env: NodeJS.ProcessEnv = {
    Path: "C:\\Windows\\system32;C:\\Users\\x\\.local\\bin",
    USERPROFILE: "C:\\Users\\x",
  };
  applyPrependedPath(env, ["C:\\bundle\\node\\bin"]);

  const pathKeys = Object.keys(env).filter((k) => k.toLowerCase() === "path");
  assert.deepEqual(pathKeys, ["Path"], "must not introduce a second PATH key");
  const value = env.Path ?? "";
  assert.ok(value.startsWith("C:\\bundle\\node\\bin"), "prepended entry leads");
  assert.ok(value.includes("C:\\Users\\x\\.local\\bin"), ".local/bin preserved");
  assert.ok(value.includes("C:\\Windows\\system32"), "system paths preserved");
});

test("applyPrependedPath updates the POSIX 'PATH' key in place", () => {
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", HOME: "/home/x" };
  applyPrependedPath(env, ["/opt/runtime/bin"]);
  const pathKeys = Object.keys(env).filter((k) => k.toLowerCase() === "path");
  assert.deepEqual(pathKeys, ["PATH"]);
  assert.ok((env.PATH ?? "").startsWith("/opt/runtime/bin"));
  assert.ok((env.PATH ?? "").includes("/usr/bin"));
});

test("applyPrependedPath tolerates a missing PATH key", () => {
  const env: NodeJS.ProcessEnv = { HOME: "/home/x" };
  applyPrependedPath(env, ["/opt/runtime/bin"]);
  assert.equal(env.PATH, "/opt/runtime/bin");
});

afterEach(() => {
  if (ORIGINAL_ENV.SANDBOX_AGENT_RUNNER_COMMAND_TEMPLATE === undefined) {
    delete process.env.SANDBOX_AGENT_RUNNER_COMMAND_TEMPLATE;
  } else {
    process.env.SANDBOX_AGENT_RUNNER_COMMAND_TEMPLATE = ORIGINAL_ENV.SANDBOX_AGENT_RUNNER_COMMAND_TEMPLATE;
  }
  if (ORIGINAL_ENV.SANDBOX_AGENT_RUN_TIMEOUT_S === undefined) {
    delete process.env.SANDBOX_AGENT_RUN_TIMEOUT_S;
  } else {
    process.env.SANDBOX_AGENT_RUN_TIMEOUT_S = ORIGINAL_ENV.SANDBOX_AGENT_RUN_TIMEOUT_S;
  }
  if (ORIGINAL_ENV.SANDBOX_AGENT_TASK_PROPOSAL_RUN_TIMEOUT_S === undefined) {
    delete process.env.SANDBOX_AGENT_TASK_PROPOSAL_RUN_TIMEOUT_S;
  } else {
    process.env.SANDBOX_AGENT_TASK_PROPOSAL_RUN_TIMEOUT_S = ORIGINAL_ENV.SANDBOX_AGENT_TASK_PROPOSAL_RUN_TIMEOUT_S;
  }
  if (ORIGINAL_ENV.SANDBOX_AGENT_RUN_IDLE_TIMEOUT_S === undefined) {
    delete process.env.SANDBOX_AGENT_RUN_IDLE_TIMEOUT_S;
  } else {
    process.env.SANDBOX_AGENT_RUN_IDLE_TIMEOUT_S = ORIGINAL_ENV.SANDBOX_AGENT_RUN_IDLE_TIMEOUT_S;
  }
  if (ORIGINAL_ENV.SANDBOX_AGENT_TASK_PROPOSAL_RUN_IDLE_TIMEOUT_S === undefined) {
    delete process.env.SANDBOX_AGENT_TASK_PROPOSAL_RUN_IDLE_TIMEOUT_S;
  } else {
    process.env.SANDBOX_AGENT_TASK_PROPOSAL_RUN_IDLE_TIMEOUT_S = ORIGINAL_ENV.SANDBOX_AGENT_TASK_PROPOSAL_RUN_IDLE_TIMEOUT_S;
  }
  if (ORIGINAL_ENV.SANDBOX_AGENT_RUN_POST_START_GRACE_S === undefined) {
    delete process.env.SANDBOX_AGENT_RUN_POST_START_GRACE_S;
  } else {
    process.env.SANDBOX_AGENT_RUN_POST_START_GRACE_S = ORIGINAL_ENV.SANDBOX_AGENT_RUN_POST_START_GRACE_S;
  }
  if (ORIGINAL_ENV.SANDBOX_AGENT_RUNNER_HEARTBEAT_MS === undefined) {
    delete process.env.SANDBOX_AGENT_RUNNER_HEARTBEAT_MS;
  } else {
    process.env.SANDBOX_AGENT_RUNNER_HEARTBEAT_MS = ORIGINAL_ENV.SANDBOX_AGENT_RUNNER_HEARTBEAT_MS;
  }
  if (ORIGINAL_ENV.SANDBOX_RUNTIME_API_URL === undefined) {
    delete process.env.SANDBOX_RUNTIME_API_URL;
  } else {
    process.env.SANDBOX_RUNTIME_API_URL = ORIGINAL_ENV.SANDBOX_RUNTIME_API_URL;
  }
  if (ORIGINAL_ENV.SANDBOX_RUNTIME_API_HOST === undefined) {
    delete process.env.SANDBOX_RUNTIME_API_HOST;
  } else {
    process.env.SANDBOX_RUNTIME_API_HOST = ORIGINAL_ENV.SANDBOX_RUNTIME_API_HOST;
  }
  if (ORIGINAL_ENV.SANDBOX_RUNTIME_API_PORT === undefined) {
    delete process.env.SANDBOX_RUNTIME_API_PORT;
  } else {
    process.env.SANDBOX_RUNTIME_API_PORT = ORIGINAL_ENV.SANDBOX_RUNTIME_API_PORT;
  }
  if (ORIGINAL_ENV.SANDBOX_AGENT_BIND_HOST === undefined) {
    delete process.env.SANDBOX_AGENT_BIND_HOST;
  } else {
    process.env.SANDBOX_AGENT_BIND_HOST = ORIGINAL_ENV.SANDBOX_AGENT_BIND_HOST;
  }
  if (ORIGINAL_ENV.SANDBOX_AGENT_BIND_PORT === undefined) {
    delete process.env.SANDBOX_AGENT_BIND_PORT;
  } else {
    process.env.SANDBOX_AGENT_BIND_PORT = ORIGINAL_ENV.SANDBOX_AGENT_BIND_PORT;
  }
  if (ORIGINAL_ENV.HOLABOSS_RUNTIME_APP_ROOT === undefined) {
    delete process.env.HOLABOSS_RUNTIME_APP_ROOT;
  } else {
    process.env.HOLABOSS_RUNTIME_APP_ROOT = ORIGINAL_ENV.HOLABOSS_RUNTIME_APP_ROOT;
  }
  if (ORIGINAL_ENV.HOLABOSS_RUNTIME_ROOT === undefined) {
    delete process.env.HOLABOSS_RUNTIME_ROOT;
  } else {
    process.env.HOLABOSS_RUNTIME_ROOT = ORIGINAL_ENV.HOLABOSS_RUNTIME_ROOT;
  }
  if (ORIGINAL_ENV.HOLABOSS_RUNTIME_NODE_BIN === undefined) {
    delete process.env.HOLABOSS_RUNTIME_NODE_BIN;
  } else {
    process.env.HOLABOSS_RUNTIME_NODE_BIN = ORIGINAL_ENV.HOLABOSS_RUNTIME_NODE_BIN;
  }
  for (const dir of TEMP_DIRS.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workspace_id: "workspace-1",
    session_id: "session-1",
    input_id: "input-1",
    instruction: "hello",
    context: {},
    ...overrides
  };
}

function setNodeRunnerTemplate(lines: string[]): void {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hb-runner-worker-template-"));
  TEMP_DIRS.push(tempDir);
  const runnerScriptPath = path.join(tempDir, "runner-template.mjs");
  fs.writeFileSync(runnerScriptPath, `${lines.join("\n")}\n`, "utf8");
  const quotedRunnerScriptPath = quoteShellValue(runnerScriptPath);
  process.env.SANDBOX_AGENT_RUNNER_COMMAND_TEMPLATE =
    process.platform === "win32"
      ? `& {runtime_node} ${quotedRunnerScriptPath} {request_base64}`
      : `{runtime_node} ${quotedRunnerScriptPath} {request_base64}`;
}

test("native runner executor returns parsed runner events", async () => {
  setNodeRunnerTemplate([
    "const request = process.argv.at(-1) ?? '';",
    "void request;",
    "process.stdout.write(JSON.stringify({ session_id: 'session-1', input_id: 'input-1', sequence: 1, event_type: 'run_started', payload: { instruction_preview: 'hello' } }) + '\\n');",
    "process.stdout.write(JSON.stringify({ session_id: 'session-1', input_id: 'input-1', sequence: 2, event_type: 'run_completed', payload: { status: 'success' } }) + '\\n');"
  ]);

  const executor = new NativeRunnerExecutor();
  const response = await executor.run(payload());

  assert.deepEqual(response, {
    session_id: "session-1",
    input_id: "input-1",
    events: [
      {
        session_id: "session-1",
        input_id: "input-1",
        sequence: 1,
        event_type: "run_started",
        payload: { instruction_preview: "hello" }
      },
      {
        session_id: "session-1",
        input_id: "input-1",
        sequence: 2,
        event_type: "run_completed",
        payload: { status: "success" }
      }
    ]
  });
});

test("native runner executor synthesizes failed stream terminal event", async () => {
  setNodeRunnerTemplate([
    "const request = process.argv.at(-1) ?? '';",
    "void request;",
    "process.stdout.write(JSON.stringify({ session_id: 'session-1', input_id: 'input-1', sequence: 1, event_type: 'run_started', payload: { instruction_preview: 'hello' } }) + '\\n');"
  ]);

  const executor = new NativeRunnerExecutor();
  const stream = await executor.stream(payload());
  let body = "";
  for await (const chunk of stream) {
    body += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
  }

  assert.match(body, /event: run_started/);
  assert.match(body, /event: run_failed/);
  assert.match(body, /runner stream ended before terminal event/);
});

test("executeRunnerRequest parses a final terminal event without a trailing newline", async () => {
  setNodeRunnerTemplate([
    "process.stdout.write(JSON.stringify({ session_id: 'session-1', input_id: 'input-1', sequence: 1, event_type: 'run_started', payload: { instruction_preview: 'hello' } }) + '\\n');",
    "process.stdout.write(JSON.stringify({ session_id: 'session-1', input_id: 'input-1', sequence: 2, event_type: 'run_completed', payload: { status: 'success' } }));"
  ]);

  const execution = await executeRunnerRequest(payload());

  assert.equal(execution.sawTerminal, true);
  assert.deepEqual(
    execution.events.map((event) => event.event_type),
    ["run_started", "run_completed"]
  );
  assert.deepEqual(execution.skippedLines, []);
});

test("native runner executor stream parses a final terminal event without a trailing newline", async () => {
  setNodeRunnerTemplate([
    "process.stdout.write(JSON.stringify({ session_id: 'session-1', input_id: 'input-1', sequence: 1, event_type: 'run_started', payload: { instruction_preview: 'hello' } }) + '\\n');",
    "process.stdout.write(JSON.stringify({ session_id: 'session-1', input_id: 'input-1', sequence: 2, event_type: 'run_completed', payload: { status: 'success' } }));"
  ]);

  const executor = new NativeRunnerExecutor();
  const stream = await executor.stream(payload());
  let body = "";
  for await (const chunk of stream) {
    body += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
  }

  assert.match(body, /event: run_started/);
  assert.match(body, /event: run_completed/);
  assert.doesNotMatch(body, /event: run_failed/);
});

test("executeRunnerRequest surfaces onEvent failures for valid terminal events instead of classifying them as skipped output", async () => {
  setNodeRunnerTemplate([
    "process.stdout.write(JSON.stringify({ session_id: 'session-1', input_id: 'input-1', sequence: 1, event_type: 'run_completed', payload: { status: 'success' } }) + '\\n');"
  ]);

  await assert.rejects(
    () =>
      executeRunnerRequest(payload(), {
        onEvent: async (event) => {
          if (event.event_type === "run_completed") {
            throw new Error("terminal handler blew up");
          }
        },
      }),
    /terminal handler blew up/
  );
});

test("executeRunnerRequest aborts an in-flight runner immediately", async () => {
  setNodeRunnerTemplate([
    "const request = process.argv.at(-1) ?? '';",
    "void request;",
    "process.stdout.write(JSON.stringify({ session_id: 'session-1', input_id: 'input-1', sequence: 1, event_type: 'run_started', payload: { instruction_preview: 'hello' } }) + '\\n');",
    "setInterval(() => {}, 1000);"
  ]);

  const controller = new AbortController();
  const seenEvents: string[] = [];
  const executionPromise = executeRunnerRequest(payload(), {
    signal: controller.signal,
    onEvent: async (event) => {
      seenEvents.push(String(event.event_type));
      if (event.event_type === "run_started") {
        controller.abort("user_requested_pause");
      }
    },
  });

  const execution = await executionPromise;

  assert.deepEqual(seenEvents, ["run_started"]);
  assert.equal(execution.sawTerminal, false);
  assert.equal(execution.aborted, true);
  assert.equal(execution.abortReason, "user_requested_pause");
  assert.equal(execution.returnCode, 130);
  assert.equal(execution.events.length, 1);
  assert.equal(execution.events[0]?.event_type, "run_started");
});

test("executeRunnerRequest isolates a synchronously throwing onHeartbeat so a transient store error never crashes the runner", async () => {
  // A heartbeat hook that throws models a transient "database is locked" while
  // renewing the input-claim lease (the real regression). The hook fires on a
  // setInterval, so an unguarded throw would become an uncaughtException →
  // process.exit(1), taking the whole runtime — and this test process — down.
  // It must be swallowed and the run must complete normally.
  process.env.SANDBOX_AGENT_RUNNER_HEARTBEAT_MS = "50";
  setNodeRunnerTemplate([
    "process.stdout.write(JSON.stringify({ session_id: 'session-1', input_id: 'input-1', sequence: 1, event_type: 'run_started', payload: { instruction_preview: 'hello' } }) + '\\n');",
    // Stay alive long enough for several heartbeats to fire before completing.
    "setTimeout(() => { process.stdout.write(JSON.stringify({ session_id: 'session-1', input_id: 'input-1', sequence: 2, event_type: 'run_completed', payload: { status: 'success' } }) + '\\n'); }, 220);"
  ]);

  let heartbeats = 0;
  const execution = await executeRunnerRequest(payload(), {
    onHeartbeat: () => {
      heartbeats += 1;
      throw new Error("database is locked");
    },
  });

  assert.ok(heartbeats >= 1, "the throwing heartbeat must have fired at least once");
  assert.equal(execution.sawTerminal, true);
  assert.deepEqual(
    execution.events.map((event) => event.event_type),
    ["run_started", "run_completed"]
  );
});

test("executeRunnerRequest isolates a rejecting async onHeartbeat", async () => {
  // The onHeartbeat contract is `() => void | Promise<void>`; a rejected promise
  // must be swallowed too (otherwise it surfaces as an unhandledRejection →
  // process.exit(1)) rather than escaping the heartbeat timer.
  process.env.SANDBOX_AGENT_RUNNER_HEARTBEAT_MS = "50";
  setNodeRunnerTemplate([
    "process.stdout.write(JSON.stringify({ session_id: 'session-1', input_id: 'input-1', sequence: 1, event_type: 'run_started', payload: { instruction_preview: 'hello' } }) + '\\n');",
    "setTimeout(() => { process.stdout.write(JSON.stringify({ session_id: 'session-1', input_id: 'input-1', sequence: 2, event_type: 'run_completed', payload: { status: 'success' } }) + '\\n'); }, 220);"
  ]);

  let heartbeats = 0;
  const execution = await executeRunnerRequest(payload(), {
    onHeartbeat: async () => {
      heartbeats += 1;
      throw new Error("database is locked");
    },
  });

  assert.ok(heartbeats >= 1, "the rejecting heartbeat must have fired at least once");
  assert.equal(execution.sawTerminal, true);
});

test("native runner executor reports invalid command templates", async () => {
  process.env.SANDBOX_AGENT_RUNNER_COMMAND_TEMPLATE = "echo {missing}";

  const executor = new NativeRunnerExecutor();
  await assert.rejects(() => executor.run(payload()), (error: unknown) => {
    assert.ok(error instanceof RunnerExecutorError);
    assert.equal(error.statusCode, 500);
    assert.match(error.message, /invalid SANDBOX_AGENT_RUNNER_COMMAND_TEMPLATE/);
    return true;
  });
});

test("native runner executor can use the TypeScript runner template", async () => {
  delete process.env.SANDBOX_AGENT_RUNNER_COMMAND_TEMPLATE;
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hb-runner-worker-ts-"));
  TEMP_DIRS.push(runtimeRoot);
  process.env.HOLABOSS_RUNTIME_ROOT = runtimeRoot;
  process.env.HOLABOSS_RUNTIME_NODE_BIN = process.execPath;
  fs.mkdirSync(path.join(runtimeRoot, "api-server", "dist"), { recursive: true });

  const startEvent = Buffer.from(
    JSON.stringify({
      session_id: "session-1",
      input_id: "input-1",
      sequence: 1,
      event_type: "run_started",
      payload: { runner: "ts" }
    }),
    "utf8"
  ).toString("base64");
  const doneEvent = Buffer.from(
    JSON.stringify({
      session_id: "session-1",
      input_id: "input-1",
      sequence: 2,
      event_type: "run_completed",
      payload: { status: "success" }
    }),
    "utf8"
  ).toString("base64");
  const scriptBase64 = Buffer.from(
    [
      "const request = process.argv.at(-1) ?? '';",
      `const start = Buffer.from('${startEvent}', 'base64').toString('utf8');`,
      `const done = Buffer.from('${doneEvent}', 'base64').toString('utf8');`,
      "void request;",
      "process.stdout.write(start + '\\n');",
      "process.stdout.write(done + '\\n');"
    ].join(" "),
    "utf8"
  ).toString("base64");
  fs.writeFileSync(
    path.join(runtimeRoot, "api-server", "dist", "ts-runner.mjs"),
    [
      "const request = process.argv.at(-1) ?? '';",
      `const script = Buffer.from('${scriptBase64}', 'base64').toString('utf8');`,
      "void request;",
      "await import(`data:text/javascript,${encodeURIComponent(script)}`);",
      ""
    ].join("\n"),
    "utf8"
  );

  const executor = new NativeRunnerExecutor();
  const response = await executor.run(payload());
  const events = response.events as Array<Record<string, unknown>>;

  assert.equal((events[0]?.payload as Record<string, unknown>).runner, "ts");
  assert.deepEqual(events.at(-1), {
    session_id: "session-1",
    input_id: "input-1",
    sequence: 2,
    event_type: "run_completed",
    payload: { status: "success" }
  });
});

test("native runner executor gives subagent runs a longer hard timeout budget", async () => {
  process.env.SANDBOX_AGENT_RUN_TIMEOUT_S = "1";
  process.env.SANDBOX_AGENT_SUBAGENT_RUN_TIMEOUT_S = "5";
  process.env.SANDBOX_AGENT_RUN_IDLE_TIMEOUT_S = "10";
  process.env.SANDBOX_AGENT_SUBAGENT_RUN_IDLE_TIMEOUT_S = "10";

  setNodeRunnerTemplate([
    "setTimeout(() => {",
    "  process.stdout.write(JSON.stringify({ session_id: 'session-1', input_id: 'input-1', sequence: 1, event_type: 'run_started', payload: { instruction_preview: 'hello' } }) + '\\n');",
    "  process.stdout.write(JSON.stringify({ session_id: 'session-1', input_id: 'input-1', sequence: 2, event_type: 'run_completed', payload: { status: 'success' } }) + '\\n');",
    "}, 1500);"
  ]);

  const executor = new NativeRunnerExecutor();
  const response = await executor.run(payload({ session_kind: "subagent" }));
  const events = response.events as Array<Record<string, unknown>>;

  assert.deepEqual(
    events.map((event) => event.event_type),
    ["run_started", "run_completed"]
  );
});

test("native runner executor gives subagent runs a longer idle timeout budget", async () => {
  process.env.SANDBOX_AGENT_RUN_TIMEOUT_S = "10";
  process.env.SANDBOX_AGENT_SUBAGENT_RUN_TIMEOUT_S = "10";
  process.env.SANDBOX_AGENT_RUN_IDLE_TIMEOUT_S = "1";
  process.env.SANDBOX_AGENT_SUBAGENT_RUN_IDLE_TIMEOUT_S = "5";

  setNodeRunnerTemplate([
    "process.stdout.write(JSON.stringify({ session_id: 'session-1', input_id: 'input-1', sequence: 1, event_type: 'run_started', payload: { instruction_preview: 'hello' } }) + '\\n');",
    "setTimeout(() => {",
    "  process.stdout.write(JSON.stringify({ session_id: 'session-1', input_id: 'input-1', sequence: 2, event_type: 'run_completed', payload: { status: 'success' } }) + '\\n');",
    "}, 1500);"
  ]);

  const executor = new NativeRunnerExecutor();
  const response = await executor.run(payload({ session_kind: "subagent" }));
  const events = response.events as Array<Record<string, unknown>>;

  assert.deepEqual(
    events.map((event) => event.event_type),
    ["run_started", "run_completed"]
  );
});

test("native runner executor keeps silent runs alive with invisible runner heartbeats", async () => {
  process.env.SANDBOX_AGENT_RUN_TIMEOUT_S = "10";
  process.env.SANDBOX_AGENT_RUN_IDLE_TIMEOUT_S = "1";
  process.env.SANDBOX_AGENT_RUNNER_HEARTBEAT_MS = "50";

  setNodeRunnerTemplate([
    "setTimeout(() => {",
    "  process.stdout.write(JSON.stringify({ session_id: 'session-1', input_id: 'input-1', sequence: 1, event_type: 'run_started', payload: { instruction_preview: 'hello' } }) + '\\n');",
    "  process.stdout.write(JSON.stringify({ session_id: 'session-1', input_id: 'input-1', sequence: 2, event_type: 'run_completed', payload: { status: 'success' } }) + '\\n');",
    "}, 1500);"
  ]);

  const executor = new NativeRunnerExecutor();
  const response = await executor.run(payload());
  const events = response.events as Array<Record<string, unknown>>;

  assert.deepEqual(
    events.map((event) => event.event_type),
    ["run_started", "run_completed"]
  );
});

test("executeRunnerRequest gives a started harness its own timeout budget before the outer watchdog kills it", async () => {
  process.env.SANDBOX_AGENT_RUN_TIMEOUT_S = "1";
  process.env.SANDBOX_AGENT_RUN_IDLE_TIMEOUT_S = "10";
  process.env.SANDBOX_AGENT_RUN_POST_START_GRACE_S = "0";

  setNodeRunnerTemplate([
    "setTimeout(() => {",
    "  process.stdout.write(JSON.stringify({ session_id: 'session-1', input_id: 'input-1', sequence: 1, event_type: 'run_started', payload: { instruction_preview: 'hello' } }) + '\\n');",
    "}, 500);",
    "setTimeout(() => {",
    "  process.stdout.write(JSON.stringify({ session_id: 'session-1', input_id: 'input-1', sequence: 2, event_type: 'run_completed', payload: { status: 'success' } }) + '\\n');",
    "}, 1500);"
  ]);

  const execution = await executeRunnerRequest(
    payload({ harness_timeout_seconds: 2 }),
    {}
  );

  assert.equal(execution.stderr, "");
  assert.equal(execution.returnCode, 0);
  assert.equal(execution.sawTerminal, true);
  assert.deepEqual(
    execution.events.map((event) => event.event_type),
    ["run_started", "run_completed"]
  );
});

test("executeRunnerRequest refreshes subagent harness deadlines when real progress continues", async () => {
  process.env.SANDBOX_AGENT_RUN_TIMEOUT_S = "1";
  process.env.SANDBOX_AGENT_RUN_IDLE_TIMEOUT_S = "10";
  process.env.SANDBOX_AGENT_RUN_POST_START_GRACE_S = "0";

  setNodeRunnerTemplate([
    "process.stdout.write(JSON.stringify({ session_id: 'session-1', input_id: 'input-1', sequence: 1, event_type: 'run_started', payload: { instruction_preview: 'hello' } }) + '\\n');",
    "setTimeout(() => {",
    "  process.stdout.write(JSON.stringify({ session_id: 'session-1', input_id: 'input-1', sequence: 2, event_type: 'message_update', payload: { delta: 'still working' } }) + '\\n');",
    "}, 400);",
    "setTimeout(() => {",
    "  process.stdout.write(JSON.stringify({ session_id: 'session-1', input_id: 'input-1', sequence: 3, event_type: 'run_completed', payload: { status: 'success' } }) + '\\n');",
    "}, 1200);"
  ]);

  const execution = await executeRunnerRequest(
    payload({ session_kind: "subagent", harness_timeout_seconds: 1 }),
    {}
  );

  assert.equal(execution.stderr, "");
  assert.equal(execution.returnCode, 0);
  assert.equal(execution.sawTerminal, true);
  assert.deepEqual(
    execution.events.map((event) => event.event_type),
    ["run_started", "message_update", "run_completed"]
  );
});

test("current runtime api url prefers explicit value", () => {
  process.env.SANDBOX_RUNTIME_API_URL = "http://127.0.0.1:5060";
  process.env.SANDBOX_RUNTIME_API_PORT = "9999";

  assert.equal(currentRuntimeApiUrl(), "http://127.0.0.1:5060");
});

test("current runtime api url derives from runtime host and port", () => {
  delete process.env.SANDBOX_RUNTIME_API_URL;
  process.env.SANDBOX_RUNTIME_API_HOST = "0.0.0.0";
  process.env.SANDBOX_RUNTIME_API_PORT = "53668";

  assert.equal(currentRuntimeApiUrl(), "http://127.0.0.1:53668");
});

test("build runner env injects runtime api url when missing", () => {
  delete process.env.SANDBOX_RUNTIME_API_URL;
  delete process.env.SANDBOX_RUNTIME_API_HOST;
  process.env.SANDBOX_AGENT_BIND_HOST = "127.0.0.1";
  process.env.SANDBOX_AGENT_BIND_PORT = "5060";

  const env = buildRunnerEnv();

  assert.equal(env.SANDBOX_RUNTIME_API_URL, "http://127.0.0.1:5060");
});

test("build runner env prepends api-server local bin helpers", () => {
  process.env.HOLABOSS_RUNTIME_ROOT = "/bundle/runtime";
  process.env.HOLABOSS_RUNTIME_APP_ROOT = "/bundle/runtime";
  const delimiter = shellPathDelimiter();
  process.env.PATH = ["/usr/local/bin", "/usr/bin"].join(delimiter);
  const bundleRoot = path.resolve("/bundle");
  const runtimeAppRoot = "/bundle/runtime";

  const env = buildRunnerEnv();

  assert.equal(
    env.PATH,
    [
      ...(process.platform === "win32"
        ? [
            path.join(bundleRoot, "python-runtime", "python"),
            path.join(bundleRoot, "python-runtime", "python", "Scripts"),
            path.join(bundleRoot, "python-runtime", "bin"),
            path.join(bundleRoot, "node-runtime", "bin"),
            path.join(bundleRoot, "node-runtime", "node_modules", ".bin"),
          ]
        : [
            path.join(bundleRoot, "python-runtime", "bin"),
            path.join(bundleRoot, "python-runtime", "python", "bin"),
            path.join(bundleRoot, "node-runtime", "node_modules", ".bin"),
            path.join(bundleRoot, "node-runtime", "node_modules", "node", "bin"),
          ]),
      path.join(runtimeAppRoot, "api-server", "node_modules", ".bin"),
      "/usr/local/bin",
      "/usr/bin"
    ].join(delimiter)
  );
});

test("build runner env anchors the bundle root to this module (not drive-root) when HOLABOSS_RUNTIME_ROOT is unset", () => {
  // Regression: with the env var unset, runtimeRoot() defaulted to "/runtime",
  // and runtimeBundleRoot()'s `path.resolve(root, "..")` collapsed that to the
  // drive root on Windows — producing bogus `C:\python-runtime\...` PATH entries
  // and a silent fallback to a system Python. It must now anchor to this
  // module's real on-disk location instead.
  delete process.env.HOLABOSS_RUNTIME_ROOT;
  delete process.env.HOLABOSS_RUNTIME_APP_ROOT;
  const delimiter = shellPathDelimiter();
  process.env.PATH = ["/usr/bin"].join(delimiter);

  const env = buildRunnerEnv();

  // <repo> is three levels up from this test file (src → api-server → runtime),
  // which is exactly the bundle root the module anchor resolves to.
  const expectedBundleRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../..",
  );
  const anchoredPythonRoot = path.join(expectedBundleRoot, "python-runtime");
  assert.ok(
    (env.PATH ?? "").includes(anchoredPythonRoot),
    `PATH should anchor python-runtime under ${expectedBundleRoot}; got ${env.PATH}`,
  );

  const brokenBundleRoot = path.resolve("/runtime", "..");
  const brokenPythonEntry = path.join(
    brokenBundleRoot,
    "python-runtime",
    "python",
  );
  assert.ok(
    !(env.PATH ?? "").split(delimiter).includes(brokenPythonEntry),
    `PATH must not contain the drive-root python entry ${brokenPythonEntry}`,
  );
});

test("default runner invocation hands the request off by file, never on the command line", () => {
  delete process.env.SANDBOX_AGENT_RUNNER_COMMAND_TEMPLATE;
  const invocation = runnerInvocation(payload());
  try {
    assert.ok(invocation.requestFilePath, "default path writes a request file");
    assert.match(invocation.command, /--request-file/);
    assert.doesNotMatch(invocation.command, /--request-base64/);
    // The command references the file, not the payload itself: the unique
    // instruction text must not appear inline on the command line.
    assert.ok(fs.existsSync(invocation.requestFilePath), "request file exists");
    const decoded = JSON.parse(
      Buffer.from(
        fs.readFileSync(invocation.requestFilePath, "utf8").trim(),
        "base64",
      ).toString("utf8"),
    );
    assert.equal(decoded.instruction, "hello");
    assert.equal(decoded.session_id, "session-1");
  } finally {
    removeRunnerRequestFile(invocation.requestFilePath);
  }
  assert.equal(
    fs.existsSync(invocation.requestFilePath ?? ""),
    false,
    "removeRunnerRequestFile deletes the temp file",
  );
});

test("a huge request keeps the command line tiny (no Windows ENAMETOOLONG)", () => {
  delete process.env.SANDBOX_AGENT_RUNNER_COMMAND_TEMPLATE;
  // ~400KB instruction: base64 of this alone dwarfs Windows' 32,767-char
  // command-line cap. The whole point of the file handoff is that the command
  // length is independent of payload size.
  const huge = "x".repeat(400_000);
  const invocation = runnerInvocation(payload({ instruction: huge }));
  try {
    assert.ok(
      invocation.command.length < 1_000,
      `command line must stay small; was ${invocation.command.length}`,
    );
    assert.doesNotMatch(invocation.command, /xxxxx/);
    const decoded = JSON.parse(
      Buffer.from(
        fs.readFileSync(invocation.requestFilePath ?? "", "utf8").trim(),
        "base64",
      ).toString("utf8"),
    );
    assert.equal(decoded.instruction, huge);
  } finally {
    removeRunnerRequestFile(invocation.requestFilePath);
  }
});

test("a custom runner template still inlines the base64 request (no file)", () => {
  process.env.SANDBOX_AGENT_RUNNER_COMMAND_TEMPLATE = "runme {request_base64}";
  const request = payload();
  const invocation = runnerInvocation(request);
  assert.equal(invocation.requestFilePath, null, "template path writes no file");
  const expectedBase64 = Buffer.from(JSON.stringify(request), "utf-8").toString(
    "base64",
  );
  assert.ok(
    invocation.command.includes(expectedBase64),
    "template inlines the base64 request as before",
  );
});
