import { spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";

import {
  type HarnessHostClaudeCodeRequest,
  type JsonObject,
  type JsonValue,
  type RunnerEventType,
  type RunnerOutputEventPayload,
} from "./contracts.js";
import { renderHarnessCliAttachments } from "../../harnesses/src/attachment-content.js";
import { expandCliHarnessSkillReferences } from "./cli-skill-references.js";
import { resolveWindowsCliInvocation } from "./windows-cli-invocation.js";

/**
 * Claude Code harness host runner.
 *
 * Spawns the `claude` CLI in non-interactive stream-json mode and
 * translates its JSON-line protocol into Holaboss `RunnerOutputEvent`s.
 *
 * Wire shape: stdin and stdout both carry newline-delimited JSON.
 *   ▸ daemon → claude: a single `{type:"user", message:{role:"user",
 *     content:[{type:"text",text:"<prompt>"}]}}` line, plus
 *     `control_response` frames in reply to `control_request`s.
 *   ▸ claude → daemon: a stream of `{type:"assistant"|"user"|"system"|
 *     "result"|"control_request"|"log", …}` events; the protocol is the
 *     same one used by `@anthropic-ai/claude-agent-sdk`.
 *
 * Tool approval: this runner auto-approves every tool call (daemon
 * mode). `--permission-mode bypassPermissions` covers most flows; the
 * CLI still sometimes emits `control_request` frames mid-run (for
 * permission upgrades, async-launch decisions, etc.) which we answer
 * with `behavior:"allow"`. Per-tool gating belongs in the runtime's
 * tools policy upstream of this runner, not here.
 *
 * Implemented here: per-model token accounting, session resume via
 * --resume <id> with resume reconciliation, MCP config materialization
 * to a temp file + --mcp-config, and workspace skill injection via a
 * throwaway --add-dir.
 *
 * Still deferred (acceptable gaps):
 *   • Async-launch detection (a run_in_background guard)
 *   • Per-task custom_args (only the HOLABOSS_CLAUDE_ARGS host default is
 *     honored today)
 *
 * The runner is parameterized over the binary + env-var namespace
 * ({@link ClaudeStreamHarnessOptions}) so any fork that ships the same
 * stream-json protocol could reuse it verbatim. {@link runClaudeCode} is
 * the `claude` binding.
 */
export interface ClaudeStreamHarnessOptions {
  /** Harness id, emitted on run_started (e.g. "claude-code"). */
  id: string;
  /** Human label used in error/status messages (e.g. "claude"). */
  label: string;
  /** PATH-resolved binary name when the *_PATH override is unset. */
  defaultBinary: string;
  /** Env var that pins a non-PATH binary, e.g. "HOLABOSS_CLAUDE_PATH". */
  binaryEnv: string;
  /** Env var for a per-host default model, e.g. "HOLABOSS_CLAUDE_MODEL". */
  modelEnv: string;
  /** Env var for shell-split default args, e.g. "HOLABOSS_CLAUDE_ARGS". */
  argsEnv: string;
}

const CLAUDE_STREAM_OPTIONS: ClaudeStreamHarnessOptions = {
  id: "claude-code",
  label: "claude",
  defaultBinary: "claude",
  binaryEnv: "HOLABOSS_CLAUDE_PATH",
  modelEnv: "HOLABOSS_CLAUDE_MODEL",
  argsEnv: "HOLABOSS_CLAUDE_ARGS",
};

export async function runClaudeCode(request: HarnessHostClaudeCodeRequest): Promise<number> {
  return await runClaudeStreamHarness(request, CLAUDE_STREAM_OPTIONS);
}

export async function runClaudeStreamHarness(
  request: HarnessHostClaudeCodeRequest,
  opts: ClaudeStreamHarnessOptions,
): Promise<number> {
  // Materialize the workspace's MCP server list into Claude's
  // --mcp-config JSON before building the spawn args. Without this,
  // Claude Code starts with zero MCP servers and the user sees a
  // "no MCP" surface even when Hola has working integrations on the
  // same workspace — the harness adapter carries `mcp_servers` on the
  // request, but the Holaboss shape differs from Claude's, so we have
  // to translate before writing the file.
  const mcpMaterialization = materializeClaudeMcpConfig(request.mcp_servers);
  // Stage workspace skills into a throwaway dir and expose it with
  // --add-dir; claude discovers `<added-dir>/.claude/skills/<name>/`
  // without us touching the user's real cwd. (CLAUDE_CONFIG_DIR would
  // also surface them but relocates auth + history; --add-dir is the
  // non-invasive lever.)
  const skillsMaterialization = materializeClaudeSkills(
    request.workspace_skill_dirs,
  );
  // Attachments + images: Claude's stream-json user message takes content
  // blocks, so inline images as vision blocks and fold document excerpts /
  // file path references into the text block. cwd is the workspace, so the
  // agent can also read any referenced file directly.
  const attachmentInput = await renderHarnessCliAttachments({
    attachments: request.attachments,
    imageUrls: request.image_urls,
    roots: [request.workspace_dir, request.agent_cwd ?? ""].filter(Boolean),
    inlineImages: true,
  });
  const args = buildClaudeArgs(
    request,
    mcpMaterialization?.path ?? null,
    skillsMaterialization?.dir ?? null,
    opts,
  );
  const env = filterChildEnv(process.env);

  // Allow operators to pin a non-PATH binary without re-plumbing the runtime.
  const claudeBin = (process.env[opts.binaryEnv] ?? "").trim() || opts.defaultBinary;
  // On Windows, npm-installed CLIs can ship a `.cmd` shim; spawn the Node CLI
  // it wraps (`node cli.js …`) directly so multi-line args and the
  // bidirectional stdio stream both survive. No-op for the native `claude.exe`
  // and on non-Windows. See windows-cli-invocation.ts.
  const invocation = resolveWindowsCliInvocation(
    opts.defaultBinary,
    claudeBin,
    args,
  );
  const child = spawn(invocation.command, invocation.args, {
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

  emit("run_started", { harness: opts.id, pid: child.pid ?? null });

  // Stderr is captured both to our stderr (for daemon logs) and a bounded
  // tail buffer so we can attach the last few KB to run_failed.
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

  // The CLI emits a startup banner on stdout before reading its first
  // stdin frame; if nothing is draining stdout while we write the prompt,
  // claude can block writing stdout and never read stdin. Send the
  // prompt off the main loop so the stdout reader below starts
  // immediately.
  const promptContent: Array<Record<string, unknown>> = [];
  for (const image of attachmentInput.images) {
    promptContent.push({
      type: "image",
      source: { type: "base64", media_type: image.mimeType, data: image.data },
    });
  }
  for (const url of attachmentInput.remoteImageUrls) {
    promptContent.push({ type: "image", source: { type: "url", url } });
  }
  // Expand any leading `/skill-name` references into inlined skill blocks so
  // claude doesn't read the raw slash line as an unknown native command.
  const instruction = expandCliHarnessSkillReferences({
    instruction: request.instruction,
    workspaceDir: request.workspace_dir,
    workspaceSkillDirs: request.workspace_skill_dirs,
  });
  const promptText =
    attachmentInput.textLines.length > 0
      ? `${instruction}\n\n${attachmentInput.textLines.join("\n\n")}`
      : instruction;
  promptContent.push({ type: "text", text: promptText });
  const promptFrame = JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: promptContent,
    },
  });
  try {
    child.stdin.write(`${promptFrame}\n`);
  } catch (err) {
    emit("run_failed", {
      error: `failed to write ${opts.label} prompt: ${err instanceof Error ? err.message : String(err)}`,
    });
    closeStdin();
  }

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });

  let sessionId: string | null = null;
  let finalStatus: "completed" | "failed" = "completed";
  let finalError: string | null = null;
  let outputText = "";
  // True once any partial stream_event delta (text/thinking) has been emitted.
  // With --include-partial-messages Claude streams token-level deltas AND then
  // re-sends the same content as a complete `assistant` message; this flag lets
  // handleAssistant suppress that duplicate. Stays false (→ handleAssistant is
  // the emitter) if a CLI build ignores the flag, so streaming degrades safely.
  let streamedPartialContent = false;
  // Tool-use blocks carry `name`, but tool_result blocks only carry
  // `tool_use_id`. The Holaboss chat UI wants `tool_name` on the
  // completion event too (it's how the trace card is labeled). Track
  // call_id → name as the assistant emits tool_use, then look it up
  // when the user-role tool_result lands.
  const pendingToolNames = new Map<string, string>();
  // Per-model token usage accumulator. Two sources:
  //   1. live: each assistant message carries content.model + content.
  //      usage with input/output/cache numbers.
  //   2. terminal: the result event carries an authoritative
  //      modelUsage map; when present it overrides the live tally so
  //      mid-stream estimates don't pollute the final totals.
  const usage = new Map<string, ClaudeTokenUsage>();
  const requestedResumeSessionId =
    request.persisted_harness_session_id?.trim() || null;

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: ClaudeSDKMessage;
    try {
      msg = JSON.parse(trimmed) as ClaudeSDKMessage;
    } catch {
      return;
    }
    handleClaudeMessage(msg);
  });

  function handleClaudeMessage(msg: ClaudeSDKMessage): void {
    switch (msg.type) {
      case "assistant":
        handleAssistant(msg);
        break;
      case "user":
        handleUser(msg);
        break;
      case "stream_event":
        handleStreamEvent(msg);
        break;
      case "system":
        if (typeof msg.session_id === "string" && msg.session_id) {
          sessionId = msg.session_id;
        }
        break;
      case "result":
        if (typeof msg.session_id === "string" && msg.session_id) {
          sessionId = msg.session_id;
        }
        if (typeof msg.result === "string" && msg.result.length > 0) {
          outputText = msg.result;
        }
        // Terminal usage: prefer result.modelUsage (authoritative per-
        // model totals) over the live tally. Fall back to result.usage
        // applied against the message's headline model, or skip if
        // claude reported nothing usable.
        if (msg.modelUsage && typeof msg.modelUsage === "object") {
          usage.clear();
          for (const [model, value] of Object.entries(msg.modelUsage)) {
            if (!model || !value || typeof value !== "object") continue;
            addClaudeUsage(usage, model, value as ClaudeUsageNumbers);
          }
        } else if (msg.usage && typeof msg.model === "string" && msg.model) {
          usage.set(
            msg.model,
            normalizeClaudeUsage(msg.usage as ClaudeUsageNumbers),
          );
        }
        if (msg.is_error) {
          finalStatus = "failed";
          finalError = msg.result ?? "claude reported is_error=true";
        }
        closeStdin();
        break;
      case "control_request":
        handleControlRequest(msg);
        break;
      // "log" and unknown types are dropped; the daemon log captures stderr.
    }
  }

  function handleStreamEvent(msg: ClaudeSDKMessage): void {
    const parsed = parseClaudeStreamDelta(msg);
    if (!parsed) return;
    streamedPartialContent = true;
    if (parsed.kind === "text") {
      outputText += parsed.text;
      emit("output_delta", { delta: parsed.text });
    } else {
      emit("thinking_delta", { delta: parsed.text });
    }
  }

  function handleAssistant(msg: ClaudeSDKMessage): void {
    const content = parseMessageContent(msg.message);
    if (!content) return;
    // Live per-message usage: each assistant frame carries a usage
    // block keyed on its own model name. Accumulate into the runner-
    // wide map; result.modelUsage (terminal) overrides this on the
    // final event so estimates don't bleed into the reported totals.
    if (content.usage && typeof content.model === "string" && content.model) {
      addClaudeUsage(usage, content.model, content.usage);
    }
    for (const block of content.content ?? []) {
      switch (block.type) {
        case "text":
          // When partial deltas already streamed this content (the normal case
          // under --include-partial-messages), skip the complete block to avoid
          // doubling the message. Only emit here as the fallback for CLI builds
          // that don't honor the flag.
          if (
            !streamedPartialContent &&
            typeof block.text === "string" &&
            block.text.length > 0
          ) {
            outputText += block.text;
            // Field is `delta`, not `text` — the chat UI reads
            // payload.delta when accumulating the streamed assistant
            // message (ChatPane/index.tsx:3409 + 6571). Sending {text}
            // silently drops the content; the event flows through, the
            // turn marks DONE, the user sees a blank assistant reply.
            emit("output_delta", { delta: block.text });
          }
          break;
        case "thinking":
          if (
            !streamedPartialContent &&
            typeof block.text === "string" &&
            block.text.length > 0
          ) {
            emit("thinking_delta", { delta: block.text });
          }
          break;
        case "tool_use": {
          const toolName = block.name ?? "";
          const callId = block.id ?? "";
          if (callId && toolName) {
            pendingToolNames.set(callId, toolName);
          }
          // The chat UI builds the trace step from `tool_args`/`result`
          // (toolTraceStepFromPayload), not input/output — emit those
          // names or the step shows just the tool title with no command/
          // diff detail. Completion lands as a separate phase from
          // handleUser; the UI ties the two by call_id.
          emit("tool_call", {
            tool_name: toolName,
            call_id: callId,
            tool_args: asJsonValue(block.input),
            phase: "in_progress",
          });
          break;
        }
      }
    }
  }

  function handleUser(msg: ClaudeSDKMessage): void {
    const content = parseMessageContent(msg.message);
    if (!content) return;
    for (const block of content.content ?? []) {
      if (block.type === "tool_result") {
        const callId = block.tool_use_id ?? "";
        const toolName = (callId && pendingToolNames.get(callId)) || "";
        // Use `tool_call` event_type with `phase: "completed"` rather
        // than a separate `tool_completed` event_type — the UI treats
        // both as equivalent (ChatPane/index.tsx:3277) but only
        // `tool_call` is in the typed KnownRunnerEventType enum.
        emit("tool_call", {
          tool_name: toolName,
          call_id: callId,
          result: asJsonValue(block.content),
          error: block.is_error === true,
          phase: "completed",
        });
        if (callId) {
          pendingToolNames.delete(callId);
        }
      }
    }
  }

  function handleControlRequest(msg: ClaudeSDKMessage): void {
    // Auto-approve in daemon mode. Force `run_in_background:false` if the
    // tool would otherwise launch async — Holaboss-managed runs need
    // foreground completion semantics.
    const requestId = msg.request_id ?? "";
    let updatedInput: Record<string, unknown> = {};
    if (msg.request && typeof msg.request === "object" && !Array.isArray(msg.request)) {
      const req = msg.request as { input?: unknown };
      if (req.input && typeof req.input === "object" && !Array.isArray(req.input)) {
        updatedInput = { ...(req.input as Record<string, unknown>) };
      }
    }
    if (updatedInput.run_in_background === true) {
      updatedInput.run_in_background = false;
    }
    const response = {
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        response: {
          behavior: "allow",
          updatedInput,
        },
      },
    };
    try {
      child.stdin.write(`${JSON.stringify(response)}\n`);
    } catch {
      // stdin closed — best effort.
    }
  }

  const exitCode = await new Promise<number>((resolve) => {
    child.on("close", (code) => resolve(code ?? 0));
  });

  // Wipe the temp --mcp-config file as soon as claude has exited.
  // The file contains decrypted MCP env (Notion OAuth tokens, etc.),
  // so the window where it lives on disk should be as small as
  // possible; tmpdir reaping is a last-resort fallback only.
  mcpMaterialization?.cleanup();
  skillsMaterialization?.cleanup();

  if (exitCode !== 0 && finalStatus === "completed") {
    finalStatus = "failed";
    finalError = `${opts.label} exited with code ${exitCode}`;
  }

  // Resume reconciliation: when we asked for --resume <X> but claude
  // emitted a different session_id, the prior conversation wasn't
  // recoverable (claude printed "No conversation found …" and started
  // fresh). Report the run as failed so the upstream "retry with no
  // resume" fallback can drop the bad pointer rather than persisting
  // a brand-new id as if it had succeeded.
  const reportedSessionId = resolveSessionIdForReport(
    requestedResumeSessionId,
    sessionId,
    finalStatus === "failed",
  );
  if (
    finalStatus === "completed" &&
    requestedResumeSessionId &&
    sessionId &&
    sessionId !== requestedResumeSessionId
  ) {
    finalStatus = "failed";
    finalError =
      `${opts.label} resume did not land — requested ${requestedResumeSessionId}, ` +
      `emitted ${sessionId}`;
  }

  if (finalStatus === "failed") {
    emit("run_failed", {
      error: composeFailureMessage(finalError ?? `${opts.label} failed`, stderrTail, opts.label),
      harness_session_id: reportedSessionId,
      usage: serializeUsage(usage),
    });
    return 1;
  }

  emit("run_completed", {
    status: "completed",
    output: outputText,
    harness_session_id: reportedSessionId,
    usage: serializeUsage(usage),
  });
  return 0;
}

