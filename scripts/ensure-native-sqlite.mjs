// Ensures better-sqlite3's native binary matches the Node running the runtime
// tests. The desktop's `rebuild:native` compiles it for Electron's ABI; running
// the runtime tests under plain Node then fails with ERR_DLOPEN_FAILED. This
// rebuilds it for the current Node — but only when it's actually mismatched, so
// it's a near-instant no-op the rest of the time (incl. CI, where `bun install`
// already built it for Node).
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// better-sqlite3 is a dependency of the runtime packages, not of the root. Under
// bun's isolated install it's only resolvable from those packages, so try the
// invoking package (cwd) first, then the known consumers.
const resolveBases = [
  process.cwd(),
  path.join(repoRoot, "runtime", "state-store"),
  path.join(repoRoot, "runtime", "api-server"),
  repoRoot,
];

function findRequire() {
  for (const base of resolveBases) {
    try {
      const require = createRequire(path.join(base, "package.json"));
      require.resolve("better-sqlite3/package.json");
      return require;
    } catch {
      // try the next base
    }
  }
  return null;
}

const require = findRequire();
if (!require) {
  console.error(
    "[ensure-native-sqlite] could not resolve better-sqlite3 from any runtime package; skipping"
  );
  process.exit(0);
}

function loadsUnderCurrentNode() {
  try {
    const Database = require("better-sqlite3");
    new Database(":memory:").close();
    return true;
  } catch {
    return false;
  }
}

if (loadsUnderCurrentNode()) {
  process.exit(0);
}

const packageJsonPath = require.resolve("better-sqlite3/package.json");
const packageDir = path.dirname(packageJsonPath);
const nodeGyp = createRequire(packageJsonPath).resolve("node-gyp/bin/node-gyp.js");

console.log(
  `[ensure-native-sqlite] better-sqlite3 is not loadable under node ${process.version}; rebuilding…`
);
// Use this exact node binary so the addon targets the current ABI, regardless of
// what's on PATH (mise/nvm/bunx all resolve differently).
execFileSync(process.execPath, [nodeGyp, "rebuild", "--release"], {
  cwd: packageDir,
  stdio: "inherit",
});
console.log(`[ensure-native-sqlite] better-sqlite3 rebuilt for node ${process.version}`);
