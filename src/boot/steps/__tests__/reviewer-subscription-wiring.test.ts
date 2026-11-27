import { beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { configureHostResources } from "../../../main/host-resources.js";

import { PermissionManager } from "../../../permissions/permission-manager.js";
import type { LLMProvider } from "../../../engine/llm/types.js";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";
import { createBootHostFixture } from "../../../__tests__/support/host-runtime.js";
import { makeRecentlyDeniedStore } from "../../../__tests__/support/recently-denied.js";
import { deferred } from "../../../__tests__/test-helpers.js";
import type { LLMSettings } from "../../../data/settings-store.js";
import { makeAppIpcInvoker } from "../../../ipc/domains/__tests__/test-helpers.js";
import { CHANNELS } from "../../../contract/app-contract.js";
import { RuleBasedRiskClassifier } from "../../../permissions/reviewer/risk-classifier.js";
import { VerdictCache } from "../../../permissions/reviewer/verdict-cache.js";
import { UnavailableRationaleScopeReviewer } from "../../../permissions/reviewer/rationale-scope-reviewer.js";
import { UnavailableApprovalSentenceSelector } from "../../../permissions/reviewer/approval-sentence-selector.js";
import type { WireReviewerResult } from "../reviewer-wiring.js";

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

const AUTH_LOSS_CASES = [
  ["direct-plan settings logout", "chatgpt-plan", "logout"],
  ["direct-plan refresh invalid_grant", "chatgpt-plan", "invalid_grant"],
  ["managed ACP logout", "grok-build", "logout"],
  ["ACP forget", "kimi-code", "forget"],
  ["ACP startup auth required", "grok-build", "startup"],
  ["direct-plan refresh invalid_client", "chatgpt-plan", "invalid_client"],
  ["CLI signed out", "codex", "signed-out"],
] as const;

async function prepareAuthLoss(
  provider: (typeof AUTH_LOSS_CASES)[number][1],
  loss: (typeof AUTH_LOSS_CASES)[number][2],
) {
  const { SubscriptionRuntimeService } = await import("../../../main/subscription-runtime-service.js");
  const { claimFakeRuntimeDirectories, createSubscriptionRuntimeNamespace } =
    await import("../../../__tests__/support/subscription-runtime-namespace.js");
  const { ChatGptPlanSession } = await import("../../../main/chatgpt-plan/session.js");
  const { ChatGptPlanRuntime } = await import("../../../main/chatgpt-plan/runtime.js");
  const { AcpSubscriptionSessionError } = await import("../../../main/acp-subscription-session-client.js");
  const { acpSubscriptionStatus } = await import("../../../shared/acp-subscription.js");
  type RuntimeOptions = NonNullable<Parameters<typeof SubscriptionRuntimeService.create>[1]>;

  let now = Date.now();
  const expiresAt = now + 3_600_000;
  let planRecord = JSON.stringify({
    version: 1, issuer: "https://auth.openai.com", clientId: "oaiapp_1", welcomed: true,
    subject: "fixture-subject", email: "alice@example.com",
    tokens: {
      accessToken: "fixture-access", refreshToken: "fixture-refresh", idToken: "fixture-id",
      expiresAt, savedAt: now, scopes: ["chatgpt.tokens.use.direct"],
    },
  });
  const planFetch: typeof fetch = async () => loss === "logout"
    ? new Response(null, { status: 200 })
    : Response.json({ error: loss }, { status: 400 });
  const planSession = new ChatGptPlanSession({
    fetch: planFetch, now: () => now,
    secrets: {
      isSecretStorageEncrypted: async () => true,
      getEncryptedSecret: async () => planRecord,
      setSecret: async (_key, record) => { planRecord = record; },
      deleteSecret: async () => { planRecord = ""; },
    },
    hostId: async () => "fixture-host", openAuthorizationUrl: vi.fn(), startListener: vi.fn(),
    verifier: { verify: vi.fn(), prefetchKeys: vi.fn() },
  });

  let connection: "connected" | "signed-out" = "connected";
  let runtime: "ready" | "not-configured" = "ready";
  const acpStatus = async () => {
    if (provider === "chatgpt-plan" || provider === "codex") throw new Error("Expected an ACP selection");
    return acpSubscriptionStatus(provider, runtime, connection);
  };
  const openAcp = vi.fn(async () => { throw new AcpSubscriptionSessionError("acp-session-authentication-required"); });
  const service = await SubscriptionRuntimeService.create(vi.fn(), {
    namespace: createSubscriptionRuntimeNamespace(), claimRuntimeDirectories: claimFakeRuntimeDirectories,
    codexClient: {
      getStatus: async () => ({ runtime: "ready", connection, planType: null, pendingLogin: false, version: null }),
      stop: vi.fn(),
    } as unknown as RuntimeOptions["codexClient"],
    claudeCodeClient: { stop: vi.fn() } as unknown as RuntimeOptions["claudeCodeClient"],
    acpRegistry: {
      getStatus: acpStatus, verify: acpStatus, openTextSession: openAcp,
      logout: async () => { connection = "signed-out"; return acpStatus(); },
      forgetExecutable: async () => { runtime = "not-configured"; connection = "signed-out"; return acpStatus(); },
      stopAll: vi.fn(),
    } as unknown as RuntimeOptions["acpRegistry"],
    chatGptPlanRuntime: new ChatGptPlanRuntime(planSession, planFetch),
  });

  return {
    stop: () => service.stop(),
    async loseAuth() {
      if (loss === "invalid_grant" || loss === "invalid_client") {
        now = expiresAt;
        await expect(service.requireChatGptPlan().confirmSession()).rejects.toMatchObject({
          code: loss === "invalid_grant" ? "subscription-chat-unavailable" : "subscription-operation-failed",
        });
      } else if (loss === "logout") {
        expect((await service.logout(provider)).connection).toBe("signed-out");
      } else if (loss === "forget") {
        expect((await service.forgetExecutable(provider)).runtime).toBe("not-configured");
      } else if (loss === "signed-out") {
        connection = "signed-out";
      }
    },
    async checkAuthorization() {
      if (provider === "chatgpt-plan") await service.requireChatGptPlan().accessToken();
      else {
        const selection = { kind: "subscription", provider } as const;
        await (await service.openTextSession(selection)).stop();
      }
    },
    openAcp,
  };
}

async function withLiveReviewer(
  provider: (typeof AUTH_LOSS_CASES)[number][1] | "api",
  test: (fixture: {
    manager: PermissionManager;
    directory: string;
    getCache: () => VerdictCache;
    seedVerdict: (headless: boolean) => Promise<ReturnType<PermissionManager["resolveReviewedPermission"]>>;
    loseAuth: () => Promise<void>;
    reply: ReturnType<typeof vi.fn<LLMProvider["streamTurn"]>>;
    apiReply: ReturnType<typeof vi.fn<LLMProvider["streamTurn"]>>;
    registerRouteSelection: (refreshProvider: () => Promise<void>, refreshActiveLlmWildcard?: () => void) => Promise<{
      invoke: ReturnType<typeof makeAppIpcInvoker>;
      getSelection: () => LLMSettings["activeChatRuntime"];
      rewire: () => Promise<void>;
    }>;
    dispatch: (headless: boolean) => Promise<{
      review: Awaited<ReturnType<PermissionManager["dispatchReviewer"]>>;
      result: ReturnType<PermissionManager["resolveReviewedPermission"]>;
    }>;
  }) => Promise<void>,
  loss?: (typeof AUTH_LOSS_CASES)[number][2],
) {
  const tempDir = mkdtempSync(join(tmpdir(), "reviewer-live-"));
  vi.resetModules();
  const resources = await import("../../../main/host-resources.js");
  resources.configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
  const { DEFAULT_JUDGE_SETTINGS } = await import("../../../permissions/judge/judge-settings.js");
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  vi.doMock("electron", () => ({
    BrowserWindow: { getAllWindows: () => [] },
    ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler) },
  }));
  vi.doMock("../../../permissions/permission-settings-store.js", async importOriginal => ({
    ...await importOriginal<typeof import("../../../permissions/permission-settings-store.js")>(),
    readJudgeSettings: () => ({ settings: DEFAULT_JUDGE_SETTINGS, issues: [] }),
    readPermissionSettings: () => ({ permissions: { blockReadsOutsideWorkingDirectories: false }, fault: null }),
  }));
  const replyWithVerdict: LLMProvider["streamTurn"] = async function* () {
    yield { type: "text_delta", text: '{"level":"low","reason":"Fixture review"}' };
    yield { type: "message_complete", stopReason: "end_turn" };
  };
  const reply = vi.fn(replyWithVerdict);
  const apiReply = vi.fn(replyWithVerdict);
  let cache: VerdictCache | undefined;
  vi.doMock("../reviewer-wiring.js", async importOriginal => {
    const original = await importOriginal<typeof import("../reviewer-wiring.js")>();
    return {
      ...original,
      wireReviewerAgent: (deps: Parameters<typeof original.wireReviewerAgent>[0]) => {
        const wired = original.wireReviewerAgent({
          ...deps,
          ...(provider === "api" ? { streamProviderFor: (id: string) => id.startsWith("subscription:")
            ? deps.streamProviderFor?.(id) ?? null
            : { vendor: "openai" as const, streamTurn: apiReply } } : {}),
          readSettings: () => ({ mode: "llm", fallbackOnError: "deny" }),
          verdictCachePath: join(tempDir, "cache.jsonl"),
          recentlyDenied: makeRecentlyDeniedStore(join(tempDir, "recent.json")),
        });
        cache = wired.cache;
        return wired;
      },
    };
  });
  let auth: Awaited<ReturnType<typeof prepareAuthLoss>> | undefined;
  try {
    if (provider !== "api" && loss) auth = await prepareAuthLoss(provider, loss);
    const { wireReviewerAndPermissions } = await import("../reviewer-permission-wiring.js");
    const { PermissionManager } = await import("../../../permissions/permission-manager.js");
    const manager = new PermissionManager(join(tempDir, "permissions.json"));
    manager.setMode("auto");
    let selection: LLMSettings["activeChatRuntime"] = provider === "api" ? { kind: "api" } :
      { kind: "subscription", provider, model: "fixture-model" };
    const getLlm = () => ({
      provider: "openai", activeChatRuntime: selection, vendors: { openai: { model: "fixture-model" } },
    });
    const context = {
      host: createBootHostFixture(), toolRegistry: { setDenyRules: vi.fn() }, permissionManager: manager,
      approvalGate: { setOwnerAwayAutoSkipMinutes: vi.fn() }, getMainWindow: () => null,
      settingsService: {
        onChanged: vi.fn(), getSecret: vi.fn(() => "fixture-key"),
        get: (key: string) => key === "llm" ? getLlm() : {},
      },
      llmFetch: vi.fn(), singleHopNetworkFetch: vi.fn(),
      bootAuditLogger: { appendPermissionAuditEntry: vi.fn(), logShadow: vi.fn() },
      resolveRootSessionId: (id: string) => id,
      subscriptionProviderFactory: vi.fn((): LLMProvider => ({ vendor: "openai", streamTurn: reply })),
      rewireReviewerAgent: undefined as (() => Promise<void>) | undefined,
    };
    const setReviewer = vi.spyOn(manager, "setReviewer");
    await wireReviewerAndPermissions(context as never);
    let invocation = 0;
    const dispatch = async (headless: boolean) => {
      const sessionId = "live-review";
      const permission = manager.checkDetailed("network_probe", "builtin", "network", undefined, { sessionId, headless });
      const review = await manager.dispatchReviewer("network_probe", {
        invocationId: String(++invocation), sessionId, source: "builtin", category: "network",
        pathFields: [], finalInput: { url: "http://localhost:3456" }, trustOrigin: "llm-tool-arg",
        executionCwd: tempDir, allowedDirectories: [tempDir], sensitivePathsAdjacent: [], permissionDecision: permission,
      }, undefined, { lane: headless ? "headless" : "foreground-auto" });
      return { review, result: manager.resolveReviewedPermission(permission, review) };
    };
    const seedVerdict = async (headless: boolean) => {
      // Seed and flush with the same dependencies and main's original cache behavior.
      const wiring = setReviewer.mock.lastCall?.[0];
      if (!wiring) throw new Error("Missing reviewer wiring");
      const { classifier, cache: seedCache, recentlyDenied, model, cacheScope } = wiring;
      manager.setReviewer({ classifier, cache: seedCache, recentlyDenied, model, cacheScope });
      const first = await dispatch(headless);
      expect(first.review.outcome).toBe("fresh");
      expect((await dispatch(headless)).review.outcome).toBe("cache");
      await seedCache.flush();
      await wireReviewerAndPermissions(context as never);
      expect(manager.getVerdictCache()).not.toBe(seedCache);
      return first.result;
    };
    const loseAuth = async () => {
      const route = auth;
      if (!route) throw new Error("Missing route failure fixture");
      await route.loseAuth();
      reply.mockClear();
      reply.mockImplementation(async function* (params) {
        await route.checkAuthorization();
        yield* replyWithVerdict(params);
      });
    };
    const getCache = () => {
      const installedCache = manager.getVerdictCache();
      if (!installedCache) throw new Error("Missing reviewer cache");
      return installedCache;
    };
    const registerRouteSelection = async (refreshProvider: () => Promise<void>, refreshActiveLlmWildcard?: () => void) => {
      vi.doMock("../../../main/subscription-runtime-service.js", async importOriginal => ({
        ...await importOriginal<typeof import("../../../main/subscription-runtime-service.js")>(),
        getSubscriptionRuntimeService: async () => ({
          verify: async () => ({ capabilities: { chat: true } }),
          invalidateCachedReads: vi.fn(),
        }),
        onSubscriptionRuntimeStatusChanged: () => vi.fn(),
      }));
      const { registerSettingsHandlers } = await import("../../../ipc/domains/settings.js");
      const rewire = context.rewireReviewerAgent;
      if (!rewire) throw new Error("Missing reviewer rewire");
      registerSettingsHandlers({
        settingsService: {
          ...context.settingsService,
          getAll: () => ({ llm: getLlm() }),
          hasStoredSecret: async () => true,
          patch: async (value: { llm: { activeChatRuntime: LLMSettings["activeChatRuntime"] } }) => {
            selection = value.llm.activeChatRuntime;
          },
        },
        conversationLoop: { permissionManager: manager, refreshProvider },
        auditLogger: { log: vi.fn() },
        getAppWindows: () => [],
        rewireReviewerAgent: rewire,
        refreshActiveLlmWildcard,
      } as never);
      return { invoke: makeAppIpcInvoker(handlers), getSelection: () => selection, rewire };
    };
    await test({ manager, directory: tempDir, getCache, reply, apiReply, dispatch, seedVerdict, loseAuth, registerRouteSelection });
    if (loss === "startup") expect(auth?.openAcp).toHaveBeenCalled();
  } finally {
    await auth?.stop();
    await cache?.flush();
    vi.doUnmock("electron");
    vi.doUnmock("../reviewer-wiring.js");
    vi.doUnmock("../../../permissions/permission-settings-store.js");
    vi.doUnmock("../../../main/subscription-runtime-service.js");
    vi.resetModules();
    await cleanupTmpDir(tempDir);
  }
}

