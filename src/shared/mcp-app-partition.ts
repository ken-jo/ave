/** Use injective per-server partition encoding so main policy registration and renderer guests cannot collide. */

import {
  hasUnsafeUriChars,
  MCP_RESOURCE_URI_MAX_CHARS,
} from "./mcp-resource-bounds.js";

export const MCP_APP_PARTITION_PREFIX = "ave-mcp-app:";

/** Share the privileged proxy scheme without importing process-specific protocol dependencies. */
export const MCP_APP_SCHEME = "ave-mcp-app";

/** Bound raw server ids here too because persisted-config loading bypasses addConfig validation. */
export const MAX_SERVER_ID_LEN = 128;

/** Validate ids independently of provenance-envelope patterns so tightening one contract cannot change another. */
const SERVER_ID_CHARS_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isUsableMcpServerId(value: unknown): value is string {
  // Check the shared length bound before regex evaluation.
  return typeof value === "string"
    && value.length <= MAX_SERVER_ID_LEN
    && SERVER_ID_CHARS_RE.test(value);
}

/** Only literal case-sensitive UI schemes with an authority may skip ordinary resource capability checks. */
const MCP_APP_UI_SCHEME = "ui://";

/** Other URIs belong on the declared-resource path with its listed-set gate. */
export function isMcpAppUiUri(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > MCP_RESOURCE_URI_MAX_CHARS) return false;
  // Check raw scheme case; URL parsing lowercases it and would widen the capability exemption.
  if (!value.startsWith(MCP_APP_UI_SCHEME)) return false;
  // Ask the parser for an authority rather than enumerating delimiters.
  // Parsing validates only; forward the original URI unchanged.
  let authority: string;
  try {
    authority = new URL(value).hostname;
  } catch {
    return false;
  }
  if (authority.length === 0) return false;
  // Check raw characters because URL parsing removes tabs and line breaks.
  // Reuse the resource URI character predicate; never duplicate invisible-character ranges.
  return !hasUnsafeUriChars(value);
}

/** Hex-encode UTF-8 injectively and reject empty or oversized ids. */
export function encodeMcpServerId(serverId: string): string {
  if (typeof serverId !== "string" || serverId.length === 0) {
    throw new Error("[mcp-app-partition] serverId must be a non-empty string");
  }
  if (serverId.length > MAX_SERVER_ID_LEN) {
    throw new Error(
      `[mcp-app-partition] serverId exceeds ${MAX_SERVER_ID_LEN} chars (got ${serverId.length})`,
    );
  }
  const bytes = new TextEncoder().encode(serverId);
  let hex = "";
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, "0");
  }
  return hex;
}

/** Per-server ephemeral session partition (no `persist:` ⇒ in-memory). */
export function mcpAppPartitionName(serverId: string): string {
  return `${MCP_APP_PARTITION_PREFIX}${encodeMcpServerId(serverId)}`;
}
