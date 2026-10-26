import { beforeEach, describe, expect, it, vi } from "vitest";
import { InputClassifier } from "../../core/input-classifier.js";
import { RouteEngine } from "../../core/route-engine.js";
import type { LLMProvider, StreamEvent, StreamTurnParams } from "../../engine/llm/types.js";
import type { SubscriptionRuntimeAuditEvent } from "../../main/subscription-runtime-service.js";
import type { SubscriptionChatRuntimeSelection } from "../../shared/subscription-runtime.js";
import { ToolRegistry } from "../../tools/registry.js";
import { makeConversationLoopMemoryManager } from "../../engine/__tests__/conversation-loop-test-helpers.js";

const h = vi.hoisted(() => ({
  createSubscriptionLlmProvider: vi.fn(),
}));

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  shell: { openExternal: vi.fn(async () => {}) },
}));

vi.mock("../../main/subscription-llm-provider.js", () => ({
  createSubscriptionLlmProvider: h.createSubscriptionLlmProvider,
}));

import {
  createConversationLoop,
  createRoutineConversationLoop,
  createSideChatConversationLoop,
} from "../conversation.js";
import { createSubscriptionChatLoopBindings } from "../steps/conversation-wiring.js";
import { installOAuthLoginOpener, type OpenOAuthLogin } from "../../main/oauth-login.js";

const selection = {
  kind: "subscription",
  provider: "codex",
  model: "gpt-5.4",
} as const satisfies SubscriptionChatRuntimeSelection;

interface SubscriptionProviderFactoryOptions {
  readonly selection: SubscriptionChatRuntimeSelection;
  readonly openAuthorizationUrl: OpenOAuthLogin;
  readonly runtimeServiceOptions: {
    readonly audit: (event: SubscriptionRuntimeAuditEvent) => void;
  };
}

function providerFor(runtimeSelection: SubscriptionChatRuntimeSelection): LLMProvider {
  return {
    vendor: "openai",
    subscriptionRuntime: runtimeSelection,
    async *streamTurn(_input: StreamTurnParams): AsyncIterable<StreamEvent> {},
  };
}

function sharedLoopDeps() {
  return {
    settingsService: {
      get: (key: string) => {
        if (key === "llm") return { activeChatRuntime: selection };
        if (key === "features") return { hostClassifiesRisk: false };
        return {};
      },
      getSecret: () => undefined,
    },
    inputClassifier: new InputClassifier(),
    routeEngine: new RouteEngine(),
    toolRegistry: new ToolRegistry(),
    memoryManager: makeConversationLoopMemoryManager(),
    pluginRuntime: { listPluginCards: () => [] },
    permissionManager: {},
    approvalGate: {},
    hookRunner: {},
    bashAstValidator: {},
    pluginOperationGrants: {},
    pluginOperationIdentityProvider: {},
  };
}

