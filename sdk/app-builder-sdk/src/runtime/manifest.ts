// Generates an app.runtime.yaml document from an SDK app's declaration.
//
// The Holaboss runtime reads app.runtime.yaml for lifecycle (setup/start/stop),
// healthchecks, MCP descriptor (port + tool list), env contract, and
// integrations. With this helper, an SDK app doesn't hand-write boilerplate
// — the manifest is derived from what the app already declared.

import type { AppHandleInternal } from "../app.ts"

export interface ManifestOpts {
  /** Display name for marketplace / UI. Defaults to app.id with title-case. */
  name?: string
  /** Manifest slug. Defaults to app.id. */
  slug?: string
  /** npm/bun setup + start commands. Defaults to sensible bun pattern. */
  lifecycle?: { setup?: string; start?: string; stop?: string }
  /** MCP port the entry point will listen on. Default 3099 (matches existing convention). */
  mcpPort?: number
  /** Optional UI port (Express server) — omit if the app has no UI. */
  uiPort?: number
  /** Extra env vars beyond the SDK's defaults. */
  extraEnv?: string[]
}

export function buildAppRuntimeManifest(app: AppHandleInternal, opts: ManifestOpts = {}): string {
  const cfg = app.config
  const name = opts.name ?? titleCase(cfg.id)
  const slug = opts.slug ?? cfg.id
  const mcpPort = opts.mcpPort ?? 3099
  const lifecycle = {
    setup: opts.lifecycle?.setup ?? "bun install",
    start: opts.lifecycle?.start ?? `MCP_PORT=${mcpPort} bun run server.ts`,
    stop: opts.lifecycle?.stop ?? `kill $(lsof -t -i :\${MCP_PORT:-${mcpPort}} 2>/dev/null) 2>/dev/null || true`,
  }
  const baseEnv = [
    "HOLABOSS_WORKSPACE_ID",
    "WORKSPACE_DB_PATH",
    "HOLABOSS_INTEGRATION_BROKER_URL",
    "HOLABOSS_APP_GRANT",
    "MCP_PORT",
  ]
  const env = [...new Set([...baseEnv, ...(opts.extraEnv ?? [])])]

  const toolNames = app.derivedTools().map(t => t.name)

  // Produce yaml manually — no yaml dep needed, structure is rigid.
  const lines: string[] = []
  lines.push(`app_id: "${cfg.id}"`)
  lines.push(`name: "${name}"`)
  lines.push(`slug: "${slug}"`)
  lines.push(``)
  lines.push(`lifecycle:`)
  lines.push(`  setup: "${escapeYaml(lifecycle.setup)}"`)
  lines.push(`  start: "${escapeYaml(lifecycle.start)}"`)
  lines.push(`  stop: "${escapeYaml(lifecycle.stop)}"`)
  lines.push(``)
  lines.push(`healthchecks:`)
  lines.push(`  mcp:`)
  lines.push(`    path: /mcp/health`)
  lines.push(`    timeout_s: 120`)
  lines.push(``)
  lines.push(`mcp:`)
  lines.push(`  enabled: true`)
  lines.push(`  transport: http-sse`)
  lines.push(`  port: ${mcpPort}`)
  lines.push(`  path: /mcp/sse`)
  lines.push(`  tools:`)
  for (const t of toolNames) lines.push(`    - ${t}`)
  if (opts.uiPort !== undefined) {
    lines.push(``)
    lines.push(`ui:`)
    lines.push(`  port: ${opts.uiPort}`)
  }
  lines.push(``)
  lines.push(`integration:`)
  lines.push(`  destination: "${cfg.provider.composioToolkit ?? cfg.id}"`)
  lines.push(`  credential_source: "platform"`)
  lines.push(``)
  lines.push(`env_contract:`)
  for (const e of env) lines.push(`  - "${e}"`)
  lines.push(``)
  return lines.join("\n")
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).replace(/[_-]/g, " ")
}

function escapeYaml(s: string): string {
  return s.replace(/"/g, '\\"')
}
