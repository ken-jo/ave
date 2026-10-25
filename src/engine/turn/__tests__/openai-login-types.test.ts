import { describe, expect, it, vi } from "vitest";

import type { LLMProvider, StreamEvent, StreamTurnParams } from "../../llm/types.js";
import { buildProvider } from "../provider.js";
import type { ConversationLoopDeps } from "../types.js";
import { freshVendorBlocks } from "../../../shared/llm-vendor-defaults.js";
import {
  openAiLoginTypeFor,
  type ActiveChatRuntime,
  type SubscriptionChatRuntimeSelection,
} from "../../../shared/subscription-runtime.js";
import { normalizeActiveChatRuntime } from "../../../data/settings-normalization.js";
import { createSubscriptionLlmProvider } from "../../../main/subscription-llm-provider.js";
import type { ChatGptPlanRuntime } from "../../../main/chatgpt-plan/runtime.js";

/**
 * OpenAI is reached three ways, side by side: the user's Codex CLI, an API key, and ChatGPT plan usage (Sign in
 * with ChatGPT). The persisted `activeChatRuntime` picks exactly one; a selected way that is not configured fails
 * as not configured and never borrows another way's credential.
 */

const OPENAI_KEY = "sk-openai-api-key";

function deps(activeChatRuntime: ActiveChatRuntime | undefined, options: {
  apiKey?: string | null;
  subscriptionProviderFactory?: ConversationLoopDeps["subscriptionProviderFactory"];
} = {}) {
  const getSecret = vi.fn((key: string) => key === "llm.apiKey.openai" ? options.apiKey ?? null : null);
  return {
    deps: {
      settingsService: {
        get: vi.fn((key: string) => key === "llm"
          ? {
            ...(activeChatRuntime ? { activeChatRuntime } : {}),
            provider: "openai",
            vendors: { ...freshVendorBlocks(), openai: { ...freshVendorBlocks().openai, model: "gpt-6.1-sol" } },
            fallbackChain: [],
          }
          : { installedProviderPresets: [] }),
        getSecret,
      },
      ...(options.subscriptionProviderFactory ? { subscriptionProviderFactory: options.subscriptionProviderFactory } : {}),
    } as unknown as ConversationLoopDeps,
    getSecret,
  };
}

function codexFactory() {
  return vi.fn((selection: SubscriptionChatRuntimeSelection): LLMProvider => ({
    vendor: "openai",
    subscriptionRuntime: selection,
    async *streamTurn(_params: StreamTurnParams): AsyncIterable<StreamEvent> {
      yield { type: "message_complete", stopReason: "end_turn" };
    },
  }));
}

/** The production factory for plan usage, over a stub plan runtime. */
function planFactory(runtime: Partial<ChatGptPlanRuntime> | null) {
  return vi.fn((selection: SubscriptionChatRuntimeSelection) => createSubscriptionLlmProvider({
    selection,
    service: {
      openTextSession: vi.fn(async () => { throw new Error("plan usage must not open a CLI session"); }),
      requireChatGptPlan: () => {
        if (!runtime) throw new Error("subscription-runtime-not-configured");
        return runtime as ChatGptPlanRuntime;
      },
    },
  }));
}

