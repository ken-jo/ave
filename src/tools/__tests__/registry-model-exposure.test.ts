// App-only tools remain registered for governed execution but must be absent from every model listing.
// Registration, model exposure, and ownership are separate boundaries.
import { describe, it, expect, vi } from "vitest";
import { ToolRegistry } from "../registry.js";
import { createDynamicTool, type Tool } from "../base.js";
import { ToolExecutor } from "../executor.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { runWithInvocationOrigin } from "../../plugins/runtime/origin-chain.js";
import { mcpToolToTool } from "../../mcp/mcp-tool-adapter.js";
import { mcpToolToPluginTool } from "../../mcp/plugin-tool-from-mcp.js";
import { manifestToolsToMcpTools } from "../../mcp/plugin-server-projection.js";
import type { McpToolSchema } from "../../mcp/types.js";
import type { PluginManifest } from "../../plugins/types.js";

const PLUGIN_ID = "com.example.meeting";
const SERVER_ID = "github";

type Visibility = Array<"model" | "app">;

// Use production manifest projection; auth tools must declare app-only visibility.
const MANIFEST: PluginManifest = {
  id: PLUGIN_ID,
  name: "Meeting",
  version: "1.0.0",
  entry: "dist/index.js",
  description: "meetings",
  tools: [
    { name: "meeting_start", description: "Start", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["model"] } } },
    { name: "meeting_toggle", description: "Toggle", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["model", "app"] } } },
    { name: "meeting_ui_list_rows", description: "Rows for the card", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["app"] } } },
    { name: "meeting_auth_status", description: "Auth status", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["app"] } } },
    { name: "meeting_auth_login", description: "Auth login", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["app"] } } },
  ],
  auth: { statusTool: "meeting_auth_status", loginTool: "meeting_auth_login" },
};

const AUTH_TRIO = ["meeting_auth_status", "meeting_auth_login"];

function pluginTools(): Tool[] {
  const invoke = vi.fn(async (name: string) => ({ text: `ran ${name}` }));
  return manifestToolsToMcpTools(MANIFEST).map((t) => mcpToolToPluginTool(PLUGIN_ID, t, invoke));
}

function externalTool(name: string, visibility?: Visibility): Tool {
  const schema = {
    name,
    description: `${name} tool`,
    inputSchema: { type: "object", properties: {} },
    ...(visibility ? { _meta: { ui: { visibility } } } : {}),
  } as McpToolSchema;
  return mcpToolToTool(SERVER_ID, `mcp_gh_${name}`, schema, async () => ({ text: "ok" }));
}

function builtinTool(name: string): Tool {
  return createDynamicTool({
    name,
    description: `${name} builtin`,
    source: "builtin",
    category: "read",
    jsonSchema: { type: "object", properties: {} },
    execute: async () => ({ output: "ok", isError: false }),
  });
}

function loadedRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.registerBatch([
    builtinTool("bash"),
    ...pluginTools(),
    externalTool("query", ["model", "app"]),
    externalTool("gh_ui_rows", ["app"]),
    externalTool("legacy"), // Undeclared visibility defaults to both model and app.
  ]);
  return registry;
}

const FULL_SCOPE = {
  activePluginIds: [PLUGIN_ID],
  includeBuiltins: true,
  includeMcp: true,
  includeEgress: true,
  deferral: false,
};