it.each(AUTH_LOSS_CASES)("fails closed with an empty verdict cache after %s", async (_case, provider, loss) => {
  await withLiveReviewer(provider, async ({ reply, dispatch, loseAuth }) => {
    await loseAuth();
    for (const headless of [false, true]) {
      reply.mockClear();
      const { review, result } = await dispatch(headless);
      expect(reply).toHaveBeenCalled();
      expect(review).toMatchObject({ outcome: "error", verdict: { level: "high" } });
      expect(result.decision).toBe(headless ? "deny" : "ask");
    }
  }, loss);
});

it.each(AUTH_LOSS_CASES)("re-reviews an identical request after %s despite a persisted allow", async (_case, provider, loss) => {
  await withLiveReviewer(provider, async ({ seedVerdict, reply, dispatch, getCache, loseAuth }) => {
    await seedVerdict(true);
    const lookup = vi.spyOn(getCache(), "lookup");
    const store = vi.spyOn(getCache(), "store");

    await loseAuth();
    const { review, result } = await dispatch(true);
    expect(result.decision).toBe("deny");
    expect(review.outcome).toBe("error");
    expect(reply).toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
    expect(store).not.toHaveBeenCalled();
  }, loss);
});

it("keeps cache hits for an API-key follow-chat reviewer", async () => {
  await withLiveReviewer("api", async ({ apiReply, dispatch }) => {
    expect((await dispatch(true)).review.outcome).toBe("fresh");
    expect((await dispatch(true)).review.outcome).toBe("cache");
    expect(apiReply).toHaveBeenCalledOnce();
  });
});