describe("OpenAI login type selection", () => {
  it("names the one login type each persisted selection uses", () => {
    expect(openAiLoginTypeFor({ kind: "subscription", provider: "codex" }, "openai")).toBe("codex-cli");
    expect(openAiLoginTypeFor({ kind: "subscription", provider: "chatgpt-plan", model: "m" }, "openai")).toBe("chatgpt-plan");
    expect(openAiLoginTypeFor({ kind: "api" }, "openai")).toBe("api-key");
    expect(openAiLoginTypeFor(undefined, "openai")).toBe("api-key");
    expect(openAiLoginTypeFor({ kind: "api" }, "claude")).toBeNull();
    expect(openAiLoginTypeFor({ kind: "subscription", provider: "claude-code" }, "openai")).toBeNull();
  });

  it("keeps settings saved before plan usage existed on their login type", () => {
    // No stored runtime: the API route, so an API-key user stays on the API key.
    expect(normalizeActiveChatRuntime(undefined)).toEqual({ kind: "api" });
    expect(openAiLoginTypeFor(normalizeActiveChatRuntime(undefined), "openai")).toBe("api-key");
    expect(normalizeActiveChatRuntime({ kind: "api" })).toEqual({ kind: "api" });
    // A Codex CLI user stays on the Codex CLI, with the model they picked.
    const codex = normalizeActiveChatRuntime({ kind: "subscription", provider: "codex", model: "gpt-6.1-sol" });
    expect(codex).toEqual({ kind: "subscription", provider: "codex", model: "gpt-6.1-sol" });
    expect(openAiLoginTypeFor(codex, "openai")).toBe("codex-cli");
    // The new selection round-trips too.
    const plan = normalizeActiveChatRuntime({ kind: "subscription", provider: "chatgpt-plan", model: "gpt-6.1-sol" });
    expect(plan).toEqual({ kind: "subscription", provider: "chatgpt-plan", model: "gpt-6.1-sol" });
    expect(openAiLoginTypeFor(plan, "openai")).toBe("chatgpt-plan");
  });

  describe("API key", () => {
    it("builds the API-key provider when a key is stored", () => {
      const { deps: d } = deps({ kind: "api" }, { apiKey: OPENAI_KEY, subscriptionProviderFactory: codexFactory() });
      const provider = buildProvider(d);
      expect(provider?.vendor).toBe("openai");
      expect(provider?.subscriptionRuntime).toBeUndefined();
    });

    it("is not configured without a key, even when a subscription could answer", () => {
      const factory = codexFactory();
      const { deps: d } = deps({ kind: "api" }, { apiKey: null, subscriptionProviderFactory: factory });
      expect(buildProvider(d)).toBeNull();
      expect(factory).not.toHaveBeenCalled();
    });
  });

  describe("Codex CLI", () => {
    it("builds the Codex subscription provider and never reads the API key", () => {
      const { deps: d, getSecret } = deps(
        { kind: "subscription", provider: "codex" },
        { apiKey: OPENAI_KEY, subscriptionProviderFactory: codexFactory() },
      );
      expect(buildProvider(d)?.subscriptionRuntime).toEqual({ kind: "subscription", provider: "codex" });
      expect(getSecret).not.toHaveBeenCalled();
    });

    it("is not configured without its runtime, and does not fall back to the API key", () => {
      const { deps: d, getSecret } = deps({ kind: "subscription", provider: "codex" }, { apiKey: OPENAI_KEY });
      expect(buildProvider(d)).toBeNull();
      expect(getSecret).not.toHaveBeenCalled();
    });
  });

  describe("ChatGPT plan usage", () => {
    it("builds the plan provider on the OpenAI Responses connection and never reads the API key", () => {
      const { deps: d, getSecret } = deps(
        { kind: "subscription", provider: "chatgpt-plan", model: "gpt-6.1-sol" },
        { apiKey: OPENAI_KEY, subscriptionProviderFactory: planFactory({}) },
      );
      const provider = buildProvider(d);
      expect(provider?.subscriptionRuntime).toEqual({ kind: "subscription", provider: "chatgpt-plan", model: "gpt-6.1-sol" });
      expect(getSecret).not.toHaveBeenCalled();
    });

    it("is not configured without a model, and does not fall back to the API key", () => {
      const { deps: d, getSecret } = deps(
        { kind: "subscription", provider: "chatgpt-plan" },
        { apiKey: OPENAI_KEY, subscriptionProviderFactory: planFactory({}) },
      );
      expect(buildProvider(d)).toBeNull();
      expect(getSecret).not.toHaveBeenCalled();
    });

    it("ends a turn as not signed in when no plan runtime is configured, with no API-key request", async () => {
      const { deps: d, getSecret } = deps(
        { kind: "subscription", provider: "chatgpt-plan", model: "gpt-6.1-sol" },
        { apiKey: OPENAI_KEY, subscriptionProviderFactory: planFactory(null) },
      );
      const provider = buildProvider(d)!;
      const events: StreamEvent[] = [];
      for await (const event of provider.streamTurn({ model: "gpt-6.1-sol", systemPrompt: "s", messages: [{ role: "user", content: "hi" }] })) {
        events.push(event);
      }
      expect(events.at(-1)).toMatchObject({ type: "error", classification: "chatgpt-plan-reconnect-required" });
      expect(getSecret).not.toHaveBeenCalled();
    });
  });
});
