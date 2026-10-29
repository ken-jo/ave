import { mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";
import { createBootHostFixture } from "../../../__tests__/support/host-runtime.js";
import { unusedNetworkFetch } from "../../../__tests__/support/network-fetch-stubs.js";
import { PermissionManager } from "../../../permissions/permission-manager.js";
import type { JudgeModelRef, JudgeSettings } from "../../../permissions/judge/judge-settings.js";
import type { LLMProvider } from "../../../engine/llm/types.js";
import { llmVendorModelOptions } from "../../../shared/llm-vendor-defaults.js";

describe("judge configured provider wiring", () => {
  it("constructs an explicitly selected configured model independently of the active reviewer transport", async () => {
    const directory = mkdtempSync(join(tmpdir(), "judge-provider-wiring-"));
    vi.resetModules();
    const { configureHostResources } = await import("../../../main/host-resources.js");
    configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
    const provider: LLMProvider = { vendor: "openai-compatible", async *streamTurn() {} };
    const createProvider = vi.fn((_options: unknown) => provider);
    const wireReviewerAgent = vi.fn(() => ({ recentlyDenied: { setReplayResolver: vi.fn() } }));
    const wireJudgeAgent = vi.fn((_input: unknown) => undefined);
    vi.doMock("../../../engine/llm/provider-factory.js", () => ({
      createProvider, secretKeyFor: (vendor: string) => `llm.apiKey.${vendor}`,
    }));
    vi.doMock("../reviewer-wiring.js", () => ({ wireReviewerAgent }));
    vi.doMock("../judge-wiring.js", () => ({ wireJudgeAgent }));
    writeFileSync(join(directory, "settings.json"), JSON.stringify({ permissions: { judge: {
      chain: [{ id: "selected", provider: "builtin-llm", model: "openai-compatible/preset-only-model" }],
      mode: "active",
    } } }));
    vi.doMock("../../../permissions/permission-settings-store.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../../../permissions/permission-settings-store.js")>();
      return {
        ...actual,
        readJudgeSettings: (_path: string | undefined, catalog: Parameters<typeof actual.readJudgeSettings>[1]) =>
          actual.readJudgeSettings(join(directory, "settings.json"), catalog),
      };
    });
    try {
      const { wireReviewerAndPermissions } = await import("../reviewer-permission-wiring.js");
      const networkFetch = unusedNetworkFetch;
      let selectedBaseUrl = "http://127.0.0.1:1234/v1";
      let activeModel = "active-model";
      let activeProvider = "openai";
      let presetId: string | undefined;
      const vertexBlock = { model: "saved-model", vertexProject: "sample-project", vertexLocation: "region-one" };
      const installedProviderPresets = [{
        providerId: "configured-router", baseUrl: "https://router.example/v1", requiresApiKey: true,
        defaultModel: "preset-only-model", modelOptions: ["preset-only-model"], modelDiscoveryPolicy: "static",
        capabilities: { tools: true },
      }];
      const settingsService = {
        get: (key: string) => key === "llm" ? {
          provider: activeProvider,
          activeChatRuntime: { kind: "subscription", provider: "codex", model: activeModel },
          marketplaceProviderPresetId: presetId,
          vendors: {
            "openai-compatible": { model: "saved-chat-model", baseUrl: selectedBaseUrl },
            "vertex-ai": vertexBlock,
          },
        } : key === "marketplace" ? { installedProviderPresets } : {},
        getSecret: vi.fn((): string | null => "configured-key"),
        onChanged: vi.fn(),
      };
      const context = {
        host: createBootHostFixture(), toolRegistry: { setDenyRules: vi.fn() },
        permissionManager: new PermissionManager(join(directory, "permissions.json")),
        approvalGate: { setOwnerAwayAutoSkipMinutes: vi.fn() },
        settingsService, llmFetch: networkFetch, singleHopNetworkFetch: networkFetch,
        getMainWindow: () => null, bootAuditLogger: { log: vi.fn() },
        subscriptionProviderFactory: vi.fn(() => provider),
      };
      wireReviewerAndPermissions(context as never);
      expect(context.approvalGate.setOwnerAwayAutoSkipMinutes).toHaveBeenCalledWith(0);
      expect(settingsService.onChanged).toHaveBeenCalledWith("permissions", expect.any(Function));
      const judgeDeps = wireJudgeAgent.mock.calls[0]![0] as {
        providerForModel: (model: JudgeModelRef) => LLMProvider | null;
        selectedModelCacheScope: (model: JudgeModelRef) => Record<string, unknown>;
        networkFetch: typeof networkFetch;
        audit: unknown;
        settings: JudgeSettings;
        chainRejected?: boolean;
        settingsUnreadable?: boolean;
      };
      expect(judgeDeps.networkFetch).toBe(networkFetch);
      expect(judgeDeps.audit).toBe(context.bootAuditLogger);
      expect(judgeDeps.settings.mode).toBe("active");
      expect(judgeDeps.settings.chain).toEqual([]);
      expect(judgeDeps.chainRejected).toBe(true);
      expect(judgeDeps.settingsUnreadable).toBeUndefined();
      expect(judgeDeps.providerForModel({ vendor: "openai-compatible", model: "selected-judge-model" })).toBe(provider);
      expect(createProvider).toHaveBeenCalledWith(expect.objectContaining({
        vendor: "openai-compatible", model: "selected-judge-model", apiKey: "configured-key",
        baseUrl: "http://127.0.0.1:1234/v1", fetch: expect.any(Function),
      }));
      expect(context.subscriptionProviderFactory).not.toHaveBeenCalled();
      settingsService.getSecret.mockReturnValue(null);
      expect(judgeDeps.providerForModel({ vendor: "openai", model: "selected-unavailable-model" })).toBeNull();
      expect(createProvider).toHaveBeenCalledOnce();
      const model = { vendor: "openai-compatible" as const, model: "selected-judge-model" };
      const initialScope = judgeDeps.selectedModelCacheScope(model);
      expect(initialScope).toMatchObject({
        provider: model.vendor, model: model.model, baseUrl: selectedBaseUrl,
        credentialScope: "llm.apiKey.openai-compatible",
      });
      expect(JSON.stringify(initialScope)).not.toContain("configured-key");
      activeModel = "another-reviewer-model";
      expect(judgeDeps.selectedModelCacheScope(model)).toEqual(initialScope);
      selectedBaseUrl = "http://127.0.0.1:4321/v1";
      expect(judgeDeps.selectedModelCacheScope(model)).not.toEqual(initialScope);
      presetId = "configured-router";
      expect(judgeDeps.selectedModelCacheScope(model)).toMatchObject({
        baseUrl: selectedBaseUrl, credentialScope: "llm.apiKey.openai-compatible",
      });
      expect(judgeDeps.providerForModel(model)).toBe(provider);
      expect(createProvider).toHaveBeenLastCalledWith(expect.objectContaining({
        baseUrl: selectedBaseUrl, model: model.model,
      }));
      expect(createProvider.mock.lastCall?.[0]).not.toHaveProperty("providerMetadata");
      activeProvider = "openai-compatible";
      const presetScope = judgeDeps.selectedModelCacheScope(model);
      expect(presetScope).toMatchObject({
        baseUrl: "https://router.example/v1", marketplaceProviderPresetId: presetId,
      });
      expect(presetScope.credentialScope).not.toBe(initialScope.credentialScope);
      (context as unknown as { rewireReviewerAgent: () => void }).rewireReviewerAgent();
      const rewired = wireJudgeAgent.mock.lastCall![0] as typeof judgeDeps;
      expect(rewired.settings.chain).toEqual([{
        id: "selected", provider: "builtin-llm",
        model: { vendor: "openai-compatible", model: "preset-only-model" },
      }]);
      expect(rewired.chainRejected).toBeUndefined();
      writeFileSync(join(directory, "settings.json"), JSON.stringify({ permissions: { judge: {
        chain: [], mode: "active",
      } } }));
      (context as unknown as { rewireReviewerAgent: () => void }).rewireReviewerAgent();
      const disabled = wireJudgeAgent.mock.lastCall![0] as typeof judgeDeps;
      expect(disabled.settings.chain).toEqual([]);
      expect(disabled.chainRejected).toBeUndefined();
      expect(disabled.settingsUnreadable).toBeUndefined();
      writeFileSync(join(directory, "settings.json"), "{");
      (context as unknown as { rewireReviewerAgent: () => void }).rewireReviewerAgent();
      const unreadable = wireJudgeAgent.mock.lastCall![0] as typeof judgeDeps;
      expect(unreadable.settingsUnreadable).toBe(true);
      expect(unreadable.settings.mode).toBe("shadow");
      expect(unreadable.settings.chain).toEqual([]);
      writeFileSync(join(directory, "settings.json"), "{}");
      (context as unknown as { rewireReviewerAgent: () => void }).rewireReviewerAgent();
      const absentBlock = wireJudgeAgent.mock.lastCall![0] as typeof judgeDeps;
      expect(absentBlock.settingsUnreadable).toBeUndefined();
      expect(absentBlock.settings.chain).toEqual([]);
      unlinkSync(join(directory, "settings.json"));
      (context as unknown as { rewireReviewerAgent: () => void }).rewireReviewerAgent();
      const absentFile = wireJudgeAgent.mock.lastCall![0] as typeof judgeDeps;
      expect(absentFile.settingsUnreadable).toBeUndefined();
      expect(absentFile.settings.chain).toEqual([]);
      installedProviderPresets[0]!.baseUrl = "https://replacement.example/v1";
      expect(judgeDeps.selectedModelCacheScope(model)).not.toEqual(presetScope);
      const vertexModel = { vendor: "vertex-ai" as const, model: "selected-model" };
      const vertexScope = judgeDeps.selectedModelCacheScope(vertexModel);
      vertexBlock.vertexProject = "other-project";
      expect(judgeDeps.selectedModelCacheScope(vertexModel)).not.toEqual(vertexScope);
      vertexBlock.vertexProject = "sample-project";
      vertexBlock.vertexLocation = "region-two";
      expect(judgeDeps.selectedModelCacheScope(vertexModel)).not.toEqual(vertexScope);
    } finally {
      vi.doUnmock("../../../engine/llm/provider-factory.js");
      vi.doUnmock("../reviewer-wiring.js");
      vi.doUnmock("../judge-wiring.js");
      vi.doUnmock("../../../permissions/permission-settings-store.js");
      vi.resetModules();
      await cleanupTmpDir(directory);
    }
  });

  it("resolves an unset reviewer model to the chat model on every re-wire, and a selected one to itself", async () => {
    const directory = mkdtempSync(join(tmpdir(), "reviewer-model-wiring-"));
    vi.resetModules();
    const { configureHostResources } = await import("../../../main/host-resources.js");
    configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
    const provider: LLMProvider = { vendor: "claude", async *streamTurn() {} };
    const createProvider = vi.fn((_options: unknown) => provider);
    const wireReviewerAgent = vi.fn((_deps: unknown) => ({ recentlyDenied: { setReplayResolver: vi.fn() } }));
    const wireJudgeAgent = vi.fn((_input: unknown) => undefined);
    vi.doMock("../../../engine/llm/provider-factory.js", () => ({
      createProvider, secretKeyFor: (vendor: string) => `llm.apiKey.${vendor}`,
    }));
    vi.doMock("../reviewer-wiring.js", () => ({ wireReviewerAgent }));
    vi.doMock("../judge-wiring.js", () => ({ wireJudgeAgent }));
    const settingsPath = join(directory, "settings.json");
    const writeReviewerModel = (model: string | null) =>
      writeFileSync(settingsPath, JSON.stringify({ permissions: { judge: { model } } }));
    vi.doMock("../../../permissions/permission-settings-store.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../../../permissions/permission-settings-store.js")>();
      return {
        ...actual,
        readJudgeSettings: (_path: string | undefined, catalog: Parameters<typeof actual.readJudgeSettings>[1]) =>
          actual.readJudgeSettings(settingsPath, catalog),
      };
    });
    try {
      const { wireReviewerAndPermissions } = await import("../reviewer-permission-wiring.js");
      const offered = llmVendorModelOptions("claude")[0]!;
      const vendors: Record<string, { model: string }> = { openai: { model: "chat-a" } };
      const settingsService = {
        get: (key: string) => key === "llm" ? { provider: "openai", vendors } : key === "marketplace" ? {} : {},
        getSecret: vi.fn((): string | null => "configured-key"),
        onChanged: vi.fn(),
      };
      const context = {
        host: createBootHostFixture(), toolRegistry: { setDenyRules: vi.fn() },
        permissionManager: new PermissionManager(join(directory, "permissions.json")),
        approvalGate: { setOwnerAwayAutoSkipMinutes: vi.fn() },
        settingsService, llmFetch: unusedNetworkFetch, singleHopNetworkFetch: unusedNetworkFetch,
        getMainWindow: () => null, bootAuditLogger: { log: vi.fn() },
        subscriptionProviderFactory: vi.fn(() => provider),
      };
      type ReviewerDeps = {
        readActiveLlm: () => { provider: string; model: string };
        streamProviderFor: (vendor: string) => LLMProvider | null;
        selectedModel?: { label: string; available: boolean };
      };
      const rewire = () => (context as unknown as { rewireReviewerAgent: () => void }).rewireReviewerAgent();
      const lastReviewerDeps = () => wireReviewerAgent.mock.lastCall![0] as ReviewerDeps;

      writeReviewerModel(null);
      wireReviewerAndPermissions(context as never);
      expect(context.approvalGate.setOwnerAwayAutoSkipMinutes).toHaveBeenCalledWith(0);
      expect(settingsService.onChanged).toHaveBeenCalledWith("permissions", expect.any(Function));
      expect(lastReviewerDeps().selectedModel).toBeUndefined();
      expect(lastReviewerDeps().readActiveLlm()).toMatchObject({ provider: "openai", model: "chat-a" });
      vendors.openai = { model: "chat-b" };
      rewire();
      expect(lastReviewerDeps().readActiveLlm()).toMatchObject({ provider: "openai", model: "chat-b" });

      writeReviewerModel(`claude/${offered}`);
      rewire();
      expect(lastReviewerDeps().selectedModel).toEqual({ label: `claude/${offered}`, available: true });
      expect(lastReviewerDeps().readActiveLlm()).toMatchObject({ provider: "claude", model: offered });
      expect(lastReviewerDeps().streamProviderFor("claude")).toBe(provider);
      expect(createProvider).toHaveBeenLastCalledWith(expect.objectContaining({ vendor: "claude", model: offered }));
      vendors.openai = { model: "chat-c" };
      rewire();
      expect(lastReviewerDeps().readActiveLlm()).toMatchObject({ provider: "claude", model: offered });

      writeReviewerModel("claude/not-offered-model");
      rewire();
      expect(lastReviewerDeps().selectedModel).toEqual({ label: "configured in Settings", available: false });
    } finally {
      vi.doUnmock("../../../engine/llm/provider-factory.js");
      vi.doUnmock("../reviewer-wiring.js");
      vi.doUnmock("../judge-wiring.js");
      vi.doUnmock("../../../permissions/permission-settings-store.js");
      vi.resetModules();
      await cleanupTmpDir(directory);
    }
  });
});
