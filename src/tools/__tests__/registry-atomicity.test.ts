import { describe, expect, it } from "vitest";
import { createDynamicTool, type Tool } from "../base.js";
import { ToolRegistry } from "../registry.js";

function tool(name: string, serverId: string): Tool {
  return createDynamicTool({
    name,
    description: `${name} from ${serverId}`,
    source: "mcp",
    category: "network",
    mcpServerId: serverId,
    jsonSchema: { type: "object", properties: {} },
    execute: async () => ({ output: serverId, isError: false }),
  });
}

function pluginTool(name: string, pluginId: string): Tool {
  return createDynamicTool({
    name,
    description: `${name} from ${pluginId}`,
    source: "plugin",
    category: "read",
    pluginId,
    jsonSchema: { type: "object", properties: {} },
    execute: async () => ({ output: pluginId, isError: false }),
  });
}

describe("ToolRegistry MCP generation replacement", () => {
  it("keeps the predecessor live until one exact synchronous publish", () => {
    const registry = new ToolRegistry();
    const predecessor = tool("mcp_portal_read", "server-g1");
    const unrelated = tool("mcp_other_read", "other-server");
    registry.registerBatch([predecessor, unrelated]);

    const candidate = tool("mcp_portal_read", "server-g2");
    const prepared = registry.reserveMcpReplacement(["server-g1"], [candidate]);
    expect(registry.findByName("mcp_portal_read")?.mcpServerId).toBe("server-g1");
    expect(() => registry.register(tool("mcp_portal_read", "racer"))).toThrow(/reserved/);

    prepared.publish();
    expect(registry.findByName("mcp_portal_read")?.mcpServerId).toBe("server-g2");
    expect(registry.findByName("mcp_other_read")?.mcpServerId).toBe("other-server");
    registry.unregisterByMcp("server-g1");
    expect(registry.findByName("mcp_portal_read")?.mcpServerId).toBe("server-g2");
  });

  it("leaves the live registry unchanged when candidate validation fails", () => {
    const registry = new ToolRegistry();
    registry.register(tool("mcp_portal_read", "server-g1"));
    registry.register(createDynamicTool({
      name: "collision",
      description: "builtin",
      source: "builtin",
      category: "read",
      jsonSchema: { type: "object", properties: {} },
      execute: async () => ({ output: "ok", isError: false }),
    }));

    expect(() => registry.reserveMcpReplacement(
      ["server-g1"],
      [tool("collision", "server-g2")],
    )).toThrow(/collision/);
    expect(registry.findByName("mcp_portal_read")?.mcpServerId).toBe("server-g1");
    expect(registry.findByName("collision")?.source).toBe("builtin");
  });

  it("blocks an unrelated bulk plugin replacement from stealing a reserved MCP name", () => {
    const registry = new ToolRegistry();
    registry.register(tool("mcp_portal_read", "server-g1"));
    const prepared = registry.reserveMcpReplacement(
      ["server-g1"],
      [tool("mcp_portal_read", "server-g2")],
    );

    expect(() => registry.replacePluginTools(
      ["racer"],
      [pluginTool("mcp_portal_read", "racer")],
    )).toThrow(/reserved/);

    prepared.publish();
    expect(registry.findByName("mcp_portal_read")?.mcpServerId).toBe("server-g2");
  });

  it("blocks an unrelated bulk plugin replacement from stealing a reserved plugin name", () => {
    const registry = new ToolRegistry();
    registry.register(pluginTool("plugin_portal_read", "sampleportal"));
    const prepared = registry.reservePluginReplacement(
      "sampleportal",
      [pluginTool("plugin_portal_read", "sampleportal")],
    );

    expect(() => registry.replacePluginTools(
      ["racer"],
      [pluginTool("plugin_portal_read", "racer")],
    )).toThrow(/reserved/);

    prepared.publish();
    expect(registry.findByName("plugin_portal_read")?.pluginId).toBe("sampleportal");
  });

  it("publishes only prepared names and preserves unrelated registrations made while reserved", () => {
    const registry = new ToolRegistry();
    registry.register(pluginTool("plugin_portal_read", "sampleportal"));
    const prepared = registry.reservePluginReplacement(
      "sampleportal",
      [pluginTool("plugin_portal_write", "sampleportal")],
    );

    registry.register(pluginTool("other_read", "other-plugin"));
    prepared.publish();

    expect(registry.findByName("plugin_portal_read")).toBeUndefined();
    expect(registry.findByName("plugin_portal_write")?.pluginId).toBe("sampleportal");
    expect(registry.findByName("other_read")?.pluginId).toBe("other-plugin");
  });

  it.each(["publish", "cancel"] as const)("releases runtime-only method claims on %s without exposing tools", (settle) => {
    const registry = new ToolRegistry();
    const prepared = registry.reservePluginReplacement("first-plugin", [], [], ["runtime_method"]);

    expect(prepared.replacementTools).toEqual([]);
    expect(registry.findByName("runtime_method")).toBeUndefined();
    expect(() => registry.reservePluginReplacement("second-plugin", [], [], ["runtime_method"]))
      .toThrow("Tool name is already reserved: runtime_method");
    expect(() => registry.register(pluginTool("runtime_method", "second-plugin"))).toThrow(/reserved/);
    const unrelated = registry.reservePluginReplacement("second-plugin", [pluginTool("other_method", "second-plugin")]);
    unrelated.publish();

    prepared[settle]();
    expect(registry.findByName("runtime_method")).toBeUndefined();
    expect(registry.findByName("other_method")?.pluginId).toBe("second-plugin");
    const next = registry.reservePluginReplacement("second-plugin", [], [], ["runtime_method"]);
    prepared.cancel();
    expect(() => registry.reservePluginReplacement("third-plugin", [], [], ["runtime_method"]))
      .toThrow("Tool name is already reserved: runtime_method");
    next.cancel();
  });
});
