/** Register injected handler factories through createMcpAppBridge; derive advertised capabilities from that same handler
 * set. */
import type { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { McpUiToolCallOutcome } from "../../../../mcp/types.js";
import type { McpUiMessageOutcome } from "../../../../mcp/mcp-ui-message.js";
import type { McpUiDownloadOutcome } from "../../../../mcp/mcp-app-download.js";
import type { McpUiModelContextOutcome } from "../../../../mcp/mcp-app-model-context.js";
import {
  isSupportedMcpAppDisplayMode,
  type McpUiDisplayMode,
} from "../../../../shared/mcp-app-display-mode.js";
import { errorMessage } from "../../../../shared/error-message.js";

/**
 * `onsandboxready` handler — the sandbox handshake leg of the MCP App bridge.
 *
 * The proxy announces it is ready for HTML; we answer with the app document. The
 * relay preload mounts it into the inner sandboxed iframe, after which the App
 * performs `ui/initialize` over the same transport.
 */
export type OnSandboxReady = NonNullable<AppBridge["onsandboxready"]>;

export interface OnSandboxReadyDeps {
  /** The constructed bridge — used only to send the app document back. */
  bridge: Pick<AppBridge, "sendSandboxResourceReady">;
  /** The app document HTML to mount into the inner sandboxed iframe. */
  html: string;
}

export function createOnSandboxReady({ bridge, html }: OnSandboxReadyDeps): OnSandboxReady {
  return () => {
    // No `sandbox` field: the relay preload OWNS the inner iframe's sandbox attribute
    // (always `allow-scripts`, opaque origin) and never consumes a wire value — a
    // containment flag must not be renderer-governed. Sending one would be dead data.
    void bridge.sendSandboxResourceReady({ html });
  };
}

/** Admit only ui:// resources before server-bound IPC; wider reads exceed UI consent and can evict live proxy tokens from
 * the bounded LRU. Refusal becomes a JSON-RPC error. */
export type OnReadResource = NonNullable<AppBridge["onreadresource"]>;

/** The only scheme an MCP App may read through this proxy. It matches the `_meta.ui` contract: a `ui://` resource IS the
 * card surface, and nothing else on the server is reachable from inside the sandbox. */
const MCP_UI_URI_PREFIX = "ui://";

export interface OnReadResourceDeps {
  /** The MCP server whose partition + policy already gated this card. */
  serverId: string;
}

export function createOnReadResource({ serverId }: OnReadResourceDeps): OnReadResource {
  return async ({ uri }) => {
    if (typeof uri !== "string" || !uri.startsWith(MCP_UI_URI_PREFIX)) {
      throw new Error("resources/read is restricted to ui:// resources");
    }
    const bundle = await window.ave.mcp.readUiResource(serverId, uri);
    return {
      contents: [{ uri, mimeType: "text/html;profile=mcp-app", text: bundle.html }],
    };
  };
}

/** Reuse the host's effect-gated external opener, including scheme validation; do not add an ungated navigation sink. */
export type OnOpenLink = NonNullable<AppBridge["onopenlink"]>;

export interface OnOpenLinkDeps {
  /** Open an external URL through the host's existing gated egress path. Resolves `{ ok: true }` when main accepted + opened
   * the URL, `{ ok: false }` when it was rejected (bad scheme, malformed URL, or a denied effect). */
  openLink(url: string): Promise<{ ok: boolean }>;
}

export function createOnOpenLink({ openLink }: OnOpenLinkDeps): OnOpenLink {
  return async ({ url }) => {
    const result = await openLink(url);
    // Spec `McpUiOpenLinkResult`: `{}` = opened, `{ isError: true }` = host declined.
    return result?.ok ? {} : { isError: true };
  };
}

/** Forward untrusted size values unchanged; clamp once at the pixel sink in McpAppView, not in this protocol adapter. */
export type OnSizeChange = NonNullable<AppBridge["onsizechange"]>;

export interface OnSizeChangeDeps {
  /** Apply a content-driven size change to the card. The sink is where the bound lives: it clamps the reported numbers into
   * the card-size SoT before they reach layout. */
  onResize(next: { width?: number; height?: number }): void;
}

export function createOnSizeChange({ onResize }: OnSizeChangeDeps): OnSizeChange {
  return ({ width, height }) => {
    onResize({ width, height });
  };
}

/** The trusted renderer binds server identity and main verifies tool ownership and consent. Return denials as isError tool
 * results, never protocol failures. */
export type OnCallTool = NonNullable<AppBridge["oncalltool"]>;

/** The `CallToolResult` this handler returns (spec shape, derived off the bridge). */
type CallToolResult = Awaited<ReturnType<OnCallTool>>;

export interface OnCallToolDeps {
  /**
   * Run a tool on the card's OWN server through the host's gated IPC. Already bound
   * to the card's `serverId` by McpAppView — this handler cannot choose a server.
   * Resolves to an outcome; a `{ ok: false }` is a host DENIAL or a tool error.
   */
  callTool(name: string, args: Record<string, unknown>): Promise<McpUiToolCallOutcome>;
}

/** MCP-style error result — what the app gets for any denial or failure. */
function errorResult(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

/**
 * Render the host tool layer's raw value as a text content block. The host executor's
 * result contract is a rendered string (external MCP tools) or an arbitrary plugin
 * return value (loopback) — it does not carry MCP content blocks, so we do not
 * fabricate typed blocks the host never produced.
 */
function textBlock(result: unknown): { type: "text"; text: string } {
  if (typeof result === "string") return { type: "text", text: result };
  if (result === undefined || result === null) return { type: "text", text: "" };
  try {
    return { type: "text", text: JSON.stringify(result) ?? String(result) };
  } catch {
    return { type: "text", text: String(result) };
  }
}

export function createOnCallTool({ callTool }: OnCallToolDeps): OnCallTool {
  return async ({ name, arguments: args }) => {
    let outcome: McpUiToolCallOutcome;
    try {
      outcome = await callTool(name, args ?? {});
    } catch (err) {
      // The IPC itself failed (transport / unauthorized frame throw). Still an error RESULT, never a rejected bridge request.
      return errorResult(errorMessage(err));
    }
    if (!outcome.ok) return errorResult(outcome.message ?? outcome.error);
    return { content: [textBlock(outcome.result)] };
  };
}

/** Bind server and origin session in the trusted renderer; main owns notification/guidance/staging policy and never wakes
 * the model autonomously. Return only isError status, never conversation content. */
export type OnMessage = NonNullable<AppBridge["onmessage"]>;

/** The `McpUiMessageResult` this handler returns (spec shape, derived off the bridge). */
type McpUiMessageResult = Awaited<ReturnType<OnMessage>>;

export interface OnMessageDeps {
  /**
   * Deliver the app's `ui/message` params through the host's gated IPC. Already bound
   * to the card's `serverId` + origin session id by McpAppView — this handler cannot
   * choose either. Resolves to an outcome; `{ ok: false }` is a host rejection.
   */
  postMessage(params: unknown): Promise<McpUiMessageOutcome>;
}

export function createOnMessage({ postMessage }: OnMessageDeps): OnMessage {
  return async (params) => {
    try {
      const outcome = await postMessage(params);
      // Accept → `{}`. Reject → `{ isError: true }`. No content, no reason: the app is told whether the host took it, never what
      // the conversation contains.
      return outcome.ok ? {} : ({ isError: true } satisfies McpUiMessageResult);
    } catch {
      // The IPC itself failed (transport / unauthorized frame). Still an error RESULT, never a rejected bridge request.
      return { isError: true } satisfies McpUiMessageResult;
    }
  };
}

/** Accept only the shared advertised mode set and return the actual applied mode; unsupported modes resolve to the current
 * mode without throwing. */
export type OnRequestDisplayMode = NonNullable<AppBridge["onrequestdisplaymode"]>;

export interface OnRequestDisplayModeDeps {
  /** The card's CURRENT display mode, read at call time (McpAppView owns the state). */
  getMode(): McpUiDisplayMode;
  /** Apply a SUPPORTED mode to this card's surface. Resolves to the mode actually applied — which is the previous one when
   * the host declined. Never called for an unsupported mode. */
  applyMode(mode: McpUiDisplayMode): Promise<McpUiDisplayMode>;
}

export function createOnRequestDisplayMode(
  { getMode, applyMode }: OnRequestDisplayModeDeps,
): OnRequestDisplayMode {
  return async ({ mode }) => {
    // Not advertised ⇒ not applied. Answer with the mode the card is actually in.
    if (!isSupportedMcpAppDisplayMode(mode)) return { mode: getMode() };
    try {
      return { mode: await applyMode(mode) };
    } catch {
      // The apply path failed (IPC transport / unauthorized frame throw). The card did not move, so the truthful answer is the
      // mode it is still in.
      return { mode: getMode() };
    }
  };
}

/** Main bounds and saves through a dialog; reject resource links rather than navigating from the host frame. Saved and
 * cancelled map to {}; rejections expose only isError:true. */
export type OnDownloadFile = NonNullable<AppBridge["ondownloadfile"]>;

/** The `McpUiDownloadFileResult` this handler returns (spec shape, derived off the bridge). */
type McpUiDownloadFileResult = Awaited<ReturnType<OnDownloadFile>>;

export interface OnDownloadFileDeps {
  /**
   * Hand the app's `ui/download-file` params to the host's gated IPC. Already bound to
   * the card's `serverId` by McpAppView — this handler cannot choose a server. Resolves
   * to an outcome; `{ ok: false }` is a host rejection, and a user cancel is `ok: true`.
   */
  downloadFile(params: unknown): Promise<McpUiDownloadOutcome>;
}

export function createOnDownloadFile({ downloadFile }: OnDownloadFileDeps): OnDownloadFile {
  return async (params) => {
    try {
      const outcome = await downloadFile(params);
      // saved → `{}`. cancelled → `{}` (the user declined; nothing failed). rejected → `{ isError: true }`, with no reason
      // attached.
      return outcome.ok ? {} : ({ isError: true } satisfies McpUiDownloadFileResult);
    } catch {
      // The IPC itself failed (transport / unauthorized frame). Still an error RESULT, never a rejected bridge request.
      return { isError: true } satisfies McpUiDownloadFileResult;
    }
  };
}

/** Bind server, origin session and card id in trusted code; update only that context slot and never trigger a turn. Always
 * return {}; refusals are audit facts because EmptyResult has no error channel. */
export type OnUpdateModelContext = NonNullable<AppBridge["onupdatemodelcontext"]>;

/** The `EmptyResult` this handler returns (spec shape, derived off the bridge). */
type EmptyResult = Awaited<ReturnType<OnUpdateModelContext>>;

export interface OnUpdateModelContextDeps {
  /** Hand the app's `ui/update-model-context` params to the host's gated IPC. Already bound to the card's `serverId` + origin
   * session id + card id by McpAppView — this handler cannot choose any of them. */
  updateModelContext(params: unknown): Promise<McpUiModelContextOutcome>;
}

export function createOnUpdateModelContext(
  { updateModelContext }: OnUpdateModelContextDeps,
): OnUpdateModelContext {
  return async (params) => {
    try {
      await updateModelContext(params);
    } catch {
      // The IPC itself failed (transport / unauthorized frame throw). Still an empty RESULT, never a rejected bridge request —
      // see the header.
    }
    return {} satisfies EmptyResult;
  };
}
