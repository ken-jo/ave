import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebContents } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScriptHookManager } from "../../../hooks/script-hook-manager.js";
import { HookRunner } from "../../../hooks/hook-runner.js";
import { PermissionManager } from "../../../permissions/permission-manager.js";
import { ApprovalGate, type ApprovalRequest } from "../../../permissions/approval-gate.js";
import { gateMutatingEffect } from "../../../permissions/effect-enforcement.js";
import { ApprovalSurfaceRegistry } from "../../../permissions/approval-surface-registry.js";
import { ToolRegistry } from "../../../tools/registry.js";
import { AuditLogger } from "../../../audit/audit-logger.js";
import { mcpToolToPluginTool } from "../../../mcp/plugin-tool-from-mcp.js";
import { manifestToolsToMcpTools } from "../../../mcp/plugin-server-projection.js";
import { TestPluginRuntime } from "../../../plugins/__tests__/test-helpers.js";
import type { PluginManifest } from "../../../plugins/types.js";
import type { BootContext } from "../../context.js";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";

vi.mock("../../conversation.js", () => ({ createHookRunner: () => new HookRunner() }));
vi.mock("../hook-system-wiring.js", () => ({ wireHookSystem: async () => ({ manager: new ScriptHookManager() }) }));
vi.mock("../../../permissions/permission-settings-store.js", () => ({
  readPermissionSettings: () => ({ permissions: { additionalDirectories: [] } }),
}));
vi.mock("../../../permissions/sandbox-capability.js", async (original) => ({
  ...await original<typeof import("../../../permissions/sandbox-capability.js")>(),
  isActiveSandboxFilesystemContainedForPluginEffects: () => false,
}));
import { setupPluginToolExecutor } from "../plugin-tool-executor.js";

let directory: string;
beforeEach(() => { directory = realpathSync(mkdtempSync(join(tmpdir(), "ave-app-approval-"))); });
afterEach(async () => { await cleanupTmpDir(directory); });

async function harness(options: { readOnly?: boolean; destructive?: boolean; raisingPolicy?: boolean; mainWindow?: boolean; effect?: "storage.write" | "hostFetch" | "spawnWorker" } = {}) {
  const operationPolicy = options.raisingPolicy ? {
    discriminant: "operation" as const,
    operations: { status: { kind: "read" as const, minimumRisk: "write" as const, appVisible: true } },
  } : undefined;
  const manifest: PluginManifest = {
    id: "sample-panel", name: "Sample panel", version: "1.0.0", entry: "index.js", description: "Approval integration fixture",
    tools: [{ name: "panel_status", inputSchema: { type: "object", properties: {} },
      ...(options.readOnly ? { annotations: { readOnlyHint: true } } : {}),
      _meta: { ui: { visibility: ["app"] }, ...(operationPolicy ? { "ai.agent-connector.ave/operationPolicy": operationPolicy } : {}) } }],
  };
  const runtime = new TestPluginRuntime({ hostRoot: directory, manifestPaths: [] });
  const performEffect = vi.fn();
  const handler = vi.fn(async () => {
    if (options.effect) {
      await gateMutatingEffect({
        pluginId: manifest.id, methodPath: options.effect, effect: "write", target: undefined, permissionManager: manager, approvalGate: gate,
        input: options.effect === "hostFetch" ? ["https://example.com", { method: "POST", body: "data" }]
          : options.effect === "spawnWorker" ? [{ command: "sh", args: ["-c", "touch output"] }] : ["output", "data"],
        resolveStoragePath: (path) => join(directory, path),
      });
      performEffect();
    }
    return "panel result";
  });
  // Mutable runtime fixture uses the real generation coordinator and callFromApp admission.
  const internals = runtime as unknown as {
    plugins: Map<string, unknown>; methodMap: Map<string, unknown>;
  };
  internals.plugins.set(manifest.id, { manifest });
  internals.methodMap.set("panel_status", { pluginId: manifest.id, handler });
  const generation = runtime.getGenerationAccess()!.getActive(manifest.id)!;
  const registry = new ToolRegistry();
  const wire = manifestToolsToMcpTools(manifest)[0];
  registry.register(mcpToolToPluginTool(manifest.id, {
    ...wire, ...(options.destructive ? { annotations: { readOnlyHint: true, destructiveHint: true } } : {}),
  }, async () => ({ text: await handler() }), operationPolicy, generation.generationId));
  const surfaces = new ApprovalSurfaceRegistry();
  const cards: ApprovalRequest[] = [];
  const main = { id: 101, isDestroyed: () => false, send: vi.fn((_channel: string, request: ApprovalRequest) => {
    if (request.toolName) cards.push(request);
  }) } as unknown as WebContents;
  if (options.mainWindow !== false) surfaces.registerUnattributed(main);
  const gate = new ApprovalGate((sessionId) => surfaces.resolve(sessionId));
  const manager = new PermissionManager(join(directory, "permissions.json"));
  manager.setMode("strict");
  const context = {
    toolRegistry: registry, permissionManager: manager, approvalGate: gate,
    bootAuditLogger: new AuditLogger(join(directory, "audit")),
    settingsService: { get: () => ({ hostClassifiesRisk: true }) },
    pluginRuntime: runtime, pluginBundleLifecycle: runtime.getGenerationAccess(),
    lateBinding: { pluginToolInvokerRef: {} },
  } as unknown as BootContext;
  await setupPluginToolExecutor(context);
  const call = (surface = "sidebar") => runtime.callFromApp("panel_status", options.raisingPolicy ? { operation: "status" } : {}, { appSessionId: surface });
  const allow = () => {
    const card = cards.at(-1)!;
    expect(gate.resolveFromDesktopRenderer(card.id, { requestId: card.id, choice: "allow-once", nonce: card.nonce, hmac: card.hmac }, main)?.choice).toBe("allow-once");
  };
  return { call, handler, cards, allow, surfaces, main, gate, performEffect };
}

