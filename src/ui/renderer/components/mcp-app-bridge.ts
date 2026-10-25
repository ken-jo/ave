/** UI handshake tests import this shipping bridge wiring so transport and connection regressions cannot hide behind a
 * reimplementation. */
import { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
// `McpUiHostContext` comes from the local standard-type twin, not the package —
// a drift-safety/hygiene choice for types, not a strict compile necessity (see
// mcp-app-host-context.ts for the full rationale, including the concrete
// extensionless-chain errors this file's `AppBridge` value import interacted with).
import type { McpUiHostContext } from "./mcp-app-host-context.js";
import type { McpUiPayload, McpUiToolCallOutcome } from "../../../mcp/types.js";
import { MCP_APP_HOST_INFO } from "../../../shared/mcp-app-bridge-contract.js";
import { WebviewIpcTransport, type BridgeWebviewElement } from "./webview-ipc-transport.js";
import {
  createOnSandboxReady,
  createOnReadResource,
  createOnOpenLink,
  createOnSizeChange,
  createOnCallTool,
  createOnMessage,
  createOnRequestDisplayMode,
  createOnDownloadFile,
  createOnUpdateModelContext,
} from "./mcp-app-bridge/handlers.js";
import type { McpUiMessageOutcome } from "../../../mcp/mcp-ui-message.js";
import type { McpUiDownloadOutcome } from "../../../mcp/mcp-app-download.js";
import type { McpUiModelContextOutcome } from "../../../mcp/mcp-app-model-context.js";
import type { McpUiDisplayMode } from "../../../shared/mcp-app-display-mode.js";

/** The exact `McpUiHostCapabilities` shape the `AppBridge` ctor's 3rd arg expects, derived off the resolvable class value.
 * (A direct named import of `McpUiHostCapabilities` collapses under NodeNext — see the handler modules.) */
type McpAppHostCapabilities = ConstructorParameters<typeof AppBridge>[2];

/** React-owned adapters injected by McpAppView. This module stays React-free (the e2e gate imports it), so any handler that
 * needs renderer state or a preload surface receives it here rather than reaching for React/globals. */
export interface McpAppBridgeDeps {
  /**
   * `onsizechange` sink — the app reported a content-driven size. McpAppView owns the
   * live card dimensions (React state) and CLAMPS them there, through the shared
   * card-size SoT (`shared/mcp-app-card-size.ts`): non-finite / ≤ 0 values are refused
   * and the rest are bounded, because nothing in CSS can bound them (the card's
   * containing block has an indefinite height, so a percentage max-height caps nothing).
   */
  onResize(next: { width?: number; height?: number }): void;
  /** `onopenlink` opener — routes an external URL through the host's existing effect-gated egress path
   * (`window.aveApi.openExternalUrl`). Resolves `{ ok: true }` when opened, `{ ok: false }` when the host declined. */
  openLink(url: string): Promise<{ ok: boolean }>;
  /** Bind tool calls to the card's server through gated host IPC; return denials as tool error outcomes. */
  callTool(name: string, args: Record<string, unknown>): Promise<McpUiToolCallOutcome>;
  /** Bind messages to the card's server and origin session; main chooses delivery policy and never returns conversation
   * content. */
  postMessage(params: unknown): Promise<McpUiMessageOutcome>;
  /** `onrequestdisplaymode` reader — the card's CURRENT mode. McpAppView owns the state; the handler answers with this
   * whenever it did not (or could not) move the card, which is the spec's contract for an unavailable mode. */
  getDisplayMode(): McpUiDisplayMode;
  /** Move the card through the shared location store, retiring the losing bridge before the gaining mount connects; report
   * only the mode actually applied. */
  applyDisplayMode(mode: McpUiDisplayMode): Promise<McpUiDisplayMode>;
  /**
   * `ondownloadfile` sink — the app asked the host to save inline bytes it already
   * possessed. Routed through the host's gated `CHANNELS.mcp.uiDownloadFile` IPC, which
   * McpAppView binds to the card's `serverId`. Main decodes + bounds the payload, REJECTS
   * any `resource_link` (the host never fetches an app-supplied URI), and puts the user's
   * own save dialog in front of the write. A cancel resolves `{ ok: true }` — declining
   * to save is not an error.
   */
  downloadFile(params: unknown): Promise<McpUiDownloadOutcome>;
  /**
   * `onupdatemodelcontext` sink — the app OVERWROTE the context it wants the model to
   * have NEXT turn. Routed through the host's gated `CHANNELS.mcp.uiModelContext` IPC,
   * which McpAppView binds to the card's `serverId`, its origin session, and its card id.
   * Main stores it as untrusted DATA in that card's one slot; the slot is read at the
   * next prompt build, so this can never start a turn.
   */
  updateModelContext(params: unknown): Promise<McpUiModelContextOutcome>;
}

/** Pass null as the first bridge constructor argument; the real client stays in main and must not enter the renderer
 * bundle. Use singular handler setters while extensionless declaration imports hide inherited event methods under
 * NodeNext. */
export function createMcpAppBridge(
  payload: Pick<McpUiPayload, "serverId">,
  html: string,
  el: BridgeWebviewElement,
  hostContext: McpUiHostContext,
  deps: McpAppBridgeDeps,
): { bridge: AppBridge; transport: WebviewIpcTransport; connected: Promise<void> } {
  const transport = new WebviewIpcTransport(el);

  // Derive advertised capabilities and handler registration from one table; register after construction and before connect.
  const handlers: Array<{
    capability?: McpAppHostCapabilities;
    register(bridge: AppBridge): void;
  }> = [
    // Sandbox handshake (internal notification — no advertised capability).
    {
      register: (bridge) => {
        bridge.onsandboxready = createOnSandboxReady({ bridge, html });
      },
    },
    // `resources/read` proxy → advertises `serverResources`.
    {
      capability: { serverResources: {} },
      register: (bridge) => {
        bridge.onreadresource = createOnReadResource({ serverId: payload.serverId });
      },
    },
    // `tools/call` on the card's OWN server → advertises `serverTools`. The handler
    // gets the serverId-BOUND invoker (McpAppView closed it over `payload.serverId`),
    // so the app names only a tool; main re-verifies the tool is owned by that server
    // and runs it through the host's risk/consent gate.
    {
      capability: { serverTools: {} },
      register: (bridge) => {
        bridge.oncalltool = createOnCallTool({ callTool: deps.callTool });
      },
    },
    // `ui/message` → advertises `message: { text: {} }` (text only: the host takes no
    // other content kind into a turn). The handler gets the serverId- AND session-BOUND
    // poster (McpAppView closed over both), so the app addresses neither a server nor a
    // conversation; main owns the turn policy and answers `{ isError? }` only.
    {
      capability: { message: { text: {} } },
      register: (bridge) => {
        bridge.onmessage = createOnMessage({ postMessage: deps.postMessage });
      },
    },
    // `ui/update-model-context` → advertises `updateModelContext: { text, structuredContent }`
    // — exactly the two modalities main SERIALIZES into the prompt (text blocks, and
    // structured content as fenced JSON). Advertising `image`/`audio`/`resource` here
    // would invite a payload the host silently drops.
    {
      capability: { updateModelContext: { text: {}, structuredContent: {} } },
      register: (bridge) => {
        bridge.onupdatemodelcontext = createOnUpdateModelContext({
          updateModelContext: deps.updateModelContext,
        });
      },
    },
    // `ui/download-file` → advertises `downloadFile`. The handler gets the serverId-BOUND
    // sink; main decodes the INLINE bytes, rejects any `resource_link` (the host does not
    // fetch app-supplied URIs), and the user's save dialog authorizes the write.
    {
      capability: { downloadFile: {} },
      register: (bridge) => {
        bridge.ondownloadfile = createOnDownloadFile({ downloadFile: deps.downloadFile });
      },
    },
    // `ui/open-link` → advertises `openLinks`.
    {
      capability: { openLinks: {} },
      register: (bridge) => {
        bridge.onopenlink = createOnOpenLink({ openLink: deps.openLink });
      },
    },
    // Display modes advertise through host-context availableDisplayModes; the capability interface has no display-mode key.
    {
      register: (bridge) => {
        bridge.onrequestdisplaymode = createOnRequestDisplayMode({
          getMode: deps.getDisplayMode,
          applyMode: deps.applyDisplayMode,
        });
      },
    },
    // `ui/notifications/size-changed` (View → Host notification — no capability).
    {
      register: (bridge) => {
        bridge.onsizechange = createOnSizeChange({ onResize: deps.onResize });
      },
    },
  ];

  const capabilities = handlers.reduce<McpAppHostCapabilities>(
    (acc, handler) => (handler.capability ? { ...acc, ...handler.capability } : acc),
    {},
  );

  const bridge = new AppBridge(
    null,
    MCP_APP_HOST_INFO,
    capabilities,
    // Standard ext-apps 4th-arg options: seed the initial host context (theme / styles / locale / timeZone / platform). Live
    // updates go through `bridge.setHostContext(...)` on the McpAppView side.
    { hostContext },
  );

  // Register EVERY handler before `connect()` — a late assignment would race the guest's first frames (the relay preload
  // announces sandbox-proxy-ready the moment the proxy document loads, which can beat `connect()`).
  for (const handler of handlers) handler.register(bridge);

  return { bridge, transport, connected: bridge.connect(transport) };
}
