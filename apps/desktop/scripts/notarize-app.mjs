import path from "node:path";
import { notarize } from "@electron/notarize";

const appPathArg = process.argv[2]?.trim();

if (!appPathArg) {
  process.stderr.write("usage: node scripts/notarize-app.mjs <path-to-app>\n");
  process.exit(1);
}

const appleId = process.env.APPLE_ID?.trim() || "";
const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD?.trim() || "";
const teamId = process.env.APPLE_TEAM_ID?.trim() || "";
const missing = [];

if (!appleId) {
  missing.push("APPLE_ID");
}
if (!appleIdPassword) {
  missing.push("APPLE_APP_SPECIFIC_PASSWORD");
}
if (!teamId) {
  missing.push("APPLE_TEAM_ID");
}
if (missing.length > 0) {
  process.stderr.write(`missing required notarization env vars: ${missing.join(", ")}\n`);
  process.exit(1);
}

const appPath = path.resolve(appPathArg);

await notarize({
  tool: "notarytool",
  appPath,
  appleId,
  appleIdPassword,
  teamId
});

process.stdout.write(`[notarize] notarized and stapled ${appPath}\n`);
