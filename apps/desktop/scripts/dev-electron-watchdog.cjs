// Dev-only teardown safety net for Windows, preloaded into Electron's main
// process via NODE_OPTIONS=--require (set by run-dev.mjs).
//
// Why it exists: on Windows, Ctrl+C on `bun dev` kills run-dev.mjs (and the
// concurrently subtree) before run-dev's own SIGINT handler can run, and
// electronmon exits WITHOUT taking electron.exe with it — so the terminal
// returns to a prompt but the app window keeps running. Signal-based teardown in
// run-dev can't be relied on. This runs INSIDE Electron (which is the process
// that survives), watches the run-dev pid, and force-quits the app once run-dev
// is gone — i.e. the moment the dev session ends, by whatever means.
//
// Loaded into every dev node process (vite, tsup, electronmon, electron), so it
// must no-op everywhere except the Electron main process, and never interfere on
// a normal running session.

if (process.type === "browser") {
  const watchPid = Number(process.env.HB_DEV_WATCH_PID);
  if (Number.isInteger(watchPid) && watchPid > 0) {
    const isAlive = (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (err) {
        // ESRCH = gone; EPERM = alive but not ours (still alive).
        return err && err.code === "EPERM";
      }
    };
    const timer = setInterval(() => {
      if (isAlive(watchPid)) return;
      clearInterval(timer);
      // Force-quit (not cancellable, unlike app.quit()); hard-exit as a backstop.
      try {
        require("electron").app.exit(0);
      } catch (_err) {
        /* fall through */
      }
      setTimeout(() => process.exit(0), 500).unref();
    }, 750);
    // Don't keep the app alive just for this poller.
    timer.unref();
  }
}
