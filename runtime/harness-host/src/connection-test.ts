import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

/**
 * Live connection test for a harness. Runs the harness's real runner
 * (`run-<id>`) with a tiny throwaway prompt and watches its event stream for a
 * terminal `run_completed` (pass) or `run_failed` (fail). This is a genuine
 * end-to-end check — the CLI is launched, authenticates, handshakes, and the
 * model produces output — not just a PATH probe.
 *
 * It self-spawns the run as a child (rather than calling the runner in-process)
 * so the run's event stream stays isolated from this process's own stdout,
 * which carries only the verdict. No MCP servers / tools are wired in, so the
 * test is pure connectivity, not workspace integration.
 */
export interface HarnessConnectionTestResult {
  ok: boolean;
  /** Human-readable outcome (output snippet on success, error tail on failure). */
  detail: string;
  duration_ms: number;
}

const TEST_INSTRUCTION =
  "Connection test. Reply with the single word OK and nothing else.";

function buildMinimalRequest(harnessId: string, cwd: string, timeoutSeconds: number): string {
  const request = {
    workspace_id: "connection-test",
    workspace_dir: cwd,
    agent_cwd: cwd,
    session_id: `connection-test-${harnessId}`,
    input_id: "connection-test",
    instruction: TEST_INSTRUCTION,
    context_messages: [],
    tools: {},
    attachments: [],
    image_urls: [],
    thinking_value: null,
    debug: false,
    // No resume — always a fresh ephemeral session.
    provider_id: "connection-test",
    model_id: "connection-test",
    // null → the CLI uses its own default model (we're testing connectivity,
    // not a specific model).
    selected_model: null,
    timeout_seconds: timeoutSeconds,
    // No runtime endpoint + no servers → the harness runs with zero MCP, so the
    // test isolates "can this agent run" from workspace tool wiring.
    runtime_api_base_url: null,
    system_prompt: "",
    workspace_skill_dirs: [],
    mcp_servers: [],
    mcp_tool_refs: [],
    workspace_config_checksum: "connection-test",
    run_started_payload: {},
    // Unused by CLI runners, but the wire decoder requires non-empty strings.
    model_client: { model_proxy_provider: "connection-test", api_key: "connection-test" },
    agent_role: "main-loop",
  };
  return Buffer.from(JSON.stringify(request), "utf8").toString("base64");
}

function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

export async function testHarnessConnection(opts: {
  harnessId: string;
  hostCommand: string;
  cwd?: string;
  timeoutMs: number;
}): Promise<HarnessConnectionTestResult> {
  const startedAt = Date.now();
  // Run in a throwaway dir so the test never touches a real workspace.
  const ownsCwd = !opts.cwd;
  const cwd = opts.cwd ?? mkdtempSync(join(tmpdir(), "holaboss-conn-test-"));
  const cleanup = (): void => {
    if (ownsCwd) {
      try {
        rmSync(cwd, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  };

  const requestBase64 = buildMinimalRequest(
    opts.harnessId,
    cwd,
    Math.max(1, Math.round(opts.timeoutMs / 1000)),
  );

  // Self-spawn the harness-host entry with the harness's run command. Replicate
  // process.execArgv (e.g. `--import tsx` in dev) so the child loads the same way.
  const entry = process.argv[1];
  if (!entry) {
    cleanup();
    return { ok: false, detail: "harness-host entry not resolvable", duration_ms: 0 };
  }

  return await new Promise<HarnessConnectionTestResult>((resolve) => {
    let settled = false;
    let outputText = "";
    let failError = "";
    let stderrTail = "";
    let sawTerminal = false;
    let ok = false;

    const finish = (result: Omit<HarnessConnectionTestResult, "duration_ms">): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
      cleanup();
      resolve({ ...result, duration_ms: Date.now() - startedAt });
    };

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(
        process.execPath,
        [...process.execArgv, entry, opts.hostCommand, "--request-stdin"],
        // Inherit the parent's cwd so a dev `--import tsx` loader still
        // resolves; the harness CLI runs in `cwd` via the request's
        // workspace_dir/agent_cwd, not the child process's own cwd.
        { env: process.env, stdio: ["pipe", "pipe", "pipe"] },
      );
    } catch (error) {
      cleanup();
      resolve({
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
        duration_ms: Date.now() - startedAt,
      });
      return;
    }

    const timer = setTimeout(() => {
      finish({
        ok: false,
        detail: `Timed out after ${Math.round(opts.timeoutMs / 1000)}s with no response.`,
      });
    }, opts.timeoutMs);

    try {
      child.stdin.write(requestBase64);
      child.stdin.end();
    } catch {
      // reader/close handlers below will surface the failure
    }

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-2048);
    });

    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }
      let event: { event_type?: string; payload?: Record<string, unknown> };
      try {
        event = JSON.parse(trimmed) as typeof event;
      } catch {
        return;
      }
      const payload = event.payload ?? {};
      if (event.event_type === "output_delta") {
        const delta = payload.delta;
        if (typeof delta === "string") {
          outputText += delta;
        }
      } else if (event.event_type === "run_completed") {
        sawTerminal = true;
        ok = true;
      } else if (event.event_type === "run_failed") {
        sawTerminal = true;
        ok = false;
        const error = payload.error;
        if (typeof error === "string") {
          failError = error;
        }
      }
    });

    child.on("error", (error) => {
      finish({ ok: false, detail: error instanceof Error ? error.message : String(error) });
    });

    child.on("close", () => {
      if (settled) {
        return;
      }
      if (sawTerminal && ok) {
        const snippet = truncate(outputText, 160);
        // A clean terminal with no text is suspicious (e.g. an unauthenticated
        // CLI that ends the turn empty). Report it honestly rather than
        // claiming a response — don't mask a non-functional agent as healthy.
        finish(
          snippet
            ? { ok: true, detail: `Responded: "${snippet}"` }
            : {
                ok: false,
                detail:
                  "Agent completed the turn but produced no output — it may not be authenticated or have a model configured.",
              },
        );
        return;
      }
      const detail =
        truncate(failError, 300) ||
        truncate(stderrTail, 300) ||
        "The agent exited without responding.";
      finish({ ok: false, detail });
    });
  });
}
