// Generates app.runtime.yaml for the Slack v2 module.
//
// Run: bun run reference/slack-messaging/manifest.ts
// Output: writes reference/slack-messaging/app.runtime.yaml

import { writeFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { buildSlackApp } from "./app.ts"
import { buildAppRuntimeManifest } from "../../src/runtime/manifest.ts"
import type { AppHandleInternal } from "../../src/app.ts"

const { app } = buildSlackApp() as unknown as { app: AppHandleInternal }
const yaml = buildAppRuntimeManifest(app, {
  name: "Slack",
  slug: "slack",
  lifecycle: {
    setup: "bun install",
    start: "bun run server.ts",
    stop: "kill $(lsof -t -i :${MCP_PORT:-3099} 2>/dev/null) 2>/dev/null || true",
  },
})

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, "app.runtime.yaml")
writeFileSync(out, yaml, "utf-8")
console.log(`Wrote ${out}`)
console.log(`\n${yaml}`)
