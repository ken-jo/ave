import { beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { configureHostResources } from "../../../main/host-resources.js";

import { PermissionManager } from "../../../permissions/permission-manager.js";
import type { LLMProvider } from "../../../engine/llm/types.js";
import { deferred } from "../../../__tests__/support/deferred.js";
import { DEFAULT_SETTINGS } from "../../../data/settings-defaults.js";
import { requiredFixture } from "../../../__tests__/support/required-fixture.js";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";
import { createBootHostFixture } from "../../../__tests__/support/host-runtime.js";
import { makeRecentlyDeniedStore } from "../../../__tests__/support/recently-denied.js";
import { RuleBasedRiskClassifier } from "../../../permissions/reviewer/risk-classifier.js";
import { VerdictCache } from "../../../permissions/reviewer/verdict-cache.js";
import { UnavailableRationaleScopeReviewer } from "../../../permissions/reviewer/rationale-scope-reviewer.js";
import { UnavailableApprovalSentenceSelector } from "../../../permissions/reviewer/approval-sentence-selector.js";
import type { WireReviewerResult } from "../reviewer-wiring.js";
import { claimFakeRuntimeDirectories, createSubscriptionRuntimeNamespace } from "../../../__tests__/support/subscription-runtime-namespace.js";
import { CodexAppServerClient } from "../../../main/codex-app-server-client.js";
import { claudeCodeSubscriptionStatus } from "../../../shared/claude-code-subscription.js";

beforeAll(() => configureHostResources({ resourcePath: resolve("resources"), isPackaged: false }));

function reviewerResult(root: string): WireReviewerResult {
  const settings = { mode: "disabled", fallbackOnError: "deny" } as const;
  return {
    classifier: new RuleBasedRiskClassifier(), rationaleScopeReviewer: new UnavailableRationaleScopeReviewer(),
    approvalSentenceSelector: new UnavailableApprovalSentenceSelector(),
    cache: new VerdictCache(join(root, "cache.jsonl")), recentlyDenied: makeRecentlyDeniedStore(join(root, "recent.json")),
    appliedSettings: settings, effectiveSettings: { ...settings, provider: "openai", model: "fixture-model" }, runtimeMode: "disabled",
  };
}

describe("wireReviewerAndPermissions subscription runtime", () => {
  it("blocks API reviewer credentials while retirement is unresolved", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "reviewer-retired-"));
    vi.resetModules();
    const resources = await import("../../../main/host-resources.js");
    resources.configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
    const wireReviewerAgent = vi.fn((_input: unknown) => reviewerResult(tempDir));
    vi.doMock("electron", () => ({ BrowserWindow: { getAllWindows: () => [] } }));
    vi.doMock("../reviewer-wiring.js", async (importOriginal) => ({
      ...await importOriginal<typeof import("../reviewer-wiring.js")>(), wireReviewerAgent,
    }));
    try {
      const { wireReviewerAndPermissions } = await import("../reviewer-permission-wiring.js");
      let retired = true;
      const getSecret = vi.fn(() => "fixture-key");
      const context = {
        host: createBootHostFixture(), toolRegistry: { setDenyRules: vi.fn() },
        permissionManager: new PermissionManager(join(tempDir, "permissions.json")),
        approvalGate: { setOwnerAwayAutoSkipMinutes: vi.fn() },
        settingsService: {
          onChanged: vi.fn(),
          get: (key: string) => key === "llm" ? {
            provider: "openai", activeChatRuntime: { kind: "api" },
            vendors: { openai: { model: "gpt-4o" } }, ...(retired ? { retiredProvider: "copilot" } : {}),
          } : {},
          getSecret,
        },
        llmFetch: vi.fn(), getMainWindow: () => null, bootAuditLogger: { log: vi.fn() },
        subscriptionProviderFactory: vi.fn(),
      };
      await wireReviewerAndPermissions(context as never);
      const options = wireReviewerAgent.mock.calls[0]?.[0] as unknown as {
        streamProviderFor: (provider: string) => LLMProvider | null;
      };
      expect(options.streamProviderFor("openai")).toBeNull();
      expect(getSecret).not.toHaveBeenCalled();
      retired = false;
      // Resolving the retirement changes settings, which rewires the reviewer and pre-reads its credential.
      await (context as unknown as { rewireReviewerAgent: () => Promise<void> }).rewireReviewerAgent();
      const rewired = wireReviewerAgent.mock.calls.at(-1)?.[0] as unknown as typeof options;
      expect(rewired.streamProviderFor("openai")).not.toBeNull();
      expect(getSecret).toHaveBeenCalledOnce();
    } finally {
      vi.doUnmock("electron");
      vi.doUnmock("../reviewer-wiring.js");
      vi.resetModules();
      await cleanupTmpDir(tempDir);
    }
  });
  it.each([undefined, "copilot"] as const)("uses the explicitly selected subscription without releasing the API retirement marker %s", async (retiredProvider) => {
    const tempDir = mkdtempSync(join(tmpdir(), "reviewer-subscription-"));
    vi.resetModules();
    const resources = await import("../../../main/host-resources.js");
    resources.configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
    const wireReviewerAgent = vi.fn((_input: unknown) => reviewerResult(tempDir));
    vi.doMock("electron", () => ({
      BrowserWindow: { getAllWindows: () => [] },
    }));
    vi.doMock("../reviewer-wiring.js", async (importOriginal) => ({
      ...await importOriginal<typeof import("../reviewer-wiring.js")>(), wireReviewerAgent,
    }));
    vi.doMock("../../../ipc/domains/permissions.js", () => ({
      broadcastPermissionConfigChanged: vi.fn(),
    }));

    try {
      const { wireReviewerAndPermissions } = await import("../reviewer-permission-wiring.js");
      const selection = {
        kind: "subscription" as const,
        provider: "codex" as const,
        model: "gpt-5.5-codex",
      };
      const subscriptionProvider: LLMProvider = {
        vendor: "openai",
        subscriptionRuntime: selection,
        async *streamTurn() {},
      };
      const subscriptionProviderFactory = vi.fn(() => subscriptionProvider);
      let connected = true;
      const settingsService = {
        onChanged: vi.fn(),
        get: vi.fn((key: string) => {
          if (key === "llm") {
            return {
              // Deliberately different: reviewer must not consult this stale API-key setting while the subscription runtime is active.
              provider: "claude",
              retiredProvider,
              activeChatRuntime: selection,
              vendors: { claude: { model: "claude-sonnet-4-5" } },
            };
          }
          return {};
        }),
        getSecret: vi.fn(() => null),
      };
      const permissionManager = new PermissionManager(join(tempDir, "permissions.json"));
      const context = {
        host: createBootHostFixture(),
        toolRegistry: { setDenyRules: vi.fn() },
        permissionManager,
        approvalGate: { setOwnerAwayAutoSkipMinutes: vi.fn() },
        settingsService,
        llmFetch: vi.fn(),
        getMainWindow: () => null,
        bootAuditLogger: { log: vi.fn() },
        subscriptionProviderFactory,
        isSubscriptionConnected: async () => connected,
        rewireReviewerAgent: undefined as (() => Promise<void>) | undefined,
      };

      await wireReviewerAndPermissions(context as never);

      const options = wireReviewerAgent.mock.calls[0]?.[0] as unknown as {
        readActiveLlm: () => { provider: string; model: string };
        streamProviderFor: (provider: string) => LLMProvider | null;
      };
      expect(options.readActiveLlm()).toEqual({
        provider: "subscription:codex",
        model: "gpt-5.5-codex",
      });
      expect(options.streamProviderFor("subscription:codex")).toBe(subscriptionProvider);
      expect(subscriptionProviderFactory).toHaveBeenCalledWith(selection);
      // A forged/legacy API-key identity cannot fall through while a subscription runtime owns the active reviewer transport.
      expect(options.streamProviderFor("claude")).toBeNull();
      expect(subscriptionProviderFactory).toHaveBeenCalledOnce();
      connected = false;
      await requiredFixture(context.rewireReviewerAgent)();
      const disconnected = wireReviewerAgent.mock.calls.at(-1)?.[0] as typeof options;
      expect(disconnected.streamProviderFor("subscription:codex")).toBeNull();
      expect(disconnected.streamProviderFor("claude")).toBeNull();
      expect(subscriptionProviderFactory).toHaveBeenCalledOnce();

      connected = true;
      await requiredFixture(context.rewireReviewerAgent)();
      const restored = wireReviewerAgent.mock.calls.at(-1)?.[0] as typeof options;
      expect(restored.readActiveLlm()).toEqual(options.readActiveLlm());
      expect(restored.streamProviderFor("subscription:codex")).toBe(subscriptionProvider);
      expect(subscriptionProviderFactory).toHaveBeenCalledTimes(2);
      expect(settingsService.getSecret).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("electron");
      vi.doUnmock("../reviewer-wiring.js");
      vi.doUnmock("../../../ipc/domains/permissions.js");
      vi.resetModules();
      await cleanupTmpDir(tempDir);
    }
  });
});

