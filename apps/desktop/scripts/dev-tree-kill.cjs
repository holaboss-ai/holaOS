// Kill THIS checkout's leftover dev processes on Windows — Electron plus the
// build watchers (tsup / esbuild / vite) that a console Ctrl+C orphans. Each
// candidate is matched by the checkout's absolute root appearing in its command
// line OR its executable path:
//   - esbuild.exe / vite.exe live under this checkout's node_modules → matched by
//     ExecutablePath.
//   - tsup / vite (node) / electron carry the checkout path on their command line.
// So the sweep is strictly scoped to this checkout and never touches another
// checkout or another Electron app. `taskkill /T` takes each process's child
// subtree too (so killing a watcher's `npm run` parent isn't needed — npm exits
// once its script child dies).
//
// Shared by run-dev.mjs (its SIGINT-handler fast path) and dev-tree-reaper.cjs
// (a detached backstop that reaps even when the SIGINT handler never runs).
const { spawnSync } = require("node:child_process");

function reapDevTree(checkoutRoot, excludePid) {
  if (process.platform !== "win32") return;
  const root = String(checkoutRoot || "").replace(/\\/g, "/").toLowerCase();
  if (!root) return;
  // PowerShell 5.1-safe: string methods only (no ternary/??). `.Contains` keeps
  // backslash paths regex-free; both sides are slash-normalized + lowercased.
  const psCommand = [
    "Get-CimInstance Win32_Process |",
    "Where-Object {",
    "@('electron.exe','node.exe','vite.exe','esbuild.exe') -contains $_.Name -and",
    '"$($_.ProcessId)" -ne $env:HB_DEV_REAP_SELF -and',
    "( ($_.CommandLine -and $_.CommandLine.Replace('\\','/').ToLower().Contains($env:HB_DEV_CHECKOUT_ROOT))",
    "-or ($_.ExecutablePath -and $_.ExecutablePath.Replace('\\','/').ToLower().Contains($env:HB_DEV_CHECKOUT_ROOT)) ) -and",
    "-not ($_.CommandLine -and ($_.CommandLine.Contains('dev-tree-reaper')",
    "-or $_.CommandLine.Contains('run-dev.mjs') -or $_.CommandLine.Contains('hola.mts')))",
    "} |",
    "ForEach-Object { & taskkill /PID $_.ProcessId /T /F *> $null };",
    "exit 0",
  ].join(" ");
  spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", psCommand], {
    stdio: "ignore",
    env: {
      ...process.env,
      HB_DEV_CHECKOUT_ROOT: root,
      HB_DEV_REAP_SELF: String(excludePid || process.pid),
    },
  });
}

module.exports = { reapDevTree };
