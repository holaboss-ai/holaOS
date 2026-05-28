import { access, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const root = process.cwd();
const explicitBin = (process.env.HOLABOSS_PACKAGED_APP_BIN || "").trim();
const outRoot = path.join(root, "out");

const candidates = [
  explicitBin,
  path.join(root, "out", "release", "mac-arm64", "holaOS.app", "Contents", "MacOS", "holaOS"),
  path.join(root, "out", "release", "mac", "holaOS.app", "Contents", "MacOS", "holaOS"),
  path.join(root, "out", "release", "win-unpacked", "holaOS.exe"),
  path.join(root, "out", "release", "mac-arm64", "Holaboss.app", "Contents", "MacOS", "Holaboss"),
  path.join(root, "out", "release", "mac", "Holaboss.app", "Contents", "MacOS", "Holaboss"),
  path.join(root, "out", "release", "win-unpacked", "Holaboss.exe")
].filter(Boolean);

async function localReleaseCandidates() {
  try {
    const entries = await readdir(outRoot, { withFileTypes: true });
    const releaseDirs = (
      await Promise.all(
        entries
          .filter((entry) => entry.isDirectory() && entry.name.startsWith("release-local-"))
          .map(async (entry) => {
            const directoryPath = path.join(outRoot, entry.name);
            const details = await stat(directoryPath);
            return {
              directoryPath,
              mtimeMs: details.mtimeMs,
            };
          }),
      )
    ).sort((left, right) => right.mtimeMs - left.mtimeMs);

    return releaseDirs.flatMap(({ directoryPath }) => [
      path.join(directoryPath, "mac-arm64", "holaOS.app", "Contents", "MacOS", "holaOS"),
      path.join(directoryPath, "mac", "holaOS.app", "Contents", "MacOS", "holaOS"),
      path.join(directoryPath, "win-unpacked", "holaOS.exe"),
      path.join(directoryPath, "mac-arm64", "Holaboss.app", "Contents", "MacOS", "Holaboss"),
      path.join(directoryPath, "mac", "Holaboss.app", "Contents", "MacOS", "Holaboss"),
      path.join(directoryPath, "win-unpacked", "Holaboss.exe"),
    ]);
  } catch {
    return [];
  }
}

async function firstExisting(paths) {
  for (const filePath of paths) {
    try {
      await access(filePath);
      return filePath;
    } catch {
      // Continue looking for a valid packaged app binary.
    }
  }
  return null;
}

const binaryPath = await firstExisting([
  ...candidates,
  ...(await localReleaseCandidates())
]);

if (!binaryPath) {
  console.error("No packaged app binary found.");
  console.error("Run `npm run dist:mac` or `npm run dist:win` first, or set HOLABOSS_PACKAGED_APP_BIN to an executable path.");
  process.exit(1);
}

console.log(`[packaged:run] launching: ${binaryPath}`);
console.log(
  `[packaged:run] HOLABOSS_BACKEND_BASE_URL=${
    process.env.HOLABOSS_BACKEND_BASE_URL || process.env.HOLABOSS_DESKTOP_CONTROL_PLANE_BASE_URL || "(default)"
  }`
);
console.log(`[packaged:run] HOLABOSS_AUTH_BASE_URL=${process.env.HOLABOSS_AUTH_BASE_URL || "(default)"}`);

const child = spawn(binaryPath, [], {
  env: process.env,
  stdio: "inherit"
});

child.on("error", (error) => {
  console.error(`[packaged:run] failed to start packaged app: ${error.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
