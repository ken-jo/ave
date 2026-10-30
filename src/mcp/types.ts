






import type { ToolSurface } from "../plugins/runtime/tool-visibility.js";

export interface McpGovernancePolicy {
  version: string;

  defaultPolicy: "deny";

  servers: McpServerApproval[];

  /** Stable fingerprint approvals for bundled servers whose runtime ids change. */
  bundledServers?: Array<{ package: string; server: string; fingerprint: string }>;

  globalRules: McpGlobalRules;
}

export interface McpServerApproval {

  id: string;

  name: string;

  status: "approved" | "pending" | "revoked";

  approvedBy?: string;

  approvedAt?: string;
  /** Required for every host-owned runtime approval. Managed entries omit it. */
  provenance?: "user" | "policy-fingerprint";
  bundled?: { package: string; server: string; fingerprint: string };
  revokedAt?: string;


  transport: McpTransportKind;

  allowedCommands?: string[];

  allowedUrls?: string[];



  requiredAuth: "sso" | "api-key" | "oauth" | "mtls" | "none";
  /** For stdio API-key servers, the exact environment variable name that may receive the user-supplied key at process launch. */
  apiKeyEnv?: string;
  /** For HTTP API-key servers, the exact custom header name that may receive the user-supplied key. Omit to allow the built-in Bearer Authorization path. */
  apiKeyHeader?: string;

  tlsRequired: boolean;



  allowedCapabilities: McpCapability[];

  maxTools: number;

  toolNamePrefix: string;







  connectionTimeoutMs: number;

  maxConcurrentRequests: number;

  /** Admin gate for `allowPrivateNetworks` on the matching per-server config. When the client config sets `allowPrivateNetworks: true` (escape hatch for on-prem / loopback servers),
   * governance requires EITHER this flag OR `globalRules.allowPrivateNetworks` to be `true` as well. Defaults to false; preventing a self-elevating config file from bypassing NetworkGuard. */
  allowPrivateNetworks?: boolean;
}

export interface McpGlobalRules {

  maxServersTotal: number;

  blockedUrlPatterns: string[];

  allowedUrlPatterns: string[];

  policyRefreshIntervalMs: number;
  /** Existing policies without this field continue to admit user approvals. */
  allowUserApprovedServers?: boolean;
  /** Admin gate for per-server `allowPrivateNetworks`. If not `true`, any `http` server config that opts into private-network
   * access is rejected at governance; preventing a self-elevating config file from bypassing NetworkGuard. Defaults to false. */
  allowPrivateNetworks?: boolean;
}

/** MCP transport types. - `stdio` : local subprocess with newline-delimited JSON-RPC on stdin/stdout. - `http` : MCP Streamable HTTP transport (final `2026-07-28` revision). Single POST endpoint that returns either `application/json` for single responses or
 * `text/event-stream` for streaming. - `sse` : legacy HTTP+SSE dual-endpoint transport. Governance layer only (validation path); runtime client is not implemented; prefer `http`. - `websocket`: not implemented at the client layer; governance validation only. */
type McpTransportKind = "stdio" | "http" | "sse" | "websocket";
export type McpCapability = "tools" | "resources" | "prompts";

interface McpServerConfigBase {
  id: string;

  auth?: "sso" | "api-key" | "oauth" | "none";

  apiKey?: string;
}

export interface McpOAuthConfig {
  /** RFC 8707 resource identifier for the target MCP server. */
  resource?: string;
  /** RFC 9728 protected resource metadata URL, when known before first 401. */
  resourceMetadataUrl?: string;
  authorizationServers?: string[];
  scopes?: string[];
  clientRegistration?: "client-id-metadata-document" | "dynamic" | "preregistration" | "manual";
  /** Public client ID the authorization server pre-registered for Ave. When set it is used before any metadata document or dynamic registration. No secret is stored. */
  clientId?: string;
}

export interface McpStdioServerConfig extends McpServerConfigBase {
  transport: "stdio";

