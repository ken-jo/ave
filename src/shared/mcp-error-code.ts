export const MCP_CONFIG_RECOVERY_REQUIRED = "mcp-config-recovery-required";
export const MCP_CREDENTIAL_MIGRATION_FAILED = "mcp-credential-migration-failed";
export const MCP_GOVERNANCE_UNAPPROVED_SERVER = "mcp-governance-unapproved-server";

/** Remove only the explicitly supported leading code, preserving the localized detail. */
export function stripMcpErrorCode(message: string): string {
  const prefix = `${MCP_GOVERNANCE_UNAPPROVED_SERVER}: `;
  return message === MCP_GOVERNANCE_UNAPPROVED_SERVER ? ""
    : message.startsWith(prefix) ? message.slice(prefix.length) : message;
}
