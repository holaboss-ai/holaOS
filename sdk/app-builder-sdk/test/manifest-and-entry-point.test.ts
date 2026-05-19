// Verify the app.runtime.yaml manifest generator and the Slack v2 production
// entry point. The entry point test spawns server.ts as a subprocess (which
// is how the Holaboss runtime actually launches apps) and verifies the MCP
// health endpoint becomes reachable.

import { describe, test, expect } from "bun:test"
import { spawn } from "node:child_process"
import { mkdtempSync, unlinkSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { buildAppRuntimeManifest } from "../src/runtime/manifest.ts"
import { buildSlackApp } from "../reference/slack-messaging/app.ts"
import type { AppHandleInternal } from "../src/app.ts"

const SDK_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..")

describe("manifest generator — buildAppRuntimeManifest", () => {
  test("derives Slack manifest from app declaration with all expected sections", () => {
    const { app } = buildSlackApp() as unknown as { app: AppHandleInternal }
    const yaml = buildAppRuntimeManifest(app, { name: "Slack" })

    // Top-level identity
    expect(yaml).toContain(`app_id: "slack"`)
    expect(yaml).toContain(`name: "Slack"`)
    expect(yaml).toContain(`slug: "slack"`)

    // Required sections
    expect(yaml).toContain("lifecycle:")
    expect(yaml).toContain("healthchecks:")
    expect(yaml).toContain("mcp:")
    expect(yaml).toContain("integration:")
    expect(yaml).toContain("env_contract:")

    // MCP config matches the SDK convention
    expect(yaml).toContain("transport: http-sse")
    expect(yaml).toContain("path: /mcp/sse")
    expect(yaml).toContain("port: 3099")

    // Tool list is derived from app.derivedTools()
    expect(yaml).toContain("- slack_send_message_message")
    expect(yaml).toContain("- slack_react")              // custom toolName
    expect(yaml).toContain("- slack_cancel_schedule_send_message")  // reversible
    expect(yaml).toContain("- slack_snapshot")
    expect(yaml).toContain("- slack_connection_status")

    // Integration links to Composio toolkit
    expect(yaml).toContain(`destination: "slack"`)

    // Env contract has the broker + workspace essentials
    expect(yaml).toContain(`- "HOLABOSS_APP_GRANT"`)
    expect(yaml).toContain(`- "HOLABOSS_INTEGRATION_BROKER_URL"`)
    expect(yaml).toContain(`- "WORKSPACE_DB_PATH"`)
    expect(yaml).toContain(`- "MCP_PORT"`)
  })

  test("custom lifecycle + uiPort options surface in manifest", () => {
    const { app } = buildSlackApp() as unknown as { app: AppHandleInternal }
    const yaml = buildAppRuntimeManifest(app, {
      lifecycle: { setup: "pnpm install", start: "node dist/server.js", stop: "pkill node" },
      uiPort: 4100,
      extraEnv: ["MY_CUSTOM_VAR"],
    })
    expect(yaml).toContain(`setup: "pnpm install"`)
    expect(yaml).toContain(`start: "node dist/server.js"`)
    expect(yaml).toContain("ui:\n  port: 4100")
    expect(yaml).toContain(`- "MY_CUSTOM_VAR"`)
  })
})

describe("production entry point — reference/slack-messaging/server.ts boots end-to-end", () => {
  test("spawns server.ts with env, /mcp/health responds, SIGTERM shuts down cleanly", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "slack-v2-e2e-"))
    const dbPath = join(tmp, "workspace.db")
    const port = 31099 + Math.floor(Math.random() * 1000)  // avoid collisions

    // Spawn the real production entry — same way holaOS runtime would
    const child = spawn("bun", ["run", "reference/slack-messaging/server.ts"], {
      cwd: SDK_DIR,
      env: {
        ...process.env,
        WORKSPACE_DB_PATH: dbPath,
        MCP_PORT: String(port),
        HOLABOSS_INTEGRATION_BROKER_URL: "http://localhost:8080",  // dummy; not called in this test
        HOLABOSS_APP_GRANT: "grant:test_ws:slack:test_nonce",       // dummy
      },
      stdio: ["ignore", "pipe", "pipe"],
    })

    let stdout = "", stderr = ""
    child.stdout!.on("data", d => { stdout += d.toString() })
    child.stderr!.on("data", d => { stderr += d.toString() })

    // Wait for "MCP server listening" boot message OR a hard fail
    const booted = await waitFor(() => stdout.includes("MCP server listening on :") || stderr.length > 0, 5000)
    if (!booted) {
      child.kill("SIGKILL")
      throw new Error(`Server did not boot in 5s. stdout:\n${stdout}\nstderr:\n${stderr}`)
    }
    if (stderr.includes("refusing to start") || stderr.includes("Error:")) {
      child.kill("SIGKILL")
      throw new Error(`Server errored on boot:\n${stderr}`)
    }

    // Verify /mcp/health
    let healthOk = false
    for (let i = 0; i < 10 && !healthOk; i++) {
      try {
        const r = await fetch(`http://localhost:${port}/mcp/health`)
        if (r.ok) {
          const body = await r.json() as { status: string; app_id: string }
          expect(body.status).toBe("ok")
          expect(body.app_id).toBe("slack")
          healthOk = true
        }
      } catch {}
      if (!healthOk) await sleep(100)
    }
    expect(healthOk).toBe(true)

    // Send SIGTERM and verify clean exit
    child.kill("SIGTERM")
    const exitCode = await new Promise<number | null>(resolve => {
      child.once("exit", code => resolve(code))
    })
    // Either exits 0 or null (signal exit); both are acceptable clean shutdowns
    expect([0, null].includes(exitCode)).toBe(true)

    // Verify shutdown message in stdout
    expect(stdout).toContain("Received SIGTERM, shutting down")

    // Cleanup
    try { unlinkSync(dbPath) } catch {}
    try { unlinkSync(dbPath + "-wal") } catch {}
    try { unlinkSync(dbPath + "-shm") } catch {}
  }, 15000)

  test("entry point refuses to start without WORKSPACE_DB_PATH", async () => {
    const child = spawn("bun", ["run", "reference/slack-messaging/server.ts"], {
      cwd: SDK_DIR,
      env: {
        ...process.env,
        WORKSPACE_DB_PATH: "",   // explicitly empty
        MCP_PORT: "31199",
        HOLABOSS_INTEGRATION_BROKER_URL: "http://localhost:8080",
        HOLABOSS_APP_GRANT: "grant:x:x:x",
      },
      stdio: ["ignore", "pipe", "pipe"],
    })

    let stderr = ""
    child.stderr!.on("data", d => { stderr += d.toString() })
    const code = await new Promise<number | null>(resolve => {
      child.once("exit", c => resolve(c))
    })
    expect(code).toBe(1)
    expect(stderr).toContain("WORKSPACE_DB_PATH not set")
  }, 10000)
})

// ─── helpers ──────────────────────────────────────────────────────────────

async function waitFor(pred: () => boolean, timeoutMs: number): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true
    await sleep(50)
  }
  return false
}
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }
