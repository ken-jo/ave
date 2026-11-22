import { canonicalStringify } from "../shared/canonical-json.js";
import { sha256Hex } from "../lib/hex-digest-equal.js";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";
import type { McpServerApproval, McpServerConfig } from "./types.js";

/** Credential rotation does not alter the launch identity that the user reviewed. */
export function userServerFingerprint(config: McpServerConfig): string {
  const identity = config.transport === "stdio"
    ? { id: config.id, transport: config.transport, command: config.command, args: config.args, env: config.env, cwd: config.cwd,
      auth: config.auth, apiKeyEnv: config.apiKeyEnv }
    : { id: config.id, transport: config.transport, url: config.url, headers: config.headers, oauth: config.oauth,
      auth: config.auth, apiKeyHeader: config.apiKeyHeader, allowPrivateNetworks: config.allowPrivateNetworks };
  return sha256Hex(canonicalStringify(identity));
}

export function userServerTrustSecretId(serverId: string): string {
  return `mcp.server.trust.${encodeURIComponent(serverId)}`;
}

/** This approval becomes effective only after policy admission and exact stored consent. */
export function userServerApproval(config: McpServerConfig): McpServerApproval {
  return {
    id: config.id,
    name: config.id,
    status: "approved",
    provenance: "user",
    userConfigFingerprint: userServerFingerprint(config),
    transport: config.transport,
    ...(config.transport === "stdio" ? { allowedCommands: [config.command], apiKeyEnv: config.apiKeyEnv }
      : { allowedUrls: [new URL(config.url).hostname], apiKeyHeader: config.apiKeyHeader }),
    requiredAuth: config.auth ?? "none",
    tlsRequired: config.transport === "http" && config.url.startsWith("https://"),
    allowedCapabilities: ["tools", "resources", "prompts"],
    maxTools: 64,
    toolNamePrefix: `user_${sha256Hex(config.id).slice(0, 12)}`,
    connectionTimeoutMs: TOOL_TIMEOUT_POLICY.mcpRequestDefaultMs,
    maxConcurrentRequests: 4,
  };
}