it("fences both Settings route switches while the chat provider refresh is pending", async () => {
  await withLiveReviewer("api", async ({ apiReply, reply, getCache, dispatch, registerRouteSelection }) => {
    const refreshProvider = vi.fn(async () => {});
    const { invoke, getSelection, rewire } = await registerRouteSelection(refreshProvider);
    for (const headless of [false, true]) {
      expect((await dispatch(headless)).result.decision).toBe("allow");
      expect((await dispatch(headless)).review.outcome).toBe("cache");
    }
    await getCache().flush();

    for (const kind of ["subscription", "api"] as const) {
      const refreshStarted = deferred<void>();
      const releaseRefresh = deferred<void>();
      refreshProvider.mockImplementationOnce(async () => {
        refreshStarted.resolve();
        await releaseRefresh.promise;
      });
      const pending = kind === "subscription"
        ? invoke(CHANNELS.settings.subscriptionUseForChat, "grok-build")
        : invoke(CHANNELS.settings.subscriptionUseApiForChat);
      await refreshStarted.promise;
      const currentCache = getCache();
      const lookup = vi.spyOn(currentCache, "lookup");
      apiReply.mockClear();
      reply.mockClear();
      try {
        expect(getSelection()?.kind).toBe(kind);
        for (const headless of [false, true]) {
          const { review, result } = await dispatch(headless);
          expect.soft(review.outcome, kind).toBe("error");
          expect.soft(result.decision, kind).toBe(headless ? "deny" : "ask");
        }
        expect.soft(lookup, kind).not.toHaveBeenCalled();
        expect.soft(apiReply, kind).not.toHaveBeenCalled();
        expect.soft(reply, kind).not.toHaveBeenCalled();
        await rewire();
        expect.soft((await dispatch(true)).result.decision, kind).toBe("deny");
      } finally {
        lookup.mockRestore();
        releaseRefresh.resolve();
        await expect(pending).resolves.toMatchObject({ ok: true });
      }

      apiReply.mockClear();
      reply.mockClear();
      const expectedOutcome = kind === "subscription" ? "fresh" : "cache";
      for (const headless of [false, true, true]) {
        const { review, result } = await dispatch(headless);
        expect(review.outcome).toBe(expectedOutcome);
        expect(result.decision).toBe("allow");
      }
      expect(apiReply).not.toHaveBeenCalled();
      expect(reply).toHaveBeenCalledTimes(kind === "subscription" ? 3 : 0);
    }
  });
});