function resolveSessionIdForReport(
  requestedResume: string | null,
  emitted: string | null,
  failed: boolean,
): string | null {
  if (
    failed &&
    requestedResume &&
    emitted &&
    emitted !== requestedResume
  ) {
    // Withholding the fresh id on a failed-resume run keeps the
    // upstream daemon's retry fallback able to trigger instead of
    // persisting a fork.
    return null;
  }
  return emitted;
}

/**
 * Extract a user-visible token delta from a Claude `stream_event` frame
 * (emitted under --include-partial-messages). Only content_block_delta frames
 * of type text_delta / thinking_delta carry incremental content; everything
 * else (block start/stop, message_*) returns null. Pure + exported for tests.
 */
export function parseClaudeStreamDelta(
  msg: { event?: unknown },
): { kind: "text" | "thinking"; text: string } | null {
  const event = isRecord(msg.event) ? msg.event : null;
  if (!event || event.type !== "content_block_delta") {
    return null;
  }
  const delta = isRecord(event.delta) ? event.delta : null;
  if (!delta) {
    return null;
  }
  if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text.length > 0) {
    return { kind: "text", text: delta.text };
  }
  if (
    delta.type === "thinking_delta" &&
    typeof delta.thinking === "string" &&
    delta.thinking.length > 0
  ) {
    return { kind: "thinking", text: delta.thinking };
  }
  return null;
}