describe("registry — an app-only tool IS registered (it must run under the gate)", () => {
  it("resolves app-only tools by name on BOTH arms — findByName is the executor's lookup, and it must see them", () => {
    const registry = loadedRegistry();
    expect(registry.findByName("meeting_ui_list_rows")).toBeDefined();
    for (const name of AUTH_TRIO) expect(registry.findByName(name)).toBeDefined();
    expect(registry.findByName("mcp_gh_gh_ui_rows")).toBeDefined();
    // Registry registration is required for risk, approval, and audit enforcement.
    expect(registry.findByName("meeting_ui_list_rows")!.source).toBe("plugin");
    expect(registry.findByName("mcp_gh_gh_ui_rows")!.mcpServerId).toBe(SERVER_ID);
  });

  it("keeps them in getVisibleTools (the executable surface) — it is a superset of the model's", () => {
    const registry = loadedRegistry();
    const executable = registry.getVisibleTools().map((t) => t.name);
    const exposed = registry.getModelVisibleTools().map((t) => t.name);
    expect(executable).toContain("meeting_ui_list_rows");
    expect(executable).toContain("mcp_gh_gh_ui_rows");
    expect(exposed.length).toBeLessThan(executable.length);
    for (const name of exposed) expect(executable).toContain(name);
  });
});

describe("registry — an app-only tool is NOT exposed to the model (both arms, one filter)", () => {
  it("subtracts app-only tools from every model-facing listing", () => {
    const registry = loadedRegistry();

    const listings: Array<[string, string[]]> = [
      ["getModelVisibleTools", registry.getModelVisibleTools().map((t) => t.name)],
      ["getToolSchemas", registry.getToolSchemas().map((s) => s.name)],
      ["getToolSchemasForScope", registry.getToolSchemasForScope(FULL_SCOPE).map((s) => s.name)],
    ];

    for (const [label, names] of listings) {
      // Registered app-only plugin tools must still be hidden from model listings.
      expect(names, label).not.toContain("meeting_ui_list_rows");
      // The same exposure filter must hide external app-only tools.
      expect(names, label).not.toContain("mcp_gh_gh_ui_rows");
      expect(names, label).toEqual(
        expect.arrayContaining(["bash", "meeting_start", "meeting_toggle", "mcp_gh_query", "mcp_gh_legacy"]),
      );
    }
  });

  it("keeps app-only tools out of the DEFERRED catalog too — a tool the model may not see is not a candidate it may promote", () => {
    const registry = loadedRegistry();
    // App-only tools must also be absent from the deferred search catalogue.
    const deferredScope = { ...FULL_SCOPE, deferral: true, activeToolNames: [] as string[] };
    const catalog = registry.getToolCatalogForScope(deferredScope).map((e) => e.name);

    expect(catalog).not.toContain("meeting_ui_list_rows");
    expect(catalog).not.toContain("mcp_gh_gh_ui_rows");
    for (const name of AUTH_TRIO) expect(catalog).not.toContain(name);
    expect(catalog).toEqual(expect.arrayContaining(["meeting_start", "meeting_toggle", "mcp_gh_query"]));
  });

  it("cannot be forced into exposure by naming the tool in activeToolNames", () => {
    const registry = loadedRegistry();
    // Promotion by activeToolNames cannot bypass the model-visibility filter.
    const names = registry
      .getToolSchemasForScope({
        ...FULL_SCOPE,
        deferral: true,
        activeToolNames: ["meeting_ui_list_rows", "meeting_auth_status", "mcp_gh_gh_ui_rows", "meeting_start"],
      })
      .map((s) => s.name);

    expect(names).not.toContain("meeting_ui_list_rows");
    expect(names).not.toContain("meeting_auth_status");
    expect(names).not.toContain("mcp_gh_gh_ui_rows");
    expect(names).toContain("meeting_start");
  });

  it("THE AUTH TRIO stays model-invisible and IS registered under the gate (app-only by manifest law)", () => {
    const registry = loadedRegistry();
    for (const name of AUTH_TRIO) {
      expect(registry.getModelVisibleTools().map((t) => t.name)).not.toContain(name);
      expect(registry.getToolSchemas().map((s) => s.name)).not.toContain(name);
      expect(registry.getToolSchemasForScope(FULL_SCOPE).map((s) => s.name)).not.toContain(name);
      // Keep app-only tools registered so card-origin calls still traverse risk, approval, and audit gates.
      expect(registry.findByName(name)).toBeDefined();
      expect(registry.findByName(name)!.modelVisible).toBe(false);
    }
    // Model-origin execution is denied by the executor; registry lookup must still resolve card tools.
  });

  it("leaves builtins alone — a tool that declares no MCP visibility is model-visible", () => {
    const registry = loadedRegistry();
    // Absent modelVisible means exposed, preserving builtin tools without UI metadata.
    expect(registry.findByName("bash")!.modelVisible).toBeUndefined();
    expect(registry.getModelVisibleTools().map((t) => t.name)).toContain("bash");
    // Undeclared external visibility defaults to both model and app.
    expect(registry.findByName("mcp_gh_legacy")!.modelVisible).toBe(true);
  });
});