it("keeps review fenced until Settings rebinds the restored route after a failed switch", async () => {
  await withLiveReviewer("api", async ({ apiReply, reply, getCache, dispatch, registerRouteSelection }) => {
    const rollbackStarted = deferred<void>();
    const releaseRollback = deferred<void>();
    const refreshProvider = vi.fn(async () => {}).mockImplementationOnce(async () => {}).mockImplementationOnce(async () => {
      rollbackStarted.resolve();
      await releaseRollback.promise;
    });
    const refreshActiveLlmWildcard = vi.fn().mockImplementationOnce(() => { throw new Error("Wildcard refresh failed"); });
    const { invoke, getSelection } = await registerRouteSelection(refreshProvider, refreshActiveLlmWildcard);
    expect((await dispatch(true)).review.outcome).toBe("fresh");
    await getCache().flush();
    const pending = invoke(CHANNELS.settings.subscriptionUseForChat, "grok-build");
    await rollbackStarted.promise;
    try {
      expect(getSelection()?.kind).toBe("api");
      expect((await dispatch(false)).result.decision).toBe("ask");
      expect((await dispatch(true)).result.decision).toBe("deny");
      expect(reply).not.toHaveBeenCalled();
    } finally {
      releaseRollback.resolve();
      await expect(pending).resolves.toMatchObject({ ok: false, error: "subscription-operation-failed" });
    }
    expect((await dispatch(true)).review.outcome).toBe("cache");
    expect(apiReply).toHaveBeenCalledOnce();
  });
});

