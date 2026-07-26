import assert from "node:assert/strict";
import { test } from "node:test";

import {
  resolveWindowsCliInvocation,
  type WindowsInvocationDeps,
} from "./windows-cli-invocation.js";

const NPM = "C:\\Users\\x\\AppData\\Roaming\\npm";
const NODE = "C:\\Program Files\\nodejs\\node.exe";
const CODEX_JS = `${NPM}\\node_modules\\@openai\\codex\\bin\\codex.js`;

// Realistic npm-global shims: the `.cmd` and `.ps1` npm writes next to each
// other. Both reference the CLI entry relative to the shim dir (`%dp0%` /
// `$basedir`) — the exact strings the resolver must parse.
const CODEX_CMD_BODY = [
  "@ECHO off",
  "GOTO start",
  ":find_dp0",
  "SET dp0=%~dp0",
  "EXIT /b",
  ":start",
  "SETLOCAL",
  "CALL :find_dp0",
  "",
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ") ELSE (",
  '  SET "_prog=node"',
  "  SET PATHEXT=%PATHEXT:;.JS;=;%",
  ")",
  "",
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
].join("\n");

const CODEX_PS1_BODY = [
  "#!/usr/bin/env pwsh",
  "$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent",
  'if ($MyInvocation.ExpectingInput) {',
  '  $input | & "$basedir/node.exe"  "$basedir/node_modules/@openai/codex/bin/codex.js" $args',
  "} else {",
  '  & "$basedir/node.exe"  "$basedir/node_modules/@openai/codex/bin/codex.js" $args',
  "}",
].join("\n");

// A Windows deps builder whose `isFile` is satisfied by an explicit set of
// paths and whose `readFile` serves a map of shim contents. PATH holds the
// npm-global dir.
function winDeps(
  files: string[],
  shims: Record<string, string> = {},
  overrides: Partial<WindowsInvocationDeps> = {},
): WindowsInvocationDeps {
  // Model the Windows filesystem's case-insensitivity: PATHEXT is `.CMD`
  // (upper) while npm writes `codex.cmd` (lower), and real statSync matches
  // regardless — so the mock must too.
  const present = new Set(files.map((f) => f.toLowerCase()));
  const shimLower = new Map(
    Object.entries(shims).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    platform: "win32",
    pathEnv: "C:\\Windows\\system32;C:\\Users\\x\\AppData\\Roaming\\npm",
    pathExt: ".COM;.EXE;.BAT;.CMD",
    systemRoot: "C:\\Windows",
    nodeExe: NODE,
    isFile: (p) => present.has(p.toLowerCase()),
    readFile: (p) => shimLower.get(p.toLowerCase()) ?? "",
    ...overrides,
  };
}

test("non-Windows is always a passthrough", () => {
  const deps = winDeps(
    [`${NPM}\\codex.cmd`, CODEX_JS],
    { [`${NPM}\\codex.cmd`]: CODEX_CMD_BODY },
    { platform: "darwin" },
  );
  const out = resolveWindowsCliInvocation("codex", "codex", ["app-server"], deps);
  assert.deepEqual(out, { command: "codex", args: ["app-server"] });
});

test("rewrites a .cmd shim to `node <cli.js>`, args preserved", () => {
  const deps = winDeps([`${NPM}\\codex.cmd`, CODEX_JS], {
    [`${NPM}\\codex.cmd`]: CODEX_CMD_BODY,
  });
  const out = resolveWindowsCliInvocation(
    "codex",
    "codex",
    ["app-server", "--listen", "stdio://"],
    deps,
  );
  assert.equal(out.command, NODE);
  assert.deepEqual(out.args, [
    CODEX_JS,
    "app-server",
    "--listen",
    "stdio://",
  ]);
});

test("multi-line argv element survives the rewrite intact", () => {
  const deps = winDeps([`${NPM}\\codex.cmd`, CODEX_JS], {
    [`${NPM}\\codex.cmd`]: CODEX_CMD_BODY,
  });
  const multiline = "line one\nline two\nline three";
  const out = resolveWindowsCliInvocation(
    "codex",
    "codex",
    ["--append-system-prompt", multiline],
    deps,
  );
  assert.equal(out.command, NODE);
  // The newline-bearing argument is passed as a single discrete token — no
  // shell re-tokenisation.
  assert.deepEqual(out.args, [CODEX_JS, "--append-system-prompt", multiline]);
});

test("real .exe binary is a passthrough (claude)", () => {
  const claudeDir = "C:\\Users\\x\\.local\\bin";
  const deps = winDeps([`${claudeDir}\\claude.exe`], {}, {
    pathEnv: `C:\\Windows\\system32;${claudeDir}`,
  });
  const out = resolveWindowsCliInvocation("claude", "claude", ["-p"], deps);
  assert.deepEqual(out, { command: "claude", args: ["-p"] });
});

test("falls back to the sibling .ps1 when the .cmd has no JS reference", () => {
  const deps = winDeps([`${NPM}\\codex.cmd`, CODEX_JS], {
    // A `.cmd` we can't parse (no `.js` token), but a normal `.ps1` beside it.
    [`${NPM}\\codex.cmd`]: "@ECHO off\r\nnode %*\r\n",
    [`${NPM}\\codex.ps1`]: CODEX_PS1_BODY,
  });
  const out = resolveWindowsCliInvocation("codex", "codex", ["x"], deps);
  assert.equal(out.command, NODE);
  assert.deepEqual(out.args, [CODEX_JS, "x"]);
});

test(".cmd whose extracted entry is missing on disk → passthrough", () => {
  // Shim references codex.js but the file isn't present (isFile excludes it).
  const deps = winDeps([`${NPM}\\codex.cmd`], {
    [`${NPM}\\codex.cmd`]: CODEX_CMD_BODY,
  });
  const out = resolveWindowsCliInvocation("codex", "codex", ["x"], deps);
  assert.deepEqual(out, { command: "codex", args: ["x"] });
});

test("unrecognisable shim (no JS, no sibling ps1) → passthrough", () => {
  const deps = winDeps([`${NPM}\\codex.cmd`], {
    [`${NPM}\\codex.cmd`]: "@ECHO off\r\nsome-native-thing %*\r\n",
  });
  const out = resolveWindowsCliInvocation("codex", "codex", ["x"], deps);
  assert.deepEqual(out, { command: "codex", args: ["x"] });
});

test("unresolvable command → passthrough with the original name", () => {
  const deps = winDeps([]); // codex not installed at all
  const out = resolveWindowsCliInvocation("codex", "codex", ["x"], deps);
  assert.deepEqual(out, { command: "codex", args: ["x"] });
});

test("an operator-pinned absolute .cmd path is also rewritten", () => {
  const pinnedDir = "C:\\tools\\codex";
  const pinned = `${pinnedDir}\\codex.cmd`;
  const pinnedJs = `${pinnedDir}\\node_modules\\@openai\\codex\\bin\\codex.js`;
  const deps = winDeps([pinned, pinnedJs], {
    [pinned]: [
      "@ECHO off",
      'title %COMSPEC% & "%dp0%\\node.exe"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
    ].join("\n"),
  });
  const out = resolveWindowsCliInvocation("codex", pinned, ["app-server"], deps);
  assert.equal(out.command, NODE);
  assert.deepEqual(out.args, [pinnedJs, "app-server"]);
});
