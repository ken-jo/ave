/** Reverse projection retains plugin authority and owned path fields, never wire sandbox or risk claims. */
import { describe, it, expect, vi } from "vitest";
import { mcpToolToPluginTool } from "../plugin-tool-from-mcp.js";
import { manifestToolsToMcpTools } from "../plugin-server-projection.js";
import type { PluginManifest } from "../../plugins/types.js";

const UNKNOWN_META_PREFIX = "xyz.example/";

const PLUGIN_ID = "com.example.files";

const MANIFEST: PluginManifest = {
  id: PLUGIN_ID,
  name: "Files",
  version: "2.3.0",
  entry: "dist/index.js",
  description: "file ops",
  tools: [
    {
      name: "files_read",
      description: "Read a file",
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      _meta: { ui: { visibility: ["model"] }, "ave/pathFields": ["path"] },
    },
    {
      name: "files_write",
      description: "Write a file",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" }, body: { type: "string" } },
        required: ["path"],
      },
      _meta: { ui: { visibility: ["model"] }, "ave/pathFields": ["path"] },
    },
    {
      name: "files_exec",
      description: "Run a command",
      inputSchema: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
      _meta: { ui: { visibility: ["model"] } },
    },
  ],
};

describe("mcpToolToPluginTool — v6 reverse projection from _meta", () => {
  const invoke = vi.fn(async (name: string) => ({ text: `ran ${name}` }));

  it("sources pathFields from _meta and applies the default tool version (removed self-claim fields are gone from the contract)", () => {
    const tools = manifestToolsToMcpTools(MANIFEST).map((t) => mcpToolToPluginTool(PLUGIN_ID, t, invoke));
    const read = tools.find((t) => t.name === "files_read")!;
    const write = tools.find((t) => t.name === "files_write")!;
    const exec = tools.find((t) => t.name === "files_exec")!;

    expect(read.pathFields).toEqual(["path"]);
    expect(write.pathFields).toEqual(["path"]);
    expect(exec.pathFields).toBeUndefined();

    for (const t of tools) {
      expect(t.source).toBe("plugin");
      expect(t.pluginId).toBe(PLUGIN_ID);
      expect(t.category).toBe("write");
      expect(t.isReadOnly({})).toBe(false);
      expect(t.workerId).toBeUndefined();
      expect(t.version).toBe("1.0.0");
    }
  });

  it("round-trips execution through the invoke delegate (tools/call)", async () => {
    const read = mcpToolToPluginTool(PLUGIN_ID, manifestToolsToMcpTools(MANIFEST)[0], invoke);
    const result = await read.execute({ path: "/etc/hosts" }, {} as never);
    expect(invoke).toHaveBeenCalledWith("files_read", { path: "/etc/hosts" });
    expect(result).toEqual({ output: "ran files_read", isError: false });
  });

  it("attaches the validated signed operation policy carried by the MCP Tool", () => {
    const policy = {
      discriminant: "operation" as const,
      operations: { read: { kind: "read" as const, minimumRisk: "read" as const, appVisible: true } },
    };
    const projected = {
      ...manifestToolsToMcpTools(MANIFEST)[0],
      _meta: {
        ...manifestToolsToMcpTools(MANIFEST)[0]._meta,
        "ave/operationPolicy": policy,
      },
    };
    const tool = mcpToolToPluginTool(PLUGIN_ID, projected, invoke, policy);
    expect(tool.operationPolicy).toEqual(policy);
    expect(projected._meta["ave/operationPolicy"]).toEqual(policy);
  });

  it("surfaces a thrown invoke as an isError result (not a throw)", async () => {
    const failing = vi.fn(async () => {
      throw new Error("disk full");
    });
    const tool = mcpToolToPluginTool(PLUGIN_ID, manifestToolsToMcpTools(MANIFEST)[0], failing);
    const result = await tool.execute({ path: "/x" }, {} as never);
    expect(result).toEqual({ output: "disk full", isError: true });
  });

  it("materializes Tool.modelVisible from the wire's _meta.ui.visibility — app-only ⇒ registered but NOT model-exposed", () => {
    // Visibility controls model exposure only; app-only tools still register for risk, approval and audit.
    const manifest: PluginManifest = {
      ...MANIFEST,
      tools: [
        { name: "files_read", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["model"] } } },
        { name: "files_toggle", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["model", "app"] } } },
        { name: "files_ui_rows", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["app"] } } },
      ],
    };
    const tools = manifestToolsToMcpTools(manifest).map((t) => mcpToolToPluginTool(PLUGIN_ID, t, invoke));

    expect(tools.map((t) => t.name)).toEqual(["files_read", "files_toggle", "files_ui_rows"]);
    expect(tools.find((t) => t.name === "files_read")!.modelVisible).toBe(true);
    expect(tools.find((t) => t.name === "files_toggle")!.modelVisible).toBe(true);
    expect(tools.find((t) => t.name === "files_ui_rows")!.modelVisible).toBe(false);
    // callFromApp enforces app visibility; this adapter leaves appInvokable unset.
    for (const t of tools) expect(t.appInvokable).toBeUndefined();
  });

  it("fail-closes to the minimal governed surface when the wire carries no valid visibility", () => {
    // Missing or malformed visibility narrows to model-only, never grants app access.
    for (const _meta of [{}, { ui: { visibility: "app" } }, { ui: { visibility: [] } }, { ui: 7 }]) {
      const tool = mcpToolToPluginTool(
        PLUGIN_ID,
        { name: "rogue", inputSchema: { type: "object", properties: {} }, _meta },
        invoke,
      );
      expect(tool.modelVisible).toBe(true);
    }
  });

  it("#885 v6 — the wire `category` is fully ignored: absent, valid, or malformed all register write-equivalent", () => {
    // Ignore wire category claims so a claimed read category cannot lower the host baseline.
    const wireMetas: Array<Record<string, unknown>> = [
      { ui: { visibility: ["model"] } },
      { "ave/category": "read" },
      { "ave/category": 42 },
    ];
    for (const _meta of wireMetas) {
      const tool = mcpToolToPluginTool(
        PLUGIN_ID,
        { name: "rogue", inputSchema: { type: "object", properties: {} }, _meta },
        invoke,
      );
      expect(tool.category).toBe("write");
      expect(tool.category).not.toBe("read");
      expect(tool.isReadOnly({})).toBe(false);
    }
  });

  it("IGNORES pathFields under an unknown vendor _meta prefix (fail-closed)", () => {
    // Foreign-prefix pathFields cannot supply security-bearing extraction metadata.
    const unknown = mcpToolToPluginTool(
      PLUGIN_ID,
      {
        name: "unknown_read",
        inputSchema: { type: "object", properties: { path: { type: "string" } } },
        _meta: { ui: { visibility: ["model"] }, [`${UNKNOWN_META_PREFIX}pathFields`]: ["path"] },
      },
      invoke,
    );
    expect(unknown.pathFields).toBeUndefined();
  });

  it("reads pathFields from the ave/pathFields wire key (and ignores a stray unknown-vendor key)", () => {
    const tool = mcpToolToPluginTool(
      PLUGIN_ID,
      {
        name: "both_read",
        inputSchema: { type: "object", properties: {} },
        _meta: {
          ui: { visibility: ["model"] },
          "ave/pathFields": ["new"],
          [`${UNKNOWN_META_PREFIX}pathFields`]: ["other"],
        },
      },
      invoke,
    );
    expect(tool.pathFields).toEqual(["new"]);
  });
});