  command: string;

  args?: string[];

  env?: Record<string, string>;
  /** Validated working directory for a bundled server. */
  cwd?: string;
  /** Host-owned, package-stable writable directory for a bundled server. */
  pluginDataDir?: string;
  /** HOST-POPULATED: the retained generation payload a plugin-bundled server runs from. Every wrapped stdio server is refused the plugins root, where that payload lives, so this is the one
   * directory under it a bundled server reads. Set only by `preparePluginMcpGeneration`; a value from any other source is dropped at connect (`McpManager.connectServer`) and never crosses to the renderer. */
  bundledPayloadRoot?: string;
  /** Safe env var name that receives apiKey at process launch. */
  apiKeyEnv?: string;
  /** Only the host may derive this worker write jail; never accept it from plugin, renderer, marketplace, or persisted configuration.
   * Strip it from renderer DTOs and persistence; absence at wrap time denies all writes, never falls back to home or cwd. */
  sandboxRoot?: string;
  url?: never;
  headers?: never;
  apiKeyHeader?: never;
  allowPrivateNetworks?: never;
}

export interface McpHttpServerConfig extends McpServerConfigBase {
  transport: "http";
  /** Streamable HTTP endpoint URL (POST target). */
  url: string;
  /** OAuth discovery/login metadata. Contains no tokens or secrets. */
  oauth?: McpOAuthConfig;
  /** Optional additional request headers (e.g. `Authorization`). */
  headers?: Record<string, string>;
  /** Safe header name that receives apiKey on MCP HTTP requests. */
  apiKeyHeader?: string;
  /** Opt-in escape hatch for on-prem / localhost deployments. When true, NetworkGuard's private-IP check is skipped for this server; the
   * governance `allowedUrls` allowlist is still the primary gate. Defaults to false. Mirrors the host-wide NetworkGuard SSRF-protection pattern. */
  allowPrivateNetworks?: boolean;
  command?: never;
  args?: never;
  env?: never;
  apiKeyEnv?: never;
}

/** Legacy / not-yet-implemented transports. Kept on the discriminated union so governance validation
 * paths that branch on `config.transport === "sse"` or `"websocket"` continue to type-check unchanged. */
export interface McpLegacyRemoteServerConfig extends McpServerConfigBase {
  transport: "sse" | "websocket";
  url: string;
  headers?: Record<string, string>;
  apiKeyHeader?: string;
  command?: never;
  args?: never;
  env?: never;
  apiKeyEnv?: never;
  allowPrivateNetworks?: never;
}

export type McpServerConfig =
  | McpStdioServerConfig
  | McpHttpServerConfig
  | McpLegacyRemoteServerConfig;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Renderer-safe config DTO. Secret-bearing fields remain write-only in the main process and never cross the IPC boundary back to the renderer. */
export type McpServerConfigDto = DistributiveOmit<
  McpServerConfig,
  "apiKey" | "headers" | "env" | "args" | "sandboxRoot" | "cwd" | "pluginDataDir" | "bundledPayloadRoot"
> & { bundled?: { kind: "plugin" | "agent-plugin"; name: string; server: string } };

/** MCP Apps spec `McpUiToolVisibility`; WHO may call a tool. - `"model"`: the agent may call it. - `"app"`: the tool's OWN app (this server's `ui://` card) may call it. ONE declaration: this is an alias of {@link ToolSurface} (`plugins/runtime/
 * tool-visibility.ts`, the host's single surface-visibility reader), which had the identical `"model" | "app"` union. A type-only import, so the reverse edge (tool-visibility.ts already imports this module's `Tool` type-only) is erased at runtime; no cycle. */
export type McpUiToolVisibility = ToolSurface;

