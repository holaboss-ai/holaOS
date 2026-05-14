import { spawnSync } from "node:child_process";
import fs from "node:fs";

function npmInvocation() {
  if (process.platform === "win32") {
    const npmExecPath = process.env.npm_execpath?.trim();
    if (npmExecPath && fs.existsSync(npmExecPath)) {
      return {
        command: process.execPath,
        argsPrefix: [npmExecPath]
      };
    }

    return {
      command: "npm.cmd",
      argsPrefix: []
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
