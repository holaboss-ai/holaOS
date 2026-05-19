import { access } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const root = process.cwd();
const explicitBin = (process.env.HOLABOSS_PACKAGED_APP_BIN || "").trim();

const candidates = [
  explicitBin,
  path.join(root, "out", "release", "mac-arm64", "holaOS.app", "Contents", "MacOS", "holaOS"),
  path.join(root, "out", "release", "mac", "holaOS.app", "Contents", "MacOS", "holaOS"),
  path.join(root, "out", "release", "win-unpacked", "holaOS.exe"),
  path.join(root, "out", "release", "mac-arm64", "Holaboss.app", "Contents", "MacOS", "Holaboss"),
  path.join(root, "out", "release", "mac", "Holaboss.app", "Contents", "MacOS", "Holaboss"),
  path.join(root, "out", "release", "win-unpacked", "Holaboss.exe")
].filter(Boolean);

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

const binaryPath = await firstExisting(candidates);

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
