// Overwrite security preferences in main: renderer attributes are mutable and invalid values silently revert to defaults.
import { MCP_APP_PARTITION_PREFIX, MCP_APP_SCHEME } from "../shared/mcp-app-partition.js";
import { isPluginPartitionName } from "../shared/plugin-partition.js";
import { PRELOAD_BUNDLES } from "../shared/preload-bundles.js";
import { configureSideBrowserWebviewAttach } from "./side-browser-webview.js";
import { hardenRemoteWebPreferences } from "./remote-browser-preferences.js";

export type AuthWebviewAttachResult = "enforced" | "blocked";

// The login shell embeds only its own authorization URL, as a remote page in the login partition.
export function configureAuthWebviewAttach(input: {
  event: { preventDefault: () => void };
  webPreferences: Record<string, unknown>;
  params: Record<string, string>;
  url: string;
  partition: string;
}): AuthWebviewAttachResult {
  if (input.params.src !== input.url) {
    input.event.preventDefault();
    return "blocked";
  }
  hardenRemoteWebPreferences(input.webPreferences);
  input.webPreferences.partition = input.partition;
  return "enforced";
}

export type PluginWebviewAttachResult = "ignored" | "enforced";

export function configurePluginWebviewAttach(input: {
  webPreferences: Record<string, unknown>;
  params: Record<string, string>;
}): PluginWebviewAttachResult {
  if (!isPluginPartitionName(input.params.partition ?? "")) return "ignored";

  // Node reachability, in every form it comes in. `nodeIntegration` alone leaves workers and subframes, which are separate preferences.
  input.webPreferences.nodeIntegration = false;
  input.webPreferences.nodeIntegrationInWorker = false;
  input.webPreferences.nodeIntegrationInSubFrames = false;

  // The isolated world is what keeps the plugin's page scripts away from the `avePlugin` bridge object and its closure over `ipcRenderer`.
  input.webPreferences.contextIsolation = true;
  // From the one preload table: the build gate holds `plugin-preload.cjs` to the same mode.
  input.webPreferences.sandbox = PRELOAD_BUNDLES.pluginPreload.sandbox;
  input.webPreferences.webSecurity = true;

  // A plugin frame has no business embedding further guest views; allowing it would let a plugin attach a webview whose preferences this guard has no handler for.
  input.webPreferences.webviewTag = false;

  return "enforced";
}

export type McpAppWebviewAttachResult = "ignored" | "enforced" | "blocked";

// Accept only matching server proxy URL/partition pairs and overwrite sandbox preferences in main.
// Drop element preloads; the host-owned relay comes only from the session preload table.
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

// The server token a sandbox-proxy URL names, or null when `src` is not one.
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

// Every guest must belong to a guard that enforces preferences in main; refuse unowned partitions before attachment.
export function configureMainWindowWebviewAttach(input: {
  event: { preventDefault: () => void };
  webPreferences: Record<string, unknown>;
  params: Record<string, string>;
}): MainWindowWebviewAttachResult {
  if (configurePluginWebviewAttach(input) === "enforced") return { owner: "plugin", result: "enforced" };

  const mcpApp = configureMcpAppWebviewAttach(input);
  if (mcpApp !== "ignored") return { owner: "mcp-app", result: mcpApp };

  const sideBrowser = configureSideBrowserWebviewAttach(input);
  if (sideBrowser !== "ignored") return { owner: "side-browser", result: sideBrowser };

  input.event.preventDefault();
  return { owner: null, result: "refused" };
}
