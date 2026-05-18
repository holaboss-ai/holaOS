import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import {
  buildRunnerEnv,
  currentRuntimeApiUrl,
  executeRunnerRequest,
  NativeRunnerExecutor,
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

test("native runner executor gives task proposal runs a longer hard timeout budget", async () => {
  process.env.SANDBOX_AGENT_RUN_TIMEOUT_S = "1";
  process.env.SANDBOX_AGENT_TASK_PROPOSAL_RUN_TIMEOUT_S = "5";
  process.env.SANDBOX_AGENT_RUN_IDLE_TIMEOUT_S = "10";
  process.env.SANDBOX_AGENT_TASK_PROPOSAL_RUN_IDLE_TIMEOUT_S = "10";

  setNodeRunnerTemplate([
    "setTimeout(() => {",
    "  process.stdout.write(JSON.stringify({ session_id: 'session-1', input_id: 'input-1', sequence: 1, event_type: 'run_started', payload: { instruction_preview: 'hello' } }) + '\\n');",
    "  process.stdout.write(JSON.stringify({ session_id: 'session-1', input_id: 'input-1', sequence: 2, event_type: 'run_completed', payload: { status: 'success' } }) + '\\n');",
    "}, 1500);"
  ]);

  const executor = new NativeRunnerExecutor();
  const response = await executor.run(payload({ session_kind: "task_proposal" }));
  const events = response.events as Array<Record<string, unknown>>;

  assert.deepEqual(
    events.map((event) => event.event_type),
    ["run_started", "run_completed"]
  );
});

test("native runner executor gives task proposal runs a longer idle timeout budget", async () => {
  process.env.SANDBOX_AGENT_RUN_TIMEOUT_S = "10";
  process.env.SANDBOX_AGENT_TASK_PROPOSAL_RUN_TIMEOUT_S = "10";
  process.env.SANDBOX_AGENT_RUN_IDLE_TIMEOUT_S = "1";
  process.env.SANDBOX_AGENT_TASK_PROPOSAL_RUN_IDLE_TIMEOUT_S = "5";

  setNodeRunnerTemplate([
    "process.stdout.write(JSON.stringify({ session_id: 'session-1', input_id: 'input-1', sequence: 1, event_type: 'run_started', payload: { instruction_preview: 'hello' } }) + '\\n');",
    "setTimeout(() => {",
    "  process.stdout.write(JSON.stringify({ session_id: 'session-1', input_id: 'input-1', sequence: 2, event_type: 'run_completed', payload: { status: 'success' } }) + '\\n');",
    "}, 1500);"
  ]);

  const executor = new NativeRunnerExecutor();
  const response = await executor.run(payload({ session_kind: "task_proposal" }));
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
