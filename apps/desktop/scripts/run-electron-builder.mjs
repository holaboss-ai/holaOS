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

/**
 * Raise the open-file limit for electron-builder itself.
 *
 * Signing walks every file in the app bundle, and the staged runtime is tens of
 * thousands of files; on macOS the default soft limit is 256, and exceeding it
 * fails the build with `EMFILE: too many open files` on whichever file happened
 * to be next — a misleading error that looks like a problem with that file.
 *
 * The workflows already raise the limit, but they do it in the *prepare* step,
 * and `ulimit` does not survive into a later `run:` block — each step gets a
 * fresh shell, so the electron-builder step has always run at the default. It
 * belongs here instead: this wrapper is the one chokepoint every invocation
 * goes through (CI and local packaging alike), so the limit cannot drift away
 * from the command that needs it.
 *
 * `ulimit` is a shell builtin and Node exposes no setrlimit, so raising it means
 * going through a shell. `"$@"` keeps argv intact rather than re-quoting it, and
 * a failure to raise is non-fatal — the build then behaves exactly as it does
 * today rather than not running at all.
 *
 * It raises only, never lowers: developer machines are commonly configured well
 * above this floor (1048576 is typical on macOS), and setting the limit
 * unconditionally would *reduce* it on exactly the machines that needed no help.
 */
const OPEN_FILE_LIMIT = 65536;
// Moves the SOFT limit only, clamped to the hard limit. `ulimit -n` without a
// flag sets soft *and* hard, and lowering the hard limit is irreversible for a
// non-root process — so a plain `ulimit -n` here could leave the build worse off
// than it started. Raising the soft limit toward hard is always permitted.
const RAISE_OPEN_FILE_LIMIT = [
  `soft="$(ulimit -Sn)"`,
  `hard="$(ulimit -Hn)"`,
  `target=${OPEN_FILE_LIMIT}`,
  `if [ "$hard" != "unlimited" ] && [ "$hard" -lt "$target" ] 2>/dev/null; then`,
  `  target="$hard"`,
  `fi`,
  `if [ "$soft" != "unlimited" ] && [ "$soft" -lt "$target" ] 2>/dev/null; then`,
  `  ulimit -Sn "$target" 2>/dev/null || true`,
  `fi`,
  `exec "$@"`
].join("\n");
const useShellLimit = process.platform !== "win32";
const [command, commandArgs] = useShellLimit
  ? [
      "/bin/sh",
      [
        "-c",
        RAISE_OPEN_FILE_LIMIT,
        "sh",
        process.execPath,
        electronBuilderCli,
        ...builderArgs
      ]
    ]
  : [process.execPath, [electronBuilderCli, ...builderArgs]];

const child = spawn(command, commandArgs, {
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