export interface McpToolSchema {
  name: string;
  description: string;
  /** Untrusted permission hints; only an explicit saved rule may grant access. */
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  /** MCP Apps spec `_meta.ui` on a TOOL (`McpUiToolMeta`). Only `visibility` is read by the host: it is the spec's gate on app→server `tools/call`; a host MUST reject an app's call to a tool whose visibility does not
   * include `"app"`. Absent ⇒ the spec default `["model","app"]`, materialized ONCE at ingestion in `mcp-tool-adapter.ts` (the external-server analog of `parsePluginJson`'s U1 defaulting site) so no downstream reader defaults. */
  _meta?: {
    ui?: {
      visibility?: McpUiToolVisibility[];
    };
  };
}

/** One declared argument of an MCP prompt (prompts/list `arguments[]`). */
interface McpPromptArgumentSummary {
  name: string;
  description?: string;
  required?: boolean;
}

/** A server-declared prompt discovered via `prompts/list`. Prompts are a user-controlled MCP primitive (parallel to
 * registeredTools but never model-callable): the user picks one, supplies arguments, and the host fetches it via `prompts/get`. */
export interface McpPromptSummary {
  name: string;
  title?: string;
  description?: string;
  arguments?: McpPromptArgumentSummary[];
}

/** A resource the server declared (`resources/list`), already validated and bounded at the client boundary; see
 * `shared/mcp-resource-bounds.ts`. The `uri` is an OPAQUE identifier: the host hands it back to the publishing server and never resolves it itself. */
export interface McpResourceSummary {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  /** Server-declared size in bytes, when it gave a sane one. */
  size?: number;
  /** Listed, but the host refuses to fetch it (`https:`; see the policy doc §4). */
  hostFetchRefused?: boolean;
}

/** A URI TEMPLATE the server declared (`resources/templates/list`). Its identity is `uriTemplate`, NOT `uri`; the distinction is load-bearing rather than pedantic. A template is a pattern the host completes, so it fails the URI predicate by design (braces are refused there), and a consumer that stored one in a `uri` field would hand a brace-string to a validator
 * that can only refuse it. `variables` is derived here rather than re-parsed per consumer: the dialog renders one field per entry, in this order. The expansion does not read this list; it re-scans the template; but both come from the one grammar in `shared/mcp-resource-template-bounds`, so a form and an expansion cannot disagree about what the template asks for. */
export interface McpResourceTemplateSummary {
  uriTemplate: string;
  name: string;
  /** The host will not fetch what this template produces, because its LITERAL scheme is one the host refuses. Absent when the scheme is
   * itself a variable; that case is unknowable until expansion, which is why the read re-derives the refusal instead of trusting this. */
  hostFetchRefused?: boolean;
  title?: string;
  description?: string;
  mimeType?: string;
  /** Variable names in declaration order, first occurrence only. */
  variables: string[];
}

/** Host-owned authorization state. `insufficient_scope` means the current grant still works but
 * the server asked for more scope (403 step-up); only the explicit Authenticate action requests it. */
export type McpAuthStatus = "required" | "authenticating" | "authenticated" | "insufficient_scope" | "error";

/** Stable, renderer-safe authorization failure codes. */
export type McpAuthErrorCode =
  | "mcp-auth-required"
  | "mcp-auth-failed"
  | "mcp-auth-storage-unavailable"
  | "mcp-auth-storage-unreadable"
  | "mcp-auth-registration-unsupported"
  /** Protected-resource metadata describes a different resource than this endpoint. */
  | "mcp-auth-resource-mismatch"
  /** The credential index is unreadable; stored sign-ins are not cleaned up until it is rebuilt. */
  | "mcp-auth-index-unreadable";

export interface McpAuthenticationResult {
  connected: boolean;
  errorCode?: McpAuthErrorCode;
}

export interface McpConfigMutationResult extends McpAuthenticationResult {
  warning?: string;
}

