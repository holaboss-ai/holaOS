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

function hasExplicitOutputDir(builderArgs) {
  return builderArgs.some(
    (arg) =>
      arg === "--config.directories.output" ||
      arg.startsWith("--config.directories.output=") ||
      arg.startsWith("-c.directories.output="),
  );
}

function isCiEnvironment(env) {
  return Boolean(env.CI?.trim() || env.GITHUB_ACTIONS?.trim());
}

function buildLocalWindowsOutputDir() {
  const timestamp = new Date().toISOString().replace(/[:]/g, "-").replace(/\.\d+Z$/, "Z");
  return path.join("out", `release-local-${timestamp}`);
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

if (
  process.platform === "win32" &&
  inferredRuntimePlatform === "windows" &&
  !isCiEnvironment(process.env) &&
  !hasExplicitOutputDir(builderArgs)
) {
  const localOutputDir = buildLocalWindowsOutputDir();
  builderArgs.push(`-c.directories.output=${localOutputDir}`);
  process.stdout.write(
    `[electron-builder] using fresh local Windows output directory ${localOutputDir}\n`,
  );
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
