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
import { CodexConversationRuntime } from "../../../main/codex-conversation-runtime.js";
import { CODEX_RPC_REQUEST_TIMEOUT_MS } from "../../../main/codex-conversation-runtime.js";
import type { OAuthLoginOptions } from "../../../main/oauth-login.js";
import { CodexAppServerClient } from "../../../main/codex-app-server-client.js";
import { ClaudeCodeConversationRuntime } from "../../../main/claude-code-conversation-runtime.js";
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

const confirmationHints = ["advertisement", "matching login success", "replacement account", "settlement"] as const;
const confirmationRetirements = ["cancel timeout", "transport loss", "proof disposal", "EPIPE"] as const;
const confirmationWithdrawals = ["sign-out", "logout", "stop"] as const;
const confirmationCases = new Map<string, {
  hint: typeof confirmationHints[number];
  cause: typeof confirmationRetirements[number] | typeof confirmationWithdrawals[number];
}>([
  ...confirmationHints.flatMap((hint) => confirmationRetirements.map((cause) =>
    [`${hint} followed by ${cause}`, { hint, cause }] as const)),
  ...confirmationWithdrawals.map((cause) =>
    [`advertisement withdrawn by ${cause}`, { hint: "advertisement", cause }] as const),
]);

it.each([
  ...confirmationCases.keys(),
  "sign-out batched with initialization", "prompt pipe loss", "account replacement during isolation proof", "live disconnect", "model discovery account probe failure", "sign-out during catalog", "process exit during catalog",
  "logout during failed login", "cancel detects sign-out during failed login",
  "account notification confirmation", "account notification overtaken by logout", "account notification retries after rejection",
  "account notification retry replaced by a new account",
  "account notification retries after supersession", "account notification retry withdrawn by sign-out",
  "account notification retry withdrawn by shutdown", "matching login completion", "account read during cancel",
  "device login completion while account probes fail", "device login cancel failure while account probes fail",
  "window cancel with deferred login completion", "window cancel timeout with a successor login",
  "window cancel timeout after matching success", "window cancel timeout after matching success and connected update",
  "window cancel timeout after matching success and sign-out",
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
  const promptPipeLoss = scenario === "prompt pipe loss";
  const provider = promptPipeLoss || scenario === "live disconnect" || scenario === "logout during failed login" || scenario === "cancel detects sign-out during failed login" ? "claude-code" : "codex";
  const heldLogout = deferred<void>();
  const logoutStarted = deferred<void>();
  const heldLogin = deferred<void>();
  const loginStarted = deferred<void>();
  const loginError = new Error("Executable preparation failed");
  const accountStatus = { ...connected, planType: null, pendingDeviceCode: null };
  const getAccountStatus = vi.fn(async () => accountStatus);
  const request = vi.fn(async () => ({ data: [] }));
  const confirmationCase = confirmationCases.get(scenario);
  const accountClient = {
    getStatus: getAccountStatus, listModels: CodexAppServerClient.prototype.listModels,
    request, stop: vi.fn(),
  };
  let useConversation = false;
  const startupSignOut = scenario === "sign-out batched with initialization";
  const replacementDuringProof = scenario === "account replacement during isolation proof";
  let accountEmail = "alice@example.test";
  const primaryReadEmails: string[] = [];
  let proofChild: RuntimeProcessFixture | undefined;
  const threadStarted = deferred<{ child: RuntimeProcessFixture; id: number }>();
  const holdsCatalog = scenario === "sign-out during catalog" || scenario === "process exit during catalog";
  const windowCancel = scenario.startsWith("window cancel") || confirmationCase?.cause === "cancel timeout";
  const windowCancelTimeout = scenario.startsWith("window cancel timeout");
  const successorAfterTimeout = scenario === "window cancel timeout with a successor login";
  const retiresDeviceLogin = scenario.startsWith("device login") || windowCancel || confirmationCase !== undefined;
  const openAuthorizationUrl = vi.fn<(_url: string, options: OAuthLoginOptions) => void>();
  const windowCancelStarted = deferred<number>();
  let deviceStarts = 0;
  const usesAccountNotification = scenario.startsWith("account notification") || scenario === "matching login completion" || scenario === "account read during cancel" || retiresDeviceLogin;
  const realCancelRace = scenario === "cancel detects sign-out during failed login";
  const accountReads: number[] = [];
  const proofReadStarted = deferred<number>();
  let holdAccountReads = false;
  const catalogStarted = deferred<number>();
  let child: RuntimeProcessFixture | undefined;
  let accountConnected = true;
  let runtimeHome = tempDir;
  if (startupSignOut || replacementDuringProof || holdsCatalog || usesAccountNotification || realCancelRace || promptPipeLoss) {
    if (process.platform !== "win32") normalizeFixtureAncestorPermissions(tempDir);
    runtimeHome = join(tempDir, "runtime");
    await createPrivateDirectory(runtimeHome);
  }
  const artifact = startupSignOut || replacementDuringProof || holdsCatalog || usesAccountNotification ? await codexExecutableArtifactFixture(runtimeHome) : undefined;
  const resolveRuntime = artifact && vi.fn(async () => ({ ...artifact, version: "0.153.4" }));
  const cliArtifact = realCancelRace || promptPipeLoss ? await codexExecutableArtifactFixture(runtimeHome) : undefined;
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

  const printChild = new RuntimeProcessFixture();
  const runtime = await SubscriptionRuntimeService.create(openAuthorizationUrl, {
    ...(promptPipeLoss ? { createClaudeCodeConversationRuntime: (options) => new ClaudeCodeConversationRuntime({
      ...options,
      spawn: () => {
        printChild.stdin._final = (callback) => callback(Object.assign(new Error("Broken pipe"), { code: "EPIPE" }));
        return printChild as unknown as ChildProcess;
      },
    }) } : {}),
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
    ...(resolveRuntime ? {
      createCodexAppServerClient: (options) => new CodexAppServerClient({
        ...options, runtimeHome, sqliteHome: runtimeHome, workspaceDir: runtimeHome, runtimeTempDir: runtimeHome,
        resolveRuntime,
        spawn: () => {
          const server = new RuntimeProcessFixture();
          child = server;
          server.stdin.on("data", (chunk) => {
            for (const line of String(chunk).trim().split("\n")) {
              const { method, id } = JSON.parse(line);
              if (method === "model/list") catalogStarted.resolve(id);
              else if (method === "account/read" && holdAccountReads) accountReads.push(id);
              else if (method === "account/read" && replacementDuringProof) {
                primaryReadEmails.push(accountEmail);
                server.stdout.write(`${JSON.stringify({ id, result: { account: { type: "chatgpt", email: accountEmail } } })}\n`);
              } else if (method === "account/login/start" && scenario === "matching login completion") {
                server.stdout.write(`${JSON.stringify({ id, result: { type: "chatgpt", loginId: "fixture-login", authUrl: "https://auth.openai.com/authorize" } })}\n`);
              } else if (method === "account/login/start" && retiresDeviceLogin) {
                server.stdout.write(`${JSON.stringify({ id, result: {
                  type: "chatgptDeviceCode", loginId: ++deviceStarts === 1 ? "fixture-login" : "successor-login",
                  verificationUrl: "https://auth.openai.com/device", userCode: "Q7KD-9P2M",
                } })}\n`);
              } else if (method === "account/login/cancel" && windowCancel) {
                windowCancelStarted.resolve(id);
              } else if (method === "account/login/cancel" && retiresDeviceLogin) {
                server.stdout.write(`${JSON.stringify({ id, error: { code: -32603, message: "Cancel failed" } })}\n`);
              } else if (id !== undefined) server.stdout.write(`${JSON.stringify({
                id, result: method === "account/read"
                  ? { account: accountConnected ? { type: "chatgpt", planType: "plus", ...(confirmationCase ? { email: accountEmail } : {}) } : null } : {},
              })}\n`);
            }
          });
          return server as unknown as ChildProcess;
        },
      }),
    } : { codexClient: subscriptionAccountFixture(accountClient) as never }),
    createCodexConversationRuntime: (options) => useConversation && artifact ? new CodexConversationRuntime({
      ...options, runtimeHome, sqliteHome: runtimeHome, workspaceDir: runtimeHome, runtimeTempDir: runtimeHome,
      resolveRuntime: async () => ({ ...artifact, version: "0.153.4" }),
      spawn: () => {
        const server = new RuntimeProcessFixture();
        proofChild = server;
        server.stdin.on("data", (chunk) => {
          for (const line of String(chunk).trim().split("\n")) {
            const { method, id } = JSON.parse(line);
            if (method === "initialize" && startupSignOut) {
              server.stdout.write([JSON.stringify({ id, result: {} }),
                JSON.stringify({ method: "account/updated", params: { authMode: null } }), ""].join("\n"));
            } else if (method === "account/read" && replacementDuringProof) {
              accountEmail = "bob@example.test";
              server.stdout.write(`${JSON.stringify({ id, result: { account: { type: "chatgpt", email: accountEmail } } })}\n`);
            } else if (method === "account/read" && confirmationCase?.cause === "proof disposal") {
              proofReadStarted.resolve(id);
            } else if (method === "thread/start") {
              threadStarted.resolve({ child: server, id });
            } else if (id !== undefined) {
              server.stdout.write(`${JSON.stringify({ id, result: { status: "ready" } })}\n`);
            }
          }
        });
        return server as unknown as ChildProcess;
      },
    }) : ({ verifyIsolation: async () => {}, stop: vi.fn() }) as never,
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
    if (promptPipeLoss) await runtime.verify(provider);
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
    if (confirmationCase) {
      const { hint, cause } = confirmationCase;
      const server = requiredFixture(child);
      const send = (target: RuntimeProcessFixture, message: object) => target.stdout.write(`${JSON.stringify(message)}\n`);
      const reply = (target: RuntimeProcessFixture, id: number, email: string | null) => send(target, {
        id, result: { account: email ? { type: "chatgpt", email } : null },
      });
      const deny = { result: { decision: "deny", reasonCode: "no-approver" } };
      const fromProof = cause === "proof disposal";
      const timesOut = cause === "cancel timeout";
      let proof: { child: RuntimeProcessFixture; id: number; outcome: Promise<unknown> } | undefined;
      if (fromProof) {
        useConversation = true;
        const outcome = runtime.verify(provider).catch((error: unknown) => error);
        const id = await proofReadStarted.promise;
        proof = { child: requiredFixture(proofChild), id, outcome };
      }

      holdAccountReads = true;
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        if (timesOut || hint === "matching login success" || hint === "settlement") {
          await runtime.startLogin(provider, "device-code");
          if (hint !== "settlement") {
            await vi.advanceTimersByTimeAsync(0);
            reply(server, requiredFixture(accountReads[0]), null);
            await vi.advanceTimersByTimeAsync(0);
          }
          if (timesOut) {
            requiredFixture(openAuthorizationUrl.mock.calls[0])[1].onCancel("window-closed");
            await windowCancelStarted.promise;
            // The cancel deadline must precede the held confirmation deadline.
            if (hint !== "settlement") await vi.advanceTimersByTimeAsync(1);
          }
        }

        if (hint === "advertisement") {
          send(proof?.child ?? server, { method: "account/updated", params: { authMode: "chatgpt" } });
        } else if (hint === "matching login success") {
          send(server, { method: "account/login/completed", params: { loginId: "fixture-login", success: true } });
        } else if (hint === "replacement account") {
          accountEmail = "bob@example.test";
          if (proof) {
            reply(proof.child, proof.id, accountEmail);
            await proof.outcome;
            expect(proof.child.killed).toBe(true);
          } else {
            const index = accountReads.length;
            const read = runtime.getStatus(provider);
            await vi.advanceTimersByTimeAsync(0);
            reply(server, requiredFixture(accountReads[index]), accountEmail);
            await expect(read).resolves.toMatchObject({ connection: "unknown" });
          }
        }
        expect((await dispatch(true)).result.decision).toBe("deny");

        const withdrew = cause === "sign-out" || cause === "logout" || cause === "stop";
        const proofDetectedReplacement = fromProof && hint === "replacement account";
        let confirmationIndex = accountReads.length;
        await vi.advanceTimersByTimeAsync(1);
        expect(accountReads).toHaveLength(confirmationIndex + 1);
        const held = requiredFixture(accountReads[confirmationIndex]);
        if (!proofDetectedReplacement) {
          if (timesOut) {
            await vi.advanceTimersByTimeAsync(CODEX_RPC_REQUEST_TIMEOUT_MS - (hint === "settlement" ? 2 : 3));
            expect(server.killed).toBe(false);
            await vi.advanceTimersByTimeAsync(1);
            expect(server.killed).toBe(true);
          } else if (proof) {
            reply(proof.child, proof.id, accountEmail);
            await proof.outcome;
            expect(proof.child.killed).toBe(true);
          } else if (cause === "transport loss") {
            server.emit("exit", 1, null);
            expect(server.killed).toBe(true);
          } else if (cause === "EPIPE") {
            server.stdin.emit("error", Object.assign(new Error("Broken pipe"), { code: "EPIPE" }));
            expect(server.killed).toBe(true);
          } else if (cause === "logout") {
            await runtime.logout(provider);
          } else if (cause === "stop") {
            await runtime.stop();
          } else {
            send(server, { method: "account/updated", params: { authMode: null } });
          }
          reply(server, held, accountEmail);
          expect((await dispatch(true)).result.decision).toBe("deny");
          confirmationIndex += 1;
          await vi.advanceTimersByTimeAsync(withdrew ? 8001 : 251);
        }

        if (withdrew) {
          expect(accountReads).toHaveLength(confirmationIndex);
          expect(await dispatch(true)).toMatchObject(deny);
          return;
        }
        await vi.waitFor(() => expect(accountReads).toHaveLength(confirmationIndex + 1));
        const replacement = requiredFixture(child);
        expect(replacement).not.toBe(proof?.child ?? server);
        expect(await dispatch(true)).toMatchObject(deny);
        reply(replacement, requiredFixture(accountReads[confirmationIndex]), accountEmail);
        await vi.advanceTimersByTimeAsync(0);
      } finally {
        vi.useRealTimers();
      }
      await vi.waitFor(() => expect(wired.at(-1)?.runtimeMode).toBe("llm"));
      expect(subscriptionProviderFactory.mock.lastCall).toEqual([selection]);
      expect(await dispatch(true)).toMatchObject({ review: { outcome: "fresh" }, result: { decision: "allow" } });
      return;
    } else if (startupSignOut) {
      useConversation = true;
      const session = await runtime.openTextSession({ kind: "subscription", provider: "codex" });
      const settled = session.streamTurn("fixture prompt")[Symbol.asyncIterator]().next().catch(() => undefined);
      const request = await threadStarted.promise;
      try {
        expect(immediate).toBeDefined();
        expect(await immediate).toMatchObject({ result: { decision: "deny", reasonCode: "no-approver" } });
      } finally {
        request.child.stdout.write(`${JSON.stringify({ id: request.id, error: { code: -32603, message: "Turn ended" } })}\n`);
        await settled;
        await session.stop();
      }
    } else if (replacementDuringProof) {
      useConversation = true;
      const readsBeforeProof = primaryReadEmails.length;
      await expect(runtime.verify(provider)).rejects.toMatchObject({ code: "subscription-status-superseded" });
      expect(proofChild?.killed).toBe(true);
      expect(await immediate).toMatchObject({ result: { decision: "deny", reasonCode: "no-approver" } });
      expect(primaryReadEmails.slice(readsBeforeProof)).toEqual(["alice@example.test"]);
      await vi.waitFor(() => expect(wired.at(-1)?.runtimeMode).toBe("llm"));
      expect(primaryReadEmails.slice(readsBeforeProof)).toEqual(["alice@example.test", "bob@example.test"]);
      expect(await dispatch(true)).toMatchObject({ review: { outcome: "fresh" }, result: { decision: "allow" } });
      return;
    } else if (promptPipeLoss) {
      const session = await runtime.openTextSession(selection);
      try {
        const readCount = authReadCount;
        await expect(session.streamTurn("fixture prompt")[Symbol.asyncIterator]().next()).rejects.toThrow();
        expect(authReadCount).toBe(readCount);
        expect(await (immediate ?? dispatch(true))).toMatchObject({ result: { decision: "deny", reasonCode: "no-approver" } });
        expect(await runtime.getCachedStatus(provider)).toMatchObject({ connection: "unknown" });
      } finally {
        printChild.emit("close", 1, null);
        await session.stop();
      }
    } else if (holdsCatalog) {
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
    } else if (scenario === "account notification retry replaced by a new account") {
      const server = requiredFixture(child);
      holdAccountReads = true;
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const send = (message: object) => server.stdout.write(`${JSON.stringify(message)}\n`);
        const replyConnected = (index: number, email: string) => send({
          id: requiredFixture(accountReads[index]), result: { account: { type: "chatgpt", email } },
        });
        send({ method: "account/updated", params: { authMode: "chatgpt" } });
        await vi.advanceTimersByTimeAsync(0);
        expect(accountReads).toHaveLength(1);
        send({ id: accountReads[0], error: { code: -32603, message: "Account read temporarily unavailable" } });
        await vi.advanceTimersByTimeAsync(0);

        const readAccountA = runtime.getStatus(provider);
        await vi.advanceTimersByTimeAsync(0);
        replyConnected(1, "alice@example.test");
        await expect(readAccountA).resolves.toMatchObject({ connection: "connected" });

        immediate = undefined;
        const readAccountB = runtime.getStatus(provider);
        await vi.advanceTimersByTimeAsync(0);
        replyConnected(2, "bob@example.test");
        await expect(readAccountB).resolves.toMatchObject({ connection: "unknown" });
        expect(immediate).toBeDefined();
        expect(await immediate).toMatchObject({ result: { decision: "deny", reasonCode: "no-approver" } });

        await vi.advanceTimersByTimeAsync(250);
        expect(accountReads).toHaveLength(4);
        replyConnected(3, "bob@example.test");
        await vi.advanceTimersByTimeAsync(0);
      } finally {
        vi.useRealTimers();
      }
      await vi.waitFor(() => expect(wired.at(-1)?.runtimeMode).toBe("llm"));
      expect(subscriptionProviderFactory.mock.lastCall).toEqual([selection]);
      expect(await dispatch(true)).toMatchObject({ review: { outcome: "fresh" }, result: { decision: "allow" } });
      return;
    } else if (windowCancel) {
      const server = requiredFixture(child);
      const send = (server: RuntimeProcessFixture, message: object) => server.stdout.write(`${JSON.stringify(message)}\n`);
      const replyAccount = (server: RuntimeProcessFixture, index: number, connected: boolean) => send(server, {
        id: requiredFixture(accountReads[index]), result: { account: connected ? { type: "chatgpt", planType: "plus" } : null },
      });
      const complete = (server: RuntimeProcessFixture, loginId: string) => send(server, {
        method: "account/login/completed", params: { loginId, success: true },
      });
      const pending = { pendingLogin: "device-code", pendingDeviceCode: "Q7KD-9P2M" };
      holdAccountReads = true;
      await expect(runtime.startLogin(provider, "device-code")).resolves.toMatchObject(pending);
      await vi.waitFor(() => expect(accountReads).toHaveLength(1));
      replyAccount(server, 0, false);
      await new Promise<void>((resolve) => setImmediate(resolve));
      const window = requiredFixture(openAuthorizationUrl.mock.calls[0])[1];
      const deny = { result: { decision: "deny", reasonCode: "no-approver" } };
      let confirmingChild = server;
      let confirmationIndex = 1;

      if (windowCancelTimeout) vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        window.onCancel("window-closed");
        const cancelId = await windowCancelStarted.promise;
        expect(await runtime.getCachedStatus(provider)).toMatchObject({
          pendingLogin: null, pendingDeviceCode: null, capabilities: { chat: false },
        });
        expect((await dispatch(true)).result.decision).toBe("deny");
        if (successorAfterTimeout) {
          const successor = runtime.startLogin(provider, "device-code");
          const successorResult = expect(successor).resolves.toMatchObject(pending);
          await vi.advanceTimersByTimeAsync(CODEX_RPC_REQUEST_TIMEOUT_MS);
          await successorResult;
          expect(server.killed).toBe(true);
          expect(await runtime.getCachedStatus(provider)).toMatchObject(pending);
          confirmingChild = requiredFixture(child);
          expect(confirmingChild).not.toBe(server);
          await vi.advanceTimersByTimeAsync(1);
        } else if (windowCancelTimeout) {
          await vi.advanceTimersByTimeAsync(1);
          complete(server, "fixture-login");
          await vi.advanceTimersByTimeAsync(0);
          expect(accountReads).toHaveLength(2);
          if (scenario.endsWith("connected update")) {
            send(server, { method: "account/updated", params: { authMode: "chatgpt" } });
          }
          if (scenario.endsWith("sign-out")) {
            send(server, { method: "account/updated", params: { authMode: null } });
            expect(await runtime.getCachedStatus(provider)).toMatchObject({ connection: "signed-out" });
          }
          await vi.advanceTimersByTimeAsync(CODEX_RPC_REQUEST_TIMEOUT_MS - 1);
          expect(server.killed).toBe(true);
          expect(child).toBe(server);
          expect(await dispatch(true)).toMatchObject(deny);
          const resolutionsAfterTimeout = requiredFixture(resolveRuntime).mock.calls.length;
          await vi.advanceTimersByTimeAsync(250);
          if (scenario.endsWith("sign-out")) {
            expect(resolveRuntime).toHaveBeenCalledTimes(resolutionsAfterTimeout);
            expect(accountReads).toHaveLength(2);
            expect(child).toBe(server);
            expect(await dispatch(true)).toMatchObject(deny);
            return;
          }
        } else {
          complete(server, "unrelated-login");
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(accountReads).toHaveLength(1);
          complete(server, "fixture-login");
          await vi.waitFor(() => expect(accountReads).toHaveLength(2));
          send(server, { id: cancelId, result: {} });
        }
      } finally {
        if (windowCancelTimeout) vi.useRealTimers();
      }
      if (successorAfterTimeout) {
        await vi.waitFor(() => expect(accountReads).toHaveLength(2));
        replyAccount(confirmingChild, 1, false);
        await new Promise<void>((resolve) => setImmediate(resolve));
        complete(confirmingChild, "successor-login");
        confirmationIndex = 2;
        await vi.waitFor(() => expect(accountReads).toHaveLength(3));
      } else if (windowCancelTimeout) {
        await vi.waitFor(() => expect(accountReads).toHaveLength(3));
        confirmingChild = requiredFixture(child);
        expect(confirmingChild).not.toBe(server);
        confirmationIndex = 2;
      }
      await vi.waitFor(async () => expect(await dispatch(true)).toMatchObject(deny));
      replyAccount(confirmingChild, confirmationIndex, true);
      await vi.waitFor(() => expect(wired.at(-1)?.runtimeMode).toBe("llm"));
      expect(subscriptionProviderFactory.mock.lastCall).toEqual([selection]);
      expect(await dispatch(true)).toMatchObject({ review: { outcome: "fresh" }, result: { decision: "allow" } });
      return;
    } else if (retiresDeviceLogin) {
      const server = requiredFixture(child);
      const send = (message: object) => server.stdout.write(`${JSON.stringify(message)}\n`);
      const rejectAccountRead = (index: number) => send({
        id: requiredFixture(accountReads[index]), error: { code: -32603, message: "Account read temporarily unavailable" },
      });
      const pending = { pendingLogin: "device-code", pendingDeviceCode: "Q7KD-9P2M" };
      accountConnected = false;
      send({ method: "account/updated", params: { authMode: null } });
      await expect(runtime.startLogin(provider, "device-code")).resolves.toMatchObject(pending);
      for (let poll = 0; poll < 2; poll++) {
        await expect(runtime.getStatus(provider)).resolves.toMatchObject({ ...pending, connection: "signed-out" });
      }

      holdAccountReads = true;
      if (scenario === "device login completion while account probes fail") {
        send({ method: "account/login/completed", params: { loginId: "fixture-login", success: true } });
      } else {
        await expect(runtime.cancelLogin(provider)).rejects.toMatchObject({ code: "subscription-operation-failed" });
      }
      await vi.waitFor(() => expect(accountReads).toHaveLength(1));
      rejectAccountRead(0);
      const cardProbe = runtime.getStatus(provider);
      const failedCardProbe = expect(cardProbe).rejects.toMatchObject({ code: "subscription-operation-failed" });
      await vi.waitFor(() => expect(accountReads).toHaveLength(2));
      rejectAccountRead(1);
      await failedCardProbe;
      // Settings supplies this cached projection with a failed refresh.
      expect(await runtime.getCachedStatus(provider)).toMatchObject({
        pendingLogin: null, pendingDeviceCode: null, capabilities: { chat: false },
      });
      expect(await dispatch(true)).toMatchObject({ result: { decision: "deny", reasonCode: "no-approver" } });

      accountConnected = true;
      holdAccountReads = false;
      await expect(runtime.getStatus(provider)).resolves.toMatchObject({ connection: "connected", pendingLogin: null });
      await vi.waitFor(() => expect(wired.at(-1)?.runtimeMode).toBe("llm"));
      expect(await dispatch(true)).toMatchObject({ result: { decision: "allow" } });
      return;
    } else if (usesAccountNotification) {
      const server = requiredFixture(child);
      holdAccountReads = true;
      if (scenario === "account read during cancel") {
        const cancel = runtime.cancelLogin(provider);
        await vi.waitFor(() => expect(accountReads).toHaveLength(1));
        const newerLogin = runtime.startLogin(provider, "browser");
        const loginFailed = expect(newerLogin).rejects.toMatchObject({ code: "subscription-operation-failed" });
        server.stdout.write(`${JSON.stringify({ id: accountReads[0], result: { account: null } })}\n`);
        await expect(cancel).resolves.toMatchObject({ connection: "signed-out" });
        await loginFailed;
        expect((await dispatch(true)).result.decision).toBe("deny");
        expect(await runtime.getCachedStatus(provider)).toMatchObject({ connection: "signed-out" });
        expect(accountReads).toHaveLength(1);
        holdAccountReads = false;
      } else if (scenario === "matching login completion") {
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
      } else {
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
      }
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
