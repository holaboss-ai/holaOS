/**
 * Namespaced mcp_registry key for a capability's MCP server. Capability MCP is
 * registered into workspace.yaml's `mcp_registry` on install (unified with app
 * MCP), keyed by `${capabilityId}__${serverId}` so uninstall can remove a
 * capability's servers by prefix.
 */
export function capabilityMcpServerId(capabilityId: string, serverId: string): string {
  return `${capabilityId}__${serverId}`;
}