it.each(["live disconnect", "model discovery account probe failure"] as const)("invalidates a cached windowless reviewer verdict on %s and restores the saved route", async (scenario) => {
  const tempDir = mkdtempSync(join(tmpdir(), "windowless-reviewer-"));
  vi.resetModules();
  const resources = await import("../../../main/host-resources.js");
  resources.configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
  const cachePath = join(tempDir, "cache.jsonl");
  const wired: WireReviewerResult[] = [];
  vi.doMock("electron", () => ({ BrowserWindow: { getAllWindows: () => [] } }));
  vi.doMock("../reviewer-wiring.js", async importOriginal => {
    const actual = await importOriginal<typeof import("../reviewer-wiring.js")>();
    return {
      ...actual,
      wireReviewerAgent: (input: Parameters<typeof actual.wireReviewerAgent>[0]) => {
        const result = actual.wireReviewerAgent({
          ...input, readSettings: () => ({ mode: "llm", fallbackOnError: "deny" }), verdictCachePath: cachePath,
        });
        wired.push(result);
        return result;
      },
    };
  });
  const { SubscriptionRuntimeService, onSubscriptionRuntimeStatusChanged } = await import("../../../main/subscription-runtime-service.js");
  const connected = claudeCodeSubscriptionStatus("ready", "connected", "test");
  let status = connected;
  const provider = scenario === "live disconnect" ? "claude-code" : "codex";
  const accountStatus = { ...connected, planType: null, pendingDeviceCode: null };
  const getAccountStatus = vi.fn(async () => accountStatus);
  const request = vi.fn(async () => ({ data: [] }));
  const accountClient = {
    getStatus: getAccountStatus, listModels: CodexAppServerClient.prototype.listModels,
    request, stop: vi.fn(),
  };
  const runtime = await SubscriptionRuntimeService.create(async () => {}, {
    namespace: createSubscriptionRuntimeNamespace(),
    claimRuntimeDirectories: claimFakeRuntimeDirectories,
    claudeCodeClient: { getStatus: async () => status, stop: vi.fn() } as never,
    codexClient: accountClient as never,
    createCodexConversationRuntime: () => ({ verifyIsolation: async () => {}, stop: vi.fn() }) as never,
    acpRegistry: { stopAll: vi.fn() } as never,
  });
  const manager = new PermissionManager(join(tempDir, "permissions.json"));
  manager.setMode("auto");
  const selection = { kind: "subscription", provider, ...(provider === "codex" ? { model: "fixture-model" } : {}) } as const;
  const streamTurn = vi.fn(async function* (): ReturnType<LLMProvider["streamTurn"]> {
    yield { type: "text_delta", text: '{"level":"low","reason":"The request is consistent."}' };
    yield { type: "message_complete", stopReason: "end_turn" };
  });
  const subscriptionProviderFactory = vi.fn(() => ({ vendor: "claude", streamTurn }));
  const host = createBootHostFixture();
  const context = {
    host, permissionManager: manager, toolRegistry: { setDenyRules: vi.fn() },
    approvalGate: { setOwnerAwayAutoSkipMinutes: vi.fn() },
    settingsService: {
      onChanged: vi.fn(),
      get: (key: string) => key === "llm" ? {
        provider: "openai", activeChatRuntime: selection, vendors: { openai: { model: "fixture-model" } },
      } : {},
      getSecret: vi.fn(),
    },
    singleHopNetworkFetch: host.singleHopNetworkFetch,
    getMainWindow: () => null, bootAuditLogger: { log: vi.fn(), appendPermissionAuditEntry: vi.fn() }, subscriptionProviderFactory,
    isSubscriptionConnected: async () => (await runtime.getStatus(selection.provider, { allowCached: true })).connection === "connected",
  };
  const dispatch = async (headless: boolean) => {
    const permission = manager.checkDetailed("network_probe", "builtin", "network", undefined, { sessionId: "windowless", headless });
    const review = await manager.dispatchReviewer("network_probe", {
      invocationId: "windowless-review", sessionId: "windowless", source: "builtin", category: "network",
      pathFields: [], finalInput: { url: "http://localhost:3456" }, executionCwd: tempDir, allowedDirectories: [tempDir],
      sensitivePathsAdjacent: [], trustOrigin: "llm-tool-arg", permissionDecision: permission,
    }, undefined, { lane: headless ? "headless" : "foreground-auto" });
    return { review, result: manager.resolveReviewedPermission(permission, review) };
  };
  let dispose: (() => void) | undefined;
  let stopListening: (() => void) | undefined;
  try {
    const { wireReviewerAndPermissions } = await import("../reviewer-permission-wiring.js");
    dispose = await wireReviewerAndPermissions(context as never);
    expect((await dispatch(false)).review.outcome).toBe("fresh");
    expect((await dispatch(false)).review.outcome).toBe("cache");
    expect(streamTurn).toHaveBeenCalledOnce();
    // Observe the gate in the same turn as the host callback, before the queued rewire can complete.
    let immediate: ReturnType<typeof dispatch> | undefined;
    stopListening = onSubscriptionRuntimeStatusChanged((_provider, isConnected) => {
      if (isConnected === false) immediate = dispatch(true);
    });
    if (provider === "codex") {
      await runtime.verify(provider);
      const catalogError = new Error("Catalog unavailable");
      request.mockRejectedValueOnce(catalogError);
      await expect(runtime.openTextSession(selection)).rejects.toThrow();
      expect(immediate).toBeUndefined();
      expect((await dispatch(false)).review.outcome).toBe("cache");
      getAccountStatus.mockResolvedValueOnce(accountStatus).mockRejectedValueOnce(new Error("Account probe unavailable"));
      await expect(runtime.openTextSession(selection)).rejects.toThrow();
      expect(request).toHaveBeenCalledOnce();
    } else {
      status = claudeCodeSubscriptionStatus("unverified", "signed-out", "test");
      await runtime.getStatus(provider);
    }
    expect(await (immediate ?? dispatch(true))).toMatchObject({ review: { outcome: expect.not.stringMatching(/^cache$/) }, result: { decision: "deny", reasonCode: "no-approver" } });
    expect(immediate).toBeDefined();
    await vi.waitFor(() => expect(wired.at(-1)?.runtimeMode).toBe("llm-degraded-to-rule"));
    expect((await dispatch(true)).review.outcome).toBe("unavailable");
    expect(streamTurn).toHaveBeenCalledOnce();

    status = connected;
    await runtime.getStatus(selection.provider);
    await vi.waitFor(() => expect(wired.at(-1)?.runtimeMode).toBe("llm"));
    expect((await dispatch(true)).result.decision).toBe("allow");
    expect(subscriptionProviderFactory.mock.calls).toEqual([[selection], [selection]]);
    expect(context.settingsService.getSecret).not.toHaveBeenCalled();
  } finally {
    dispose?.();
    stopListening?.();
    for (const result of wired) await result.cache.flush();
    await runtime.stop();
    vi.doUnmock("electron");
    vi.doUnmock("../reviewer-wiring.js");
    vi.resetModules();
    await cleanupTmpDir(tempDir);
  }
});

