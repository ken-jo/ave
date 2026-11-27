import { mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assert, describe, expect, it, vi } from "vitest";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";
import { createBootHostFixture } from "../../../__tests__/support/host-runtime.js";
import { unusedNetworkFetch } from "../../../__tests__/support/network-fetch-stubs.js";
import { PermissionManager } from "../../../permissions/permission-manager.js";
import type { JudgeModelRef, JudgeSettings } from "../../../permissions/judge/judge-settings.js";
import type { LLMProvider } from "../../../engine/llm/types.js";
import { DEFAULT_SETTINGS } from "../../../data/settings-defaults.js";
import { getLlmVendorSettings, llmVendorModelOptions } from "../../../shared/llm-vendor-defaults.js";
import { systemSubagentRouteIdentity } from "../../../shared/system-subagent-model.js";

type ReviewerDeps = {
  readActiveLlm: () => { provider: string; model: string; baseUrl?: string };
  streamProviderFor: (vendor: string) => LLMProvider | null;
  selectedModel?: { label: string; available: boolean };
};

type JudgeDeps = {
  providerForModel: (model: JudgeModelRef) => LLMProvider | null;
  selectedModelCacheScope: (model: JudgeModelRef) => Record<string, unknown>;
  networkFetch: typeof unusedNetworkFetch;
  audit: unknown;
  settings: JudgeSettings;
  chainRejected?: boolean;
  settingsUnreadable?: boolean;
};

