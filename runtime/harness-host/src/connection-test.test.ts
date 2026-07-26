import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

const INDEX_ENTRY = fileURLToPath(new URL("./index.ts", import.meta.url));

/** Run `harness-host test-connection …` and return the parsed verdict line. */
function runTestConnection(
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<{ ok: boolean; detail: string; duration_ms: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [...process.execArgv, INDEX_ENTRY, "test-connection", ...args],
      { env: { ...process.env, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.on("error", reject);
    child.on("close", () => {
      const line = stdout
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .at(-1);
      try {
        resolve(JSON.parse(line ?? "") as { ok: boolean; detail: string; duration_ms: number });
      } catch {
        reject(new Error(`no verdict JSON in output: ${stdout}`));
      }
    });
  });
}

test("test-connection reports a clean failure when the agent binary can't launch", async () => {
  // Force a non-existent binary so the run fails with ENOENT regardless of
  // which CLIs happen to be installed — deterministic across machines/CI.
  const result = await runTestConnection(
    ["--harness", "codex", "--timeout-ms", "8000"],
    { HOLABOSS_CODEX_PATH: "/nonexistent/holaboss-codex-xyz" },
  );
  assert.equal(result.ok, false);
  assert.equal(typeof result.detail, "string");
  assert.ok(result.detail.length > 0);
  assert.equal(typeof result.duration_ms, "number");
});

test("test-connection rejects an unknown harness id", async () => {
  const result = await runTestConnection(["--harness", "not-a-harness"]);
  assert.equal(result.ok, false);
  assert.match(result.detail, /unknown harness/i);
});