describe("app tool approvals through production executor wiring", () => {
  it.each(["sidebar", "floating-dock"])("delivers %s calls to the main-window surface before running", async (surface) => {
    const h = await harness();
    const pending = h.call(surface);
    await vi.waitFor(() => expect(h.cards).toHaveLength(1));
    expect(h.handler).not.toHaveBeenCalled();
    expect(h.cards[0]).toMatchObject({ sourcePluginId: "sample-panel", toolName: "panel_status" });
    expect(h.cards[0].sessionId).toBeUndefined();
    h.allow();
    await expect(pending).resolves.toBe("panel result");
    expect(h.handler).toHaveBeenCalledOnce();
  });
  it("runs a declared read without an approval card", async () => {
    const h = await harness({ readOnly: true });
    await expect(h.call()).resolves.toBe("panel result");
    expect(h.cards).toHaveLength(0);
    expect(h.handler).toHaveBeenCalledOnce();
  });
  it.each([{ destructive: true }, { raisingPolicy: true }])("asks despite a read hint with %j", async (restriction) => {
    const h = await harness({ readOnly: true, ...restriction });
    const pending = h.call();
    await vi.waitFor(() => expect(h.cards).toHaveLength(1));
    expect(h.handler).not.toHaveBeenCalled();
    h.allow();
    await expect(pending).resolves.toBe("panel result");
  });
  it.each(["storage.write", "hostFetch", "spawnWorker"] as const)("a declared read still gates its actual %s effect", async (effect) => {
    const h = await harness({ readOnly: true, effect });
    const pending = h.call().catch((error: Error) => error);
    await vi.waitFor(() => expect(h.cards).toHaveLength(1));
    const card = h.cards[0];
    expect(card).toMatchObject({ category: "agent-action", sourcePluginId: "sample-panel", args: { methodPath: effect } });
    expect(h.performEffect).not.toHaveBeenCalled();
    h.gate.resolveFromDesktopRenderer(card.id, { requestId: card.id, choice: "deny-once", nonce: card.nonce, hmac: card.hmac }, h.main);
    expect(await pending).toBeInstanceOf(Error);
    expect(h.performEffect).not.toHaveBeenCalled();
  });
  it("denies without a main-window surface", async () => {
    const h = await harness({ mainWindow: false });
    await expect(h.call()).rejects.toThrow("Nobody can approve this request; do not retry.");
    expect(h.handler).not.toHaveBeenCalled();
    expect(h.cards).toHaveLength(0);
  });
});