function buildClaudeArgs(
  request: HarnessHostClaudeCodeRequest,
  mcpConfigPath: string | null,
  skillsDir: string | null,
  opts: ClaudeStreamHarnessOptions,
): string[] {
  const args = [
    "-p",
    "--output-format", "stream-json",
    "--input-format", "stream-json",
    "--verbose",
    // Stream token-level deltas (content_block_delta) as `stream_event` frames
    // so the chat shows text as it's generated instead of only when the
    // assistant message completes. Requires --verbose + stream-json (both set).
    "--include-partial-messages",
    "--permission-mode", "bypassPermissions",
    // AskUserQuestion has no surface in non-interactive mode; banning it
    // forces the agent to comment instead of silently inferring an
    // empty answer.
    "--disallowedTools", "AskUserQuestion",
  ];
  // Session model first, then a per-host default (HOLABOSS_<X>_MODEL),
  // else the CLI's own default.
  const model =
    request.selected_model?.trim() ||
    (process.env[opts.modelEnv] ?? "").trim();
  if (model) {
    args.push("--model", model);
  }
  const thinking = request.thinking_value?.trim();
  if (thinking) {
    args.push("--effort", thinking);
  }
  const systemPrompt = request.system_prompt?.trim();
  if (systemPrompt) {
    args.push("--append-system-prompt", systemPrompt);
  }
  if (mcpConfigPath) {
    // --strict-mcp-config tells Claude to use ONLY this file's servers
    // (don't merge with user-global ~/.claude.json).
    args.push("--mcp-config", mcpConfigPath);
    args.push("--strict-mcp-config");
  }
  const resumeId = request.persisted_harness_session_id?.trim() || null;
  if (resumeId) {
    // The runner cross-checks the emitted result.session_id against
    // this value after the run; if claude couldn't find the session it
    // prints "No conversation found with session ID: …" to stderr,
    // generates a fresh id, and we treat the resume as failed so the
    // upstream retry-with-fresh-session fallback can kick in.
    args.push("--resume", resumeId);
  }
  if (skillsDir) {
    // Skills load from `<added-dir>/.claude/skills/` as an exception to
    // --add-dir's usual file-access-only semantics (Claude Code docs:
    // "skills load from added dirs"). Keeps workspace skills out of the
    // user's real cwd.
    args.push("--add-dir", skillsDir);
  }
  // Per-host default args, shell-word split (e.g. HOLABOSS_CLAUDE_ARGS=
  // '--add-dir /opt/shared --model claude-opus-4-8'). Applied last so a
  // deployment can layer flags on.
  for (const extra of splitShellWords(process.env[opts.argsEnv])) {
    args.push(extra);
  }
  return args;
}

