import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const MAIN_PATH = new URL("./main.ts", import.meta.url);

test("macOS main window keeps traffic lights aligned with the compact title bar", async () => {
  const source = await readFile(MAIN_PATH, "utf8");

  assert.match(source, /titleBarStyle: "hiddenInset",/);
  // Lights are centered in the 40px (h-10) top band: (40 - 12) / 2 = 14.
  assert.match(source, /trafficLightPosition: \{ x: 14, y: 14 \},/);
});
