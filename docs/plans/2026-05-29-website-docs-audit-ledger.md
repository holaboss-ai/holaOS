# Website Docs Audit Ledger

Date: 2026-05-29

Scope: `website/docs/content/docs`

Status legend:

- `unverified`
- `verified`
- `rewritten`
- `needs-follow-up`

## Getting Started

| Page | Status | Notes |
| --- | --- | --- |
| `getting-started/index.mdx` | rewritten | Updated workspace/runtime framing to match current product seams. |
| `getting-started/quick-start.mdx` | rewritten | Rechecked current setup path and current docs navigation. |
| `getting-started/workspaces.mdx` | rewritten | Corrected workspace state and durable-memory wording. |
| `getting-started/extending.mdx` | rewritten | Rechecked extension surfaces against current app, skill, and automation model. |
| `getting-started/agent-runs.mdx` | rewritten | Replaced stale `knowledge/` memory references with current runtime and durable-memory paths. |

## Build

| Page | Status | Notes |
| --- | --- | --- |
| `build/apps/index.mdx` | rewritten | Corrected runtime-managed app framing and current port assumptions. |
| `build/apps/first-app.mdx` | rewritten | Rechecked first-app flow against current manifest and runtime lifecycle behavior. |
| `build/apps/app-anatomy.mdx` | rewritten | Fixed integration env-var example and current runtime-managed app contract. |
| `build/apps/app-runtime-yaml.mdx` | rewritten | Rechecked manifest parsing, integration ids, and lifecycle rules against code. |
| `build/apps/bridge-sdk.mdx` | rewritten | Rechecked bridge exports, provider-id guidance, and app-surface routing behavior. |
| `build/apps/mcp-tools.mdx` | verified | MCP app tool contract matched current runtime and host behavior. |
| `build/apps/publishing-outputs.mdx` | rewritten | Rechecked output and artifact publishing flow against current runtime tool path. |
| `build/apps/troubleshooting.mdx` | rewritten | Fixed embedded runtime port guidance and browser-tool session assumptions. |
| `build/templates/index.mdx` | verified | High-level template creator flow matched current Desktop publish path. |
| `build/templates/first-template.mdx` | rewritten | Corrected publish archive shape, submission flow, and template materialization assumptions. |

## Concepts

| Page | Status | Notes |
| --- | --- | --- |
| `concepts/concepts.mdx` | rewritten | Updated system-thesis language to current retrieval/writeback framing. |
| `concepts/apps.mdx` | rewritten | Rechecked app-layer role against current runtime-managed capability boundary. |
| `concepts/environment-engineering.mdx` | rewritten | Reframed memory and environment contract around current runtime surfaces. |
| `concepts/workspace-model.mdx` | rewritten | Rebuilt filesystem and memory explanation around current tree-based memory plus compatibility surfaces. |
| `concepts/memory-and-continuity/index.mdx` | rewritten | Reframed section around tree-based markdown memory, retrieval, and continuity. |
| `concepts/memory-and-continuity/durable-memory.mdx` | rewritten | Corrected primary memory forests vs secondary user-memory docs and current retrieval indexes. |
| `concepts/memory-and-continuity/recall-and-evolve.mdx` | rewritten | Recast page as recall pipeline plus async durable writeback. |
| `concepts/memory-and-continuity/runtime-continuity.mdx` | rewritten | Corrected resume-state surfaces and current post-run continuity flow. |
| `concepts/agent-harness/index.mdx` | rewritten | Corrected current browser-tool session behavior and harness boundary description. |
| `concepts/agent-harness/adapter-capabilities.mdx` | verified | Adapter capability flags matched current `pi` adapter code. |
| `concepts/agent-harness/mcp-support.mdx` | verified | MCP allowlist, discovery, and host/runtime split matched current code and tests. |
| `concepts/agent-harness/model-routing.mdx` | rewritten | Added current provider ids and corrected routing special cases. |
| `concepts/agent-harness/runtime-tools.mdx` | rewritten | Rebuilt runtime-tool inventory around current surfaced tools and session shaping. |
| `concepts/agent-harness/skills-usage.mdx` | verified | Runtime vs host skill-widening split matched current behavior. |

## Contribute

| Page | Status | Notes |
| --- | --- | --- |
| `contribute/index.mdx` | rewritten | Rechecked contributor routing and subsystem entry points. |
| `contribute/templates-materialization.mdx` | rewritten | Corrected Desktop template materialization and submission assumptions. |
| `contribute/start-developing/index.mdx` | rewritten | Rechecked real dev loops, bundle watcher, and runtime-port guidance. |
| `contribute/start-developing/from-source.mdx` | rewritten | Rechecked source install path, Bun prerequisite, and runtime bundle staging. |
| `contribute/start-developing/contributing.mdx` | rewritten | Rechecked validation matrix and repo-specific review rules. |
| `contribute/desktop/internals.mdx` | rewritten | Rechecked embedded runtime launch, browser service, and desktop code seams. |
| `contribute/desktop/model-configuration.mdx` | rewritten | Added current OpenAI Codex path and corrected model defaults and provider guidance. |
| `contribute/desktop/workspace-experience.mdx` | verified | Workspace UI contract matched current shell surface model. |
| `contribute/agent-harness/internals.mdx` | rewritten | Corrected reduced host request, browser session gating, slash-skill expansion, and runtime-tool bridge scope. |
| `contribute/runtime/apis.mdx` | rewritten | Rechecked route families, runtime-tool headers, and launch-mode port behavior. |
| `contribute/runtime/independent-deploy.mdx` | rewritten | Corrected packaged runtime filesystem layout and current memory-root structure. |
| `contribute/runtime/run-compilation.mdx` | verified | Run compilation stages matched current runtime bootstrap path. |
| `contribute/runtime/state-store.mdx` | rewritten | Corrected current memory metadata split and current database/filesystem contract. |

## Reference

| Page | Status | Notes |
| --- | --- | --- |
| `reference/environment-variables.mdx` | rewritten | Corrected current integration env-var examples and rechecked active runtime env surface. |
