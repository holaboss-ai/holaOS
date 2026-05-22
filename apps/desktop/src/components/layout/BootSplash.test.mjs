import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bootSplashPath = path.join(__dirname, "BootSplash.tsx");
const appShellPath = path.join(__dirname, "AppShell.tsx");

test("BootSplash is a fixed full-bleed brand splash with dot loader", async () => {
  const source = await readFile(bootSplashPath, "utf8");

  assert.match(source, /export function BootSplash\(\)/);
  assert.match(source, /fixed inset-0 z-20 flex items-center justify-center/);
  assert.match(source, /holaboss-splash-dot 1\.2s ease-in-out infinite/);
  assert.match(source, /src=\{holabossLogoUrl\}/);
});

test("AppShell uses the shared BootSplash for the workspace bootstrap state", async () => {
  const source = await readFile(appShellPath, "utf8");

  assert.match(
    source,
    /import \{ BootSplash \} from "@\/components\/layout\/BootSplash";/,
  );
  assert.match(source, /<BootSplash \/>/);
  // The old in-file WorkspaceBootstrapPane definition is gone.
  assert.doesNotMatch(source, /function WorkspaceBootstrapPane\(\)/);
});
