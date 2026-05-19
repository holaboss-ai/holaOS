// Workspace integration smoke test.
//
// Proves the SDK is usable from a "real workspace app" layout — i.e. an
// app directory with its own package.json that depends on
// @holaboss/app-builder-sdk via file: protocol, then `bun install` and
// `bun run server.ts` actually work end-to-end.
//
// This is what the Holaboss runtime will do when launching an SDK app:
//   1. workspace.yaml registers `apps/slack-v2/`
//   2. app-lifecycle-worker runs lifecycle.setup (bun install)
//   3. app-lifecycle-worker runs lifecycle.start (bun run server.ts)
//   4. injects WORKSPACE_DB_PATH / MCP_PORT / HOLABOSS_APP_GRANT /
//      HOLABOSS_INTEGRATION_BROKER_URL via env
//
// We do exactly that here, against a temp workspace, to prove the contract
// holds end-to-end without depending on a real desktop / runtime running.

import { describe, test, expect } from "bun:test"
import { spawn, spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const SDK_DIR = "/Users/joshua/holaboss-ai/holaboss/holaOS/experiments/app-builder-sdk"

describe("Workspace integration — slack v2 installed via file: dep", () => {
  test("bun install resolves SDK via file:, server boots, /mcp/health responds", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "ws-int-"))
    const appDir = join(workspace, "apps", "slack-v2")
    mkdirSync(appDir, { recursive: true })

    try {
      // Materialize the app as it would appear in a real workspace
      const pkg = {
        name: "slack-v2-app",
        version: "0.0.1",
        private: true,
        type: "module",
        scripts: { start: "bun run server.ts" },
        dependencies: {
          "@holaboss/app-builder-sdk": `file:${SDK_DIR}`,
          zod: "^3.23.0",
        },
      }
      writeFileSync(join(appDir, "package.json"), JSON.stringify(pkg, null, 2))

      // Copy the app source, rewriting relative SDK imports to use the
      // package name. In a real workspace the app-builder skill / scaffold
      // tool would emit code with package imports directly; here we
      // transform the in-experiment relative imports on the fly.
      const rewriteImports = (src: string) =>
        src
          .replace(/from\s+"\.\.\/\.\.\/src\/index\.ts"/g, 'from "@holaboss/app-builder-sdk"')
          .replace(/from\s+"\.\.\/\.\.\/src\/types\.ts"/g, 'from "@holaboss/app-builder-sdk"')
      for (const f of ["app.ts", "provider.ts", "server.ts"]) {
        const src = readFileSync(join(SDK_DIR, "reference/slack-messaging", f), "utf-8")
        writeFileSync(join(appDir, f), rewriteImports(src))
      }
      // Non-code asset, copy verbatim
      writeFileSync(
        join(appDir, "app.runtime.yaml"),
        readFileSync(join(SDK_DIR, "reference/slack-messaging/app.runtime.yaml"), "utf-8"),
      )

      // Step 1: lifecycle.setup
      const install = spawnSync("bun", ["install"], { cwd: appDir, stdio: "pipe", encoding: "utf-8" })
      expect(install.status).toBe(0)

      // Verify the SDK is actually linked (not duplicated)
      const linkedSdk = spawnSync("bun", ["pm", "ls"], { cwd: appDir, stdio: "pipe", encoding: "utf-8" })
      expect(linkedSdk.stdout).toContain("@holaboss/app-builder-sdk")

      // Step 2: lifecycle.start
      const dbPath = join(workspace, "workspace.db")
      const port = 32100 + Math.floor(Math.random() * 500)

      const child = spawn("bun", ["run", "server.ts"], {
        cwd: appDir,
        env: {
          ...process.env,
          WORKSPACE_DB_PATH: dbPath,
          MCP_PORT: String(port),
          HOLABOSS_INTEGRATION_BROKER_URL: "http://localhost:9999",  // dummy
          HOLABOSS_APP_GRANT: "grant:test_ws:slack:integration_nonce",  // dummy
          HOLABOSS_WORKSPACE_ID: "test_ws",
        },
        stdio: ["ignore", "pipe", "pipe"],
      })

      let stdout = "", stderr = ""
      child.stdout!.on("data", d => { stdout += d.toString() })
      child.stderr!.on("data", d => { stderr += d.toString() })

      // Wait for boot signal
      const booted = await waitFor(() => stdout.includes("MCP server listening on :"), 8000)
      if (!booted) {
        child.kill("SIGKILL")
        throw new Error(`Server did not boot. stdout:\n${stdout}\nstderr:\n${stderr}`)
      }

      // Step 3: verify /mcp/health
      let healthOk = false
      for (let i = 0; i < 20 && !healthOk; i++) {
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

      // Step 4: verify Slack-specific tools registered (proves SDK derivedTools()
      // flowed through to MCP — full integration plumbing works)
      expect(stdout).toContain("Tools registered:")
      // Number is variable; just confirm it's > 10 (we have ~14 for slack)
      const match = stdout.match(/Tools registered: (\d+)/)
      expect(match).toBeTruthy()
      expect(Number(match![1])).toBeGreaterThan(10)

      // Step 5: clean shutdown
      child.kill("SIGTERM")
      const exitCode = await new Promise<number | null>(resolve => {
        child.once("exit", c => resolve(c))
      })
      expect([0, null].includes(exitCode)).toBe(true)
      expect(stdout).toContain("Received SIGTERM, shutting down")

    } finally {
      // Cleanup temp workspace (best-effort)
      try { rmSync(workspace, { recursive: true, force: true }) } catch {}
    }
  }, 60000)
})

async function waitFor(pred: () => boolean, timeoutMs: number): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true
    await sleep(100)
  }
  return false
}
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }
