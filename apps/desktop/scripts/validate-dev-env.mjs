import path from "node:path";
import process from "node:process";

import { loadDesktopEnv, resolveDesktopEnvPaths } from "./load-desktop-env.mjs";

const { preferredEnvPath, repoRoot } = resolveDesktopEnvPaths();
loadDesktopEnv();

function configured(name) {
  return (process.env[name] ?? "").trim();
}

const remoteBridgeBaseUrl =
  configured("HOLABOSS_PROACTIVE_URL") ||
  configured("HOLABOSS_CLI_PROACTIVE_URL") ||
  configured("HOLABOSS_BACKEND_BASE_URL") ||
  configured("HOLABOSS_DESKTOP_CONTROL_PLANE_BASE_URL");

if (!remoteBridgeBaseUrl) {
  const envFileLabel = path.relative(repoRoot, preferredEnvPath) || ".env";
  console.error("[validate-dev-env] Missing remote runtime configuration.");
  console.error(
    `[validate-dev-env] Set HOLABOSS_BACKEND_BASE_URL or HOLABOSS_PROACTIVE_URL in ${envFileLabel} before running desktop:dev.`
  );
  console.error(
    "[validate-dev-env] Legacy desktop/.env files are still supported, but apps/desktop/.env is the canonical location.",
  );
  console.error("[validate-dev-env] See apps/desktop/.env.example for the expected shape.");
  process.exit(1);
}
