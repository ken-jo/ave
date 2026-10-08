/**
 * Main-process enforcement of the guest `<webview>`s' security preferences:
 * plugin frames, MCP app frames, and the main window's routing between them
 * and the side browser.
 *
 * (History of the plugin guard below.)
 *
 * The renderer sets `webpreferences="contextIsolation=yes,nodeIntegration=no,
 * sandbox=yes"` on the element. That is a REQUEST. Until this guard existed it
 * was also the only control, and it has two failure modes that produce no
 * error at all:
 *
 *  - it is a string. A mistyped key or value is ignored by Electron and the
 *    preference silently falls back to its default. Nothing logs, nothing
 *    throws, and the plugin frame comes up weaker than the attribute claims.
 *  - it is a DOM attribute in the host renderer, so it is only as trustworthy
 *    as the host renderer. Code running there can rewrite it before attach.
 *
 * The side-browser webview never depended on the attribute: its attach handler
 * overwrites the preferences in main. Plugin partitions took the early
 * `"ignored"` return from that handler and so had no equivalent — the pattern
 * existed, it just did not cover the frame that hosts third-party code.
 *
 * Overwrites rather than validates. Rejecting a bad request would leave the
 * decision with the caller; setting the value means the answer does not depend
 * on what was asked for.
 */
import { MCP_APP_PARTITION_PREFIX, MCP_APP_SCHEME } from "../shared/mcp-app-partition.js";
import { isPluginPartitionName } from "../shared/plugin-partition.js";
import { PRELOAD_BUNDLES } from "../shared/preload-bundles.js";
import { configureSideBrowserWebviewAttach } from "./side-browser-webview.js";

export type PluginWebviewAttachResult = "ignored" | "enforced";

export function configurePluginWebviewAttach(input: {
  webPreferences: Record<string, unknown>;
  params: Record<string, string>;
}): PluginWebviewAttachResult {
  if (!isPluginPartitionName(input.params.partition ?? "")) return "ignored";

  // Node reachability, in every form it comes in. `nodeIntegration` alone
  // leaves workers and subframes, which are separate preferences.
  input.webPreferences.nodeIntegration = false;
  input.webPreferences.nodeIntegrationInWorker = false;
  input.webPreferences.nodeIntegrationInSubFrames = false;

  // The isolated world is what keeps the plugin's page scripts away from the
  // `avePlugin` bridge object and its closure over `ipcRenderer`.
  input.webPreferences.contextIsolation = true;
  // From the one preload table: the build gate holds `plugin-preload.cjs` to the same mode.
  input.webPreferences.sandbox = PRELOAD_BUNDLES.pluginPreload.sandbox;
  input.webPreferences.webSecurity = true;

  // A plugin frame has no business embedding further guest views; allowing it
  // would let a plugin attach a webview whose preferences this guard has no
  // handler for.
  input.webPreferences.webviewTag = false;

  return "enforced";
}

export type McpAppWebviewAttachResult = "ignored" | "enforced" | "blocked";

/**
 * An MCP app guest: a `ave-mcp-app:<hex>` partition whose first document is
 * the host's sandbox proxy for the same server (`ave-mcp-app://<hex>/…`).
 *
 * The relay preload rides the partition's session
 * (`installMcpAppPartitionPolicy`), so the element never names one: any
 * `preload` it asks for is dropped. The guest runs in the sandbox the preload
 * table gives that relay, isolated and without Node, whatever the renderer's
 * `webpreferences` attribute said — the attribute is a request from the host
 * renderer, and until this guard the main window attached these guests with
 * whatever it asked for. A guest whose partition or first URL is not one
 * server's proxy is refused.
 */
export function configureMcpAppWebviewAttach(input: {
  event: { preventDefault: () => void };
  webPreferences: Record<string, unknown>;
  params: Record<string, string>;
}): McpAppWebviewAttachResult {
  const partition = input.params.partition ?? "";
  if (!partition.startsWith(MCP_APP_PARTITION_PREFIX)) return "ignored";

  const token = partition.slice(MCP_APP_PARTITION_PREFIX.length);
  if (!/^(?:[0-9a-f]{2})+$/u.test(token) || proxyHost(input.params.src ?? "") !== token) {
    input.event.preventDefault();
    return "blocked";
  }

  delete input.webPreferences.preload;
  delete input.webPreferences.preloadURL;
  delete input.webPreferences.additionalArguments;
  input.webPreferences.nodeIntegration = false;
  input.webPreferences.nodeIntegrationInWorker = false;
  input.webPreferences.nodeIntegrationInSubFrames = false;
  input.webPreferences.contextIsolation = true;
  // From the one preload table: the build gate holds `mcp-app-preload.cjs` to the same mode.
  input.webPreferences.sandbox = PRELOAD_BUNDLES.mcpAppPreload.sandbox;
  input.webPreferences.webSecurity = true;
  input.webPreferences.webviewTag = false;
  return "enforced";
}

/** The server token a sandbox-proxy URL names, or null when `src` is not one. */
function proxyHost(src: string): string | null {
  try {
    const url = new URL(src);
    return url.protocol === `${MCP_APP_SCHEME}:` ? url.host : null;
  } catch {
    return null;
  }
}

export type MainWindowWebviewAttachResult =
  | { owner: "plugin" | "mcp-app" | "side-browser"; result: "enforced" | "accepted" | "blocked" }
  | { owner: null; result: "refused" };

/**
 * The main window's `will-attach-webview` policy. Every guest it hosts belongs
 * to a guard that sets its preferences in main: plugin frames, MCP app frames
 * and the side browser. A guest on any other partition is refused rather than
 * attached with the renderer's request (Electron's checklist: verify a
 * `<webview>`'s options before it is created).
 */
export function configureMainWindowWebviewAttach(input: {
  event: { preventDefault: () => void };
  webPreferences: Record<string, unknown>;
  params: Record<string, string>;
  enqueueSideBrowserSrc: (src: string) => void;
}): MainWindowWebviewAttachResult {
  if (configurePluginWebviewAttach(input) === "enforced") return { owner: "plugin", result: "enforced" };

  const mcpApp = configureMcpAppWebviewAttach(input);
  if (mcpApp !== "ignored") return { owner: "mcp-app", result: mcpApp };

  const sideBrowser = configureSideBrowserWebviewAttach({ ...input, enqueueAllowedSrc: input.enqueueSideBrowserSrc });
  if (sideBrowser !== "ignored") return { owner: "side-browser", result: sideBrowser };

  input.event.preventDefault();
  return { owner: null, result: "refused" };
}
