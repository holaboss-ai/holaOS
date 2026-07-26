// Dev-mode runtime hot reload.
//
// Previous behaviour: any TS edit triggered prepare:runtime:local
// (~47s rebuild + restage of Python + node + pruning 50k+ files) and
// then touched out/dist-electron/main.cjs so electronmon would tear down
// Electron. That wiped the session cookie and forced a fresh sign-in for
// every save.
//
// New behaviour:
//   1. Trust predev's one-time prepare:runtime:local to have produced the
//      staged bundle at apps/desktop/out/runtime-macos.
//   2. Spawn `tsup --watch` for each runtime package (api-server,
//      state-store, harness-host). Incremental rebuilds land in
//      runtime/{pkg}/dist in ~200-800ms.
//   3. Watch each source-tree dist and SYNC the changed files into the
//      staged bundle's matching dist directory. We sync rather than
//      symlink because the runtime is loaded by the bundled node-runtime
//      (ABI 137) and resolves native modules (better-sqlite3) through
//      the *staged* node_modules; symlinking the dist makes Node walk up
//      into repo-root node_modules which is built for the Electron ABI
//      (145) and therefore incompatible.
//   4. Electron has its own fs.watch on the staged dist files and will
//      restart only the runtime child on change. Electron main stays up,
//      so the dev session cookie and renderer state are preserved.

import { existsSync, watch as fsWatch } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import { resolveRuntimeBundleState } from "./runtime-bundle-state.mjs";

const desktopRoot = process.cwd();
const runtimeBundleState = resolveRuntimeBundleState(desktopRoot);

const RUNTIME_PACKAGES = ["api-server", "state-store", "harness-host"];
const SYNC_DEBOUNCE_MS = 150;

function logLine(message) {
  console.log(`[watch-runtime-bundle] ${message}`);
}

function sourceDistDir(packageName) {
  return path.join(
    runtimeBundleState.repoRoot,
    "runtime",
    packageName,
    "dist",
  );
}

function stagedDistDir(packageName) {
  return path.join(
    runtimeBundleState.runtimeRoot,
    "runtime",
    packageName,
    "dist",
  );
}

async function ensureDirsExist(packageName) {
  const sourceDist = sourceDistDir(packageName);
  if (!existsSync(sourceDist)) {
    await fs.mkdir(sourceDist, { recursive: true });
  }
  const stagedDist = stagedDistDir(packageName);
  // If a previous run left a symlink there (from the symlink-based design
  // we briefly shipped), unlink it so the directory becomes a real one we
  // can sync files into.
  const stat = await fs.lstat(stagedDist).catch(() => null);
  if (stat?.isSymbolicLink()) {
    await fs.unlink(stagedDist);
  }
  if (!existsSync(stagedDist)) {
    await fs.mkdir(stagedDist, { recursive: true });
  }
}

async function syncPackageDist(packageName) {
  const sourceDist = sourceDistDir(packageName);
  const stagedDist = stagedDistDir(packageName);
  if (!existsSync(sourceDist)) {
    return false;
  }
  // fs.cp with recursive + force overwrites in place and is the cheapest
  // safe way to mirror a small (~16 MB total across packages) directory.
  await fs.cp(sourceDist, stagedDist, {
    recursive: true,
    force: true,
    preserveTimestamps: false,
  });
  return true;
}

function spawnTsupWatch(packageName) {
  const packageDir = path.join(
    runtimeBundleState.repoRoot,
    "runtime",
    packageName,
  );
  const child = spawn("npx", ["tsup", "--watch"], {
    cwd: packageDir,
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, FORCE_COLOR: "1" },
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      logLine(`tsup --watch (${packageName}) exited via signal ${signal}`);
      return;
    }
    if (code !== 0 && code !== null) {
      logLine(`tsup --watch (${packageName}) exited with code ${code}`);
    }
  });
  return child;
}

function setupWatcher(packageName) {
  const sourceDist = sourceDistDir(packageName);
  let pending = null;
  const watcher = fsWatch(sourceDist, async (eventType, filename) => {
    if (!filename) return;
    if (
      !filename.endsWith(".mjs") &&
      !filename.endsWith(".cjs") &&
      !filename.endsWith(".js")
    ) {
      return;
    }
    if (pending) clearTimeout(pending);
    pending = setTimeout(async () => {
      pending = null;
      try {
        const ok = await syncPackageDist(packageName);
        if (ok) {
          logLine(`synced ${packageName}/dist -> staged`);
        }
      } catch (err) {
        logLine(`sync failed for ${packageName}: ${err?.message ?? err}`);
      }
    }, SYNC_DEBOUNCE_MS);
  });
  watcher.on("error", (err) => {
    logLine(`watcher error for ${packageName}: ${err?.message ?? err}`);
  });
  return watcher;
}

async function main() {
  if (!existsSync(runtimeBundleState.runtimeRoot)) {
    console.error(
      "[watch-runtime-bundle] staged runtime bundle does not exist at",
      runtimeBundleState.runtimeRoot,
    );
    console.error(
      "[watch-runtime-bundle] run `npm run prepare:runtime:local` first (predev should normally do this).",
    );
    process.exit(1);
  }

  for (const packageName of RUNTIME_PACKAGES) {
    await ensureDirsExist(packageName);
  }

  // Sync the current state-of-source-tree dist into staged once so we
  // start from a coherent baseline. (tsup --watch will replace these
  // files on its first emit anyway, but if a previous run produced fresh
  // dist files that haven't been synced yet, this restores them.)
  for (const packageName of RUNTIME_PACKAGES) {
    try {
      await syncPackageDist(packageName);
    } catch (err) {
      logLine(
        `initial sync failed for ${packageName}: ${err?.message ?? err}`,
      );
    }
  }

  const tsupChildren = RUNTIME_PACKAGES.map(spawnTsupWatch);
  const watchers = RUNTIME_PACKAGES.map(setupWatcher);

  const shutdown = (signal) => {
    logLine(`received ${signal}, stopping tsup watchers...`);
    for (const watcher of watchers) {
      try {
        watcher.close();
      } catch {
        // best-effort
      }
    }
    for (const child of tsupChildren) {
      try {
        child.kill("SIGTERM");
      } catch {
        // best-effort
      }
    }
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("exit", () => shutdown("exit"));

  logLine(
    `tsup --watch + dist sync running for ${RUNTIME_PACKAGES.length} runtime packages.`,
  );
}

main().catch((err) => {
  console.error("[watch-runtime-bundle] fatal", err);
  process.exit(1);
});