export interface McpServerState {
  id: string;
  status: "disconnected" | "connecting" | "connected" | "error";
  /** Host-owned authorization state. Credentials never cross this boundary. */
  authStatus?: McpAuthStatus;
  /** A renderer-safe authorization problem to show on the server row. */
  authError?: McpAuthErrorCode;
  connectedAt?: string;
  lastError?: string;
  registeredTools: string[];
  /** Prompts declared by the server (only when it advertised + was approved for the `prompts` capability). */
  prompts?: McpPromptSummary[];
  /** Server-level usage guidance from discovery (`instructions`), surfaced read-only. */
  instructions?: string;
  /** Resources declared by the server (advertised + approved for `resources`). */
  resources?: McpResourceSummary[];
  /** URI templates declared by the server (advertised + approved for `resources`). */
  resourceTemplates?: McpResourceTemplateSummary[];
}

export type ValidationResult =
  | { valid: true }
  | { valid: false; reason: string; layer: number };

// ─── MCP Apps UI Payload (MCP Apps spec 2026-01-26) ─

/** Slot in which the MCP App should be rendered. - `"chat"` : inline in the chat message flow (below the tool
 * card) - `"sidebar"` : docked to the sidebar panel - `"tool-result"` : embedded inside the ToolGroupCard result row */
export type McpUiSlot = "chat" | "sidebar" | "tool-result";

/** CSP domain buckets belong to resource metadata, not tool results.
 * Mirror the upstream shape locally because its declarations do not resolve under this compiler mode; tests pin compatibility. */
export interface McpUiResourceCsp {
  /** Origins for network requests (fetch/XHR/WebSocket) → `connect-src`. */
  connectDomains?: string[];
  /** Origins for images, scripts, stylesheets, fonts, media → those five directives. */
  resourceDomains?: string[];
  /** Origins for nested iframes → `frame-src`. */
  frameDomains?: string[];
  /** Allowed base URIs for the document → `base-uri`. */
  baseUriDomains?: string[];
}

/** Resource declarations select only host-mapped permissions; absent or unknown features remain denied.
 * Main derives both iframe allow and session grants from the shared mapping, with the inner frame using its per-server origin. */
export interface McpUiResourcePermissions {
  camera?: Record<string, never>;
  microphone?: Record<string, never>;
  geolocation?: Record<string, never>;
  clipboardWrite?: Record<string, never>;
}

/** The security-relevant `_meta.ui` a UI resource carries (spec `McpUiResourceMeta`). */
export interface McpUiResourceMeta {
  csp?: McpUiResourceCsp;
  permissions?: McpUiResourcePermissions;
}

/** What `resources/read` yields for a UI resource: the HTML plus the resource's OWN declared security metadata. `readResource` previously returned a bare
 * string and dropped `_meta` entirely, which is why the CSP had to be (wrongly) sourced from the tool result. Main builds the sandbox-proxy CSP header from this. */
export interface McpUiResourceRead {
  html: string;
  csp?: McpUiResourceCsp;
  permissions?: McpUiResourcePermissions;
}

/** Serve plugin content through the shared resource model; policy stays in the validated, integrity-covered manifest, never the runtime response.
 * Require the declaring plugin's URI authority and an exact manifest-declared resource; main computes CSP and iframe grants from that resource only. */
export interface PluginUiResourceDecl {
  /** `ui://<pluginId>/<path>`; authority MUST equal the declaring plugin's id. */
  uri: string;
  /** The resource's own declared CSP (spec `McpUiResourceCsp`). @optional */
  csp?: McpUiResourceCsp;
  /** Sandbox permissions the resource requests (spec `McpUiResourcePermissions`). @optional */
  permissions?: McpUiResourcePermissions;
}

/** The MCP Apps TOOL-RESULT `_meta.ui` extension (spec §3.2); how a server says "render this card with my result". These are the STANDARD `_meta.ui.*` keys, not a legacy reverse-DNS vendor extension, so both arms declare a card identically: an external MCP server puts it on its `CallToolResult`, and a
 * first-party plugin puts it on its handler's return value (the loopback delegate lifts it onto the wire, see `plugin-runtime-delegate.ts`). Deliberately NO `csp`; per spec that lives on the RESOURCE, and main derives the header there ({@link McpUiResourceMeta}). A `csp` on a tool result is ignored. */
