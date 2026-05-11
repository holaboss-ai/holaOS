/**
 * Patch @mariozechner/pi-ai's openai-completions.js in the staged runtime bundle
 * to use a 2-hour HTTP timeout for providers with a custom baseURL (local providers
 * like LM Studio and Ollama) instead of the OpenAI SDK default of 10 minutes.
 *
 * This is needed because large 32k+ context windows on local hardware can take
 * longer than 10 minutes to generate.
 *
 * Run after desktop:prepare-runtime:local or desktop:prepare-runtime.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BUNDLE_FILE = path.resolve(
  __dirname,
  "..",
  "out",
  "runtime-windows",
  "runtime",
  "api-server",
  "node_modules",
  "@mariozechner",
  "pi-ai",
  "dist",
  "providers",
  "openai-completions.js",
);

const OLD_SNIPPET = `return new OpenAI({
        apiKey,
        baseURL: model.baseUrl,
        dangerouslyAllowBrowser: true,
        defaultHeaders: headers,
    });`;

const NEW_SNIPPET = `return new OpenAI({
        apiKey,
        baseURL: model.baseUrl,
        dangerouslyAllowBrowser: true,
        defaultHeaders: headers,
        // 2-hour timeout for local providers (custom baseURL) to support
        // large 32k+ context windows on slow local hardware.
        timeout: model.baseUrl ? 7_200_000 : 600_000,
    });`;

if (!existsSync(BUNDLE_FILE)) {
  console.warn(
    "[patch-local-provider-timeout] Bundle file not found (skipping):",
    BUNDLE_FILE,
  );
  process.exit(0);
}

const content = readFileSync(BUNDLE_FILE, "utf8");
if (content.includes("7_200_000")) {
  console.log("[patch-local-provider-timeout] Already patched, skipping.");
  process.exit(0);
}

if (!content.includes(OLD_SNIPPET)) {
  console.warn(
    "[patch-local-provider-timeout] Expected snippet not found — bundle may have changed. Skipping.",
  );
  process.exit(0);
}

writeFileSync(BUNDLE_FILE, content.replace(OLD_SNIPPET, NEW_SNIPPET), "utf8");
console.log("[patch-local-provider-timeout] Patched timeout in", BUNDLE_FILE);
