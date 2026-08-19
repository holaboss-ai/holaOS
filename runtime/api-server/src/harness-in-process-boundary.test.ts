import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/**
 * The api-server ↔ harness-host boundary, pinned from the api-server side.
 *
 * ts-runner runs pi in-process by importing harness-host's built entry point
 * BY PATH and casting the result to a locally-declared interface. That cast is
 * necessary — declaring the package as a dependency is what caused the failure
 * below — but it also means TypeScript can no longer check that the two sides
 * agree. These tests are what replaces that lost checking.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const apiServerRoot = path.resolve(here, "..");
const runtimeRoot = path.resolve(apiServerRoot, "..");

test("api-server must not depend on harness-host", () => {
  // Declaring this dependency made bun copy harness-host's entire tree into
  // api-server/node_modules during runtime staging — a 14,734-file / 473MB
  // duplicate of a package already staged as a sibling. It doubled the packaged
  // file count and broke the signed macOS release with EMFILE, electron-builder
  // exhausting its file descriptors partway through signing.
  //
  // The dependency also runs the wrong way round: harness-host is downstream of
  // api-server's contracts, not upstream of them.
  const manifest = JSON.parse(
    fs.readFileSync(path.join(apiServerRoot, "package.json"), "utf8"),
  ) as Record<string, Record<string, string> | undefined>;

  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    assert.equal(
      manifest[field]?.["@holaboss/runtime-harness-host"],
      undefined,
      `@holaboss/runtime-harness-host must not be in ${field} — it is staged as a sibling and duplicating it broke the macOS release with EMFILE`,
    );
  }
});

test("the staging rewrite table does not reintroduce the duplicate", () => {
  // The rewrite table is what turns `workspace:*` into a real install during
  // runtime staging, so an entry here recreates the duplication even if
  // package.json is clean.
  const staging = fs.readFileSync(
    path.join(runtimeRoot, "deploy", "build_runtime_root.mjs"),
    "utf8",
  );
  const rewrites = staging.slice(
    staging.indexOf("WORKSPACE_SIBLING_REWRITES"),
    staging.indexOf("WORKSPACE_SIBLING_REWRITES") + 2000,
  );
  assert.ok(
    !rewrites.includes("@holaboss/runtime-harness-host"),
    "harness-host must not be rewritten into api-server's install",
  );
});

test("harness-host still exports the in-process contract ts-runner casts to", async () => {
  // ts-runner declares this shape locally (HarnessHostInProcessModule) and casts
  // the dynamic import to it. If harness-host renames the export or a result
  // field, the cast keeps compiling and the failure only shows up at runtime as
  // a turn that silently falls back to spawning — losing the whole in-process
  // win with nothing but a warning to say so. This asserts the two agree.
  const entry = path.join(runtimeRoot, "harness-host", "src", "index.ts");
  assert.ok(fs.existsSync(entry), `harness-host entry missing at ${entry}`);

  const module = (await import(entry)) as {
    runPiInProcess?: (params: Record<string, unknown>) => Promise<unknown>;
  };
  const runPiInProcess = module.runPiInProcess;
  assert.equal(
    typeof runPiInProcess,
    "function",
    "ts-runner destructures runPiInProcess from this module",
  );
  assert.ok(runPiInProcess);

  // Drive it with a stubbed pi, then assert every field ts-runner reads off the
  // result is actually present — the fields, not just the function name.
  const result = (await runPiInProcess({
    requestPayload: { session_id: "s", input_id: "i" },
    emitEvent: async () => {},
    deps: {
      runPi: async (
        request: unknown,
        deps: {
          emitEvent?: (
            request: unknown,
            sequence: number,
            eventType: string,
            payload: Record<string, unknown>,
          ) => void;
        },
      ) => {
        deps.emitEvent?.(request, 1, "output_delta", {});
        deps.emitEvent?.(request, 2, "run_completed", {});
        return 0;
      },
      defaultPiDeps: () => ({}),
    },
  })) as Record<string, unknown>;

  for (const field of [
    "exitCode",
    "stderr",
    "sawEvent",
    "terminalEmitted",
    "lastSequence",
    "harnessSpawnToFirstEventMs",
    "harnessSpawnToFirstTokenMs",
  ]) {
    assert.ok(
      field in result,
      `ts-runner reads result.${field}; harness-host no longer returns it`,
    );
  }
  assert.equal(result.terminalEmitted, true);
  assert.equal(result.exitCode, 0);
});
