import os from "node:os";

export interface RedactionIdentity {
  hostnames: string[];
  usernames: string[];
}

export function currentRedactionIdentity(): RedactionIdentity {
  const hostname = os.hostname();
  const hostnames = new Set<string>();
  if (hostname) {
    hostnames.add(hostname);
    hostnames.add(hostname.replace(/\.(local|lan|home)$/i, ""));
  }
  let username = "";
  try {
    username = os.userInfo().username;
  } catch {
    username = process.env.USER ?? process.env.USERNAME ?? "";
  }
  return {
    hostnames: [...hostnames].filter((value) => value.length >= 3),
    usernames: username.length >= 3 ? [username] : [],
  };
}

const PRIVATE_HOST =
  "(?:localhost|127(?:\\.\\d{1,3}){3}|0\\.0\\.0\\.0|\\[::1\\]|10(?:\\.\\d{1,3}){3}|192\\.168(?:\\.\\d{1,3}){2}|172\\.(?:1[6-9]|2\\d|3[01])(?:\\.\\d{1,3}){2}|169\\.254(?:\\.\\d{1,3}){2}|[A-Za-z0-9-]+\\.local)";
const LOCAL_URL = new RegExp(`\\bhttps?://${PRIVATE_HOST}(?::\\d{1,5})?(?:/[^\\s"'<>)\\]]*)?`, "gi");
const HOST_PORT = new RegExp(`\\b${PRIVATE_HOST}:\\d{2,5}\\b`, "gi");
const LAN_IP = /\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|169\.254(?:\.\d{1,3}){2})\b/g;
const POSIX_PATH =
  /(?<![\w:/.])(?:~|\/(?:Users|home|Volumes|private|tmp|var|opt|mnt|media|root|srv|data|workspace|holaboss))(?:\/[^\s"'<>`|,;)\]]+)+/g;
const WINDOWS_PATH = /\b[A-Za-z]:\\(?:[^\s"'<>`|\\,;)\]]+\\)*[^\s"'<>`|\\,;)\]]*/g;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function lastSegment(value: string, separator: string): string {
  const parts = value.split(separator).filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

export function redactPublicText(text: string, identity: RedactionIdentity = currentRedactionIdentity()): string {
  let result = text;
  result = result.replace(LOCAL_URL, "[local server]");
  result = result.replace(HOST_PORT, "[local server]");
  result = result.replace(LAN_IP, "[LAN address]");
  result = result.replace(POSIX_PATH, (match) => {
    const name = lastSegment(match, "/");
    return name && name !== "~" ? `…/${name}` : "[path]";
  });
  result = result.replace(WINDOWS_PATH, (match) => {
    const name = lastSegment(match, "\\");
    return name ? `…\\${name}` : "[path]";
  });
  for (const hostname of identity.hostnames) {
    result = result.replace(new RegExp(`\\b${escapeRegExp(hostname)}\\b`, "gi"), "[host]");
  }
  for (const username of identity.usernames) {
    result = result.replace(new RegExp(`\\b${escapeRegExp(username)}\\b`, "gi"), "[user]");
  }
  return result;
}

export function redactPublicValue<T>(value: T, identity: RedactionIdentity = currentRedactionIdentity()): T {
  if (typeof value === "string") {
    return redactPublicText(value, identity) as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactPublicValue(entry, identity)) as T;
  }
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      output[key] = redactPublicValue(entry, identity);
    }
    return output as T;
  }
  return value;
}