it("preserves cache hits for an explicit independent model", async () => {
  await withLiveReviewer("grok-build", async ({ seedVerdict, manager, reply, dispatch }) => {
    await seedVerdict(true);
    const { BuiltinLlmJudge } = await import("../../../permissions/judge/builtin-llm-judge.js");
    const { judgeSettings, collectingAudit } = await import("../../../permissions/judge/__tests__/judge-request-fixture.js");
    const stage = { id: "independent", provider: "builtin-llm", model: { vendor: "openai", model: "fixture-independent" } } as const;
    const classifyWithTrace = vi.fn(async () => {
      const verdict = { level: "low", reason: "Independent verdict" } as const;
      return { ruleVerdict: verdict, finalVerdict: verdict, llmVerdict: verdict, outcome: "fresh" as const };
    });
    manager.setJudge({
      settings: judgeSettings({ chain: [stage], categories: { shell: true, network: true, write: true } }),
      chain: [{ settings: stage, judge: new BuiltinLlmJudge({ classifyWithTrace }, stage.model.model) }],
      breaker: manager.getJudgeBreaker(), audit: collectingAudit().logger,
    });
    reply.mockClear();
    reply.mockImplementation(() => { throw new Error("subscription-chat-unavailable"); });
    for (let attempt = 0; attempt < 2; attempt++) {
      const { review, result } = await dispatch(true);
      expect(result.decision).toBe("allow");
      expect(review.outcome).toBe(attempt === 0 ? "fresh" : "cache");
    }
    expect(classifyWithTrace).toHaveBeenCalledOnce();
    expect(reply).not.toHaveBeenCalled();
  });
});

