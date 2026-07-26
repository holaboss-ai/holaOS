import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  desktopRuntimeApiPortForUserDataPath,
  parseLauncherArgs,
  resolveDesktopUserDataPath,
  resolveStandaloneSandboxRoot,
  sanitizeInstanceName,
  standaloneRuntimeApiPortForSandboxRoot,
} from "./isolated-runtime-launchers.mjs";

test("sanitizeInstanceName normalizes whitespace and punctuation", () => {
  assert.equal(sanitizeInstanceName(" Feature Dev / Bugfix "), "feature-dev-bugfix");
  assert.equal(sanitizeInstanceName("memory_evals.v2"), "memory_evals.v2");
});

test("resolveDesktopUserDataPath and resolveStandaloneSandboxRoot stay under the provided home root", () => {
  const homeRoot = "/tmp/holaos";

  assert.equal(
    resolveDesktopUserDataPath("Feature Dev", homeRoot),
    path.join(homeRoot, "desktop", "feature-dev"),
  );
  assert.equal(
    resolveStandaloneSandboxRoot("Memory Evals", "evals", homeRoot),
    path.join(homeRoot, "evals", "memory-evals"),
  );
});

test("desktop runtime port derivation is stable per user-data path", () => {
  const userDataPath = "/tmp/holaos/desktop/feature-dev";

  assert.equal(
    desktopRuntimeApiPortForUserDataPath(userDataPath),
    desktopRuntimeApiPortForUserDataPath(userDataPath),
  );
  assert.notEqual(
    desktopRuntimeApiPortForUserDataPath("/tmp/holaos/desktop/feature-dev"),
    desktopRuntimeApiPortForUserDataPath("/tmp/holaos/desktop/bugfix-a"),
  );
});

test("standalone runtime port derivation is stable per sandbox root", () => {
  const sandboxRoot = "/tmp/holaos/evals/memory-evals";
  const port = standaloneRuntimeApiPortForSandboxRoot(sandboxRoot);

  assert.equal(port, standaloneRuntimeApiPortForSandboxRoot(sandboxRoot));
  assert.ok(port >= 42160);
  assert.ok(port < 44160);
});

test("parseLauncherArgs supports positional names and explicit overrides", () => {
  assert.deepEqual(parseLauncherArgs(["feature-dev"]), {
    defaultName: "",
    devServerUrl: "",
    help: false,
    name: "feature-dev",
    namespace: "",
    port: null,
    prepare: true,
    sandboxRoot: "",
    userDataPath: "",
  });

  assert.deepEqual(
    parseLauncherArgs([
      "--namespace",
      "evals",
      "--default-name=memory-evals",
      "--port",
      "43001",
      "--no-prepare",
    ]),
    {
      defaultName: "memory-evals",
      devServerUrl: "",
      help: false,
      name: "",
      namespace: "evals",
      port: 43001,
      prepare: false,
      sandboxRoot: "",
      userDataPath: "",
    },
  );
});
