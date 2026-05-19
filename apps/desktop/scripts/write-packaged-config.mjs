import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");
const outputDir = path.join(desktopRoot, "out");
const outputPath = path.join(outputDir, "holaboss-config.json");

function resolveUpdateChannel() {
  const rawValue = (process.env.HOLABOSS_RELEASE_CHANNEL || "").trim().toLowerCase();
  if (!rawValue || rawValue === "latest") {
    return "latest";
  }
  if (rawValue === "beta") {
    return "beta";
  }
  throw new Error(`Unsupported HOLABOSS_RELEASE_CHANNEL: ${rawValue}`);
}

function resolveAppUpdateEnabled() {
  const explicitValue = (
    process.env.HOLABOSS_ENABLE_APP_UPDATES || ""
  )
    .trim()
    .toLowerCase();
  if (["1", "true", "yes", "on"].includes(explicitValue)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(explicitValue)) {
    return false;
  }

  const releaseTag =
    process.env.RELEASE_TAG?.trim() ||
    process.env.HOLABOSS_RELEASE_TAG?.trim() ||
    "";
  return Boolean(releaseTag);
}

async function loadDesktopEnvDefaults() {
  const envCandidates = [
    path.join(desktopRoot, ".env"),
    path.join(desktopRoot, ".env.production")
  ];
  const parsed = {};
  for (const envPath of envCandidates) {
    if (!existsSync(envPath)) {
      continue;
    }
    try {
      Object.assign(parsed, dotenv.parse(await fs.readFile(envPath, "utf8")));
    } catch {
      // Ignore malformed optional env files; explicit process env still applies.
    }
  }
  return parsed;
}

const desktopEnvDefaults = await loadDesktopEnvDefaults();
const updateChannel = resolveUpdateChannel();
const appUpdateEnabled = resolveAppUpdateEnabled();

function resolveEnvValue(...names) {
  for (const name of names) {
    const fromProcess = process.env[name]?.trim();
    if (fromProcess) {
      return fromProcess;
    }
    const fromFile = desktopEnvDefaults[name]?.trim();
    if (fromFile) {
      return fromFile;
    }
  }
  return "";
}

function resolveMacWebAuthnKeychainAccessGroup() {
  // The Touch ID / platform WebAuthn access group is only safe when the
  // signed app is built with the matching Apple capability and provisioning
  // context. Treat it as an explicit opt-in so default Developer ID builds
  // remain launchable.
  return resolveEnvValue(
    "HOLABOSS_MAC_WEBAUTHN_KEYCHAIN_ACCESS_GROUP",
  );
}

const macWebAuthnKeychainAccessGroup =
  resolveMacWebAuthnKeychainAccessGroup();

const config = {
  authBaseUrl: resolveEnvValue("HOLABOSS_AUTH_BASE_URL"),
  authSignInUrl: resolveEnvValue("HOLABOSS_AUTH_SIGN_IN_URL"),
  backendBaseUrl: resolveEnvValue("HOLABOSS_BACKEND_BASE_URL"),
  desktopControlPlaneBaseUrl: resolveEnvValue(
    "HOLABOSS_DESKTOP_CONTROL_PLANE_BASE_URL"
  ),
  projectsUrl: resolveEnvValue(
    "HOLABOSS_PROJECTS_URL",
    "HOLABOSS_CLI_PROJECTS_URL"
  ),
  marketplaceUrl: resolveEnvValue(
    "HOLABOSS_MARKETPLACE_URL",
    "HOLABOSS_CLI_MARKETPLACE_URL"
  ),
  proactiveUrl: resolveEnvValue(
    "HOLABOSS_PROACTIVE_URL",
    "HOLABOSS_CLI_PROACTIVE_URL"
  ),
  appUpdateEnabled,
  ...(macWebAuthnKeychainAccessGroup
    ? { macWebAuthnKeychainAccessGroup }
    : {}),
  ...(updateChannel === "beta" ? { updateChannel } : {}),
};

await fs.mkdir(outputDir, { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

process.stdout.write(`[packaged-config] wrote ${outputPath}\n`);