it("does not replay the authoritative subscription baseline in shadow mode", async () => {
  await withLiveReviewer("grok-build", async ({ seedVerdict, manager, reply, dispatch, loseAuth }) => {
    await seedVerdict(true);
    const { judgeSettings, scriptedStage, collectingAudit } = await import("../../../permissions/judge/__tests__/judge-request-fixture.js");
    const stage = scriptedStage("observer");
    const judge = vi.fn(async () => ({ decision: "allow" as const, rationale: "Shadow observation" }));
    manager.setJudge({
      settings: judgeSettings({ chain: [stage], mode: "shadow", categories: { shell: true, network: true, write: true } }),
      chain: [{ settings: stage, judge: { id: "observer", version: "fixture", judge } }],
      breaker: manager.getJudgeBreaker(), audit: collectingAudit().logger,
    });

    await loseAuth();
    const { review, result } = await dispatch(true);
    expect(result.decision).toBe("deny");
    expect(review.outcome).toBe("error");
    expect(judge).toHaveBeenCalledOnce();
    expect(reply).toHaveBeenCalled();
  }, "logout");
});

it("reviews logical surface actions live after subscription auth loss", async () => {
  await withLiveReviewer("grok-build", async ({ manager, reply, directory, getCache, loseAuth }) => {
    const { issueUserOwnedBrowserScope } = await import("../../../permissions/user-owned-browser-scope.js");
    const sessionId = "logical-review";
    const userOwnedBrowser = issueUserOwnedBrowserScope({
      kind: "browser-origin", origin: "https://example.test", tabOpener: "user", tabId: "tab", documentId: 1, controlGeneration: 1,
    }, () => true);
    manager.setUserOwnedSurfaceChoice(sessionId, "browser", "auto");
    reply.mockImplementation(async function* () {
      yield { type: "text_delta", text: '{"consistent":true,"reason":"Requested action"}' };
      yield { type: "message_complete", stopReason: "end_turn" };
    });
    let invocation = 0;
    const dispatchSurface = async () => {
      const permission = manager.checkDetailed("browser_action", "builtin", "read", undefined, {
        sessionId, trustOrigin: "llm-tool-arg", userOwnedBrowser,
      });
      const review = await manager.dispatchReviewer("browser_action", {
        invocationId: String(++invocation), sessionId, source: "builtin", category: "read", pathFields: [],
        finalInput: { tabId: "tab", action: "read details" }, executionCwd: directory, allowedDirectories: [directory],
        sensitivePathsAdjacent: [], trustOrigin: "llm-tool-arg", permissionDecision: permission,
        conversationContext: { recentUserMessage: "Read my current tab", currentTaskStep: "Read the details" },
      });
      return manager.resolveReviewedPermission(permission, review);
    };
    const lookup = vi.spyOn(getCache(), "lookup");
    expect((await dispatchSurface()).decision).toBe("allow");
    await loseAuth();
    expect(await dispatchSurface()).toMatchObject({ decision: "ask", reviewer: { outcome: "error" } });
    expect(reply).toHaveBeenCalledOnce();
    expect(lookup).not.toHaveBeenCalled();
  }, "logout");
});

