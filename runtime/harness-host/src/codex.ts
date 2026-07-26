import { spawn } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";

import {
  type HarnessHostCodexRequest,
  type JsonObject,
  type JsonValue,
  type RunnerEventType,
  type RunnerOutputEventPayload,
} from "./contracts.js";
import { renderHarnessCliAttachments } from "../../harnesses/src/attachment-content.js";
import type { HarnessSupportedModel } from "../../harnesses/src/types.js";
import { expandCliHarnessSkillReferences } from "./cli-skill-references.js";
import { resolveWindowsCliInvocation } from "./windows-cli-invocation.js";

/**
 * Codex harness host runner.
 *
 * Spawns `codex app-server --listen stdio://` and speaks JSON-RPC 2.0
 * over newline-delimited frames.
 *
 * Bidirectional protocol summary:
 *   • Daemon → Codex requests: initialize, thread/start (or
 *     thread/resume), turn/start.
 *   • Daemon → Codex notifications: initialized.
 *   • Codex → daemon notifications: turn/started, item/started,
 *     item/completed, turn/completed, turn/aborted, plus the older
 *     codex/event family (legacy v1 protocol).
 *   • Codex → daemon requests: approval prompts — auto-answered with
 *     `decision:"accept"` (or `action:"accept"` for MCP elicitation).
 *
 * Implemented here: MCP TOML materialization, the two-tier semantic /
 * first-turn inactivity timeouts, token-usage extraction from
 * turn/completed, thread/resume on persisted_harness_session_id, and a
 * managed CODEX_HOME that seeds the user's auth + session history (see
 * prepareCodexHome).
 *
 * Still deferred (acceptable gaps):
 *   • Custom-args filtering (we don't accept custom_args yet)
 *   • JSONL token-usage fallback for codex builds that omit turn.usage
 */
