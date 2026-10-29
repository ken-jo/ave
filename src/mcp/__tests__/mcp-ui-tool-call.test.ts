/** App visibility and host execution gates apply to both external and plugin card calls. */
import { describe, it, expect, vi } from "vitest";
import { createExternalToolCallSource, createLoopbackToolCallSource } from "../mcp-ui-tool-call.js";
import { mcpToolToTool } from "../mcp-tool-adapter.js";
import type { McpToolSchema, McpUiToolVisibility } from "../types.js";
import type { Tool } from "../../tools/base.js";

const INVOCATION = { appSessionId: "mcp-app:github:17", operationGrantToken: "grant-once" };

function schema(name: string, visibility?: McpUiToolVisibility[] | unknown): McpToolSchema {
  return {
    name,
    description: `${name} tool`,
    inputSchema: { type: "object", properties: {} },
    ...(visibility === undefined ? {} : { _meta: { ui: { visibility } } }),
  } as McpToolSchema;
}

function externalTool(serverId: string, name: string, visibility?: McpUiToolVisibility[] | unknown): Tool {
  return mcpToolToTool(serverId, `mcp_gh_${name}`, schema(name, visibility), async () => ({ text: "ok" }));
}

function externalSource(tools: Tool[], invoker = vi.fn(async () => "tool-output")) {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const source = createExternalToolCallSource({
    namespacedToolName: (_serverId, toolName) =>
      toolName.startsWith("mcp_gh_") ? toolName : `mcp_gh_${toolName}`,
    findTool: (name) => byName.get(name),
    getInvoker: () => invoker,
  });
  return { source, invoker };
}

function loopbackRuntime(result = "plugin-result") {
  return {
    resolveToolOwner: vi.fn(() => "acme-cards"),
    callFromApp: vi.fn(async () => result),
  };
}

describe("mcp-tool-adapter — BOTH visibility bits are materialized ONCE, at ingestion", () => {
  it("applies the MCP Apps spec default [\"model\",\"app\"] when the server declares nothing", () => {
    const t = externalTool("github", "query");
    expect(t.appInvokable).toBe(true);
    expect(t.modelVisible).toBe(true);
  });

  it("honours an explicit app visibility (app-only and dual)", () => {
    expect(externalTool("github", "query", ["app"]).appInvokable).toBe(true);
    expect(externalTool("github", "query", ["model", "app"]).appInvokable).toBe(true);
  });

  it("marks a model-only tool as NOT app-invokable", () => {
    expect(externalTool("github", "query", ["model"]).appInvokable).toBe(false);
  });

  it("marks an APP-ONLY tool as NOT model-visible — the spec says the model must not see it", () => {
    // Register app-only tools for governance while hiding them at the model-exposure boundary.
    const appOnly = externalTool("github", "list_rows", ["app"]);
    expect(appOnly.appInvokable).toBe(true);
    expect(appOnly.modelVisible).toBe(false);
    expect(externalTool("github", "query", ["model", "app"]).modelVisible).toBe(true);
    expect(externalTool("github", "query", ["model"]).modelVisible).toBe(true);
  });

  it("fails closed on a malformed visibility declaration — no app surface, still model-governed", () => {
    for (const malformed of ["app", ["app", "everyone"], []]) {
      const t = externalTool("github", "query", malformed);
      expect(t.appInvokable).toBe(false);
      expect(t.modelVisible).toBe(true);
    }
  });
});

describe("external tool-call source — ownership comes from the registry entry", () => {
  it("resolves the owner from the namespaced registry entry's mcpServerId", () => {
    const { source } = externalSource([externalTool("github", "query")]);
    expect(source.resolveToolOwner("github", "query")).toBe("github");
  });

  it("resolves an unknown tool to undefined (the caller's owner check then denies it)", () => {
    const { source } = externalSource([externalTool("github", "query")]);
    expect(source.resolveToolOwner("github", "not_a_tool")).toBeUndefined();
  });

  it("resolves a HOST BUILTIN to undefined — a builtin has no mcpServerId", () => {
    const bash = { name: "mcp_gh_bash", mcpServerId: undefined } as unknown as Tool;
    const { source } = externalSource([bash]);
    expect(source.resolveToolOwner("github", "bash")).toBeUndefined();
  });
});

