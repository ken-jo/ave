import type { PluginUiExtension } from "../plugins/public-contract.js";
import type { McpUiPayload } from "../mcp/types.js";

/** Host placement metadata and immutable server identity for one standard app resource. */
export interface PluginUiExtensionView {
  pluginId: string;
  icon?: string;
  iconText?: string;
  extension: PluginUiExtension & { slot: "sidebar" };
  payload: McpUiPayload;
  runtimeRevision: number;
}
