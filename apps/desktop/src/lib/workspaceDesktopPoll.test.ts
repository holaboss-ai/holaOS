import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const providerSourcePath = path.join(__dirname, "workspaceDesktop.tsx");

/**
 * STRUCTURAL guard, deliberately.
 *
 * The behaviour — "a setInterval whose effect is torn down every render never
 * fires" — is a property of React + timers, not of code worth simulating, and
 * this provider can't be mounted cheaply (no React test renderer here, and it
 * needs the whole window.electronAPI surface). What can be pinned is the thing
 * that actually broke: the poll effect must not depend on a value that is new
 * on every render.
 */

test("the initializing-apps poll does not depend on per-render functions", () => {
  const source = fs.readFileSync(providerSourcePath, "utf8");

  const marker = "// Auto-poll installed apps when any app is not yet ready.";
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, "the auto-poll effect was not found");
  const block = source.slice(start, source.indexOf("\n  const value = useMemo", start));

  const deps = block.match(/\}, \[([^\]]*)\]\);/);
  assert.ok(deps, "could not read the poll effect's dependency array");
  const listed = deps[1]
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  // Both of these are plain function declarations in the component body, so
  // they are new objects on every render. Either one in this array recreates
  // the interval before it can ever fire.
  for (const unstable of ["refreshInstalledApps", "applyWorkspaceLifecycle"]) {
    assert.ok(
      !listed.includes(unstable),
      `${unstable} is back in the poll effect's deps — the interval will be recreated every render and never fire`,
    );
  }
  assert.deepEqual(listed.sort(), ["installedApps", "selectedWorkspaceId"]);
});

test("the poll tick is read through a ref so it cannot go stale", () => {
  const source = fs.readFileSync(providerSourcePath, "utf8");

  // The flip side of dropping those deps: a longer-lived effect would
  // otherwise capture the first render's closures forever.
  assert.match(source, /pollInitializingAppsRef\.current = \(\) => \{/);
  assert.match(source, /setInterval\(\(\) => pollInitializingAppsRef\.current\(\), 3000\)/);
});
