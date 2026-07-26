# Bossman — Claude Agent SDK harness (spike)

**Branch:** `spike/bossman-harness` · **Status:** scaffold (not yet installed / type-checked / run live)

## Goal

A new agent harness, **Bossman**, built on the **Claude Agent SDK**
(`@anthropic-ai/claude-agent-sdk`), running **in parallel** with the existing
`pi` (Hola) harness. Driver: **stronger native tool-use + planning + reliability**
than pi's hand-rolled loop — achieved by inheriting Claude's native agent loop
(planning, tool orchestration, context compaction, subagents) while keeping our
existing tools.

## The key distinction (why not just use `claude-code`?)

The existing `claude-code` harness shells out to the `claude` CLI with the
**user's own native auth** and **bypasses the model proxy** (no
`consume_user_token` billing, Anthropic-only, requires a Claude subscription).

Bossman instead follows the **`pi` template**: in-process, wired through the
**Holaboss model proxy** via `model_client`. Result:

| | Hola (pi) | claude-code | **Bossman** |
|---|---|---|---|
| Agent loop | hand-rolled pi loop | Claude native | **Claude native** |
| In-process | ✅ | ❌ (CLI subprocess) | **✅** |
| Via model proxy (billed, any-model) | ✅ | ❌ (native auth) | **✅** |
| Needs user's own Claude login | ❌ | ✅ | **❌** |

Bossman = **Claude's native loop + our proxy (billing + any-model via LiteLLM/
OpenRouter) + our runtime MCP tools + a "Bossman" persona.**

## What this spike scaffolds

| File | Change |
|---|---|
| `runtime/harnesses/src/bossman.ts` | **new** — `bossmanHarnessDefinition` adapter (mirrors claude-code's wire builder; forwards `model_client`) |
| `runtime/harness-host/src/bossman.ts` | **new** — `runBossman()`: drives SDK `query()`, points it at the proxy, maps `mcp_servers`→`mcpServers`, translates the SDK stream → `RunnerOutputEvent` |
| `runtime/harnesses/src/index.ts` | register in `HARNESS_DEFINITIONS` |
| `runtime/harness-host/src/harness-registry.ts` | register in `HARNESS_HOST_IMPLEMENTATIONS` (`run-bossman`) |
| `runtime/harness-host/src/contracts.ts` | `HarnessHostBossmanRequest` + `decodeHarnessHostBossmanRequestBase64` (alias to pi's decoder) |
| `runtime/harness-host/package.json` | add `@anthropic-ai/claude-agent-sdk` |

The harness auto-appears in the desktop picker (registry-driven), accepts the
shared `HarnessHostPiRequest` wire payload, and emits `RunnerOutputEvent`
JSON-lines — identical envelope to pi/claude-code.

## How the wiring works

- **Model/proxy:** `runBossman` sets `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`
  from `request.model_client` (base_url + api_key), so the SDK's Anthropic
  Messages calls flow through our proxy → billing intact, any-model via the
  LiteLLM path we shipped. Default model = `selected_model ?? model_id`.
- **Tools:** `request.mcp_servers` entries are `{ name, config }` where `config`
  is Claude's per-server MCP schema — the SDK's `mcpServers` uses the *same*
  schema, so it's a straight `name → config` map. Instant parity with pi/
  claude-code (browser, sandbox, web-search, composio, cronjobs, memory).
- **Permissions:** `permissionMode: "bypassPermissions"` — the runtime gates
  tools upstream (same posture as claude-code).
- **Events:** SDK `system`/`assistant`/`user`/`result` messages → `run_started`
  / `output_delta` / `thinking_delta` / `tool_call` / `run_completed` /
  `run_failed`. We emit from full assistant blocks (not partial `stream_event`
  deltas) to avoid double-emitting; finer streaming is a follow-up.
- **Resume:** `request.persisted_harness_session_id` → SDK `resume`; we capture
  the SDK `session_id` from the `system` init frame for the binding.

## Open questions to resolve during validation (`TODO(validate)` in code)

1. **Does `@anthropic-ai/claude-agent-sdk` bundle its engine, or need the
   `claude` binary on PATH?** If it needs the CLI, "in-process" becomes a
   managed subprocess → packaging must ship the binary (like `HOLABOSS_CLAUDE_PATH`).
2. **`model_client.base_url` sub-path.** The SDK appends `/v1/messages`. Confirm
   whether the runtime's `base_url` is already the proxy's Anthropic-format root
   or needs `/model-proxy/anthropic` appended (`normalizeAnthropicBaseUrl`).
   We already proved the proxy's Anthropic-native `/messages` endpoint works
   end-to-end (LiteLLM multi-turn test), so the format is sound — only the exact
   base path needs pinning.
3. **Model-id mapping.** Confirm the proxy's Anthropic endpoint accepts the
   `supportedModels` ids (e.g. `claude-sonnet-4-6`) or whether they need
   catalog-id translation.
4. **Exact SDK message union** — field names/discriminants in `mapSdkMessage`
   (typed `any` for now; pin once installed).
5. **Streaming granularity** — whether to emit from `stream_event` partials for
   token-level streaming in the UI.

## How to validate (next phase — the actual de-risking)

```bash
cd runtime/harness-host && npm install        # pulls @anthropic-ai/claude-agent-sdk
npm run typecheck                              # pin the SDK message/option types (resolve TODOs)
```

Then run it in-process the same way `scripts/hola.mts` debugs pi (swap
`run-bossman`), against a real workspace + proxy creds, and confirm: (a) engine
runs without an external `claude` binary, (b) chat + one MCP tool round-trips
through the proxy, (c) events render in the desktop trace. If green → promote
from spike to a full design doc + UI polish (beta tag, model picker).
