// Builds runtime/api-server/src/__fixtures__/minimal-app.tar.gz deterministically.
// Run: node src/__fixtures__/build-fixture.mjs
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as tar from "tar";

const here = path.dirname(new URL(import.meta.url).pathname);
const stage = fs.mkdtempSync(path.join(os.tmpdir(), "holaboss-fixture-"));

fs.writeFileSync(
  path.join(stage, "app.runtime.yaml"),
  `app_id: "minimal"
name: "Minimal"
slug: "minimal"

lifecycle:
  setup: "true"
  start: "true"
  stop: "true"

healthchecks:
  mcp:
    path: /mcp/health
    timeout_s: 5

mcp:
  enabled: false
  transport: http-sse
  port: 3099
  path: /mcp/sse
`,
);
fs.writeFileSync(
  path.join(stage, "package.json"),
  JSON.stringify({ name: "minimal-module", version: "0.0.0" }, null, 2),
);

const out = path.join(here, "minimal-app.tar.gz");
await tar.c(
  { gzip: true, file: out, cwd: stage, portable: true, noMtime: true },
  ["app.runtime.yaml", "package.json"],
);
console.log(`wrote ${out}`);

fs.rmSync(stage, { recursive: true, force: true });