export async function runCodex(request: HarnessHostCodexRequest): Promise<number> {
  const env = { ...process.env };
  // Prepare a managed $CODEX_HOME holding (a) a config.toml with this
  // workspace's [mcp_servers.*] tables, (b) the workspace's skills under
  // skills/, and (c) symlinks back to the shared ~/.codex auth.json +
  // sessions/ so native auth and thread history survive. codex app-server
  // reads credentials from $CODEX_HOME, so a bare home would be
  // unauthenticated, and thread/resume needs the prior run's session
  // files to still exist. Returns null
  // only when there's nothing to manage (no MCP servers and no skills) —
  // then codex just inherits the user's own ~/.codex.
  const codexHomePrep = prepareCodexHome(request);
  if (codexHomePrep) {
    env.CODEX_HOME = codexHomePrep.codexHome;
  }

  // Allow operators to pin a non-PATH codex binary (e.g. a sandboxed
  // install) without re-plumbing the runtime.
  const codexBin = (process.env.HOLABOSS_CODEX_PATH ?? "").trim() || "codex";
  // On Windows, codex installs as a `codex.cmd` npm shim; spawn the Node CLI it
  // wraps (`node codex.js …`) directly so the bidirectional stdio JSON-RPC
  // survives — the old `.ps1` route deadlocked app-server's handshake (no-op
  // elsewhere / for a native binary). See windows-cli-invocation.ts.
  const codexInvocation = resolveWindowsCliInvocation(
    "codex",
    codexBin,
    ["app-server", "--listen", "stdio://"],
  );
  const child = spawn(codexInvocation.command, codexInvocation.args, {
    cwd: request.agent_cwd || request.workspace_dir,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let sequence = 0;
  const emit = (eventType: RunnerEventType, payload: JsonObject): void => {
    const event: RunnerOutputEventPayload = {
      session_id: request.session_id,
      input_id: request.input_id,
      sequence: sequence++,
      event_type: eventType,
      payload,
    };
    process.stdout.write(`${JSON.stringify(event)}\n`);
  };

  emit("run_started", { harness: "codex", pid: child.pid ?? null });

  let stderrTail = "";
  const STDERR_TAIL_MAX = 4096;
  child.stderr.on("data", (chunk: Buffer) => {
    process.stderr.write(chunk);
    stderrTail = (stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL_MAX);
  });

  const stdinClosedRef = { closed: false };
  const closeStdin = (): void => {
    if (stdinClosedRef.closed) return;
    stdinClosedRef.closed = true;
    try {
      child.stdin.end();
    } catch {
      // already closed
    }
  };

  // ── JSON-RPC dispatch state ─────────────────────────────────────────
  let nextId = 1;
  const pending = new Map<number, {
    resolve: (value: JsonValue) => void;
    reject: (err: Error) => void;
  }>();

  function sendRequest(method: string, params: JsonObject | null): Promise<JsonValue> {
    const id = nextId++;
    const frame = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise<JsonValue>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try {
        child.stdin.write(`${frame}\n`);
      } catch (err) {
        pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  function sendNotification(method: string, params: JsonObject | null): void {
    const frame = JSON.stringify({ jsonrpc: "2.0", method, params });
    try {
      child.stdin.write(`${frame}\n`);
    } catch {
      // best effort
    }
  }

  function sendResponse(id: JsonValue, result: JsonValue): void {
    const frame = JSON.stringify({ jsonrpc: "2.0", id, result });
    try {
      child.stdin.write(`${frame}\n`);
    } catch {
      // best effort
    }
  }

  // ── Streaming state ─────────────────────────────────────────────────
  let sessionId: string | null = null;
  let finalStatus: "completed" | "failed" = "completed";
  let finalError: string | null = null;
  let outputText = "";
  // agentMessage item ids we've already streamed via item/agentMessage/delta.
  // Codex streams token deltas during the turn AND re-sends the full text on
  // item/completed; this lets the completion handler skip that duplicate. The
  // delta's `itemId` equals the completed item's `id` (verified against the
  // app-server). Empty for codex builds that don't stream deltas, so the
  // completion path stays the emitter and output degrades safely.
  const streamedAgentMessageItemIds = new Set<string>();
  let turnCompletedResolver: ((value: void) => void) | null = null;
  const turnCompletedPromise = new Promise<void>((resolve) => {
    turnCompletedResolver = resolve;
  });
  // A spawn failure (bad node path, missing entry) surfaces as an async 'error'
  // event; with no listener Node throws it as an uncaught exception and the host
  // exits emitting no terminal event — the silent "exited without responding"
  // the connection test reports. Convert it into a clean run_failed instead.
  child.on("error", (error) => {
    if (finalStatus === "failed" && finalError) return;
    finalStatus = "failed";
    finalError = `failed to spawn codex: ${
      error instanceof Error ? error.message : String(error)
    }`;
    turnCompletedResolver?.();
  });
  // Per-model token usage accumulator, populated from turn/completed.
  // Codex reports usage in the same shape as OpenAI's chat completions
  // — keys are snake_case input_tokens / output_tokens / etc.
  const usage = new Map<string, CodexTokenUsage>();
  // Two-tier inactivity timer:
  //   • firstTurnNoProgressTimeout: 30s for *any* event after spawn.
  //     If codex stays silent that long the binary is stuck and we
  //     kill it before the outer timeout to fail fast with a useful
  //     stderr tail.
  //   • semanticInactivityTimeout: 10m default once at least one
  //     activity-class event has landed. Activity = item/started,
  //     item/completed (excluding noise), turn/started. Heartbeat
  //     notifications and approval round-trips don't reset the
  //     timer.
  let semanticInactivityFired = false;
  let firstTurnProgressSeen = false;
  let semanticInactivityTimer: NodeJS.Timeout | null = null;
  let firstTurnTimer: NodeJS.Timeout | null = null;
  const FIRST_TURN_NO_PROGRESS_MS = 30_000;
  const SEMANTIC_INACTIVITY_MS = 10 * 60 * 1000;
  const fireSemanticInactivity = (reason: string): void => {
    if (semanticInactivityFired) return;
    semanticInactivityFired = true;
    finalStatus = "failed";
    finalError = reason;
    closeStdin();
    try {
      child.kill("SIGTERM");
    } catch {
      // already dead
    }
    turnCompletedResolver?.();
  };
  const resetSemanticInactivityTimer = (): void => {
    if (semanticInactivityTimer) {
      clearTimeout(semanticInactivityTimer);
    }
    semanticInactivityTimer = setTimeout(() => {
      fireSemanticInactivity(
        `codex made no progress for ${Math.round(SEMANTIC_INACTIVITY_MS / 60_000)} minutes`,
      );
    }, SEMANTIC_INACTIVITY_MS);
    semanticInactivityTimer.unref();
  };
  const markActivity = (): void => {
    if (!firstTurnProgressSeen) {
      firstTurnProgressSeen = true;
      if (firstTurnTimer) {
        clearTimeout(firstTurnTimer);
        firstTurnTimer = null;
      }
    }
    resetSemanticInactivityTimer();
  };
  firstTurnTimer = setTimeout(() => {
    if (firstTurnProgressSeen) return;
    fireSemanticInactivity(
      `codex emitted no event in the first ${FIRST_TURN_NO_PROGRESS_MS / 1000}s — likely stuck before the first turn`,
    );
  }, FIRST_TURN_NO_PROGRESS_MS);
  firstTurnTimer.unref();

  function handleApprovalRequest(id: JsonValue, method: string): void {
    // Auto-approve every approval prompt in daemon mode. The methods:
    // command execution, patch / file change, MCP elicitation.
    // Elicitation uses {action} instead of {decision}.
    if (method === "mcpServer/elicitation/request") {
      sendResponse(id, { action: "accept", content: null, _meta: null });
    } else {
      sendResponse(id, { decision: "accept" });
    }
  }

  function handleNotification(method: string, params: unknown): void {
    if (!isRecord(params)) return;

    // Codex can run auxiliary threads (subagents / memory consolidation) on the
    // SAME stdio pipe. Drop notifications for any thread other than ours so
    // their messages/tools don't leak into this conversation. (multi_agent +
    // memories are disabled for managed runs, so this is belt-and-suspenders —
    // but it mirrors the reference impl and is cheap.) Guarded on our thread id
    // being known: early frames before thread/start resolves have nothing to
    // compare against and pass through.
    if (isForeignCodexThreadNotification(sessionId, params)) {
      return;
    }

    // Raw v2 protocol — item-based streaming.
    if (method === "turn/started") {
      markActivity();
      return;
    }
    // Token-level streaming: codex emits item/agentMessage/delta frames while
    // the agent message is being generated ({itemId, delta}), then the full
    // text again on item/completed. Emit each delta so the chat renders text as
    // it arrives instead of all at once when the item completes.
    if (method === "item/agentMessage/delta") {
      markActivity();
      const itemId = typeof params.itemId === "string" ? params.itemId : "";
      const delta = typeof params.delta === "string" ? params.delta : "";
      if (!delta) return;
      // Separate distinct agentMessage items (preamble / progress / answer)
      // with a blank line — but only before the FIRST delta of a new item, so
      // mid-message tokens concatenate normally.
      const firstDeltaForItem = itemId
        ? !streamedAgentMessageItemIds.has(itemId)
        : false;
      if (itemId) streamedAgentMessageItemIds.add(itemId);
      const chunk = codexAgentMessageDeltaChunk(
        delta,
        outputText,
        firstDeltaForItem,
      );
      outputText += chunk;
      emit("output_delta", { delta: chunk });
      return;
    }
    if (method === "item/started" || method === "item/completed") {
      const item = isRecord(params.item) ? params.item : null;
      if (!item) return;
      markActivity();
      const itemType = typeof item.type === "string" ? item.type : "";
      const completed = method === "item/completed";
      const itemId = typeof item.id === "string" ? item.id : "";
      if (itemType === "agentMessage" && completed) {
        // Already streamed token-by-token via item/agentMessage/delta — the
        // completion frame just re-sends the same text, so don't double it.
        if (itemId && streamedAgentMessageItemIds.has(itemId)) {
          return;
        }
        const text = typeof item.text === "string" ? item.text : "";
        if (text) {
          // Fallback for codex builds that DON'T stream deltas. Codex emits
          // MULTIPLE agentMessage items in one turn (a preamble, progress
          // updates, then the final answer). Join distinct items with a blank
          // line so they render as separate paragraphs instead of one run-on
          // blob ("…available first.The email connector…").
          const separator =
            outputText && !outputText.endsWith("\n") ? "\n\n" : "";
          const chunk = separator + text;
          outputText += chunk;
          // Field is `delta`, not `text` — the chat UI reads payload.delta when
          // accumulating streamed assistant text (ChatPane/index.tsx). See the
          // same fix in claude-code.ts.
          emit("output_delta", { delta: chunk });
        }
        return;
      }
      if (itemType === "reasoning") {
        // Surface codex's reasoning summary as a thinking trace (the
        // collapsible "Worked for …" section) rather than losing it or letting
        // it read as part of the answer. Emit once, on completion.
        if (completed) {
          const text = codexReasoningText(item);
          if (text) {
            emit("thinking_delta", { delta: text });
          }
        }
        return;
      }
      if (itemType === "commandExecution" || itemType === "fileChange") {
        // Map codex's generic item into the tool_call shape the chat UI
        // actually renders (`tool_name` title + `tool_args`/`result` detail).
        // Chat UI treats `tool_call` with `phase:"completed"` the same as a
        // distinct `tool_completed` (ChatPane/index.tsx).
        emit("tool_call", {
          ...codexToolTraceFields(itemType, item, completed),
          call_id: itemId,
          phase: completed ? "completed" : "in_progress",
        });
        return;
      }
      if (itemType === "mcpToolCall" || itemType === "webSearch") {
        // Codex reaches Holaboss + Composio tools and web search over MCP;
        // those arrive as mcpToolCall / webSearch items (NOT commandExecution),
        // so without this branch tool use left no trace at all.
        emit("tool_call", {
          ...codexMcpToolTraceFields(itemType, item, completed),
          call_id: itemId,
          phase: completed ? "completed" : "in_progress",
        });
        return;
      }
      return;
    }
    if (method === "turn/completed") {
      markActivity();
      const turn = isRecord(params.turn) ? params.turn : null;
      if (turn) {
        const status = typeof turn.status === "string" ? turn.status : "";
        if (status && status !== "completed") {
          finalStatus = "failed";
          if (isRecord(turn.error) && typeof turn.error.message === "string") {
            finalError = turn.error.message;
          } else {
            finalError = `codex turn ended with status: ${status}`;
          }
        }
        // turn.usage shape varies a little across codex versions. The
        // common keys are input_tokens / output_tokens / cached_input_
        // tokens / cache_creation_input_tokens (OpenAI-style). Model
        // identifier may be on the turn or on a nested sub-field; fall
        // back to the request's selected_model if codex doesn't echo
        // one back.
        if (isRecord(turn.usage)) {
          const model =
            (typeof turn.model === "string" && turn.model.trim()) ||
            request.selected_model?.trim() ||
            "codex";
          accumulateCodexUsage(usage, model, turn.usage);
        }
      }
      turnCompletedResolver?.();
      return;
    }
    if (method === "turn/aborted") {
      finalStatus = "failed";
      finalError = "codex turn was aborted";
      turnCompletedResolver?.();
      return;
    }

    // Legacy v1 codex/event family. We
    // bridge a small subset for runs against older codex builds.
    if (method === "codex/event" && isRecord(params.msg)) {
      const msg = params.msg;
      const type = typeof msg.type === "string" ? msg.type : "";
      if (type === "agent_message" && typeof msg.message === "string") {
        outputText += msg.message;
        emit("output_delta", { delta: msg.message });
      } else if (type === "task_complete") {
        turnCompletedResolver?.();
      } else if (type === "turn_aborted") {
        finalStatus = "failed";
        finalError = "codex turn was aborted";
        turnCompletedResolver?.();
      }
    }
  }

  // ── Stdout reader ───────────────────────────────────────────────────
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(trimmed) as JsonRpcMessage;
    } catch {
      return;
    }
    // Response to a daemon-initiated request: matches a pending id.
    if (msg.id !== undefined && msg.method === undefined) {
      const id = typeof msg.id === "number" ? msg.id : Number(msg.id);
      const handler = pending.get(id);
      if (!handler) return;
      pending.delete(id);
      if (msg.error) {
        handler.reject(new Error(rpcErrorMessage(msg.error)));
      } else {
        handler.resolve((msg.result ?? null) as JsonValue);
      }
      return;
    }
    // Server-initiated request: has both id and method.
    if (msg.id !== undefined && typeof msg.method === "string") {
      handleApprovalRequest(msg.id as JsonValue, msg.method);
      return;
    }
    // Notification: method without id.
    if (typeof msg.method === "string") {
      handleNotification(msg.method, msg.params);
    }
  });

  // ── Handshake → turn ────────────────────────────────────────────────
  try {
    await sendRequest("initialize", {
      clientInfo: {
        name: "holaboss-harness-host",
        title: "Holaboss",
        version: "0.1.0",
      },
      capabilities: { experimentalApi: true },
    });
    sendNotification("initialized", null);

    // Try thread/resume first when we have a prior thread id; fall
    // back to thread/start when codex says it can't find the thread.
    // Any JSON-RPC error on resume is treated as the fallback signal,
    // not just a specific code, because the codex error vocabulary
    // isn't stable across versions.
    const requestedResumeId =
      request.persisted_harness_session_id?.trim() || null;
    // The connection test just needs codex to emit *something* quickly. A heavy
    // ~/.codex/config.toml default (e.g. model_reasoning_effort = "xhigh") makes
    // even "reply OK" take ~35s and blow past the 45s connection-test timeout,
    // so force a light effort for the test only. Real runs keep the requested
    // value (or the user's config default).
    const isConnectionTest = request.workspace_id === "connection-test";
    const connectionTestEffort = "low";
    const thinkingConfig = request.thinking_value
      ? { model_reasoning_effort: request.thinking_value }
      : isConnectionTest
        ? { model_reasoning_effort: connectionTestEffort }
        : null;
    // Fresh threads honor the session's selected model, falling back to a
    // per-host default (HOLABOSS_CODEX_MODEL) and finally codex's own
    // default. Resume keeps the existing thread's model, so we only set
    // it on thread/start.
    let codexModel =
      request.selected_model?.trim() ||
      (process.env.HOLABOSS_CODEX_MODEL ?? "").trim() ||
      null;
    if (!codexModel) {
      // Neither Holaboss nor the host pinned a model (e.g. the connection
      // test). Resolve the account's default from model/list rather than
      // letting codex fall through to the user's config.toml: app-server only
      // accepts the account's own models, so a config.toml pinning an API-only
      // model (e.g. gpt-5.4 on a ChatGPT-plan login) would 400 the whole run.
      try {
        const listed = await sendRequest("model/list", {});
        codexModel = codexDefaultModelId(
          codexModelListToSupportedModels(
            isRecord(listed) ? (listed as JsonObject).data : undefined,
          ),
        );
      } catch {
        // Leave null → thread/start uses codex's own configured default.
      }
    }
    const cwd = request.agent_cwd || request.workspace_dir;
    let threadResult: JsonValue | null = null;
    if (requestedResumeId) {
      try {
        // thread/resume accepts ONLY threadId + a small set of overrides
        // (model, cwd, effort, personality, …). It does NOT accept
        // `developerInstructions` or a generic `config` field — codex-rs
        // rejects the unknown params, which silently dropped EVERY resume
        // back to a fresh thread (lost cross-turn context). Keep this to
        // the documented accepted fields. (Model/effort stay with the
        // resumed thread; we only override those on a fresh start.)
        threadResult = await sendRequest("thread/resume", {
          threadId: requestedResumeId,
          cwd,
        });
      } catch (error) {
        // Fall through to a fresh thread/start. We surface the reason
        // (previously fully swallowed): a *persistent* resume failure
        // means lost context every turn, not just an aged-out thread.
        process.stderr.write(
          `[codex-harness] thread/resume failed for thread ${requestedResumeId}: ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        );
        threadResult = null;
      }
    }
    if (!threadResult) {
      threadResult = await sendRequest("thread/start", {
        model: codexModel,
        modelProvider: null,
        profile: null,
        cwd,
        approvalPolicy: null,
        sandbox: null,
        config: thinkingConfig,
        baseInstructions: null,
        developerInstructions: request.system_prompt || null,
        compactPrompt: null,
        includeApplyPatchTool: null,
        experimentalRawEvents: false,
        persistExtendedHistory: true,
      });
    }
    if (isRecord(threadResult) && isRecord(threadResult.thread) && typeof threadResult.thread.id === "string") {
      sessionId = threadResult.thread.id;
    }

    // Attachments + images: codex app-server's turn/start input has no image
    // item type, so fold document excerpts + path references (images included
    // by path) into the text. cwd is the workspace, so the agent can read the
    // referenced files with its own tools.
    const attachmentInput = await renderHarnessCliAttachments({
      attachments: request.attachments,
      imageUrls: request.image_urls,
      roots: [request.workspace_dir, request.agent_cwd ?? ""].filter(Boolean),
      inlineImages: false,
    });
    // Expand any leading `/skill-name` references into inlined skill blocks so
    // the raw slash line isn't forwarded verbatim.
    const instruction = expandCliHarnessSkillReferences({
      instruction: request.instruction,
      workspaceDir: request.workspace_dir,
      workspaceSkillDirs: request.workspace_skill_dirs,
    });
    const turnText =
      attachmentInput.textLines.length > 0
        ? `${instruction}\n\n${attachmentInput.textLines.join("\n\n")}`
        : instruction;
    await sendRequest("turn/start", {
      threadId: sessionId,
      input: [{ type: "text", text: turnText }],
      effort:
        request.thinking_value || (isConnectionTest ? connectionTestEffort : null),
    });

    await turnCompletedPromise;
  } catch (err) {
    finalStatus = "failed";
    finalError = err instanceof Error ? err.message : String(err);
  }

  // ── Graceful shutdown ───────────────────────────────────────────────
  closeStdin();
  // Wait up to 10s for codex to exit on its own (graceful shutdown
  // timeout). Then force-kill.
  const exitCode = await new Promise<number>((resolve) => {
    let resolved = false;
    const finish = (code: number): void => {
      if (resolved) return;
      resolved = true;
      resolve(code);
    };
    const shutdownTimer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // already dead
      }
      // Hard cap to keep this from hanging the host process.
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // already dead
        }
        finish(1);
      }, 5_000).unref();
    }, 10_000);
    shutdownTimer.unref();
    child.on("close", (code) => {
      clearTimeout(shutdownTimer);
      finish(code ?? 0);
    });
  });

  // Wipe the per-run CODEX_HOME — it carries decrypted MCP env (OAuth
  // tokens etc.) and shouldn't linger past the run. The auth.json +
  // sessions/ entries are symlinks, so rmSync unlinks them without
  // touching the shared ~/.codex targets. Best-effort; OS tmpdir
  // reaping is the safety net.
  codexHomePrep?.cleanup();

  // Clear inactivity timers so the runner doesn't hold a dangling
  // setTimeout reference and prevent process exit on tight test
  // loops. They unref themselves but explicit clear is cheap.
  if (firstTurnTimer) {
    clearTimeout(firstTurnTimer);
  }
  if (semanticInactivityTimer) {
    clearTimeout(semanticInactivityTimer);
  }

  if (exitCode !== 0 && finalStatus === "completed") {
    finalStatus = "failed";
    finalError = `codex exited with code ${exitCode}`;
  }

  if (finalStatus === "failed") {
    emit("run_failed", {
      error: composeFailureMessage(finalError ?? "codex failed", stderrTail),
      harness_session_id: sessionId,
      usage: serializeCodexUsage(usage),
    });
    return 1;
  }

  emit("run_completed", {
    status: "completed",
    output: outputText,
    harness_session_id: sessionId,
    usage: serializeCodexUsage(usage),
  });
  return 0;
}

/**
 * Map a codex app-server `model/list` result's `data[]` into the harness model
 * shape. Pure (exported for unit tests). Skips hidden/internal entries and any
 * without a usable id; `isDefault`/`default` → the harness `default` flag and
 * `displayName` → the label.
 */
export function codexModelListToSupportedModels(data: unknown): HarnessSupportedModel[] {
  if (!Array.isArray(data)) {
    return [];
  }
  const models: HarnessSupportedModel[] = [];
  for (const entry of data) {
    if (!isRecord(entry)) continue;
    if (entry.hidden === true) continue;
    const id =
      (typeof entry.id === "string" && entry.id.trim()) ||
      (typeof entry.model === "string" && entry.model.trim()) ||
      "";
    if (!id) continue;
    const label =
      typeof entry.displayName === "string" && entry.displayName.trim()
        ? entry.displayName.trim()
        : id;
    const isDefault = entry.isDefault === true || entry.default === true;
    models.push({
      id,
      label,
      provider: "openai",
      ...(isDefault ? { default: true } : {}),
    });
  }
  return models;
}

/** Pick the account's default model id (the flagged default, else the first). */
function codexDefaultModelId(models: HarnessSupportedModel[]): string | null {
  return models.find((model) => model.default)?.id ?? models[0]?.id ?? null;
}

/**
 * Live-discover the codex model catalogue for the current account by driving
 * `codex app-server`'s `model/list` method. This is the ONLY surface that
 * reports the account's actually-usable models — the interactive CLI's set
 * differs, and codex ships no `models` subcommand. Spawns app-server the same
 * way the runner does (Windows shim → node). Never throws: returns [] on any
 * failure so the api-server falls back to the static catalogue.
 */
export async function discoverCodexModels(cwd: string): Promise<HarnessSupportedModel[]> {
  const codexBin = (process.env.HOLABOSS_CODEX_PATH ?? "").trim() || "codex";
  const invocation = resolveWindowsCliInvocation("codex", codexBin, [
    "app-server",
    "--listen",
    "stdio://",
  ]);
  const child = spawn(invocation.command, invocation.args, {
    cwd,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return await new Promise<HarnessSupportedModel[]>((resolve) => {
    let settled = false;
    const finish = (models: HarnessSupportedModel[]): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
      resolve(models);
    };
    const timer = setTimeout(() => finish([]), 20_000);
    child.on("error", () => finish([]));
    child.on("close", () => finish([]));

    let nextId = 1;
    const pending = new Map<number, (result: JsonValue) => void>();
    const write = (frame: unknown): void => {
      try {
        child.stdin.write(`${JSON.stringify(frame)}\n`);
      } catch {
        // close handler surfaces the failure
      }
    };
    const request = (method: string, params: JsonObject | null): Promise<JsonValue> => {
      const id = nextId++;
      write({ jsonrpc: "2.0", id, method, params });
      return new Promise<JsonValue>((res) => pending.set(id, res));
    };

    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(trimmed) as JsonRpcMessage;
      } catch {
        return;
      }
      if (msg.id !== undefined && msg.method === undefined) {
        const id = typeof msg.id === "number" ? msg.id : Number(msg.id);
        const handler = pending.get(id);
        if (handler) {
          pending.delete(id);
          handler((msg.result ?? null) as JsonValue);
        }
      }
    });

    void (async () => {
      try {
        await request("initialize", {
          clientInfo: { name: "holaboss-harness-host", title: "Holaboss", version: "0.1.0" },
          capabilities: { experimentalApi: true },
        });
        write({ jsonrpc: "2.0", method: "initialized", params: null });
        const listed = await request("model/list", {});
        finish(
          codexModelListToSupportedModels(
            isRecord(listed) ? (listed as JsonObject).data : undefined,
          ),
        );
      } catch {
        finish([]);
      }
    })();
  });
}

interface CodexHomePreparation {
  codexHome: string;
  cleanup: () => void;
}

/**
 * Prepare a managed `$CODEX_HOME` for one codex run. The directory is
 * task-local (wiped on exit) but
 * symlinks the shared ~/.codex `auth.json` and `sessions/` back in so
 *   • native auth (ChatGPT-OAuth login or API key) keeps working — codex
 *     app-server reads credentials from $CODEX_HOME, and a bare home has
 *     none; and
 *   • thread/resume can actually find the prior thread's session files
 *     (they live under sessions/, which would otherwise have been wiped
 *     with the previous run's tmp home).
 *
 * config.toml is written fresh (NOT merged with the user's) so the run is
 * sealed to this workspace's servers; it also disables codex native
 * multi-agent + auto-memory (see buildCodexManagedFeatureOverrides):
 *   [mcp_servers.notion]
 *   command = "npx"
 *   args = ["@notionhq/notion-mcp-server"]
 *   [mcp_servers.notion.env]
 *   NOTION_TOKEN = "..."
 *
 *   [mcp_servers.example_http]
 *   url = "https://example/mcp"
 *   [mcp_servers.example_http.headers]
 *   Authorization = "Bearer ..."
 *
 * Returns null only when there is nothing to manage (no MCP servers and
 * no workspace skills); then codex inherits the user's own ~/.codex.
 */
export function prepareCodexHome(
  request: HarnessHostCodexRequest,
): CodexHomePreparation | null {
  const sections = buildCodexMcpSections(request.mcp_servers);
  // url-based MCP servers (including the holaboss_runtime /mcp bridge) only
  // connect under codex's experimental rmcp client — enable it whenever the
  // managed home carries at least one remote server.
  const hasRemoteMcpServer =
    Array.isArray(request.mcp_servers) &&
    request.mcp_servers.some((entry) => {
      const config = isRecord(entry) && isRecord(entry.config) ? entry.config : null;
      return (
        !!config &&
        config.type === "remote" &&
        config.enabled !== false &&
        typeof config.url === "string" &&
        config.url.trim().length > 0
      );
    });
  const skillDirs = Array.isArray(request.workspace_skill_dirs)
    ? request.workspace_skill_dirs.filter(
        (dir): dir is string => typeof dir === "string" && dir.trim().length > 0,
      )
    : [];
  if (sections.length === 0 && skillDirs.length === 0) {
    return null;
  }
  const codexHome = mkdtempSync(join(tmpdir(), "holaboss-codex-home-"));
  // Seed auth + sessions first so a failure writing skills/config still
  // leaves an authenticated home.
  seedCodexAuthAndSessions(codexHome);
  if (skillDirs.length > 0) {
    writeCodexSkills(codexHome, skillDirs);
  }
  // Root-level feature overrides MUST precede the [mcp_servers.*] tables
  // (TOML: bare/dotted keys at root are only valid before the first table
  // header). Written whenever the home is managed — including a
  // skills-only home with no MCP servers — so the codex feature defaults
  // never apply to a sealed task session.
  const featureOverrides = buildCodexManagedFeatureOverrides({
    enableRmcpClient: hasRemoteMcpServer,
  });
  const configBody = [featureOverrides, ...sections]
    .filter((part) => part.length > 0)
    .join("\n\n");
  if (configBody.length > 0) {
    const configPath = join(codexHome, "config.toml");
    writeFileSync(configPath, configBody + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
  }
  return {
    codexHome,
    cleanup: () => {
      try {
        rmSync(codexHome, { recursive: true, force: true });
      } catch {
        // best effort
      }
    },
  };
}

/**
 * Resolve the user's shared codex home ($CODEX_HOME, else ~/.codex) and
 * link its auth.json + sessions/ into the per-run home. Symlinks share
 * state so token refreshes propagate and new threads persist; on
 * platforms where symlinking a file fails (e.g. Windows without
 * Developer Mode) auth.json falls back to a copy. All best-effort —
 * codex still runs (just possibly unauthenticated) if the shared home is
 * absent.
 */
function seedCodexAuthAndSessions(codexHome: string): void {
  const sharedHome =
    (process.env.CODEX_HOME ?? "").trim() || join(homedir(), ".codex");
  // auth.json — symlink (shared) with a copy fallback.
  const authSrc = join(sharedHome, "auth.json");
  if (existsSync(authSrc)) {
    const authDst = join(codexHome, "auth.json");
    try {
      symlinkSync(authSrc, authDst);
    } catch {
      try {
        copyFileSync(authSrc, authDst);
      } catch {
        // best effort — run continues unauthenticated
      }
    }
  }
  // sessions/ — symlink the directory so thread history persists in the
  // shared home (required for thread/resume to find prior threads).
  const sessionsSrc = join(sharedHome, "sessions");
  try {
    mkdirSync(sessionsSrc, { recursive: true });
    symlinkSync(sessionsSrc, join(codexHome, "sessions"), "dir");
  } catch {
    // best effort — resume just won't persist if this fails
  }
}

/**
 * Copy each workspace skill directory into `$CODEX_HOME/skills/<name>/`
 * so codex's native skill discovery picks them up. Copies (not symlinks)
 * because the home is wiped on exit and we don't want codex writing back
 * into the workspace's staged skill source. Skips dirs without a
 * SKILL.md. Best-effort per dir — a malformed skill never fails the run.
 */
function writeCodexSkills(codexHome: string, skillDirs: string[]): void {
  const skillsRoot = join(codexHome, "skills");
  for (const dir of skillDirs) {
    try {
      if (!existsSync(join(dir, "SKILL.md"))) {
        continue;
      }
      mkdirSync(skillsRoot, { recursive: true });
      cpSync(dir, join(skillsRoot, basename(dir)), { recursive: true });
    } catch {
      // best effort
    }
  }
}

/** Truthy env check: "1" | "true" | "yes" | "on" (case-insensitive). */
function isTruthyEnv(value: string | undefined): boolean {
  switch ((value ?? "").trim().toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    default:
      return false;
  }
}

/**
 * Root-level TOML keys that disable codex's native multi-agent and
 * auto-memory subsystems for sealed runtime task sessions. We write a
 * fresh config.toml (never merging the user's global ~/.codex), so these
 * are plain dotted keys the caller places ABOVE any [mcp_servers.*]
 * table. Returns "" when both features are opted back in.
 *
 * Why disable them:
 *   • multi_agent: codex app-server can fan out into nested subagents,
 *     but the runner only models the parent thread — the parent's
 *     turn/completed marks the task done while children may still be
 *     running (premature-completion failures).
 *   • memories: codex's native auto-memory writes/reads an opaque store
 *     under $CODEX_HOME/memories (and may read ~/.codex/memories), which
 *     leaks context across tasks/workspaces and the runtime can't audit.
 *
 * Per-feature escape hatches: a truthy HOLABOSS_CODEX_MULTI_AGENT /
 * HOLABOSS_CODEX_MEMORY leaves that codex feature at its native default.
 */
function buildCodexManagedFeatureOverrides(options: {
  enableRmcpClient: boolean;
}): string {
  const keys: string[] = [];
  if (options.enableRmcpClient) {
    // Streamable-HTTP (url-based) MCP servers only work under codex's
    // experimental rmcp client; the default client speaks stdio only and
    // silently drops remote servers. Required for both workspace.yaml
    // remote servers and the holaboss_runtime /mcp bridge.
    keys.push("features.experimental_use_rmcp_client = true");
  }
  if (!isTruthyEnv(process.env.HOLABOSS_CODEX_MULTI_AGENT)) {
    keys.push("features.multi_agent = false");
  }
  if (!isTruthyEnv(process.env.HOLABOSS_CODEX_MEMORY)) {
    keys.push("features.memories = false");
    keys.push("memories.generate_memories = false");
    keys.push("memories.use_memories = false");
  }
  if (keys.length === 0) {
    return "";
  }
  return [
    "# Holaboss-managed: codex native multi-agent + auto-memory are",
    "# disabled for sealed runtime task sessions (override per feature",
    "# with HOLABOSS_CODEX_MULTI_AGENT=1 / HOLABOSS_CODEX_MEMORY=1).",
    ...keys,
  ].join("\n");
}

/**
 * Build the `[mcp_servers.NAME]` TOML sections for codex's config.toml
 * from Holaboss's mcp_servers payload — one string per server.
 */
function buildCodexMcpSections(servers: JsonObject[] | undefined): string[] {
  if (!Array.isArray(servers) || servers.length === 0) {
    return [];
  }
  const sections: string[] = [];
  for (const entry of servers) {
    if (!entry || typeof entry !== "object") continue;
    const rawName = typeof entry.name === "string" ? entry.name.trim() : "";
    const config = isRecord(entry.config) ? entry.config : null;
    if (!rawName || !config) continue;
    if (config.enabled === false) continue;
    const tableKey = toCodexTableKey(rawName);
    if (!tableKey) continue;
    if (config.type === "local") {
      const command = Array.isArray(config.command)
        ? (config.command as unknown[]).filter(
            (v): v is string => typeof v === "string",
          )
        : [];
      if (command.length === 0) continue;
      const lines = [`[mcp_servers.${tableKey}]`];
      lines.push(`command = ${toTomlString(command[0]!)}`);
      if (command.length > 1) {
        lines.push(
          `args = [${command.slice(1).map(toTomlString).join(", ")}]`,
        );
      }
      const envMap = isRecord(config.environment) ? config.environment : null;
      if (envMap && Object.keys(envMap).length > 0) {
        lines.push("");
        lines.push(`[mcp_servers.${tableKey}.env]`);
        for (const [k, v] of Object.entries(envMap)) {
          if (typeof v !== "string") continue;
          lines.push(`${toTomlBareKey(k)} = ${toTomlString(v)}`);
        }
      }
      sections.push(lines.join("\n"));
    } else if (config.type === "remote") {
      const url = typeof config.url === "string" ? config.url.trim() : "";
      if (!url) continue;
      const lines = [`[mcp_servers.${tableKey}]`];
      lines.push(`url = ${toTomlString(url)}`);
      const headers = isRecord(config.headers) ? config.headers : null;
      if (headers) {
        // Codex reads remote-server headers from an inline `http_headers`
        // map on the server entry. A `[mcp_servers.NAME.headers]` sub-table
        // (what we used to emit) is silently ignored, so any Authorization
        // header was dropped and the request went out unauthenticated.
        const headerPairs = Object.entries(headers)
          .filter(
            (pair): pair is [string, string] => typeof pair[1] === "string",
          )
          .map(([k, v]) => `${toTomlBareKey(k)} = ${toTomlString(v)}`);
        if (headerPairs.length > 0) {
          lines.push(`http_headers = { ${headerPairs.join(", ")} }`);
        }
      }
      sections.push(lines.join("\n"));
    }
  }
  return sections;
}

/**
 * Sanitize a server name into a TOML bare key. Names that don't fit
 * the bare-key pattern (alphanumeric + `_` + `-`) get rejected by
 * returning null — the materializer skips them. We could quote-escape
 * but bare keys keep the file readable.
 */
function toCodexTableKey(name: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    return null;
  }
  return name;
}

function toTomlBareKey(key: string): string {
  // Quote anything that isn't a TOML-legal bare key. Most HTTP header
  // names (e.g. "Authorization") and env-var names are bare-key safe;
  // weird ones get quoted.
  if (/^[A-Za-z0-9_-]+$/.test(key)) {
    return key;
  }
  return toTomlString(key);
}

function toTomlString(value: string): string {
  // Basic TOML string: replace backslashes, quotes, and control chars.
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `"${escaped}"`;
}

function rpcErrorMessage(error: unknown): string {
  if (isRecord(error) && typeof error.message === "string") {
    return error.message;
  }
  return "codex JSON-RPC error";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asJsonValue(value: unknown): JsonValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch {
    return null;
  }
}

/**
 * Translate a codex v2 `commandExecution`/`fileChange` item into the
 * tool_call payload fields the chat UI renders: a clean `tool_name`
 * (becomes the step title) plus `tool_args`/`result` (become the detail
 * lines). codex wraps every shell command in `/bin/zsh -lc '...'`, so we
 * prefer the parsed inner command from `commandActions`. `result`/`error`
 * are only meaningful once the item completes.
 */
export function codexToolTraceFields(
  itemType: string,
  item: Record<string, unknown>,
  completed: boolean,
): Record<string, JsonValue> {
  if (itemType === "commandExecution") {
    const actions = Array.isArray(item.commandActions) ? item.commandActions : [];
    const firstAction = isRecord(actions[0]) ? actions[0] : null;
    const command =
      (firstAction && typeof firstAction.command === "string" && firstAction.command.trim()
        ? firstAction.command.trim()
        : typeof item.command === "string"
          ? item.command
          : "");
    const fields: Record<string, JsonValue> = {
      tool_name: "shell",
      tool_args: { command },
    };
    if (completed) {
      const exitCode = typeof item.exitCode === "number" ? item.exitCode : null;
      const status = typeof item.status === "string" ? item.status : "";
      const output =
        typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : "";
      fields.result = {
        ...(exitCode === null ? {} : { exit_code: exitCode }),
        ...(output ? { output } : {}),
      };
      fields.error =
        (exitCode !== null && exitCode !== 0) ||
        (status !== "" && status !== "completed");
    }
    return fields;
  }
  // fileChange (and any future item kind): surface the raw item as args so
  // the changed files stay visible until we map the shape explicitly.
  return {
    tool_name: itemType === "fileChange" ? "file_change" : itemType,
    tool_args: asJsonValue(item),
  };
}

/**
 * The text chunk to emit for one item/agentMessage/delta. Prefixes a blank-line
 * separator only before the FIRST delta of a new agentMessage item (and only
 * when there's prior output not already ending in a newline) so distinct
 * messages render as paragraphs while mid-message tokens concatenate verbatim.
 */
export function codexAgentMessageDeltaChunk(
  delta: string,
  priorOutputText: string,
  firstDeltaForItem: boolean,
): string {
  const separator =
    firstDeltaForItem && priorOutputText && !priorOutputText.endsWith("\n")
      ? "\n\n"
      : "";
  return separator + delta;
}

/**
 * Whether a codex notification belongs to a DIFFERENT thread than ours and
 * should be ignored. Codex multiplexes auxiliary threads (subagents / memory
 * consolidation) over the same stdio pipe; their `params.threadId` differs from
 * the thread we started. Returns false (process it) when our thread id isn't
 * known yet or the notification carries no threadId, so nothing is dropped
 * spuriously.
 */
export function isForeignCodexThreadNotification(
  ownThreadId: string | null,
  params: Record<string, unknown>,
): boolean {
  const notifThreadId =
    typeof params.threadId === "string" ? params.threadId : null;
  return Boolean(ownThreadId && notifThreadId && notifThreadId !== ownThreadId);
}

/**
 * Extract the human-readable text from a codex `reasoning` item. codex builds
 * vary: some carry a flat `text`, others a `summary` array (of strings or
 * `{ text }` parts), older ones a `content` string. Best-effort — returns ""
 * when nothing usable is present (nothing gets emitted then).
 */
export function codexReasoningText(item: Record<string, unknown>): string {
  if (typeof item.text === "string" && item.text.trim()) {
    return item.text.trim();
  }
  const summary = item.summary;
  if (Array.isArray(summary)) {
    const parts = summary
      .map((entry) =>
        typeof entry === "string"
          ? entry
          : isRecord(entry) && typeof entry.text === "string"
            ? entry.text
            : "",
      )
      .filter((part) => part.trim().length > 0);
    if (parts.length > 0) {
      return parts.join("\n\n");
    }
  }
  if (typeof item.content === "string" && item.content.trim()) {
    return item.content.trim();
  }
  return "";
}

/**
 * Translate a codex `mcpToolCall` / `webSearch` item into the tool_call payload
 * the chat UI renders. `tool` is the confirmed field name for the invoked tool;
 * `arguments` / `result` / `status` are best-effort across codex versions. The
 * bare `tool` name is used (not `server.tool`) so downstream bare-name matching
 * — e.g. the propose_connect Connect card / dispatch gate — still triggers.
 */
export function codexMcpToolTraceFields(
  itemType: string,
  item: Record<string, unknown>,
  completed: boolean,
): Record<string, JsonValue> {
  if (itemType === "webSearch") {
    const query = typeof item.query === "string" ? item.query : "";
    return {
      tool_name: "web_search",
      ...(query ? { tool_args: { query } } : {}),
    };
  }
  const tool = typeof item.tool === "string" && item.tool.trim() ? item.tool.trim() : "";
  const invocation = isRecord(item.invocation) ? item.invocation : null;
  const args = isRecord(item.arguments)
    ? item.arguments
    : invocation && isRecord(invocation.arguments)
      ? invocation.arguments
      : null;
  const fields: Record<string, JsonValue> = {
    tool_name: tool || "mcp_tool",
    ...(args ? { tool_args: asJsonValue(args) } : {}),
  };
  if (completed) {
    const status = typeof item.status === "string" ? item.status : "";
    fields.error = status === "failed";
    if (item.result !== undefined) {
      fields.result = asJsonValue(item.result);
    }
  }
  return fields;
}

function composeFailureMessage(message: string, stderrTail: string): string {
  const tail = stderrTail.trim();
  if (!tail) return message;
  return `${message}\n--- codex stderr (tail) ---\n${tail}`;
}

interface CodexTokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

function accumulateCodexUsage(
  acc: Map<string, CodexTokenUsage>,
  model: string,
  raw: Record<string, unknown>,
): void {
  const inputTokens = numberFromUnknown(
    raw.input_tokens ?? raw.inputTokens ?? 0,
  );
  const outputTokens = numberFromUnknown(
    raw.output_tokens ?? raw.outputTokens ?? 0,
  );
  const cacheRead = numberFromUnknown(
    raw.cached_input_tokens ??
      raw.cache_read_input_tokens ??
      raw.cacheReadInputTokens ??
      0,
  );
  const cacheWrite = numberFromUnknown(
    raw.cache_creation_input_tokens ?? raw.cacheCreationInputTokens ?? 0,
  );
  if (
    inputTokens === 0 &&
    outputTokens === 0 &&
    cacheRead === 0 &&
    cacheWrite === 0
  ) {
    return;
  }
  const existing = acc.get(model);
  if (!existing) {
    acc.set(model, {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_tokens: cacheRead,
      cache_write_tokens: cacheWrite,
    });
    return;
  }
  acc.set(model, {
    input_tokens: existing.input_tokens + inputTokens,
    output_tokens: existing.output_tokens + outputTokens,
    cache_read_tokens: existing.cache_read_tokens + cacheRead,
    cache_write_tokens: existing.cache_write_tokens + cacheWrite,
  });
}

function serializeCodexUsage(
  acc: Map<string, CodexTokenUsage>,
): JsonObject | null {
  if (acc.size === 0) return null;
  const out: JsonObject = {};
  for (const [model, totals] of acc) {
    out[model] = {
      input_tokens: totals.input_tokens,
      output_tokens: totals.output_tokens,
      cache_read_tokens: totals.cache_read_tokens,
      cache_write_tokens: totals.cache_write_tokens,
    };
  }
  return out;
}

function numberFromUnknown(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, value);
  }
  return 0;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}