interface ClaudeMcpMaterialization {
  path: string;
  cleanup: () => void;
}

/**
 * Translate the Holaboss `mcp_servers` payload (an array of
 * `{name, config: {type, command, environment, url, headers, enabled, timeout}}`)
 * into Claude Code's `--mcp-config` JSON shape and write it to a temp
 * file. Returns the file path + a cleanup hook the runner calls on
 * exit; null if there's nothing to materialize.
 *
 * Claude's expected shape:
 *   {
 *     "mcpServers": {
 *       "<name>": { "type": "stdio", "command": "...", "args": [...], "env": {...} },
 *       "<name>": { "type": "http",  "url": "...", "headers": {...} }
 *     }
 *   }
 */
function materializeClaudeMcpConfig(
  servers: JsonObject[] | undefined,
): ClaudeMcpMaterialization | null {
  if (!Array.isArray(servers) || servers.length === 0) {
    return null;
  }
  const mcpServers: Record<string, unknown> = {};
  for (const entry of servers) {
    if (!entry || typeof entry !== "object") continue;
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    const config = isRecord(entry.config) ? entry.config : null;
    if (!name || !config) continue;
    if (config.enabled === false) continue;
    if (config.type === "local") {
      const command = Array.isArray(config.command)
        ? (config.command as unknown[]).filter(
            (v): v is string => typeof v === "string",
          )
        : [];
      if (command.length === 0) continue;
      mcpServers[name] = {
        type: "stdio",
        command: command[0],
        args: command.slice(1),
        env: isRecord(config.environment) ? config.environment : {},
      };
    } else if (config.type === "remote") {
      const url = typeof config.url === "string" ? config.url.trim() : "";
      if (!url) continue;
      mcpServers[name] = {
        type: "http",
        url,
        headers: isRecord(config.headers) ? config.headers : {},
      };
    }
  }
  if (Object.keys(mcpServers).length === 0) {
    return null;
  }
  const dir = mkdtempSync(join(tmpdir(), "holaboss-claude-mcp-"));
  const filePath = join(dir, "mcp.json");
  writeFileSync(filePath, JSON.stringify({ mcpServers }, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  return {
    path: filePath,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort; OS reaps tmpdir eventually
      }
    },
  };
}