describe("subscription chat boot wiring", () => {
  it("forwards the boot-configured tracer through every loop factory", () => {
    // Assert tracing at the loop boundary; a spread dependency can typecheck without reaching a loop.
    const tracer = { startActiveSpan: vi.fn(), startSpan: vi.fn() };
    const shared = sharedLoopDeps();

    const main = createConversationLoop({
      ...shared,
      systemPromptBuilder: {},
      routineEngine: {},
      postTurnHookChain: {},
      tracer,
    } as unknown as Parameters<typeof createConversationLoop>[0]);
    const side = createSideChatConversationLoop({
      ...shared,
      sideChatMemoryManager: makeConversationLoopMemoryManager(),
      tracer,
    } as unknown as Parameters<typeof createSideChatConversationLoop>[0]);
    const routine = createRoutineConversationLoop({
      ...shared,
      systemPromptBuilder: {},
      tracer,
    } as unknown as Parameters<typeof createRoutineConversationLoop>[0]);

    expect(main.deps.tracer).toBe(tracer);
    expect(side.deps.tracer).toBe(tracer);
    expect(routine.deps.tracer).toBe(tracer);
  });

  beforeEach(() => {
    h.createSubscriptionLlmProvider.mockReset();
    h.createSubscriptionLlmProvider.mockImplementation((options: SubscriptionProviderFactoryOptions) =>
      providerFor(options.selection),
    );
  });

  it("injects the subscription runtime into main, side, and routine loops", () => {
    const bindings = createSubscriptionChatLoopBindings({
      auditLogger: { log: vi.fn() },
    });
    const shared = sharedLoopDeps();

    const main = createConversationLoop({
      ...shared,
      systemPromptBuilder: {},
      routineEngine: {},
      postTurnHookChain: {},
      ...bindings,
    } as unknown as Parameters<typeof createConversationLoop>[0]);
    const side = createSideChatConversationLoop({
      ...shared,
      sideChatMemoryManager: makeConversationLoopMemoryManager(),
      ...bindings,
    } as unknown as Parameters<typeof createSideChatConversationLoop>[0]);
    const routine = createRoutineConversationLoop({
      ...shared,
      systemPromptBuilder: {},
      ...bindings,
    } as unknown as Parameters<typeof createRoutineConversationLoop>[0]);

    expect(main.deps.subscriptionProviderFactory).toBe(bindings.subscriptionProviderFactory);
    expect(side.deps.subscriptionProviderFactory).toBe(bindings.subscriptionProviderFactory);
    expect(routine.deps.subscriptionProviderFactory).toBe(bindings.subscriptionProviderFactory);
    expect((main as unknown as { provider: LLMProvider | null }).provider?.subscriptionRuntime).toEqual(selection);
    expect((side as unknown as { provider: LLMProvider | null }).provider?.subscriptionRuntime).toEqual(selection);
    expect((routine as unknown as { provider: LLMProvider | null }).provider?.subscriptionRuntime).toEqual(selection);
    expect(h.createSubscriptionLlmProvider).toHaveBeenCalledTimes(3);
    expect(h.createSubscriptionLlmProvider).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ selection }),
    );
    expect(h.createSubscriptionLlmProvider).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ selection }),
    );
    expect(h.createSubscriptionLlmProvider).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ selection }),
    );
  });

  it("rejects unsafe login URLs and keeps audit metadata redacted", async () => {
    const auditLogger = { log: vi.fn() };
    const bindings = createSubscriptionChatLoopBindings({ auditLogger });

    bindings.subscriptionProviderFactory(selection);
    const options = h.createSubscriptionLlmProvider.mock.calls[0]?.[0] as SubscriptionProviderFactoryOptions;
    const openLogin = vi.fn(async () => {});
    const releaseOpener = installOAuthLoginOpener(openLogin);
    const login = { completion: Promise.resolve(), onCancel: vi.fn(), timeoutMs: 10_000 };
    try {
      await options.openAuthorizationUrl("https://login.example.test/authorize?state=private", login);
      expect(openLogin).toHaveBeenCalledWith("https://login.example.test/authorize?state=private", login);
    } finally {
      releaseOpener();
    }
    await expect(options.openAuthorizationUrl("file:///C:/sensitive.txt", login)).rejects.toMatchObject({
      code: "subscription-verification-url-unavailable",
    });

    options.runtimeServiceOptions.audit({
      provider: "codex",
      outcome: "host-request-rejected",
      requestKind: "command-approval",
    });
    options.runtimeServiceOptions.audit({
      provider: "codex",
      outcome: "session-failed",
      requestKind: "bad\nmetadata",
    });

    expect(auditLogger.log).toHaveBeenNthCalledWith(1, {
      timestamp: expect.any(String),
      sessionId: "subscription-runtime",
      type: "warn",
      input: JSON.stringify({
        provider: "codex",
        outcome: "host-request-rejected",
        requestKind: "command-approval",
      }),
    });
    expect(auditLogger.log).toHaveBeenNthCalledWith(2, {
      timestamp: expect.any(String),
      sessionId: "subscription-runtime",
      type: "warn",
      input: JSON.stringify({ provider: "codex", outcome: "session-failed" }),
    });
    expect(JSON.stringify(auditLogger.log.mock.calls)).not.toContain("one-time-secret");
  });
});
