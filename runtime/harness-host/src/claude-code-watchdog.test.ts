import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { decodeHarnessHostClaudeCodeRequestBase64 } from "./contracts.js";
import { runClaudeStreamHarness } from "./claude-code.js";

const tempDirs: string[] = [];
const originalEnv = { ...process.env };

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  process.env = { ...originalEnv };
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** A stand-in CLI that starts fine and then produces nothing at all. */
function wedgedBinary(dir: string): string {
  const file = path.join(dir, "wedged.mjs");
  fs.writeFileSync(file, "setInterval(() => {}, 1000);\n", "utf8");
  const shim = path.join(dir, "wedged.sh");
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${file}"\n`, "utf8");
  fs.chmodSync(shim, 0o755);
  return shim;
}

function makeRequest(cwd: string) {
  return decodeHarnessHostClaudeCodeRequestBase64(
    Buffer.from(
      JSON.stringify({
        workspace_id: "workspace-1",
        session_id: "session-1",
        input_id: "input-1",
        instruction: "hello",
        agent_cwd: cwd,
        workspace_dir: cwd,
        model_client: {
          model_proxy_provider: "openai_compatible",
          api_key: "test-key",
          base_url: "http://127.0.0.1:1/v1",
        },
        workspace_config_checksum: "x",
        timeout_seconds: 600,
        model_id: "x",
        provider_id: "x",
        context: {},
      }),
    ).toString("base64"),
  );
}

test("a CLI that never emits anything fails fast instead of spinning", async () => {
  const dir = tempDir("hb-claude-watchdog-");
  process.env.HOLABOSS_CLAUDE_PATH = wedgedBinary(dir);

  const emitted: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  // Capture only our own event lines and pass everything else straight
  // through — node:test writes its own protocol frames to this same stream.
  (process.stdout as unknown as { write: unknown }).write = ((
    chunk: unknown,
    ...rest: unknown[]
  ) => {
    const text = typeof chunk === "string" ? chunk : "";
    if (text.startsWith('{"session_id"')) {
      emitted.push(text);
      return true;
    }
    return (originalWrite as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;

  const startedAt = Date.now();
  try {
    await runClaudeStreamHarness(makeRequest(dir), {
      id: "claude-code",
      label: "claude",
      defaultBinary: "claude",
      binaryEnv: "HOLABOSS_CLAUDE_PATH",
      modelEnv: "HOLABOSS_CLAUDE_MODEL",
      argsEnv: "HOLABOSS_CLAUDE_ARGS",
      // Without a watchdog here this hangs until the api-server's 900s idle
      // cap, which is the whole bug: a 15-minute spinner and then a generic
      // "runner command became idle".
      firstFrameTimeoutMs: 150,
    });
  } finally {
    (process.stdout as unknown as { write: unknown }).write = originalWrite;
  }
  const elapsed = Date.now() - startedAt;

  assert.ok(elapsed < 10_000, `harness should give up promptly, took ${elapsed}ms`);

  const events = emitted
    .join("")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as { event_type?: string; payload?: Record<string, unknown> };
      } catch {
        return null;
      }
    })
    .filter((e): e is { event_type?: string; payload?: Record<string, unknown> } => Boolean(e));

  const failed = events.find((e) => e.event_type === "run_failed");
  assert.ok(failed, `expected a run_failed event, saw ${events.map((e) => e.event_type).join(",")}`);
  // The message has to name the actual condition — "became idle" 15 minutes
  // later is what made this undiagnosable.
  assert.match(String(failed.payload?.error ?? ""), /first turn|emitted nothing/i);
});
