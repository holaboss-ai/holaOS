// Single entrypoint for `bun run dev`. Two jobs:
//
//   1. Wipe the terminal (viewport + scrollback) so the predev /
//      prepare-runtime output stops squatting at the top forever.
//   2. Hand off to `concurrently`, inheriting stdio so its prefixed
//      output goes straight to the user's terminal.
//
// Why a wrapper instead of `node clear.mjs && concurrently ...` directly
// in the npm script: bun's pretty script runner can render a chained
// command as a single "$ concurrently …" header — depending on bun
// version + terminal — making it look like the clear step didn't run.
// Funnelling through ONE script gives us deterministic behavior
// regardless of how the parent script runner formats its prefixes.

import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// CSI sequences supported by every terminal we ship against (iTerm2,
// macOS Terminal, Warp, VS Code/Cursor integrated terminals, GNOME
// Terminal, Windows Terminal). 2J = viewport, 3J = scrollback, H = home.
process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
process.stdout.write(
  "[Holaboss] dev runtime starting — predev finished, logs below are live.\n\n",
);

// Resolve concurrently's JS entry from its own manifest and run it directly
// with Node — no platform-specific bin shim. This sidesteps two Windows
// failures: (1) since CVE-2024-27980, Node's spawn refuses to launch a
// .cmd/.bat without shell:true (throws EINVAL), and (2) a bun-installed .bin
// exposes .exe/.bunx shims, not the .cmd this script used to assume — so the
// old path didn't even exist. createRequire also resolves bun's hoisted
// (.bun/…) store layout transparently.
const require = createRequire(import.meta.url);
const concurrentlyPkg = require("concurrently/package.json");
const concurrentlyBinRel =
  typeof concurrentlyPkg.bin === "string"
    ? concurrentlyPkg.bin
    : concurrentlyPkg.bin.concurrently;
const concurrentlyEntry = resolve(
  dirname(require.resolve("concurrently/package.json")),
  concurrentlyBinRel,
);

// This checkout's script dir + absolute root. Used to (1) locate the dev
// watchdog + reaper and (2) scope Windows teardown to THIS checkout only —
// every dev process's command line or exe path carries this root.
const scriptDir = dirname(fileURLToPath(import.meta.url));
const checkoutRoot = resolve(scriptDir, "..", "..", "..");
const { reapDevTree } = require("./dev-tree-kill.cjs");

// `dev:runtime:watch` rebuilds runtime/ and syncs the bundle into the staged
// runtime on every change — handy while editing runtime source, but it writes
// into directories that tsup + electronmon watch. That feedback loop has
// repeatedly spun up a rebuild→restart storm: Electron instances orphan
// (PPID 1) instead of dying, helpers pile up by the dozen, and CPU/RAM blow up.
// So it's opt-in now. Plain `bun run dev` uses the staged runtime from
// predev/prepare-runtime as-is; set WATCH_RUNTIME=1 only when you're actually
// changing runtime/ and want live re-sync.
const watchRuntime = /^(1|true|yes|on)$/i.test(process.env.WATCH_RUNTIME ?? "");

if (watchRuntime) {
  process.stdout.write(
    "[Holaboss] WATCH_RUNTIME=1 — live-syncing runtime/ on change (heavier; can loop).\n\n",
  );
} else {
  process.stdout.write(
    "[Holaboss] runtime watch OFF — using the staged runtime. Set WATCH_RUNTIME=1 to live-sync runtime/ edits.\n\n",
  );
}

const args = [
  "-k",
  "npm:dev:renderer",
  "npm:dev:electron:build",
  ...(watchRuntime ? ["npm:dev:runtime:watch"] : []),
  "npm:dev:electron:run",
];

// On Windows, Ctrl+C on `bun dev` kills run-dev before its SIGINT handler runs,
// and electronmon orphans electron.exe — so signal-based teardown from here can't
// be trusted (the terminal returns but the app window stays open). Preload a
// watchdog INTO the electron main process via NODE_OPTIONS=--require (Electron
// honors it in dev, verified) that force-quits the app once THIS run-dev process
// is gone — i.e. the instant the dev session ends, by any means. NODE_OPTIONS
// propagates through concurrently -> electronmon -> electron; the watchdog no-ops
// in every process except the Electron main (process.type === "browser").
const childEnv = { ...process.env };
if (process.platform === "win32") {
  const watchdog = resolve(scriptDir, "dev-electron-watchdog.cjs").replace(
    /\\/g,
    "/",
  );
  const prior = process.env.NODE_OPTIONS ? `${process.env.NODE_OPTIONS} ` : "";
  childEnv.NODE_OPTIONS = `${prior}--require=${watchdog}`;
  childEnv.HB_DEV_WATCH_PID = String(process.pid);
}

const child = spawn(process.execPath, [concurrentlyEntry, ...args], {
  stdio: "inherit",
  shell: false,
  env: childEnv,
});

// Windows backstop: a detached reaper that outlives run-dev and, the instant
// run-dev's pid is gone (Ctrl+C, crash, normal exit), kills any leftover dev
// processes for THIS checkout — the tsup/esbuild/vite watchers a console Ctrl+C
// orphans (and that the SIGINT handler below races and misses). Detached so the
// same Ctrl+C can't take the reaper down before it runs.
if (process.platform === "win32") {
  const reaper = spawn(
    process.execPath,
    [resolve(scriptDir, "dev-tree-reaper.cjs")],
    {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        HB_DEV_WATCH_PID: String(process.pid),
        HB_DEV_CHECKOUT_ROOT: checkoutRoot,
      },
    },
  );
  reaper.unref();
}

// Windows has no process-group teardown, and on Ctrl+C electronmon tends to exit
// WITHOUT taking electron.exe with it, while concurrently's children (vite, tsup,
// esbuild) reparent instead of dying — so the terminal returns to a prompt but
// the app window and build watchers keep running. Teardown on win32:
//   1. taskkill /T the `concurrently` subtree (whatever is still parented there).
//   2. reapDevTree(): match THIS checkout's root in each process's command line
//      or exe path to kill anything already reparented out of that subtree —
//      electron plus the tsup/esbuild/vite watchers — which a PID tree-walk from
//      `concurrently` can't reach once its children have orphaned. Scoped to this
//      checkout so it never touches another Electron app or another checkout.
// This SIGINT handler is unreliable on Windows (Ctrl+C can fell run-dev before it
// runs), so the detached reaper spawned above is the real guarantee; this path
// just makes a clean Ctrl+C tear down instantly when it does run. POSIX
// propagates termination via the process group (macOS tears down cleanly), so it
// just forwards the signal.
let tearingDown = false;
function terminateChildTree(signal) {
  if (process.platform !== "win32") {
    if (!child.killed) child.kill(signal);
    return;
  }
  if (tearingDown) return;
  tearingDown = true;
  process.stderr.write("[Holaboss] stopping dev tree (electron + watchers)...\n");
  if (child.pid !== undefined && !child.killed) {
    const result = spawnSync(
      "taskkill",
      ["/pid", String(child.pid), "/T", "/F"],
      { stdio: "ignore" },
    );
    // Fall back to a best-effort direct kill only if taskkill couldn't run.
    if (result.error) {
      try {
        child.kill();
      } catch {
        // already gone
      }
    }
  }
  reapDevTree(checkoutRoot);
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => terminateChildTree(signal));
}

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
