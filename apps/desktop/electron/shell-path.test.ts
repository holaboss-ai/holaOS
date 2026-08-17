import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import {
  computeWindowsSupplementalPath,
  mergePathEntries,
} from "./shell-path";

const sep = path.delimiter;
// Windows uses ";" regardless of the host we run these on. Joining Windows
// paths with the host delimiter would split "C:\\Windows" at the drive letter,
// which is why these cases used to pass only on Windows — i.e. never in CI.
const winSep = ";";

test("adds shell-only dirs while keeping shell ordering first", () => {
  const shellPath = ["/Users/x/.local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin"].join(sep);
  const currentPath = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(sep);

  const merged = mergePathEntries(shellPath, currentPath).split(sep);

  // The native-installer dir the GUI process was missing is now present...
  assert.ok(merged.includes("/Users/x/.local/bin"));
  // ...and the shell's order leads.
  assert.deepEqual(merged.slice(0, 2), ["/Users/x/.local/bin", "/opt/homebrew/bin"]);
  // GUI-only dirs are preserved (appended, not dropped).
  assert.ok(merged.includes("/usr/sbin"));
  assert.ok(merged.includes("/sbin"));
});

test("dedupes overlapping entries", () => {
  const shellPath = ["/usr/bin", "/bin"].join(sep);
  const currentPath = ["/usr/bin", "/bin"].join(sep);

  const merged = mergePathEntries(shellPath, currentPath).split(sep);

  assert.deepEqual(merged, ["/usr/bin", "/bin"]);
});

test("ignores empty segments", () => {
  const merged = mergePathEntries(`${sep}/usr/bin${sep}`, `${sep}/bin${sep}`).split(sep);

  assert.deepEqual(merged, ["/usr/bin", "/bin"]);
});

test("appends existing Windows install dirs, current PATH first", () => {
  const current = ["C:\\Windows\\system32", "C:\\Windows"].join(winSep);
  const candidates = [
    "C:\\Users\\x\\.local\\bin", // exists (claude.exe)
    "C:\\Users\\x\\AppData\\Roaming\\npm", // exists (codex.cmd)
    "C:\\Users\\x\\.bun\\bin", // missing → must be skipped
  ];
  const exists = (dir: string) => dir !== "C:\\Users\\x\\.bun\\bin";

  const merged = computeWindowsSupplementalPath(
    current,
    candidates,
    exists,
    winSep,
  ).split(winSep);

  // Registry-inherited PATH still leads (system tools win).
  assert.deepEqual(merged.slice(0, 2), ["C:\\Windows\\system32", "C:\\Windows"]);
  // The install dirs that exist are appended…
  assert.ok(merged.includes("C:\\Users\\x\\.local\\bin"));
  assert.ok(merged.includes("C:\\Users\\x\\AppData\\Roaming\\npm"));
  // …and the missing one is never injected.
  assert.ok(!merged.includes("C:\\Users\\x\\.bun\\bin"));
});

test("Windows supplemental is a no-op when no candidate dir exists", () => {
  const current = ["C:\\Windows\\system32"].join(winSep);
  const merged = computeWindowsSupplementalPath(
    current,
    ["C:\\nope\\one", "C:\\nope\\two"],
    () => false,
    winSep,
  );
  assert.equal(merged, current);
});

test("Windows supplemental doesn't duplicate an already-present dir", () => {
  const local = "C:\\Users\\x\\.local\\bin";
  const current = ["C:\\Windows\\system32", local].join(winSep);
  const merged = computeWindowsSupplementalPath(
    current,
    [local],
    () => true,
    winSep,
  ).split(winSep);

  assert.equal(merged.filter((d) => d === local).length, 1);
});