interface ClaudeSkillsMaterialization {
  dir: string;
  cleanup: () => void;
}

/**
 * Stage workspace skills into `<tmp>/.claude/skills/<name>/` and return
 * the tmp dir for `--add-dir`. Claude discovers skills from added dirs,
 * so this surfaces workspace skills to a headless run without writing
 * into the user's real cwd. Skips dirs without a SKILL.md; returns null
 * when nothing stages. Best-effort per skill.
 */
export function materializeClaudeSkills(
  skillDirs: string[] | undefined,
): ClaudeSkillsMaterialization | null {
  const dirs = Array.isArray(skillDirs)
    ? skillDirs.filter(
        (dir): dir is string => typeof dir === "string" && dir.trim().length > 0,
      )
    : [];
  if (dirs.length === 0) {
    return null;
  }
  const root = mkdtempSync(join(tmpdir(), "holaboss-claude-skills-"));
  const skillsRoot = join(root, ".claude", "skills");
  let staged = 0;
  for (const dir of dirs) {
    try {
      if (!existsSync(join(dir, "SKILL.md"))) continue;
      mkdirSync(skillsRoot, { recursive: true });
      cpSync(dir, join(skillsRoot, basename(dir)), { recursive: true });
      staged += 1;
    } catch {
      // best effort
    }
  }
  if (staged === 0) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // best effort
    }
    return null;
  }
  return {
    dir: root,
    cleanup: () => {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // best effort; OS reaps tmpdir eventually
      }
    },
  };
}

