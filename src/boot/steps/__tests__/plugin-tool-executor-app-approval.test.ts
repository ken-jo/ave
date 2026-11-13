import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebContents } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScriptHookManager } from "../../../hooks/script-hook-manager.js";
import { HookRunner } from "../../../hooks/hook-runner.js";
import { approvalSurfaceResolver } from "../../approval-surface.js";
import { PermissionTestResources } from "../../../permissions/__tests__/test-resources.js";
import { VerdictCache } from "../../../permissions/reviewer/verdict-cache.js";
import { setReviewerForTest } from "../../../__tests__/support/reviewer-judge.js";
import { makeRecentlyDeniedStore } from "../../../__tests__/support/recently-denied.js";
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

const resources = new PermissionTestResources();
let directory: string;
beforeEach(() => { directory = realpathSync(mkdtempSync(join(tmpdir(), "ave-app-approval-"))); });
afterEach(async () => { await resources.cleanup(); await cleanupTmpDir(directory); });

async function harness(options: { readOnly?: boolean; raisingPolicy?: boolean; origin?: "ui" | "mcp-app"; mode?: "strict" | "auto"; reviewLevel?: "low" | "high"; mainWindow?: boolean; effect?: "storage.write" | "hostFetch" | "spawnWorker" } = {}) {
  const operationPolicy = options.raisingPolicy ? {
    discriminant: "operation" as const,
    operations: { status: { kind: "read" as const, minimumRisk: "write" as const, appVisible: true } },
  } : undefined;
  const manifest: PluginManifest = {
    id: "sample-panel", name: "Sample panel", version: "1.0.0", entry: "index.js", description: "Approval integration fixture",
    tools: [{ name: "panel_status", inputSchema: { type: "object", properties: {} },
      ...(options.readOnly ? { annotations: { readOnlyHint: true } } : {}),
      _meta: { ui: { visibility: options.origin === "ui" ? ["model", "app"] : ["app"] }, ...(operationPolicy ? { "ai.agent-connector.ave/operationPolicy": operationPolicy } : {}) } }],
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
  registry.register(mcpToolToPluginTool(manifest.id, wire, async () => ({ text: await handler() }), operationPolicy, generation.generationId));
  const surfaces = new ApprovalSurfaceRegistry();
  const cards: ApprovalRequest[] = [];
  const main = { id: 101, isDestroyed: () => false, send: vi.fn((_channel: string, request: ApprovalRequest) => {
    if (request.toolName) cards.push(request);
  }) } as unknown as WebContents;
  if (options.mainWindow !== false) surfaces.registerUnattributed(main);
  const gate = new ApprovalGate(approvalSurfaceResolver(surfaces));
  const manager = new PermissionManager(join(directory, "permissions.json"));
  manager.setMode(options.mode ?? "strict");
  const classify = vi.fn(() => ({ level: options.reviewLevel ?? "high" as "low" | "high", reason: "Panel action reviewed" }));
  if (options.mode === "auto") setReviewerForTest(manager, { classifier: { classify },
    cache: resources.trackFlushable(new VerdictCache(join(directory, "review-cache.jsonl"))),
    recentlyDenied: makeRecentlyDeniedStore(join(directory, "recently-denied.jsonl")),
  });
  const review = vi.spyOn(manager, "dispatchReviewer");
  const context = {
    toolRegistry: registry, permissionManager: manager, approvalGate: gate,
    bootAuditLogger: resources.trackFlushable(new AuditLogger(join(directory, "audit"))),
    settingsService: { get: () => ({}) },
    pluginRuntime: runtime, pluginBundleLifecycle: runtime.getGenerationAccess(),
    lateBinding: { pluginToolInvokerRef: {} },
  } as unknown as BootContext;
  await setupPluginToolExecutor(context);
  const call = (surface = "sidebar", input: Record<string, unknown> = {}) => options.origin === "ui"
    ? runtime.callFromUi("panel_status", input, { appSessionId: surface, userAction: true })
    : runtime.callFromApp("panel_status", options.raisingPolicy ? { operation: "status" } : input, { appSessionId: surface });
  const allow = () => {
    const card = cards.at(-1)!;
    expect(gate.resolveFromDesktopRenderer(card.id, { requestId: card.id, choice: "allow-once", nonce: card.nonce, hmac: card.hmac }, main)?.choice).toBe("allow-once");
  };
  return { call, handler, cards, allow, surfaces, main, gate, performEffect, manager, classify, review, runtime };
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
  it("asks despite a read hint when the operation policy raises risk", async () => {
    const h = await harness({ readOnly: true, raisingPolicy: true });
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
  it.each(["second-main", "floating-dock"])("rejects %s answers to a panel request", async (kind) => {
    const h = await harness();
    const pending = h.call();
    await vi.waitFor(() => expect(h.cards).toHaveLength(1));
    const card = h.cards[0];
    const foreign = { id: kind === "floating-dock" ? 202 : 203, isDestroyed: () => false, send: vi.fn() } as unknown as WebContents;
    if (kind === "second-main") h.surfaces.register("other-conversation", foreign);
    expect(h.gate.resolveFromDesktopRenderer(card.id, { requestId: card.id, choice: "allow-once", nonce: card.nonce, hmac: card.hmac }, foreign)).toBeNull();
    expect(h.gate.listPendingRendererRequests(foreign)).toEqual([]);
    expect(h.handler).not.toHaveBeenCalled();
    expect(h.gate.pendingCount).toBe(1);
    h.allow();
    await expect(pending).resolves.toBe("panel result");
  });
  it("keeps trusted-panel ui-origin calls on the governed path for model-visible tools", async () => {
    const h = await harness({ origin: "ui" });
    const pending = h.call();
    await vi.waitFor(() => expect(h.cards).toHaveLength(1));
    expect(h.cards[0].sessionId).toBeUndefined();
    expect(h.handler).not.toHaveBeenCalled();
    h.allow();
    await expect(pending).resolves.toBe("panel result");
  });
  it("reviews sessionless panel approvals in auto mode and can allow without a card", async () => {
    const h = await harness({ mode: "auto", reviewLevel: "low" });
    await expect(h.runtime.callFromApp("panel_status")).resolves.toBe("panel result");
    expect(h.review).toHaveBeenCalledOnce();
    expect(h.classify).toHaveBeenCalledOnce();
    expect(h.review.mock.calls[0][1].sessionId).toBe("plugin-mcp-app-sample-panel");
    expect(h.cards).toHaveLength(0);
  });
  it("retains the reviewer breaker across sessionless panel cards", async () => {
    const h = await harness({ mode: "auto" });
    for (let index = 0; index < 4; index++) {
      const pending = h.runtime.callFromApp("panel_status", { sequence: index }).catch((error: Error) => error);
      await vi.waitFor(() => expect(h.cards).toHaveLength(index + 1));
      const card = h.cards[index];
      expect(card.sessionId).toBeUndefined();
      h.gate.resolveFromDesktopRenderer(card.id, { requestId: card.id, choice: "deny-once", nonce: card.nonce, hmac: card.hmac }, h.main);
      expect(await pending).toBeInstanceOf(Error);
    }
    expect(h.classify).toHaveBeenCalledTimes(3);
    expect(h.manager.getJudgeBreaker().snapshot("plugin-mcp-app-sample-panel")).toMatchObject({ consecutive: 3, total: 3, open: true });
    expect(h.cards[3].reason).toMatch(/paused/i);
    expect(h.handler).not.toHaveBeenCalled();
  });
  it("routes a late breaker approval to the main window and rejects other owners", async () => {
    const h = await harness({ mode: "auto", reviewLevel: "low" });
    const recheck = h.manager.recheckPermission.bind(h.manager);
    const admission = vi.spyOn(h.manager, "recheckPermission").mockImplementationOnce((result) => {
      expect(result.decision).toBe("allow");
      for (let index = 0; index < 3; index++) {
        h.manager.getJudgeBreaker().record("plugin-mcp-app-sample-panel", "deny", `sibling-block-${index}`);
      }
      return recheck(result);
    });
    const pending = h.runtime.callFromApp("panel_status");
    await vi.waitFor(() => expect(h.cards).toHaveLength(1));
    expect(admission).toHaveBeenCalled();
    expect(h.review).toHaveBeenCalledOnce();
    expect(h.classify).toHaveBeenCalledOnce();
    const card = h.cards[0];
    expect(card.sessionId).toBeUndefined();
    expect(card.sourcePluginId).toBe("sample-panel");
    expect(card.reason).toMatch(/paused/i);
    expect(h.handler).not.toHaveBeenCalled();
    const foreign = { id: 204, isDestroyed: () => false } as WebContents;
    expect(h.gate.resolveFromDesktopRenderer(card.id, {
      requestId: card.id, choice: "allow-once", nonce: card.nonce, hmac: card.hmac,
    }, foreign)).toBeNull();
    expect(h.gate.pendingCount).toBe(1);
    h.allow();
    await expect(pending).resolves.toBe("panel result");
    expect(h.handler).toHaveBeenCalledOnce();
  });
  it("denies without a main-window surface", async () => {
    const h = await harness({ mainWindow: false });
    await expect(h.call()).rejects.toThrow("Nobody can approve this request; do not retry.");
    expect(h.handler).not.toHaveBeenCalled();
    expect(h.cards).toHaveLength(0);
  });
});
