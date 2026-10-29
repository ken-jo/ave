import { PluginMcpHost } from "../plugin-mcp-host.js";
import type { PluginToolDelegate } from "../plugin-mcp-server.js";
import type { PluginManifest } from "../../plugins/types.js";
import type { ToolRegistry } from "../../tools/registry.js";

export function testLoopbackHost(
  manifest: PluginManifest,
  delegate: PluginToolDelegate,
  _registry: ToolRegistry,
  uiResources?: Parameters<typeof PluginMcpHost.loopback>[2],
  generationId = "test-generation",
): PluginMcpHost {
  return PluginMcpHost.loopback(manifest, delegate, uiResources, generationId);
}

export async function publishTestHost(
  host: PluginMcpHost,
  pluginId: string,
  registry: ToolRegistry,
): Promise<string[]> {
  const tools = await host.prepareTools();
  registry.reservePluginReplacement(pluginId, tools, []).publish();
  host.publishPrepared(tools);
  return tools.map((tool) => tool.name);
}
