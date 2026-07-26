import { createHmac, randomBytes, randomUUID } from "node:crypto";

const GRANT_TTL_MS = 24 * 60 * 60 * 1000;

let signingKey: Buffer | null = null;

function getSigningKey(): Buffer {
  if (!signingKey) {
    signingKey = randomBytes(32);
  }
  return signingKey;
}

export function createSignedGrant(workspaceId: string, appId: string): string {
  const timestamp = Date.now().toString(36);
  const nonce = randomUUID();
  const payload = `grant:${workspaceId}:${appId}:${timestamp}:${nonce}`;
  const signature = createHmac("sha256", getSigningKey()).update(payload).digest("base64url");
  return `${payload}:${signature}`;
}

export interface ValidatedGrant {
  workspaceId: string;
  appId: string;
  timestamp: number;
  nonce: string;
}

export function validateSignedGrant(grant: string): ValidatedGrant | null {
  if (typeof grant !== "string" || !grant.startsWith("grant:")) return null;
  const parts = grant.split(":");
  if (parts.length < 6) return null;
  const workspaceId = parts[1] ?? "";
  const appId = parts[2] ?? "";
  const timestampStr = parts[3] ?? "";
  const nonce = parts[4] ?? "";
  const receivedSignature = parts.slice(5).join(":");
  if (!workspaceId || !appId || !timestampStr || !nonce || !receivedSignature) return null;

  const payload = `grant:${workspaceId}:${appId}:${timestampStr}:${nonce}`;
  const expectedSignature = createHmac("sha256", getSigningKey()).update(payload).digest("base64url");
  if (receivedSignature !== expectedSignature) return null;

  const timestamp = parseInt(timestampStr, 36);
  if (isNaN(timestamp) || Date.now() - timestamp > GRANT_TTL_MS) return null;

  return { workspaceId, appId, timestamp, nonce };
}