// The executor must reject model-origin app-only calls while allowing governed mcp-app calls.
describe("executor refuses a model-origin call to an app-only tool (the model-uncallable half)", () => {
  const APP_ONLY = ["meeting_ui_list_rows", "meeting_auth_login"];

  function loadedWithSpy(): { registry: ToolRegistry; invoke: ReturnType<typeof vi.fn> } {
    const invoke = vi.fn(async (name: string) => ({ text: `ran ${name}` }));
    const registry = new ToolRegistry();
    registry.registerBatch([
      builtinTool("bash"),
      ...manifestToolsToMcpTools(MANIFEST).map((schema) => mcpToolToPluginTool(PLUGIN_ID, schema, invoke)),
    ]);
    return { registry, invoke };
  }

  // Auto-allow makes a missing origin guard observable; model denial must precede permission checks.
  function executorFor(registry: ToolRegistry): ToolExecutor {
    const permMgr = new PermissionManager("/tmp/nonexistent-model-exposure.json");
    permMgr.checkDetailed = () => ({ decision: "allow", reason: "test auto-allow", });
    return new ToolExecutor(registry, undefined, permMgr);
  }

  it("MODEL origin (no invocation-origin frame) is DENIED — is_error, and the app-only handler NEVER runs", async () => {
    for (const name of APP_ONLY) {
      const { registry, invoke } = loadedWithSpy();
      const [result] = await executorFor(registry).executeAll(
        [{ id: `tu-${name}`, name, input: {} }],
        {
          sessionId: "s",
          permissionContext: { trustOrigin: "llm-tool-arg", allowedPluginIds: new Set([PLUGIN_ID]) },
        },
      );
      expect(result.is_error, name).toBe(true);
      expect(invoke, `${name} handler must not run`).not.toHaveBeenCalled();
    }
  });

  it("APP origin (runWithInvocationOrigin 'mcp-app') reaches the SAME app-only tool's handler — the contrast", async () => {
    const { registry, invoke } = loadedWithSpy();
    const [result] = await runWithInvocationOrigin("mcp-app", undefined, () =>
      executorFor(registry).executeAll(
        [{ id: "tu-card", name: "meeting_ui_list_rows", input: {} }],
        {
          sessionId: "s",
          permissionContext: { trustOrigin: "plugin-emitted", allowedPluginIds: new Set([PLUGIN_ID]) },
        },
      ),
    );
    expect(result.is_error).toBeFalsy();
    expect(invoke).toHaveBeenCalledWith("meeting_ui_list_rows", {});
  });

  it("a MODEL-VISIBLE plugin tool is unaffected — the guard keys on modelVisible, not on being a plugin tool", async () => {
    const { registry, invoke } = loadedWithSpy();
    const [result] = await executorFor(registry).executeAll(
      [{ id: "tu-model", name: "meeting_start", input: {} }],
      {
        sessionId: "s",
        permissionContext: { trustOrigin: "llm-tool-arg", allowedPluginIds: new Set([PLUGIN_ID]) },
      },
    );
    expect(result.is_error).toBeFalsy();
    expect(invoke).toHaveBeenCalledWith("meeting_start", {});
  });
});
