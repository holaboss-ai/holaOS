import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const NEW_TAB_DIALOG_PATH = new URL("./NewTabDialog.tsx", import.meta.url);
const APP_SHELL_PATH = new URL("./AppShell.tsx", import.meta.url);
const OPEN_OUTPUT_PATH = new URL("./useOpenWorkspaceOutput.ts", import.meta.url);

function count(source, pattern) {
  return (source.match(pattern) ?? []).length;
}

// Regression guard: the web launcher (globe entry next to Search) opens the
// browser tabs area via NewTabDialog.revealBrowser. But ShellMainArea replaces
// the entire right side — including the browser <Center> — whenever
// projectViewAtom or workspaceOverlayAtom is set. So reveal must dismiss those
// overlays, or the tabs area opens hidden behind a project/automations/skills
// surface and the user sees nothing.
test("web launcher reveal dismisses project + workspace overlays", async () => {
  const [dialogSrc, appShellSrc] = await Promise.all([
    readFile(NEW_TAB_DIALOG_PATH, "utf8"),
    readFile(APP_SHELL_PATH, "utf8"),
  ]);

  // The overlays that gate the browser surface out of the render tree.
  assert.match(
    appShellSrc,
    /if \(projectView\) \{[\s\S]*?ProjectsOverlay/,
    "ShellMainArea should early-return ProjectsOverlay when projectView is set",
  );
  assert.match(
    appShellSrc,
    /if \(workspaceOverlay && selectedWorkspaceId\) \{/,
    "ShellMainArea should early-return the workspace overlay when set",
  );

  // The dialog must own setters for both overlay atoms.
  assert.match(dialogSrc, /useSetAtom\(projectViewAtom\)/);
  assert.match(dialogSrc, /useSetAtom\(workspaceOverlayAtom\)/);

  // revealBrowser must clear both overlays so <Center> can render the browser.
  assert.match(
    dialogSrc,
    /const revealBrowser = \(\) => \{[\s\S]*?setProjectView\(null\)[\s\S]*?setWorkspaceOverlay\(null\)[\s\S]*?\};/,
    "revealBrowser must clear projectView and workspaceOverlay",
  );
});

// useOpenWorkspaceOutput reveals the browser (openUrlInBrowserTab) and file
// (openFileInInternalTab) surfaces in <Center>, gated by the same overlays —
// both must dismiss them too.
test("workspace-output reveal paths dismiss project + workspace overlays", async () => {
  const src = await readFile(OPEN_OUTPUT_PATH, "utf8");

  assert.match(src, /useSetAtom\(projectViewAtom\)/);
  assert.match(src, /useSetAtom\(workspaceOverlayAtom\)/);

  // Both reveal paths (browser tab + internal file tab) clear the overlays.
  assert.ok(
    count(src, /setProjectView\(null\)/g) >= 2,
    "both reveal paths must clear projectView",
  );
  assert.ok(
    count(src, /setWorkspaceOverlay\(null\)/g) >= 2,
    "both reveal paths must clear workspaceOverlay",
  );
});
