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

  // Every one of these gets a new identity on each render or each lifecycle
  // payload, and any one of them in this array recreates the interval before
  // it can fire. `installedApps` is the subtle one: applyWorkspaceLifecycle
  // replaces it with a freshly hydrated array, and a second lifecycle poll
  // runs unconditionally on its own 3s timer — so depending on the array
  // reproduced the bug even after the function deps were dropped.
  for (const unstable of [
    "refreshInstalledApps",
    "applyWorkspaceLifecycle",
    "installedApps",
  ]) {
    assert.ok(
      !listed.includes(unstable),
      `${unstable} is back in the poll effect's deps — the interval will be recreated before it can fire`,
    );
  }
  assert.deepEqual(listed.sort(), ["hasInitializingApps", "selectedWorkspaceId"]);
});

test("the poll effect keys off the derived boolean, not the array", () => {
  const source = fs.readFileSync(providerSourcePath, "utf8");

  // The boolean only flips when an app actually becomes ready, which is
  // exactly when this poll should start or stop.
  assert.match(
    source,
    /const hasInitializingApps = installedApps\.some\(\(app\) => !app\.ready\);/,
  );
});

test("the poll tick is read through a ref so it cannot go stale", () => {
  const source = fs.readFileSync(providerSourcePath, "utf8");

  // The flip side of dropping those deps: a longer-lived effect would
  // otherwise capture the first render's closures forever.
  assert.match(source, /pollInitializingAppsRef\.current = \(\) => \{/);
  assert.match(source, /setInterval\(\(\) => pollInitializingAppsRef\.current\(\), 3000\)/);
});

test("the poll tick ref is assigned in an effect, not during render", () => {
  const source = fs.readFileSync(providerSourcePath, "utf8");

  // Writing a ref during render leaves it pointing at the closure of a render
  // React may discard (Strict Mode's double invoke, or a losing concurrent
  // render).
  const assignment = source.indexOf("pollInitializingAppsRef.current = () => {");
  assert.notEqual(assignment, -1, "the poll tick assignment was not found");
  const preceding = source.slice(0, assignment);
  const lastEffect = preceding.lastIndexOf("useEffect(() => {");
  const lastRefDeclaration = preceding.lastIndexOf("const pollInitializingAppsRef");
  assert.ok(
    lastEffect > lastRefDeclaration,
    "pollInitializingAppsRef.current is assigned during render — move it into a useEffect",
  );
});
