import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function isNodeScript(execPath) {
  const extension = path.extname(execPath).toLowerCase();
  return extension === ".js" || extension === ".cjs" || extension === ".mjs";
}

// Resolve npm's CLI entry relative to the node binary running this script, so we
// can invoke it as `node npm-cli.js ...` without relying on `npm` being on PATH.
// Version managers (mise, nvm, fnm) and Electron often leave PATH without npm in
// nested spawns, which otherwise surfaces as `spawn npm ENOENT`.
function resolveNpmCliPath() {
  const npmExecPath = process.env.npm_execpath?.trim();
  if (npmExecPath && fs.existsSync(npmExecPath) && isNodeScript(npmExecPath)) {
    return npmExecPath;
  }

  const execDir = path.dirname(process.execPath);
  const candidates = [
    // Windows / portable node: bin/node + bin/node_modules/npm
    path.join(execDir, "node_modules", "npm", "bin", "npm-cli.js"),
    // Unix layout: <prefix>/bin/node + <prefix>/lib/node_modules/npm
    path.join(execDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(execDir, "..", "..", "npm", "bin", "npm-cli.js"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function npmInvocation() {
  const npmCliPath = resolveNpmCliPath();
  if (npmCliPath) {
    return { command: process.execPath, argsPrefix: [npmCliPath] };
  }

  if (process.platform === "win32") {
    return {
      command: process.env.ComSpec || "cmd.exe",
      argsPrefix: ["/d", "/s", "/c", "npm.cmd"],
    };
  }

  return { command: "npm", argsPrefix: [] };
}

export function runNpm(args, options = {}) {
  const { command, argsPrefix } = npmInvocation();
  const result = spawnSync(command, [...argsPrefix, ...args], options);

  if (result.error) {
    console.error(
      `[npm-runner] failed to spawn ${command}: ${result.error.message}`,
    );
  }

  if (result.signal) {
    console.error(`[npm-runner] npm exited because of signal ${result.signal}`);
  }

  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }
}
