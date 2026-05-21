import { existsSync } from "node:fs";
import { utimes } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import {
  newestExistingMtime,
  resolveRuntimeBundleState,
} from "./runtime-bundle-state.mjs";

const desktopRoot = process.cwd();
const runtimeBundleState = resolveRuntimeBundleState(desktopRoot);
const ensureRuntimeBundlePath = path.join(
  desktopRoot,
  "scripts",
  "ensure-runtime-bundle.mjs",
);
const electronMainOutputPath = path.join(
  desktopRoot,
  "out",
  "dist-electron",
  "main.cjs",
);
// 1s poll was thrashing — a single ts edit fires several mtime updates
// (editor write + lint format + IDE autosave + git mark) and each one
// would individually kick off the 100+ second runtime rebuild + Electron
// restart cycle, leaving the renderer in a reconnect loop. Slower poll +
// a quiescence window means we wait for the source tree to stop moving
// before we start a rebuild.
const pollIntervalMs = 2000;
const quiescenceWindowMs = 2500;

let lastObservedSourceStamp = await newestExistingMtime(
  runtimeBundleState.runtimeSourceInputs,
);
let rebuildInFlight = false;
let rebuildQueued = false;

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function runEnsureRuntimeBundle() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ensureRuntimeBundlePath], {
      cwd: desktopRoot,
      stdio: "inherit",
      env: process.env,
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if ((code ?? 1) === 0) {
        resolve();
        return;
      }
      reject(new Error(`ensure-runtime-bundle exited with code ${code ?? 1}`));
    });
  });
}

async function touchElectronMainOutput() {
  if (!existsSync(electronMainOutputPath)) {
    return;
  }
  const now = new Date();
  await utimes(electronMainOutputPath, now, now);
  console.log(
    "[watch-runtime-bundle] touched out/dist-electron/main.cjs to restart Electron.",
  );
}

async function rebuildRuntimeBundle(reason) {
  if (rebuildInFlight) {
    rebuildQueued = true;
    return;
  }

  rebuildInFlight = true;
  try {
    console.log(`[watch-runtime-bundle] ${reason}`);
    await runEnsureRuntimeBundle();
    await touchElectronMainOutput();
  } finally {
    rebuildInFlight = false;
  }

  if (rebuildQueued) {
    rebuildQueued = false;
    lastObservedSourceStamp = await newestExistingMtime(
      runtimeBundleState.runtimeSourceInputs,
    );
    await rebuildRuntimeBundle("applying queued runtime bundle changes.");
  }
}

// Hold a candidate stamp until the source tree has been quiet for at
// least `quiescenceWindowMs`. Only then do we rebuild. This collapses
// bursts of saves (run prettier on save, lint autofix, etc.) into a
// single rebuild and stops the cascade that wedged Electron.
let pendingSourceStamp = lastObservedSourceStamp;
let pendingObservedAt = 0;

while (true) {
  await delay(pollIntervalMs);
  const nextSourceStamp = await newestExistingMtime(
    runtimeBundleState.runtimeSourceInputs,
  );
  if (nextSourceStamp <= lastObservedSourceStamp) {
    continue;
  }
  if (nextSourceStamp !== pendingSourceStamp) {
    pendingSourceStamp = nextSourceStamp;
    pendingObservedAt = Date.now();
    continue;
  }
  if (Date.now() - pendingObservedAt < quiescenceWindowMs) {
    continue;
  }

  lastObservedSourceStamp = pendingSourceStamp;
  await rebuildRuntimeBundle(
    "runtime sources settled; rebuilding the staged runtime bundle.",
  );
}