export interface McpUiToolMeta {
  /** `ui://<serverId>/<path>`; the card to render. */
  resourceUri: string;
  /** Preferred render slot; defaults to `"chat"` when omitted. @optional */
  slot?: McpUiSlot;
  /** Preferred height in pixels. @optional */
  height?: number;
  /** Human-readable title shown in the webview title bar. @optional */
  title?: string;
}

/** An image content block lifted out of a tool result, still undecoded (base64). */
export interface McpContentImage {
  data: string;
  mimeType: string;
}

/** One `tools/call` result as the host's adapters consume it. */
export interface McpToolCallOutput {
  /** Text blocks joined, with a placeholder where each image block was. */
  text: string;
  uiPayload?: McpUiPayload;
  /** Image blocks in order; the adapter decides which reach the model. */
  images?: McpContentImage[];
}

/** Payload produced by an MCP tool that declares a UI extension. MCP Apps spec §3.2; a tool response may carry `_meta.ui` to request that the host render an interactive micro-app alongside the text reply. The
 * host fetches the resource at `resourceUri` (a `ui://` scheme URL resolved against the connected MCP server) and renders it in a sandboxed webview / iframe using the `AppBridge` postMessage JSON-RPC channel. */
export interface McpUiPayload {
  /** MCP server that owns this UI resource. */
  serverId: string;
  /** Exact plugin generation for loopback cards; absent for external MCP servers. */
  generationId?: string;
  /** `ui://` URI pointing to the HTML resource on the MCP server. The main process resolves this via `resources/read` to fetch the HTML. */
  resourceUri: string;
  /** Preferred render slot; defaults to `"chat"` when omitted. */
  slot?: McpUiSlot;
  /** Preferred height in pixels; defaults to 300 when omitted. */
  height?: number;
  /** Human-readable title shown in the webview title bar. */
  title?: string;
  // NOTE: deliberately NO `csp` here. Per spec, `csp`/`permissions` live on the RESOURCE (`resources/read` content item `_meta.ui`), not on the tool result, and the CSP must never round-trip through the
  // renderer; a compromised renderer could forge a permissive policy and widen the envelope containing the untrusted app. Main derives it from the resource it just fetched. A `csp` on a tool result is ignored.
}

/** What `ave.mcp.readUiResource` returns; everything a card needs to render one MCP App through the sandbox-proxy. It is a bundle rather than a bare HTML string because the two halves are now delivered over different channels:
 * the proxy DOCUMENT is navigated to (and carries the CSP header the app inherits), while the app HTML travels over the JSON-RPC bridge as `ui/notifications/sandbox-resource-ready`. Main mints both together so they cannot drift. */
export interface McpUiResourceBundle {
  /** `ave-mcp-app://<hex(serverId)>/proxy.html?t=<token>`; the host-owned sandbox-proxy document for
   * this card. The token selects the CSP main serves it with; it is host-minted and bound to the serverId. */
  proxyUrl: string;
  /** The app HTML, mounted into the inner sandboxed iframe by the relay preload. */
  html: string;
}

/** Result of an MCP App's `tools/call` on its OWN server, as it crosses main → preload → renderer (`CHANNELS.mcp.callTool`). Deliberately an OUTCOME, not a thrown error: every denial (cross-server, app-visibility, permission/consent) and every tool failure comes back as `{ ok: false }` with a
 * kebab-case code + English message, which the bridge handler turns into an MCP-style `{ isError: true, content: [...] }` `CallToolResult` for the app. `result` is the host tool layer's raw value (a rendered text string for external MCP tools; whatever the plugin method returned on the loopback path). */
export type McpUiToolCallOutcome =
  | { ok: true; result: unknown }
  | { ok: false; error: string; message?: string };
