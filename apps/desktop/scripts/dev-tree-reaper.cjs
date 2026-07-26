// Dev-only Windows teardown backstop. run-dev.mjs spawns this detached; it polls
// run-dev's pid and, once run-dev is gone — Ctrl+C, crash, or normal exit —
// reaps this checkout's leftover dev tree (Electron + tsup/esbuild/vite) and
// exits. Detached + SIGINT/SIGHUP no-ops so the same console Ctrl+C that fells
// the dev tree can't kill the reaper before it does its job.
//
// Why separate from dev-electron-watchdog.cjs: that watchdog only runs inside
// Electron (process.type === "browser"), so it can only quit Electron. The build
// watchers live in another subtree with no watchdog, and run-dev's own SIGINT
// handler is unreliable on Windows (killed before it runs) and races
// concurrently's death (its children reparent, so a PID tree-walk misses them).
// A detached, checkout-scoped reaper closes that gap.
const { reapDevTree } = require("./dev-tree-kill.cjs");

if (process.platform !== "win32") process.exit(0);

const watchPid = Number(process.env.HB_DEV_WATCH_PID);
const checkoutRoot = process.env.HB_DEV_CHECKOUT_ROOT || "";
if (!Number.isInteger(watchPid) || watchPid <= 0 || !checkoutRoot) process.exit(0);

// A console Ctrl+C ends the dev session — that's our trigger, not our death.
process.on("SIGINT", () => {});
process.on("SIGHUP", () => {});

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = gone; EPERM = alive but not ours (still alive).
    return Boolean(err && err.code === "EPERM");
  }
};

const timer = setInterval(() => {
  if (isAlive(watchPid)) return;
  clearInterval(timer);
  reapDevTree(checkoutRoot);
  process.exit(0);
}, 750);