describe("external tool-call source — the SPEC MUST (visibility) and the gate", () => {
  it("REJECTS a tool whose _meta.ui.visibility does not include \"app\" and never invokes it", async () => {
    const { source, invoker } = externalSource([externalTool("github", "query", ["model"])]);

    await expect(source.callTool("github", "query", {}, INVOCATION)).rejects.toThrow(/not app-callable/i);
    expect(invoker).not.toHaveBeenCalled();
  });

  it("fails closed for a registry entry that never went through the adapter (no appInvokable)", async () => {
    const raw = { name: "mcp_gh_query", mcpServerId: "github" } as unknown as Tool;
    const { source, invoker } = externalSource([raw]);

    await expect(source.callTool("github", "query", {}, INVOCATION)).rejects.toThrow(/not app-callable/i);
    expect(invoker).not.toHaveBeenCalled();
  });

  it("runs an app-visible tool through the GATED executor delegate — never a raw mcpManager.callTool", async () => {
    const { source, invoker } = externalSource([externalTool("github", "query", ["model", "app"])]);

    await expect(source.callTool("github", "query", { q: "x" }, INVOCATION)).resolves.toBe("tool-output");
    // Card calls use app origin without a user gesture, never the trusted panel origin.
    expect(invoker).toHaveBeenCalledWith("mcp_gh_query", { q: "x" }, {
      origin: "mcp-app",
      userAction: false,
      appInvocation: {
        surface: "mcp-app",
        sessionId: INVOCATION.appSessionId,
        operationGrantToken: INVOCATION.operationGrantToken,
      },
      expectedMcpServerId: "github",
    });
  });

  it("runs an APP-ONLY tool through the same GATED delegate — parity with the plugin arm", async () => {
    const { source, invoker } = externalSource([externalTool("github", "list_rows", ["app"])]);

    await expect(source.callTool("github", "list_rows", { page: 2 }, INVOCATION)).resolves.toBe("tool-output");
    expect(invoker).toHaveBeenCalledWith("mcp_gh_list_rows", { page: 2 }, {
      origin: "mcp-app",
      userAction: false,
      appInvocation: {
        surface: "mcp-app",
        sessionId: INVOCATION.appSessionId,
        operationGrantToken: INVOCATION.operationGrantToken,
      },
      expectedMcpServerId: "github",
    });
  });

  it("rechecks the exact server owner at invocation time", async () => {
    const { source, invoker } = externalSource([externalTool("replacement", "query", ["app"])]);
    await expect(source.callTool("github", "query", {}, INVOCATION)).rejects.toThrow(/owner changed/);
    expect(invoker).not.toHaveBeenCalled();
  });

  it("denies the call when the executor is not wired yet", async () => {
    const byName = new Map([["mcp_gh_query", externalTool("github", "query")]]);
    const source = createExternalToolCallSource({
      namespacedToolName: (_s, n) => `mcp_gh_${n}`,
      findTool: (n) => byName.get(n),
      getInvoker: () => null,
    });
    await expect(source.callTool("github", "query", {}, INVOCATION)).rejects.toThrow(/not wired/i);
  });
});

describe("loopback tool-call source — plugin methods through callFromApp", () => {
  it("resolves the owner from the runtime method map (a loopback serverId IS a pluginId)", () => {
    const runtime = {
      resolveToolOwner: vi.fn((m: string) => (m === "acme_open" ? "acme-cards" : undefined)),
      callFromApp: vi.fn(async () => "plugin-result"),
    };
    const source = createLoopbackToolCallSource({ runtime, findTool: () => undefined });

    expect(source.resolveToolOwner("acme-cards", "acme_open")).toBe("acme-cards");
    expect(source.resolveToolOwner("acme-cards", "other_open")).toBeUndefined();
  });

  it("delegates to callFromApp (visibility MUST + the gate) — NOT callFromUi", async () => {
    // Cards cannot use the panel-only dispatch path that bypasses tool risk, approval and audit.
    const callFromUi = vi.fn(async () => "panel-path");
    const runtime = { ...loopbackRuntime(), callFromUi };
    const source = createLoopbackToolCallSource({ runtime, findTool: () => undefined });

    await expect(source.callTool("acme-cards", "acme_open", { id: 7 }, INVOCATION)).resolves.toBe("plugin-result");
    expect(runtime.callFromApp).toHaveBeenCalledWith("acme_open", { id: 7 }, INVOCATION);
    expect(callFromUi).not.toHaveBeenCalled();
  });

  it("propagates callFromApp's visibility denial (a tool without app visibility) unchanged", async () => {
    const runtime = {
      resolveToolOwner: vi.fn(() => "acme-cards"),
      callFromApp: vi.fn(async () => {
        throw new Error(
          "Method 'acme_secret' is not declared as a UI action for plugin 'acme-cards'.",
        );
      }),
    };
    const source = createLoopbackToolCallSource({ runtime, findTool: () => undefined });

    await expect(source.callTool("acme-cards", "acme_secret", {}, INVOCATION)).rejects.toThrow(
      /not declared as a UI action/,
    );
  });

  it("passes an APP-ONLY tool straight to callFromApp — no deny of its own", async () => {
    // callFromApp owns visibility and governance; this adapter must dispatch through it.
    const runtime = loopbackRuntime("governed-result");
    const source = createLoopbackToolCallSource({ runtime, findTool: () => undefined });

    await expect(source.callTool("acme-cards", "acme_auth_status", { q: 1 }, INVOCATION)).resolves.toBe(
      "governed-result",
    );
    expect(runtime.callFromApp).toHaveBeenCalledWith("acme_auth_status", { q: 1 }, INVOCATION);
  });

  it("identifies every write from the Host registry as a grant target", () => {
    const runtime = loopbackRuntime("ok");
    const policy = {
      discriminant: "operation" as const,
      operations: {
        list: { kind: "read" as const, minimumRisk: "read" as const, appVisible: true },
        update: {
          kind: "write" as const,
          minimumRisk: "write" as const,
          appVisible: true,
          requiresRead: { tool: "portal_read", operations: ["list"], maxAgeMs: 60_000 },
        },
        reserve: {
          kind: "write" as const,
          minimumRisk: "write" as const,
          appVisible: true,
        },
      },
    };
    const tool = {
      name: "portal_write",
      pluginId: "acme-cards",
      operationPolicy: policy,
    } as Tool;
    const source = createLoopbackToolCallSource({ runtime, findTool: () => tool });

    expect(source.resolveOperationGrantTarget("acme-cards", "portal_write", { operation: "list" }))
      .toBeUndefined();
    expect(source.resolveOperationGrantTarget("acme-cards", "portal_write", { operation: "update" }))
      .toEqual({ pluginId: "acme-cards", toolName: "portal_write" });
    expect(source.resolveOperationGrantTarget("acme-cards", "portal_write", { operation: "reserve" }))
      .toEqual({ pluginId: "acme-cards", toolName: "portal_write" });
    expect(() => source.resolveOperationGrantTarget("acme-cards", "portal_write", { operation: "admin" }))
      .toThrow(/unknown operation/);
  });
});
