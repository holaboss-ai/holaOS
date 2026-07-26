import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { installBenignStdioEpipeGuard } from "./stdio-epipe.js";

class FakeWritableStream extends EventEmitter {}

test("installBenignStdioEpipeGuard swallows EPIPE stream errors and installs once", () => {
  const stdout = new FakeWritableStream() as unknown as NodeJS.WritableStream;
  const stderr = new FakeWritableStream() as unknown as NodeJS.WritableStream;

  installBenignStdioEpipeGuard({ stdout, stderr });
  installBenignStdioEpipeGuard({ stdout, stderr });

  assert.equal((stdout as unknown as EventEmitter).listenerCount("error"), 1);
  assert.equal((stderr as unknown as EventEmitter).listenerCount("error"), 1);

  assert.doesNotThrow(() => {
    (stdout as unknown as EventEmitter).emit(
      "error",
      Object.assign(new Error("broken pipe"), { code: "EPIPE" }),
    );
  });
});

test("installBenignStdioEpipeGuard rethrows non-EPIPE stream errors", () => {
  const stdout = new FakeWritableStream() as unknown as NodeJS.WritableStream;
  installBenignStdioEpipeGuard({ stdout, stderr: null });

  assert.throws(() => {
    (stdout as unknown as EventEmitter).emit("error", new Error("boom"));
  }, /boom/);
});