it.each([true, false])("projects the winning focus observation for held settings and reviewer reads (connected=%s)", async (connected) => {
  const tempDir = mkdtempSync(join(tmpdir(), "reviewer-focus-"));
  vi.resetModules();
  const resources = await import("../../../main/host-resources.js");
  resources.configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
  const reviewer = reviewerResult(tempDir);
  const wireReviewerAgent = vi.fn((_input: Parameters<typeof import("../reviewer-wiring.js").wireReviewerAgent>[0]) => reviewer);
  vi.doMock("electron", () => ({ BrowserWindow: { getAllWindows: () => [] } }));
  vi.doMock("../reviewer-wiring.js", async importOriginal => ({
    ...await importOriginal<typeof import("../reviewer-wiring.js")>(), wireReviewerAgent,
  }));
  const { SubscriptionRuntimeService } = await import("../../../main/subscription-runtime-service.js");
  const ready = claudeCodeSubscriptionStatus("ready", "connected", "fixture");
  const signedOut = claudeCodeSubscriptionStatus("unverified", "signed-out", "fixture");
  const getStatus = vi.fn(async () => ready);
  const runtime = await SubscriptionRuntimeService.create(async () => {}, {
    namespace: createSubscriptionRuntimeNamespace(),
    claimRuntimeDirectories: claimFakeRuntimeDirectories,
    claudeCodeClient: { getStatus, stop: vi.fn() } as never,
    codexClient: { stop: vi.fn() } as never,
    acpRegistry: { stopAll: vi.fn() } as never,
  });
  vi.doMock("../../../main/subscription-runtime-service.js", async importOriginal => ({
    ...await importOriginal<typeof import("../../../main/subscription-runtime-service.js")>(),
    getSubscriptionRuntimeService: async () => runtime,
  }));
  const clock = vi.spyOn(Date, "now");
  let dispose: (() => void) | undefined;
  const held = deferred<typeof ready>();
  try {
    const { createSubscriptionChatLoopBindings } = await import("../conversation-wiring.js");
    const { rendererSettingsSnapshot } = await import("../../../ipc/domains/settings.js");
    const { wireReviewerAndPermissions } = await import("../reviewer-permission-wiring.js");
    const { isSubscriptionConnected } = createSubscriptionChatLoopBindings({ auditLogger: { log: vi.fn() } });
    const selection = { kind: "subscription", provider: "claude-code", model: "fixture-model" } as const;
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.llm.activeChatRuntime = selection;
    const settingsService = {
      onChanged: vi.fn(),
      get: <K extends keyof typeof settings>(key: K) => settings[key],
      getAll: () => settings,
      getSecret: vi.fn(),
      hasStoredSecret: () => false,
    };
    const provider: LLMProvider = { vendor: "claude", async *streamTurn() {} };
    const subscriptionProviderFactory = vi.fn(() => provider);
    const context = {
      host: createBootHostFixture(), toolRegistry: { setDenyRules: vi.fn() },
      permissionManager: new PermissionManager(join(tempDir, "permissions.json")),
      approvalGate: { setOwnerAwayAutoSkipMinutes: vi.fn() }, settingsService,
      singleHopNetworkFetch: vi.fn(), getMainWindow: () => null, bootAuditLogger: { log: vi.fn() },
      subscriptionProviderFactory, isSubscriptionConnected,
      rewireReviewerAgent: undefined as (() => Promise<void>) | undefined,
    };
    dispose = await wireReviewerAndPermissions(context as never);
    const reviewerProvider = () => {
      const [wiring] = requiredFixture(wireReviewerAgent.mock.lastCall);
      return requiredFixture(wiring.streamProviderFor)("subscription:claude-code");
    };
    expect(reviewerProvider()).toBe(provider);
    clock.mockReturnValue(Date.now() + 6 * 60_000);
    const projectionStarted = deferred<void>();
    const reviewerStarted = deferred<void>();
    getStatus
      .mockImplementationOnce(() => { projectionStarted.resolve(); return held.promise; })
      .mockImplementationOnce(() => { reviewerStarted.resolve(); return held.promise; })
      .mockResolvedValue(connected ? ready : signedOut);
    const snapshot = rendererSettingsSnapshot(settingsService, undefined, isSubscriptionConnected);
    await projectionStarted.promise;
    const rewire = requiredFixture(context.rewireReviewerAgent)();
    await reviewerStarted.promise;
    await runtime.getStatus(selection.provider);
    held.resolve(ready);
    await rewire;
    const expectedModel = connected ? selection : { kind: "none", reason: "no-connected-provider" };
    expect({
      model: (await snapshot).activeChatModel,
      reviewerAvailable: reviewerProvider() === provider,
    }).toEqual({ model: expectedModel, reviewerAvailable: connected });
  } finally {
    held.resolve(ready);
    dispose?.();
    clock.mockRestore();
    await reviewer.cache.flush();
    await runtime.stop();
    vi.doUnmock("electron");
    vi.doUnmock("../reviewer-wiring.js");
    vi.doUnmock("../../../main/subscription-runtime-service.js");
    vi.resetModules();
    await cleanupTmpDir(tempDir);
  }
});

