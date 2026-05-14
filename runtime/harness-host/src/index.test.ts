import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { runHarnessHostMain } from "./index.js";

function createQueuedWritable(calls: string[]): NodeJS.WritableStream {
  let tail = Promise.resolve();
  return {
    write(chunk: string | Uint8Array, cb?: (error?: Error | null) => void) {
      const text = String(chunk);
      calls.push(`write:${JSON.stringify(text)}`);
      tail = tail.then(
        () =>
          new Promise<void>((resolve) => {
            setImmediate(() => {
              calls.push(`flush:${JSON.stringify(text)}`);
              cb?.(null);
              resolve();
            });
          })
      );
      return false;
    }
  } as NodeJS.WritableStream;
}

test("runHarnessHostMain flushes terminal output before exiting successfully", async () => {
  const calls: string[] = [];
  const stream = createQueuedWritable(calls);
  const request = { instruction: "check session" };

  await runHarnessHostMain(["pi", "--request-base64", Buffer.from(JSON.stringify(request), "utf8").toString("base64")], {
    resolvePluginByCommand: () =>
      ({
        decodeRequestBase64: (encoded: string) => JSON.parse(Buffer.from(encoded, "base64").toString("utf8")),
        run: async () => {
          stream.write('{"event_type":"run_completed"}\n');
          return 0;
        }
      }) as never,
    stdout: stream,
    stderr: stream,
    exit: (code) => {
      calls.push(`exit:${code}`);
    }
  });

  assert.deepEqual(calls, [
    'write:"{\\"event_type\\":\\"run_completed\\"}\\n"',
    'write:""',
    'write:""',
    'flush:"{\\"event_type\\":\\"run_completed\\"}\\n"',
    'flush:""',
    'flush:""',
    "exit:0"
  ]);
});

test("runHarnessHostMain flushes error output before exiting with failure", async () => {
  const calls: string[] = [];
  const stream = createQueuedWritable(calls);

  await runHarnessHostMain(["pi", "--request-base64", Buffer.from("{}", "utf8").toString("base64")], {
    resolvePluginByCommand: () =>
      ({
        decodeRequestBase64: () => ({}),
        run: async () => {
          throw new Error("boom");
        }
      }) as never,
    stdout: stream,
    stderr: stream,
    exit: (code) => {
      calls.push(`exit:${code}`);
    }
  });

  assert.deepEqual(calls, [
    'write:"boom\\n"',
    'write:""',
    'write:""',
    'flush:"boom\\n"',
    'flush:""',
    'flush:""',
    "exit:1"
  ]);
});

test("runHarnessHostMain accepts request payloads over stdin", async () => {
  const calls: string[] = [];
  const stream = createQueuedWritable(calls);
  const request = { instruction: "stdin session" };
  const encodedRequest = Buffer.from(
    JSON.stringify(request),
    "utf8",
  ).toString("base64");

  await runHarnessHostMain(["pi", "--request-stdin"], {
    stdin: Readable.from([encodedRequest]),
    resolvePluginByCommand: () =>
      ({
        decodeRequestBase64: (encoded: string) =>
          JSON.parse(Buffer.from(encoded, "base64").toString("utf8")),
        run: async () => {
          stream.write('{"event_type":"run_completed"}\n');
          return 0;
        }
      }) as never,
    stdout: stream,
    stderr: stream,
    exit: (code) => {
      calls.push(`exit:${code}`);
    }
  });

  assert.deepEqual(calls, [
    'write:"{\\"event_type\\":\\"run_completed\\"}\\n"',
    'write:""',
    'write:""',
    'flush:"{\\"event_type\\":\\"run_completed\\"}\\n"',
    'flush:""',
    'flush:""',
    "exit:0"
  ]);
});
