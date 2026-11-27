import { subscriptionAccountFixture } from "../../../__tests__/support/subscription-account-fixture.js";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
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
import { RuntimeProcessFixture } from "../../../main/__tests__/support/runtime-process.js";
import { codexExecutableArtifactFixture, normalizeFixtureAncestorPermissions } from "../../../__tests__/support/native-executable.js";
import { createPrivateDirectory } from "../../../main/codex-executable-location.js";
import { CodexAppServerClient } from "../../../main/codex-app-server-client.js";
import { ClaudeCodeSubscriptionClient } from "../../../main/claude-code-subscription-client.js";
import { claudeCodeSubscriptionStatus } from "../../../shared/claude-code-subscription.js";

vi.mock("node:child_process", async (importOriginal) =>
  (await import("../../../__tests__/support/native-executable.js")).fakeFixtureAcl(await importOriginal()));

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

it.each([
  "live disconnect", "model discovery account probe failure", "sign-out during catalog", "process exit during catalog",
  "logout during failed login", "cancel detects sign-out during failed login",
  "account notification confirmation", "account notification overtaken by logout", "account notification retries after rejection",
  "account notification retries after supersession", "account notification retry withdrawn by sign-out",
  "account notification retry withdrawn by shutdown", "matching login completion",
] as const)("invalidates a cached windowless reviewer verdict on %s and restores the saved route", async (scenario) => {
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
  let authReadCount = 0;
  let holdCancelRead = false;
  let holdLoginPreparation = false;
  const getClaudeStatus = vi.fn(async () => status);
  const cancelStarted = deferred<void>();
  const cancelReply = deferred<void>();
  const provider = scenario === "live disconnect" || scenario === "logout during failed login" || scenario === "cancel detects sign-out during failed login" ? "claude-code" : "codex";
  const heldLogout = deferred<void>();
  const logoutStarted = deferred<void>();
  const heldLogin = deferred<void>();
  const loginStarted = deferred<void>();
  const loginError = new Error("Executable preparation failed");
  const accountStatus = { ...connected, planType: null, pendingDeviceCode: null };
  const getAccountStatus = vi.fn(async () => accountStatus);
  const request = vi.fn(async () => ({ data: [] }));
  const accountClient = {
    getStatus: getAccountStatus, listModels: CodexAppServerClient.prototype.listModels,
    request, stop: vi.fn(),
  };
  const holdsCatalog = scenario === "sign-out during catalog" || scenario === "process exit during catalog";
  const usesAccountNotification = scenario.startsWith("account notification") || scenario === "matching login completion";
  const realCancelRace = scenario === "cancel detects sign-out during failed login";
  const accountReads: number[] = [];
  let holdAccountReads = false;
  const catalogStarted = deferred<number>();
  let child: RuntimeProcessFixture | undefined;
  let accountConnected = true;
  let runtimeHome = tempDir;
  if (holdsCatalog || usesAccountNotification || realCancelRace) {
    if (process.platform !== "win32") normalizeFixtureAncestorPermissions(tempDir);
    runtimeHome = join(tempDir, "runtime");
    await createPrivateDirectory(runtimeHome);
  }
  const artifact = holdsCatalog || usesAccountNotification ? await codexExecutableArtifactFixture(runtimeHome) : undefined;
  const cliArtifact = realCancelRace ? await codexExecutableArtifactFixture(runtimeHome) : undefined;
  const realCli = cliArtifact && new ClaudeCodeSubscriptionClient({
    runtimeHome, workspaceDir: runtimeHome, runtimeTempDir: runtimeHome,
    releaseFetch: async () => { throw new Error("Unexpected release request"); },
    candidates: () => [cliArtifact.executable],
    resolveExecutable: async (candidate) => {
      if (holdLoginPreparation) {
        loginStarted.resolve();
        await heldLogin.promise;
        throw loginError;
      }
      return candidate;
    },
    _pinExecutableForTest: async () => ({
      executable: cliArtifact.executable, identity: cliArtifact.contentHash,
      verify: async () => undefined, discard: async () => undefined,
    }),
    spawn: (_command, args) => {
      const process = new RuntimeProcessFixture();
      const reply = (body: string, code = 0) => {
        process.stdout.write(body);
        process.exitCode = code;
        process.emit("close", code, null);
      };
      setImmediate(() => {
        if (args.includes("--version")) return reply("2.1.311 (Claude Code)\n");
        if (args.includes("--help")) return reply("Commands:\n  login [options]   Sign in\n  logout            Log out\n  status [options]  Show status\n");
        authReadCount += 1;
        const authReply = () => {
          const loggedIn = status.connection === "connected";
          reply(JSON.stringify(loggedIn
            ? { loggedIn, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "pro" }
            : { loggedIn }), loggedIn ? 0 : 1);
        };
        if (holdCancelRead) {
          holdCancelRead = false;
          cancelStarted.resolve();
          void cancelReply.promise.then(authReply);
        } else {
          authReply();
        }
      });
      return process as unknown as ChildProcess;
    },
  });

  const runtime = await SubscriptionRuntimeService.create(async () => {}, {
    namespace: createSubscriptionRuntimeNamespace(),
    claimRuntimeDirectories: claimFakeRuntimeDirectories,
    claudeCodeClient: realCli ?? subscriptionAccountFixture({
      getStatus: getClaudeStatus,
      logout: async () => {
        logoutStarted.resolve();
        await heldLogout.promise;
        status = claudeCodeSubscriptionStatus("unverified", "signed-out", "test");
        return status;
      },
      startBrowserLogin: async () => {
        loginStarted.resolve();
        await heldLogin.promise;
        throw loginError;
      },
      stop: vi.fn(),
    }) as never,
    ...(artifact ? {
      createCodexAppServerClient: (options) => new CodexAppServerClient({
        ...options, runtimeHome, sqliteHome: runtimeHome, workspaceDir: runtimeHome, runtimeTempDir: runtimeHome,
        resolveRuntime: async () => ({ ...artifact, version: "0.153.4" }),
        spawn: () => {
          const server = new RuntimeProcessFixture();
          child = server;
          server.stdin.on("data", (chunk) => {
            for (const line of String(chunk).trim().split("\n")) {
              const { method, id } = JSON.parse(line);
              if (method === "model/list") catalogStarted.resolve(id);
              else if (method === "account/read" && holdAccountReads) accountReads.push(id);
              else if (method === "account/login/start" && scenario === "matching login completion") {
                server.stdout.write(`${JSON.stringify({ id, result: { type: "chatgpt", loginId: "fixture-login", authUrl: "https://auth.openai.com/authorize" } })}\n`);
              } else if (id !== undefined) server.stdout.write(`${JSON.stringify({
                id, result: method === "account/read"
                  ? { account: accountConnected ? { type: "chatgpt", planType: "plus" } : null } : {},
              })}\n`);
            }
          });
          return server as unknown as ChildProcess;
        },
      }),
    } : { codexClient: subscriptionAccountFixture(accountClient) as never }),
    createCodexConversationRuntime: () => ({ verifyIsolation: async () => {}, stop: vi.fn() }) as never,
    acpRegistry: { stopAll: vi.fn() } as never,
  });
  const manager = new PermissionManager(join(tempDir, "permissions.json"));
  manager.setMode("auto");
  const selection = { kind: "subscription", provider, ...(provider === "codex" ? { model: "fixture-model" } : {}) } as const;
  const reviewStarted = deferred<void>();
  const releaseReview = deferred<void>();
  const streamTurn = vi.fn(async function* (): ReturnType<LLMProvider["streamTurn"]> {
    if (scenario === "account notification retries after rejection" && streamTurn.mock.calls.length === 2) {
      reviewStarted.resolve();
      await releaseReview.promise;
    }
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
  const dispatch = async (headless: boolean, path = "") => {
    const permission = manager.checkDetailed("network_probe", "builtin", "network", undefined, { sessionId: "windowless", headless });
    const review = await manager.dispatchReviewer("network_probe", {
      invocationId: "windowless-review", sessionId: "windowless", source: "builtin", category: "network",
      pathFields: [], finalInput: { url: `http://localhost:3456${path}` }, executionCwd: tempDir, allowedDirectories: [tempDir],
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
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const wiringsBeforeDisconnect = subscriptionProviderFactory.mock.calls.length;
    if (holdsCatalog) {
      const session = runtime.openTextSession(selection);
      const outcome = session.then(async (opened) => { await opened.stop(); return "opened"; }, () => "rejected");
      const requestId = await catalogStarted.promise;
      const server = requiredFixture(child);
      accountConnected = false;
      if (scenario === "sign-out during catalog") {
        server.stdout.write(`${JSON.stringify({ method: "account/updated", params: { authMode: null } })}\n`);
        server.stdout.write(`${JSON.stringify({ id: requestId, result: { data: [{ id: "fixture-model" }] } })}\n`);
      } else {
        server.emit("exit", 1, null);
      }
      const invalidatedWhileHeld = immediate !== undefined;
      const sessionOutcome = await outcome;
      expect(invalidatedWhileHeld).toBe(true);
      expect(sessionOutcome).toBe("rejected");
    } else if (usesAccountNotification) {
      const server = requiredFixture(child);
      holdAccountReads = true;
      if (scenario === "matching login completion") {
        const reply = (id: number, connected: boolean) => {
          server.stdout.write(`${JSON.stringify({ id, result: { account: connected ? { type: "chatgpt", planType: "plus" } : null } })}\n`);
        };
        const complete = (loginId: string) => {
          server.stdout.write(`${JSON.stringify({ method: "account/login/completed", params: { loginId, success: true } })}\n`);
        };
        await expect(runtime.startLogin(provider, "browser")).resolves.toMatchObject({ pendingLogin: "browser" });
        await vi.waitFor(() => expect(accountReads).toHaveLength(1));
        reply(requiredFixture(accountReads[0]), false);
        await vi.waitFor(async () => expect(await runtime.getCachedStatus(provider)).toMatchObject({ connection: "signed-out" }));
        complete("retired-login");
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(accountReads).toHaveLength(1);
        complete("fixture-login");
        await vi.waitFor(() => expect(accountReads).toHaveLength(2));
        expect((await dispatch(true)).result.decision).toBe("deny");
        reply(requiredFixture(accountReads[1]), true);
        await vi.waitFor(() => expect(wired.at(-1)?.runtimeMode).toBe("llm"));
        expect((await dispatch(true)).result.decision).toBe("allow");
        return;
      }
      const pendingReview = scenario === "account notification retries after rejection" ? dispatch(true, "/pending") : undefined;
      if (pendingReview) await reviewStarted.promise;
      const oldRead = runtime.getStatus(provider);
      await vi.waitFor(() => expect(accountReads).toHaveLength(1));
      const replyConnected = (id: number) => server.stdout.write(`${JSON.stringify({
        id, result: { account: { type: "chatgpt", planType: "plus" } },
      })}\n`);
      server.stdout.write(`${JSON.stringify({ method: "account/updated", params: { authMode: "chatgpt" } })}\n`);
      expect(immediate).toBeDefined();
      replyConnected(requiredFixture(accountReads[0]));
      await expect(oldRead).resolves.toMatchObject({ connection: "unknown" });
      expect((await dispatch(true)).result.decision).toBe("deny");
      await vi.waitFor(() => expect(accountReads).toHaveLength(2));
      if (scenario === "account notification confirmation") {
        replyConnected(requiredFixture(accountReads[1]));
        await vi.waitFor(() => expect(wired.at(-1)?.runtimeMode).toBe("llm"));
        expect((await dispatch(true)).result.decision).toBe("allow");
        expect(accountReads).toHaveLength(2);
        return;
      }
      if (scenario.includes("retries") || scenario.includes("retry withdrawn")) {
        if (scenario === "account notification retries after supersession") {
          await expect(runtime.startLogin(provider, "browser")).rejects.toMatchObject({ code: "subscription-operation-failed" });
          replyConnected(requiredFixture(accountReads[1]));
        } else {
          server.stdout.write(`${JSON.stringify({ id: requiredFixture(accountReads[1]), error: { code: -32603, message: "Account read temporarily unavailable" } })}\n`);
        }
        if (scenario.includes("retry withdrawn")) {
          if (scenario.endsWith("shutdown")) await runtime.stop();
          else server.stdout.write(`${JSON.stringify({ method: "account/updated", params: { authMode: null } })}\n`);
          await new Promise<void>((resolve) => setTimeout(resolve, 350));
          expect(accountReads).toHaveLength(2);
          expect((await dispatch(true)).result.decision).toBe("deny");
          return;
        }
        await vi.waitFor(() => expect(accountReads).toHaveLength(3), { timeout: 2500 });
        expect((await dispatch(true)).result.decision).toBe("deny");
        replyConnected(requiredFixture(accountReads[2]));
        await vi.waitFor(() => expect(wired.at(-1)?.runtimeMode).toBe("llm"));
        releaseReview.resolve();
        if (pendingReview) expect((await pendingReview).result.decision).toBe("deny");
        expect(await dispatch(true)).toMatchObject({ review: { outcome: "fresh" }, result: { decision: "allow" } });
        return;
      }
      await expect(runtime.logout(provider)).resolves.toMatchObject({ connection: "signed-out" });
      replyConnected(requiredFixture(accountReads[1]));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(accountReads).toHaveLength(2);
      expect(subscriptionProviderFactory).toHaveBeenCalledTimes(wiringsBeforeDisconnect);
      holdAccountReads = false;
    } else if (provider === "codex") {
      const catalogError = new Error("Catalog unavailable");
      request.mockRejectedValueOnce(catalogError);
      await expect(runtime.openTextSession(selection)).rejects.toThrow();
      expect(immediate).toBeUndefined();
      expect((await dispatch(false)).review.outcome).toBe("cache");
      getAccountStatus.mockResolvedValueOnce(accountStatus).mockRejectedValueOnce(new Error("Account probe unavailable"));
      await expect(runtime.openTextSession(selection)).rejects.toThrow();
      expect(request).toHaveBeenCalledOnce();
    } else if (scenario === "cancel detects sign-out during failed login") {
      const readsBeforeCancel = authReadCount;
      holdCancelRead = true;
      const cancel = runtime.cancelLogin(provider);
      const outcome = cancel.then((value) => value.connection, (error: unknown) => error);
      await cancelStarted.promise;
      holdLoginPreparation = true;
      const login = runtime.startLogin(provider, "browser");
      const loginFailure = expect(login).rejects.toMatchObject({ code: "subscription-operation-failed" });
      await loginStarted.promise;
      status = claudeCodeSubscriptionStatus("unverified", "signed-out", "test");
      cancelReply.resolve();
      await outcome;
      const afterCancel = await runtime.getCachedStatus(provider);
      heldLogin.resolve();
      await loginFailure;
      expect((await dispatch(true)).result.decision).toBe("deny");
      expect(afterCancel).toMatchObject({ connection: "signed-out" });
      holdLoginPreparation = false;
      expect(immediate).toBeDefined();
      expect(authReadCount).toBe(readsBeforeCancel + 1);
    } else if (scenario === "logout during failed login") {
      const readsBeforeLogout = getClaudeStatus.mock.calls.length;
      const logout = runtime.logout(provider);
      const outcome = logout.then((value) => value.connection, (error: unknown) => error);
      await logoutStarted.promise;
      const login = runtime.startLogin(provider, "browser");
      const loginFailure = expect(login).rejects.toMatchObject({ code: "subscription-operation-failed" });
      await loginStarted.promise;
      heldLogout.resolve();
      const logoutOutcome = await outcome;
      const whileLoginPending = await dispatch(true);
      heldLogin.resolve();
      await loginFailure;
      expect(whileLoginPending).toMatchObject({ review: { outcome: expect.not.stringMatching(/^cache$/) }, result: { decision: "deny", reasonCode: "no-approver" } });
      expect(logoutOutcome).toBe("signed-out");
      expect(getClaudeStatus).toHaveBeenCalledTimes(readsBeforeLogout);
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
    accountConnected = true;
    await runtime.getStatus(selection.provider);
    await vi.waitFor(() => expect(wired.at(-1)?.runtimeMode).toBe("llm"));
    expect((await dispatch(true)).result.decision).toBe("allow");
    expect(subscriptionProviderFactory.mock.calls.slice(wiringsBeforeDisconnect)).toEqual([[selection]]);
    expect(context.settingsService.getSecret).not.toHaveBeenCalled();
  } finally {
    dispose?.();
    stopListening?.();
    releaseReview.resolve();
    for (const result of wired) await result.cache.flush();
    await runtime.stop();
    vi.doUnmock("electron");
    vi.doUnmock("../reviewer-wiring.js");
    vi.resetModules();
    await cleanupTmpDir(tempDir);
  }
});

it.each(["reconnect", "disconnect", "verification", "logout during verification"] as const)(
  "projects the accepted observation for held settings and reviewer reads during %s", async (scenario) => {
  const connected = scenario === "reconnect" || scenario === "verification";
  const verifying = scenario === "verification" || scenario === "logout during verification";
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
  const { SubscriptionRuntimeService, onSubscriptionRuntimeStatusChanged } = await import("../../../main/subscription-runtime-service.js");
  const ready = claudeCodeSubscriptionStatus("ready", "connected", "fixture");
  const signedOut = claudeCodeSubscriptionStatus("unverified", "signed-out", "fixture");
  const getStatus = vi.fn(async () => ready);
  const isolationStarted = deferred<void>();
  const isolation = deferred<typeof ready>();
  const runtime = await SubscriptionRuntimeService.create(async () => {}, {
    namespace: createSubscriptionRuntimeNamespace(),
    claimRuntimeDirectories: claimFakeRuntimeDirectories,
    claudeCodeClient: subscriptionAccountFixture({
      getStatus, stop: vi.fn(), logout: async () => signedOut,
      verify: () => { isolationStarted.resolve(); return isolation.promise; },
    }) as never,
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
  const changed = vi.fn();
  const stopListening = onSubscriptionRuntimeStatusChanged(changed);
  let verification: ReturnType<typeof runtime.verify> | undefined;
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
      hasStoredSecret: async () => false,
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
    verification = verifying ? runtime.verify(selection.provider) : undefined;
    const superseded = scenario === "logout during verification"
      ? expect(verification).rejects.toMatchObject({ code: "subscription-status-superseded" })
      : undefined;
    if (verification) {
      await isolationStarted.promise;
      if (superseded) await runtime.logout(selection.provider);
    } else {
      await runtime.getStatus(selection.provider);
    }
    held.resolve(ready);
    await rewire;
    const expectedModel = connected ? selection : { kind: "none", reason: "no-connected-provider" };
    expect({
      model: (await snapshot).activeChatModel,
      reviewerAvailable: reviewerProvider() === provider,
    }).toEqual({ model: expectedModel, reviewerAvailable: connected });
    isolation.resolve(ready);
    if (superseded) await superseded;
    else if (verification) {
      await expect(verification).resolves.toMatchObject({ capabilities: { chat: true } });
      expect(changed).toHaveBeenCalledWith(selection.provider, true, expect.any(Number));
    }
  } finally {
    stopListening();
    isolation.resolve(ready);
    held.resolve(ready);
    await verification?.catch(() => undefined);
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