it("does not start a rationale round from a stored subscription verdict", async () => {
  await withLiveReviewer("chatgpt-plan", async ({ dispatch, manager, reply, seedVerdict, loseAuth }) => {
    const { isRationaleEligible } = await import("../../../tools/pipeline/rationale-control.js");
    const { createTestRequestAnchor } = await import("../../../tools/pipeline/__tests__/rationale-fixtures.js");
    const anchor = createTestRequestAnchor({ sessionId: "live-review" });
    const eligible = (permission: Awaited<ReturnType<typeof dispatch>>["result"]) => isRationaleEligible({
      permission, anchor, invocationTrustOrigin: "llm-tool-arg",
      rationaleProvenance: { startedFromUserKeyboard: true, taint: "none" },
    });
    reply.mockImplementation(async function* () {
      yield { type: "text_delta", text: '{"level":"high","reason":"Extra operation risk"}' };
      yield { type: "message_complete", stopReason: "end_turn" };
    });
    expect(eligible(await seedVerdict(false))).toBe(true);
    manager.beginPermissionTurn("live-review");
    await loseAuth();
    const { review, result } = await dispatch(false);
    expect(result.decision).toBe("ask");
    expect(eligible(result)).toBe(false);
    expect(review.outcome).toBe("error");
    expect(reply).toHaveBeenCalled();
  }, "logout");
});

it("neither reads nor writes cache entries during successful subscription review", async () => {
  await withLiveReviewer("chatgpt-plan", async ({ dispatch, reply, getCache }) => {
    const lookup = vi.spyOn(getCache(), "lookup");
    const store = vi.spyOn(getCache(), "store");
    for (let attempt = 0; attempt < 2; attempt++) {
      const { review, result } = await dispatch(true);
      expect(result.decision).toBe("allow");
      expect(review.outcome).toBe("fresh");
    }
    expect(reply).toHaveBeenCalledTimes(2);
    expect(lookup).not.toHaveBeenCalled();
    expect(store).not.toHaveBeenCalled();
  });
});
