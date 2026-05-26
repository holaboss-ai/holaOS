import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function isNodeScript(execPath) {
  const extension = path.extname(execPath).toLowerCase();
  return extension === ".js" || extension === ".cjs" || extension === ".mjs";
}

function resolveWindowsNpmCliPath() {
  const npmExecPath = process.env.npm_execpath?.trim();
  if (npmExecPath && fs.existsSync(npmExecPath) && isNodeScript(npmExecPath)) {
    return npmExecPath;
  }

  const bundledCliPath = path.join(
    path.dirname(process.execPath),
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  );
  if (fs.existsSync(bundledCliPath)) {
    return bundledCliPath;
  }

  const siblingCliPath = path.join(
    path.dirname(process.execPath),
    "..",
    "..",
    "npm",
    "bin",
    "npm-cli.js",
  );
  if (fs.existsSync(siblingCliPath)) {
    return siblingCliPath;
  }

  return null;
}

function npmInvocation() {
  if (process.platform === "win32") {
    const npmCliPath = resolveWindowsNpmCliPath();
    if (npmCliPath) {
      return {
        command: process.execPath,
        argsPrefix: [npmCliPath]
      };
    }

    return {
      command: process.env.ComSpec || "cmd.exe",
      argsPrefix: ["/d", "/s", "/c", "npm.cmd"]
    };
  }

  return {
    command: "npm",
    argsPrefix: []
  };
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
