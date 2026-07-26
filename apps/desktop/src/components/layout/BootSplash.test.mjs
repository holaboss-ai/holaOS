import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bootSplashPath = path.join(__dirname, "BootSplash.tsx");
const bootGatePath = path.join(__dirname, "shell", "BootGate.tsx");
const appShellPath = path.join(__dirname, "shell", "AppShell.tsx");

test("BootSplash is a fixed full-bleed brand splash with dot loader", async () => {
  const source = await readFile(bootSplashPath, "utf8");

  assert.match(source, /export function BootSplash\(/);
  assert.match(source, /fixed inset-0 z-20 flex items-center justify-center/);
  assert.match(source, /holaboss-splash-dot 1\.2s ease-in-out infinite/);
  assert.match(source, /src=\{holabossLogoUrl\}/);
});

test("BootGate gates the shell on runtime readiness via the shared BootSplash", async () => {
  const bootGateSource = await readFile(bootGatePath, "utf8");

  assert.match(
    bootGateSource,
    /import \{ BootSplash \} from "@\/components\/layout\/BootSplash";/,
  );
  assert.match(bootGateSource, /<BootSplash/);
  // The heavy first-run cleanup renders determinate progress, not just dots.
  assert.match(bootGateSource, /progress=\{/);

  const appShellSource = await readFile(appShellPath, "utf8");
  assert.match(appShellSource, /import \{ BootGate \} from "\.\/BootGate";/);
  assert.match(appShellSource, /<BootGate>/);
});