/**
 * Minimal POSIX-ish shell-word splitter for HOLABOSS_CLAUDE_ARGS. Handles
 * single/double quotes and backslash escapes — good enough for the flag
 * strings operators actually write. Returns [] for empty/unset input.
 */
export function splitShellWords(raw: string | undefined): string[] {
  const input = (raw ?? "").trim();
  if (!input) return [];
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === "\\" && quote === '"' && i + 1 < input.length) {
        cur += input[++i];
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (ch === "\\" && i + 1 < input.length) {
      cur += input[++i];
      has = true;
    } else if (ch === " " || ch === "\t") {
      if (has) {
        out.push(cur);
        cur = "";
        has = false;
      }
    } else {
      cur += ch;
      has = true;
    }
  }
  if (has) out.push(cur);
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function filterChildEnv(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Strip internal Claude Code session markers so a nested invocation
  // doesn't mistake itself for a resumed parent session. Public
  // CLAUDE_CODE_* config (CLAUDE_CODE_GIT_BASH_PATH, …) passes through.
  const filtered: NodeJS.ProcessEnv = {};
  const stripped = new Set([
    "CLAUDECODE",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_SSE_PORT",
  ]);
  for (const [key, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    if (stripped.has(key)) continue;
    if (key.startsWith("CLAUDECODE_")) continue;
    filtered[key] = value;
  }
  return filtered;
}

function asJsonValue(value: unknown): JsonValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  // Best-effort: stringify+parse drops functions, symbols, undefined; the
  // event payload is bound by RunnerOutputEvent's JsonObject contract, so
  // unknown shapes from claude get normalized rather than rejected.
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch {
    return null;
  }
}