it.each([false, true])("blocks existing reviewer authority before a production catalog failure, custom=%s", async custom => {
  const tempDir = mkdtempSync(join(tmpdir(), "reviewer-rewire-guard-"));
  vi.resetModules();
  const resources = await import("../../../main/host-resources.js");
  resources.configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
  const reviewer = reviewerResult(tempDir);
  const wireReviewerAgent = vi.fn(() => reviewer);
  vi.doMock("electron", () => ({ BrowserWindow: { getAllWindows: () => [] } }));
  vi.doMock("../reviewer-wiring.js", async importOriginal => ({
    ...await importOriginal<typeof import("../reviewer-wiring.js")>(), wireReviewerAgent,
  }));
  try {
    const { wireReviewerAndPermissions } = await import("../reviewer-permission-wiring.js");
    const { wireJudgeForTest } = await import("../../../__tests__/support/reviewer-judge.js");
    const manager = new PermissionManager(join(tempDir, "permissions.json"));
    const begin = vi.spyOn(manager, "beginReviewerReconfiguration");
    const complete = vi.spyOn(manager, "completeReviewerReconfiguration");
    let failure: Error | undefined;
    const settingsGet = vi.fn((key: string) => {
      if (key === "llm") {
        if (failure) throw failure;
        return { provider: "openai", activeChatRuntime: { kind: "api" }, vendors: { openai: { model: "fixture-model" } } };
      }
      return {};
    });
    const context = { host: createBootHostFixture(), toolRegistry: { setDenyRules: vi.fn() }, permissionManager: manager,
      approvalGate: { setOwnerAwayAutoSkipMinutes: vi.fn() }, settingsService: { onChanged: vi.fn(), get: settingsGet, getSecret: vi.fn() },
      llmFetch: vi.fn(), singleHopNetworkFetch: vi.fn(), getMainWindow: () => null, bootAuditLogger: { log: vi.fn() }, subscriptionProviderFactory: vi.fn(),
      rewireReviewerAgent: undefined as (() => Promise<void>) | undefined };
    await wireReviewerAndPermissions(context as never);
    const classify = vi.fn(() => ({ level: "low" as const, reason: "Previously configured reviewer" }));
    manager.setReviewer({ classifier: { classify }, cache: reviewer.cache, model: "fixture-model" });
    wireJudgeForTest(manager);
    manager.setMode("auto");
    const dispatch = async (headless: boolean) => {
      const permission = manager.checkDetailed("network_probe", "builtin", "network", undefined, { sessionId: "production-rewire-session", headless });
      const review = await manager.dispatchReviewer("network_probe", { invocationId: `production-rewire-${headless}`, sessionId: "production-rewire-session", source: "builtin", category: "network", pathFields: [], finalInput: { url: "http://localhost:3456" }, executionCwd: tempDir, allowedDirectories: [tempDir], sensitivePathsAdjacent: [], trustOrigin: "llm-tool-arg", permissionDecision: permission });
      return { review, result: manager.resolveReviewedPermission(permission, review) };
    };
    expect((await dispatch(false)).result.decision).toBe("allow");
    expect((await dispatch(false)).review.outcome).toBe("cache");
    const oldJudge = vi.fn(async () => ({ decision: "allow" as const, rationale: "Previously healthy custom judge" }));
    if (custom) {
      const { judgeSettings, scriptedStage, collectingAudit } = await import("../../../permissions/judge/__tests__/judge-request-fixture.js");
      const stage = scriptedStage("old-provider");
      manager.setJudge({ settings: judgeSettings({ chain: [stage], categories: { shell: true, write: true, network: true } }), chain: [{ settings: stage, judge: { id: "old-provider", version: "fixture", judge: oldJudge } }],
        breaker: manager.getJudgeBreaker(), audit: collectingAudit().logger });
      expect((await dispatch(false)).result.decision).toBe("allow");
      expect(oldJudge).toHaveBeenCalledOnce();
      oldJudge.mockClear();
    }
    classify.mockClear();
    failure = new Error("Catalog read failed before reviewer installation");
    await expect(context.rewireReviewerAgent!()).rejects.toThrow(failure);
    expect(begin).toHaveBeenCalledTimes(2);
    expect(complete).toHaveBeenCalledOnce();
    expect(wireReviewerAgent).toHaveBeenCalledOnce();
    for (const headless of [false, true]) {
      const blocked = await dispatch(headless);
      expect(blocked.review).toMatchObject({ outcome: "error", verdict: { level: "high" }, judge: { source: "fallback", fallback: "error" } });
      expect(blocked.result).toMatchObject({ decision: headless ? "deny" : "ask", reasonCode: headless ? "no-approver" : "reviewer-human-required" });
    }
    expect(classify).not.toHaveBeenCalled();
    expect(oldJudge).not.toHaveBeenCalled();
    failure = undefined;
    await context.rewireReviewerAgent!();
    expect(complete).toHaveBeenCalledTimes(2);
  } finally {
    await reviewer.cache.flush();
    vi.doUnmock("electron");
    vi.doUnmock("../reviewer-wiring.js");
    vi.resetModules();
    await cleanupTmpDir(tempDir);
  }
});
