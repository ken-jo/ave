/** Keep relay contracts dependency-free; tests pin local handshake constants to the installed wire protocol. */

/** One bidirectional channel carries opaque frames; relay intercepts only sandbox handshakes. */
export const MCP_APP_BRIDGE_CHANNEL = "mcp-app-bridge";

/** Proxy-ready tells the host it may send resource HTML. */
export const SANDBOX_PROXY_READY = "ui/notifications/sandbox-proxy-ready";

/** Resource-ready HTML is consumed by the relay, never forwarded directly to the inner frame. */
export const SANDBOX_RESOURCE_READY = "ui/notifications/sandbox-resource-ready";

/** The inner frame shares only the isolated per-server proxy origin. Sandbox flags, declared permission delegation, and session grants must change together. */
export const INNER_SANDBOX_ATTR = "allow-scripts allow-same-origin";

/** Read permissions from host-served proxy metadata, never renderer-forwarded frames that could widen containment. */
export const MCP_APP_ALLOW_META_NAME = "ave-mcp-app-allow";

/** Protocol identity names this bridge implementation, not the application release. */
export const MCP_APP_HOST_INFO = { name: "Ave", version: "1.0.0" } as const;