function composeFailureMessage(message: string, stderrTail: string, label: string): string {
  const tail = stderrTail.trim();
  if (!tail) return message;
  return `${message}\n--- ${label} stderr (tail) ---\n${tail}`;
}

function parseMessageContent(raw: unknown): ClaudeMessageContent | null {
  if (raw == null) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as ClaudeMessageContent;
    } catch {
      return null;
    }
  }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return raw as ClaudeMessageContent;
  }
  return null;
}

interface ClaudeSDKMessage {
  type: string;
  message?: unknown;
  session_id?: string;
  result?: string;
  is_error?: boolean;
  request_id?: string;
  request?: unknown;
  // `stream_event` frames (emitted under --include-partial-messages) wrap a
  // raw Anthropic streaming event (content_block_delta, …) under `event`.
  event?: unknown;
  // Terminal result-event fields the runner reads for token accounting.
  // `usage` is the single-model fallback; `modelUsage` is the multi-
  // model authoritative map (snake_case for SDK, camelCase for the
  // terminal result event).
  model?: string;
  usage?: ClaudeUsageNumbers;
  modelUsage?: Record<string, ClaudeUsageNumbers>;
}

interface ClaudeMessageContent {
  role?: string;
  model?: string;
  content?: ClaudeContentBlock[];
  usage?: ClaudeUsageNumbers;
}

interface ClaudeContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

/**
 * Claude reports the snake_case shape for live (per-assistant-message)
 * usage and the camelCase shape on the terminal result event. Both
 * variants map to the same accounting fields; addClaudeUsage normalizes.
 */
interface ClaudeUsageNumbers {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

interface ClaudeTokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

function normalizeClaudeUsage(raw: ClaudeUsageNumbers): ClaudeTokenUsage {
  return {
    input_tokens: Math.max(0, raw.input_tokens ?? raw.inputTokens ?? 0),
    output_tokens: Math.max(0, raw.output_tokens ?? raw.outputTokens ?? 0),
    cache_read_tokens: Math.max(
      0,
      raw.cache_read_input_tokens ?? raw.cacheReadInputTokens ?? 0,
    ),
    cache_write_tokens: Math.max(
      0,
      raw.cache_creation_input_tokens ?? raw.cacheCreationInputTokens ?? 0,
    ),
  };
}

function addClaudeUsage(
  acc: Map<string, ClaudeTokenUsage>,
  model: string,
  raw: ClaudeUsageNumbers,
): void {
  const delta = normalizeClaudeUsage(raw);
  if (
    delta.input_tokens === 0 &&
    delta.output_tokens === 0 &&
    delta.cache_read_tokens === 0 &&
    delta.cache_write_tokens === 0
  ) {
    return;
  }
  const existing = acc.get(model);
  if (!existing) {
    acc.set(model, delta);
    return;
  }
  acc.set(model, {
    input_tokens: existing.input_tokens + delta.input_tokens,
    output_tokens: existing.output_tokens + delta.output_tokens,
    cache_read_tokens: existing.cache_read_tokens + delta.cache_read_tokens,
    cache_write_tokens: existing.cache_write_tokens + delta.cache_write_tokens,
  });
}

function serializeUsage(acc: Map<string, ClaudeTokenUsage>): JsonObject | null {
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
