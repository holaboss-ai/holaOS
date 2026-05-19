import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");
const electronBuilderCli = path.join(
  desktopRoot,
  "node_modules",
  "electron-builder",
  "cli.js",
);
const electronBuilderConfigPath = path.join(desktopRoot, "electron-builder.config.cjs");

function inferRuntimePlatform(builderArgs) {
  if (builderArgs.includes("--mac")) {
    return "macos";
  }
  if (builderArgs.includes("--win")) {
    return "windows";
  }
  if (builderArgs.includes("--linux")) {
    return "linux";
  }
  return null;
}

function versionFromReleaseTag(releaseTag) {
  const trimmed = releaseTag?.trim();
  if (!trimmed) {
    return "";
  }

  const match = trimmed.match(/(\d+\.\d+\.\d+)$/);
  return match ? match[1] : "";
}

const explicitVersion = process.env.HOLABOSS_APP_VERSION?.trim() || "";
const releaseTagVersion = versionFromReleaseTag(process.env.HOLABOSS_RELEASE_TAG);
const buildVersion = explicitVersion || releaseTagVersion;
const cliArgs = process.argv.slice(2);
const builderArgs = [...cliArgs];
const inferredRuntimePlatform = process.env.HOLABOSS_RUNTIME_PLATFORM?.trim() || inferRuntimePlatform(builderArgs);

if (!builderArgs.includes("--config") && !builderArgs.some((arg) => arg.startsWith("--config="))) {
  builderArgs.unshift("--config", electronBuilderConfigPath);
}

if (buildVersion) {
  builderArgs.push(`-c.extraMetadata.version=${buildVersion}`);
  builderArgs.push(`-c.buildVersion=${buildVersion}`);
  process.stdout.write(`[electron-builder] using app version ${buildVersion}\n`);
}

const child = spawn(process.execPath, [electronBuilderCli, ...builderArgs], {
  cwd: desktopRoot,
  env: {
    ...process.env,
    ...(inferredRuntimePlatform ? { HOLABOSS_RUNTIME_PLATFORM: inferredRuntimePlatform } : {})
  },
  stdio: "inherit"
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
