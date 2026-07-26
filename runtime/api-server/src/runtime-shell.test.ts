import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildPortListenerKillCommand,
  quoteShellValue,
  shellCommandInvocation,
  shellPathDelimiter,
} from "./runtime-shell.js";

test("shellCommandInvocation uses bash on POSIX", () => {
  const invocation = shellCommandInvocation("echo hello", "linux");

  assert.equal(invocation.command, "/bin/bash");
  assert.deepEqual(invocation.args, ["-lc", "echo hello"]);
  assert.equal(invocation.detached, true);
  assert.equal(invocation.shellKind, "posix");
});

test("shellCommandInvocation uses PowerShell on Windows", () => {
  const invocation = shellCommandInvocation("Write-Output hello", "win32");

  assert.equal(
    invocation.command,
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  );
  assert.deepEqual(invocation.args, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    "Write-Output hello",
  ]);
  assert.equal(invocation.detached, false);
  assert.equal(invocation.shellKind, "powershell");
});

test("quoteShellValue escapes POSIX single quotes", () => {
  assert.equal(quoteShellValue("it's working", "linux"), "'it'\\''s working'");
});

test("quoteShellValue escapes PowerShell single quotes", () => {
  assert.equal(quoteShellValue("it's working", "win32"), "'it''s working'");
});

test("shellPathDelimiter follows platform rules", () => {
  assert.equal(shellPathDelimiter("linux"), ":");
  assert.equal(shellPathDelimiter("win32"), ";");
});

test("buildPortListenerKillCommand emits POSIX lsof command", () => {
  assert.equal(
    buildPortListenerKillCommand([8080, 4100], "linux"),
    "kill $(lsof -nP -iTCP:8080 -sTCP:LISTEN -t 2>/dev/null) 2>/dev/null || true ; kill $(lsof -nP -iTCP:4100 -sTCP:LISTEN -t 2>/dev/null) 2>/dev/null || true",
  );
});

test("buildPortListenerKillCommand emits PowerShell port cleanup", () => {
  const command = buildPortListenerKillCommand([8080, 4100], "win32");

  assert.match(command, /\$ports = @\(8080, 4100\);/);
  assert.match(command, /Get-NetTCPConnection -LocalPort \$port/);
  assert.match(command, /Stop-Process -Id \$_ -Force/);
});