describe("judge configured provider wiring", () => {
  it("pins reviewer and stage destinations across chat route changes and rejects changed destinations", async () => {
    const directory = mkdtempSync(join(tmpdir(), "judge-provider-wiring-"));
    const settingsPath = join(directory, "settings.json");
    vi.resetModules();
    const { configureHostResources } = await import("../../../main/host-resources.js");
    configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
    const provider: LLMProvider = { vendor: "openai-compatible", async *streamTurn() {} };
    const createProvider = vi.fn((_options: unknown) => provider);
    const wireReviewerAgent = vi.fn((_input: unknown) => ({ recentlyDenied: { setReplayResolver: vi.fn() } }));
    const wireJudgeAgent = vi.fn((_input: unknown) => undefined);
    vi.doMock("../../../engine/llm/provider-factory.js", () => ({ createProvider }));
    vi.doMock("../reviewer-wiring.js", () => ({ wireReviewerAgent }));
    vi.doMock("../judge-wiring.js", () => ({ wireJudgeAgent }));
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
      const llm = structuredClone(DEFAULT_SETTINGS.llm);
      llm.provider = "openai-compatible";
      llm.activeChatRuntime = { kind: "subscription", provider: "codex", model: "chat-model" };
      llm.marketplaceProviderPresetId = "review-route";
      llm.vendors["openai-compatible"] = {
        ...getLlmVendorSettings(llm.vendors, "openai-compatible"), model: "shared-model", baseUrl: "https://generic.example/v1",
      };
      llm.vendors["vertex-ai"] = {
        ...getLlmVendorSettings(llm.vendors, "vertex-ai"), model: "project-model", vertexProject: "sample-project", vertexLocation: "region-one",
      };
      const selectedPreset = {
        providerId: "review-route", baseUrl: "https://review.example/v1", requiresApiKey: true,
        defaultModel: "shared-model", modelOptions: ["shared-model"], modelDiscoveryPolicy: "static" as const,
        capabilities: { tools: true },
      };
      const otherPreset = { ...selectedPreset, providerId: "chat-route", baseUrl: "https://chat.example/v1" };
      const installedProviderPresets = [selectedPreset, otherPreset];
      const selectedRoute = systemSubagentRouteIdentity(llm, "openai-compatible", installedProviderPresets, selectedPreset.providerId);
      const otherRoute = systemSubagentRouteIdentity(llm, "openai-compatible", installedProviderPresets, otherPreset.providerId);
      const projectRoute = systemSubagentRouteIdentity(llm, "vertex-ai");
      assert(selectedRoute);
      assert(otherRoute);
      assert(projectRoute);
      const selected: JudgeModelRef = { vendor: "openai-compatible", model: "shared-model", route: selectedRoute };
      const project: JudgeModelRef = { vendor: "vertex-ai", model: "project-model", route: projectRoute };
      const secrets = new Map([
        [selectedRoute.credentialScope, "review-route-secret"],
        ["llm.apiKey.openai-compatible", "generic-route-secret"],
        [otherRoute.credentialScope, "chat-route-secret"],
        [projectRoute.credentialScope, "project-route-secret"],
      ]);
      const settingsService = {
        get: (key: string) => key === "llm" ? llm : key === "marketplace" ? { installedProviderPresets } : {},
        getSecret: vi.fn((key: string): string | null => secrets.get(key) ?? null),
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
      const writeSettings = (judge: unknown) => writeFileSync(settingsPath, JSON.stringify({ permissions: { judge } }));
      writeSettings({ model: selected, chain: [
        { id: "selected", provider: "builtin-llm", model: selected },
        { id: "project", provider: "builtin-llm", model: project },
      ], mode: "active" });
      await wireReviewerAndPermissions(context as never);
      const rewire = () => (context as unknown as { rewireReviewerAgent: () => Promise<void> }).rewireReviewerAgent();
      const lastJudge = () => wireJudgeAgent.mock.lastCall?.[0] as JudgeDeps;
      const lastReviewer = () => wireReviewerAgent.mock.lastCall?.[0] as ReviewerDeps;
      expect(context.approvalGate.setOwnerAwayAutoSkipMinutes).toHaveBeenCalledWith(0);
      expect(settingsService.onChanged).toHaveBeenCalledWith("permissions", expect.any(Function));
      expect(lastJudge().networkFetch).toBe(unusedNetworkFetch);
      expect(lastJudge().audit).toBe(context.bootAuditLogger);
      expect(lastJudge().settings.chain).toHaveLength(2);
      expect(lastJudge().chainRejected).toBeUndefined();
      expect(lastReviewer().selectedModel).toEqual({ label: "openai-compatible/shared-model", available: true });
      expect(lastReviewer().streamProviderFor(selected.vendor)).toBe(provider);
      expect(lastJudge().providerForModel(selected)).toBe(provider);
      expect(createProvider).toHaveBeenLastCalledWith(expect.objectContaining({
        vendor: selected.vendor, model: selected.model, apiKey: "review-route-secret", baseUrl: selectedPreset.baseUrl,
        providerMetadata: selectedPreset, fetch: expect.any(Function),
      }));
      const initialScope = lastJudge().selectedModelCacheScope(selected);
      expect(initialScope).toMatchObject({ baseUrl: selectedPreset.baseUrl, credentialScope: selectedRoute.credentialScope });
      expect(JSON.stringify(initialScope)).not.toContain("review-route-secret");
      expect(lastJudge().providerForModel(project)).toBe(provider);
      const projectScope = lastJudge().selectedModelCacheScope(project);

      llm.provider = "openai";
      llm.marketplaceProviderPresetId = undefined;
      await rewire();
      expect(lastReviewer().readActiveLlm()).toMatchObject({ provider: selected.vendor, model: selected.model, baseUrl: selectedPreset.baseUrl });
      expect(lastReviewer().streamProviderFor(selected.vendor)).toBe(provider);
      expect(createProvider).toHaveBeenLastCalledWith(expect.objectContaining({ baseUrl: selectedPreset.baseUrl, apiKey: "review-route-secret" }));
      expect(lastJudge().selectedModelCacheScope(selected)).toEqual(initialScope);

      llm.provider = "openai-compatible";
      llm.marketplaceProviderPresetId = otherPreset.providerId;
      llm.vendors["openai-compatible"].baseUrl = "https://another-generic.example/v1";
      await rewire();
      expect(lastJudge().providerForModel(selected)).toBe(provider);
      expect(createProvider).toHaveBeenLastCalledWith(expect.objectContaining({ baseUrl: selectedPreset.baseUrl, apiKey: "review-route-secret" }));
      expect(lastJudge().selectedModelCacheScope(selected)).toEqual(initialScope);
      expect(settingsService.getSecret).not.toHaveBeenCalledWith("llm.apiKey.openai-compatible");
      expect(context.subscriptionProviderFactory).not.toHaveBeenCalled();

      llm.vendors["vertex-ai"].vertexProject = "other-project";
      expect(lastJudge().selectedModelCacheScope(project)).toEqual(projectScope);
      expect(lastJudge().providerForModel(project)).toBeNull();
      llm.vendors["vertex-ai"].vertexProject = "sample-project";
      llm.vendors["vertex-ai"].vertexLocation = "region-two";
      expect(lastJudge().providerForModel(project)).toBeNull();

      const buildsBeforeChange = createProvider.mock.calls.length;
      selectedPreset.baseUrl = "https://changed-review.example/v1";
      expect(lastJudge().providerForModel(selected)).toBeNull();
      await rewire();
      expect(lastReviewer().selectedModel?.available).toBe(false);
      expect(lastJudge().providerForModel(selected)).toBeNull();
      expect(createProvider).toHaveBeenCalledTimes(buildsBeforeChange);
      expect(lastJudge().selectedModelCacheScope(selected)).toEqual(initialScope);
      selectedPreset.baseUrl = selectedRoute.baseUrl;
      secrets.delete(selectedRoute.credentialScope);
      await rewire();
      expect(lastJudge().providerForModel(selected)).toBeNull();
      expect(lastReviewer().streamProviderFor(selected.vendor)).toBeNull();

      writeSettings({ chain: [], mode: "active" });
      await rewire();
      expect(lastJudge().settings.chain).toEqual([]);
      expect(lastJudge().chainRejected).toBeUndefined();
      writeFileSync(settingsPath, "{");
      await rewire();
      expect(lastJudge().settingsUnreadable).toBe(true);
      expect(lastJudge().settings.mode).toBe("shadow");
      expect(lastJudge().settings.chain).toEqual([]);
      writeFileSync(settingsPath, "{}");
      await rewire();
      expect(lastJudge().settingsUnreadable).toBeUndefined();
      expect(lastJudge().settings.chain).toEqual([]);
      unlinkSync(settingsPath);
      await rewire();
      expect(lastJudge().settingsUnreadable).toBeUndefined();
      expect(lastJudge().settings.chain).toEqual([]);
    } finally {
      vi.doUnmock("../../../engine/llm/provider-factory.js");
      vi.doUnmock("../reviewer-wiring.js");
      vi.doUnmock("../judge-wiring.js");
      vi.doUnmock("../../../permissions/permission-settings-store.js");
      vi.resetModules();
      await cleanupTmpDir(directory);
    }
  });

  it("follows chat when unset and requires a pinned destination for an explicit reviewer model", async () => {
    const directory = mkdtempSync(join(tmpdir(), "reviewer-model-wiring-"));
    vi.resetModules();
    const { configureHostResources } = await import("../../../main/host-resources.js");
    configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
    const provider: LLMProvider = { vendor: "claude", async *streamTurn() {} };
    const createProvider = vi.fn((_options: unknown) => provider);
    const wireReviewerAgent = vi.fn((_deps: unknown) => ({ recentlyDenied: { setReplayResolver: vi.fn() } }));
    const wireJudgeAgent = vi.fn((_input: unknown) => undefined);
    vi.doMock("../../../engine/llm/provider-factory.js", () => ({ createProvider }));
    vi.doMock("../reviewer-wiring.js", () => ({ wireReviewerAgent }));
    vi.doMock("../judge-wiring.js", () => ({ wireJudgeAgent }));
    const settingsPath = join(directory, "settings.json");
    const writeReviewerModel = (model: JudgeModelRef | string | null) =>
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
      const offered = llmVendorModelOptions("claude")[0];
      assert(offered);
      const llm = structuredClone(DEFAULT_SETTINGS.llm);
      llm.provider = "openai";
      llm.vendors.openai = { ...getLlmVendorSettings(llm.vendors, "openai"), model: "chat-a" };
      const route = systemSubagentRouteIdentity(llm, "claude");
      assert(route);
      const selected: JudgeModelRef = { vendor: "claude", model: offered, route };
      const settingsService = {
        get: (key: string) => key === "llm" ? llm : key === "marketplace" ? {} : {},
        getSecret: vi.fn((key: string): string | null => key === route.credentialScope ? "review-route-secret" : "chat-route-secret"),
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
      const rewire = () => (context as unknown as { rewireReviewerAgent: () => Promise<void> }).rewireReviewerAgent();
      const lastReviewer = () => wireReviewerAgent.mock.lastCall?.[0] as ReviewerDeps;
      writeReviewerModel(null);
      await wireReviewerAndPermissions(context as never);
      expect(lastReviewer().selectedModel).toBeUndefined();
      expect(lastReviewer().readActiveLlm()).toMatchObject({ provider: "openai", model: "chat-a" });
      llm.vendors.openai.model = "chat-b";
      await rewire();
      expect(lastReviewer().readActiveLlm()).toMatchObject({ provider: "openai", model: "chat-b" });

      writeReviewerModel(`claude/${offered}`);
      await rewire();
      expect(lastReviewer().selectedModel).toEqual({ label: `claude/${offered}`, available: false });
      expect(lastReviewer().streamProviderFor("claude")).toBeNull();
      expect(createProvider).not.toHaveBeenCalled();

      writeReviewerModel(selected);
      await rewire();
      expect(lastReviewer().selectedModel).toEqual({ label: `claude/${offered}`, available: true });
      expect(lastReviewer().readActiveLlm()).toMatchObject({ provider: "claude", model: offered, baseUrl: route.baseUrl });
      expect(lastReviewer().streamProviderFor("claude")).toBe(provider);
      expect(createProvider).toHaveBeenLastCalledWith(expect.objectContaining({ vendor: "claude", model: offered, apiKey: "review-route-secret" }));
      llm.vendors.openai.model = "chat-c";
      await rewire();
      expect(lastReviewer().readActiveLlm()).toMatchObject({ provider: "claude", model: offered });

      writeReviewerModel({ ...selected, model: "not-offered-model" });
      await rewire();
      expect(lastReviewer().selectedModel).toEqual({ label: "configured in Settings", available: false });
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
