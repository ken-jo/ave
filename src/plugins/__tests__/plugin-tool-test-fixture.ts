/** Build tool fixtures through the production projection, authority and lint path without a transport round-trip. */
import { manifestToolsToMcpTools } from "../../mcp/plugin-server-projection.js";
import { mcpToolToPluginTool } from "../../mcp/plugin-tool-from-mcp.js";
import { pluginRuntimeToolDelegate } from "../../mcp/plugin-runtime-delegate.js";
import { lintToolInputSchema } from "../tool-schema-lint.js";
import type { Tool } from "../../tools/base.js";
import type { PluginRuntime } from "../runtime.js";
import type { PluginManifest } from "../types.js";

const RAW_RESULT_META = "ave/rawResult";

export function buildPluginToolsForTest(
  pluginRuntime: PluginRuntime,
  pluginId: string,
  manifest: PluginManifest,
): Tool[] {
  const delegate = pluginRuntimeToolDelegate(pluginRuntime, pluginId);
  const invoke = async (name: string, args: Record<string, unknown>) => {
    const outcome = await delegate(name, args);
    const text = outcome.content.map((c) => c.text ?? JSON.stringify(c)).join("\n");
    if (outcome.isError) throw new Error(text);
    const meta = outcome._meta;
    const rawResult =
      meta && Object.prototype.hasOwnProperty.call(meta, RAW_RESULT_META)
        ? { value: meta[RAW_RESULT_META] }
        : undefined;
    return { text, rawResult };
  };

  const tools: Tool[] = [];
  for (const mcpTool of manifestToolsToMcpTools(manifest)) {
    // Match host order: project tools before strict lint; invalid categories default to write-equivalent risk.
    const built = mcpToolToPluginTool(pluginId, mcpTool, invoke);
    if (lintToolInputSchema(mcpTool.inputSchema).length > 0) continue;
    tools.push(built);
  }
  return tools;
}
