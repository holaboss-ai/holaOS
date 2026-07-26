import type { RemoteComposioSource } from "./composio-toolkit-resolver.js";

// Process-wide handle to the remote Composio connection source (the Hono API,
// via ComposioApiClient). Set once during app setup so services can resolve
// Composio connections from remote without threading the client through every
// constructor. Null when no bearer token is configured → callers fall back to
// local-only behaviour.
let current: RemoteComposioSource | null = null;

export function setRemoteComposioSource(src: RemoteComposioSource | null): void {
  current = src;
}

export function getRemoteComposioSource(): RemoteComposioSource | null {
  return current;
}
