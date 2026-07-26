import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const CONTROLS_PATH = new URL("./WindowsTitlebarControls.tsx", import.meta.url);
const APP_PATH = new URL("../../App.tsx", import.meta.url);

test("WindowsTitlebarControls is Windows-gated and portaled to the window's top-right", async () => {
  const source = await readFile(CONTROLS_PATH, "utf8");

  // Gated on the platform so it can be mounted unconditionally (no-op off win32).
  assert.match(source, /import \{ isWindowsDesktop \} from "@\/lib\/windowControls";/);
  assert.match(source, /if \(!isWindows\) return null;/);

  // Portaled to document.body with fixed positioning so it survives any
  // screen's layout / transformed ancestors and always pins to the top-right.
  assert.match(source, /createPortal\(/);
  assert.match(source, /document\.body,\s*\)/);
  assert.match(source, /className="window-drag fixed top-0 right-0 z-\[60\]/);

  // Wired to the real window IPC.
  assert.match(source, /window\.electronAPI\.ui\.getWindowState\(\)/);
  assert.match(source, /window\.electronAPI\.ui\.onWindowStateChange/);
  assert.match(source, /window\.electronAPI\.ui\.minimizeWindow\(\)/);
  assert.match(source, /window\.electronAPI\.ui\.toggleWindowSize\(\)/);
  assert.match(source, /window\.electronAPI\.ui\.closeWindow\(\)/);
  assert.match(source, /aria-label="Minimize window"/);
  assert.match(source, /aria-label="Close window"/);
});

test("App mounts the window controls outside RequireAuth so pre-auth screens have them", async () => {
  const source = await readFile(APP_PATH, "utf8");

  assert.match(
    source,
    /import \{ WindowsTitlebarControls \} from "@\/components\/layout\/WindowsTitlebarControls";/,
  );
  // Rendered before RequireAuth: the boot splash and sign-in gate get controls.
  assert.match(source, /<WindowsTitlebarControls \/>\s*<RequireAuth>/);
});
