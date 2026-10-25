/** Wire category claims cannot lower risk; all plugin tools register with a strict baseline.
 * Effective risk is derived by the host for each invocation. */
import { describe, it, expect, vi } from "vitest";
import { PluginMcpHost } from "../plugin-mcp-host.js";
import { ToolRegistry } from "../../tools/registry.js";
import type { PluginToolDelegate } from "../plugin-mcp-server.js";
import type { PluginManifest } from "../../plugins/types.js";

const MANIFEST: PluginManifest = {
  id: "com.example.mixed",
  name: "Mixed",
  version: "3.1.0",
  entry: "dist/index.js",
  description: "mixed-shape ops",
  tools: [
    {
      name: "mixed_read",
      description: "read-shaped op",
      inputSchema: { type: "object", properties: { q: { type: "string" } } },
      _meta: { ui: { visibility: ["model"] } },
    },
    {
      name: "mixed_write",
      description: "write-shaped op",
      inputSchema: { type: "object", properties: { body: { type: "string" } } },
      _meta: { ui: { visibility: ["model"] } },
    },
    {
      name: "mixed_undeclared",
      description: "no wire category",
      inputSchema: { type: "object", properties: { q: { type: "string" } } },
      _meta: { ui: { visibility: ["model"] } },
    },
  ],
};

const okDelegate: PluginToolDelegate = vi.fn(async (name) => ({
  content: [{ type: "text", text: `ran ${name}` }],
}));

describe("#885 v6 — loopback plugin tools register write-equivalent (category is host-derived)", () => {
  it("registers the whole plugin, and EVERY tool at the write-equivalent baseline (never silently read)", async () => {
    const registry = new ToolRegistry();
    const host = PluginMcpHost.loopback(
      MANIFEST,
      okDelegate,
      undefined,
      "test-generation",
    );
    const tools = await host.prepareTools();
    registry.reservePluginReplacement(MANIFEST.id, tools, []).publish();
    host.publishPrepared(tools);
    const registered = tools.map((tool) => tool.name);
    expect(registered).toEqual(["mixed_read", "mixed_write", "mixed_undeclared"]);

    for (const name of registered) {
      const tool = registry.findByName(name);
      expect(tool?.source).toBe("plugin");
      expect(tool?.category).toBe("write");
      expect(tool?.category).not.toBe("read");
      expect(tool?.isReadOnly({})).toBe(false);
    }
  });
});
