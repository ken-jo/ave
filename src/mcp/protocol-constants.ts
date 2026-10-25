/** Shared wire constants pin protocol error assignments; the obsolete -32002 value must not be reused. */

export const MCP_PROTOCOL_VERSION = "2026-07-28";

/** External legacy negotiation uses only implemented transport revisions; plugin hosts never negotiate it. */
export const MCP_LEGACY_PROTOCOL_VERSION = "2025-03-26";

/** Reject negotiated legacy revisions outside the implemented set. */
export const MCP_SUPPORTED_LEGACY_VERSIONS: readonly string[] = [
  "2025-03-26",
  "2024-11-05",
];

export const META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";
export const META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo";
export const META_CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
export const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";

/** Shared metadata key preserves structured plugin results across transports. */
export const RAW_RESULT_META = "ave/rawResult";

/** Opaque invocation tokens bind child host calls to host approval, origin and effect context.
 * Keep context resolvable after tool completion for background work; missing tokens have no invocation. */
export const INVOCATION_META = "ave/invocation";

export const RPC_INVALID_PARAMS = -32602;
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INTERNAL_ERROR = -32603;

/** Resource-not-found uses Invalid Params (-32602); obsolete -32002 must never be reused. */
export const RPC_RESOURCE_NOT_FOUND = -32602;

export const RPC_HEADER_MISMATCH = -32020;
export const RPC_MISSING_REQUIRED_CLIENT_CAPABILITY = -32021;
export const RPC_UNSUPPORTED_PROTOCOL_VERSION = -32022;
