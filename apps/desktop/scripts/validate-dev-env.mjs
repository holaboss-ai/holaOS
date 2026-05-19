import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import dotenv from "dotenv";

const desktopRoot = process.cwd();
const envPath = path.join(desktopRoot, ".env");

if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

function configured(name) {
  return (process.env[name] ?? "").trim();
}

const remoteBridgeBaseUrl =
  configured("HOLABOSS_PROACTIVE_URL") ||
  configured("HOLABOSS_CLI_PROACTIVE_URL") ||
  configured("HOLABOSS_BACKEND_BASE_URL") ||
  configured("HOLABOSS_DESKTOP_CONTROL_PLANE_BASE_URL");

if (!remoteBridgeBaseUrl) {
  const envFileLabel = path.relative(process.cwd(), envPath) || ".env";
  console.error("[validate-dev-env] Missing remote runtime configuration.");
  console.error(
    `[validate-dev-env] Set HOLABOSS_BACKEND_BASE_URL or HOLABOSS_PROACTIVE_URL in ${envFileLabel} before running desktop:dev.`
  );
  console.error("[validate-dev-env] See desktop/.env.example for the expected shape.");
  process.exit(1);
}
