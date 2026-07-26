import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import { wrapBashToolForWindowsCommandLimit } from "./pi.js";

// A stand-in for the SDK bash tool that records exactly the command the real
// tool would spawn. When the wrapper has rewritten an oversized command to a
// temp-script run (`bash '<path>'`), it also reads that script back so tests can
// assert the full command survived (the wrapper deletes it in a finally, so the
// read must happen inside execute, before cleanup).
function captureBashTool() {
  return {
    name: "bash",
    execute: async (
      _toolCallId: string,
      params: { command: string; timeout?: number },
    ) => {
      const match = /^bash '(.+)'$/.exec(params.command);
      return {
        receivedCommand: params.command,
        scriptPath: match ? match[1]! : null,
        scriptContent: match ? readFileSync(match[1]!, "utf8") : null,
        content: [{ type: "text", text: "ok" }],
      };
    },
  };
}

test("oversized bash command is routed through a temp script, preserving the full command verbatim", async () => {
  const wrapped = wrapBashToolForWindowsCommandLimit(captureBashTool(), "win32");
  // ~12KB heredoc — the exact shape that was silently truncated at ~8191 chars.
  const bigCommand = `cat > out.md << 'EOF'\n${"x".repeat(12000)}\nEOF`;
  const res = (await wrapped.execute("call-1", { command: bigCommand, timeout: 5 })) as any;

  // The underlying tool must get a SHORT `bash '<file>'`, never the raw 12KB argv.
  assert.match(res.receivedCommand, /^bash '.+\.sh'$/);
  assert.ok(res.receivedCommand.length < 200, "rewritten command should be short");
  assert.ok(!res.receivedCommand.includes("\\"), "temp path must use forward slashes for bash");
  // Full command preserved on disk — no truncation.
  assert.equal(res.scriptContent, bigCommand);
  // Temp script cleaned up after the run.
  assert.equal(existsSync(res.scriptPath), false, "temp script should be removed after execution");
});

test("a sub-limit bash command passes through unchanged", async () => {
  const wrapped = wrapBashToolForWindowsCommandLimit(captureBashTool(), "win32");
  const res = (await wrapped.execute("call-2", { command: "echo hi" })) as any;
  assert.equal(res.receivedCommand, "echo hi");
  assert.equal(res.scriptContent, null);
});

test("the inline limit is env-configurable", async () => {
  const prev = process.env.HOLABOSS_WINDOWS_BASH_INLINE_LIMIT_BYTES;
  process.env.HOLABOSS_WINDOWS_BASH_INLINE_LIMIT_BYTES = "100";
  try {
    const wrapped = wrapBashToolForWindowsCommandLimit(captureBashTool(), "win32");
    const cmd = `echo ${"a".repeat(500)}`; // over 100, under the 6KB default
    const res = (await wrapped.execute("call-3", { command: cmd })) as any;
    assert.match(res.receivedCommand, /^bash '.+\.sh'$/);
    assert.equal(res.scriptContent, cmd);
  } finally {
    if (prev === undefined) delete process.env.HOLABOSS_WINDOWS_BASH_INLINE_LIMIT_BYTES;
    else process.env.HOLABOSS_WINDOWS_BASH_INLINE_LIMIT_BYTES = prev;
  }
});

test("wrapper is a no-op for non-bash tools", () => {
  const other = { name: "read", execute: async () => "x" };
  assert.equal(wrapBashToolForWindowsCommandLimit(other, "win32"), other);
});

test("wrapper is a no-op off Windows (bash command passes straight through)", async () => {
  const tool = captureBashTool();
  const wrapped = wrapBashToolForWindowsCommandLimit(tool, "linux");
  assert.equal(wrapped, tool, "off Windows the wrapper returns the tool unchanged");
  const big = `cat << 'EOF'\n${"x".repeat(12000)}\nEOF`;
  const res = (await wrapped.execute("call-4", { command: big })) as any;
  assert.equal(res.receivedCommand, big, "no rewrite off Windows");
});
