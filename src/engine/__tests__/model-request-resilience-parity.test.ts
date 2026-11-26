import { afterEach, assert, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { sseResponse } from "../../__tests__/support/sse-response.js";
import { unusedNetworkFetch } from "../../__tests__/support/network-fetch-stubs.js";
import { createSubscriptionRuntimeNamespace } from "../../__tests__/support/subscription-runtime-namespace.js";
import { collectAsyncIterable as collect } from "../../__tests__/test-helpers.js";
import { LlmReviewerProviderAdapter } from "../../boot/steps/reviewer-wiring.js";
import { DEFAULT_SETTINGS } from "../../data/settings-defaults.js";
import type { LLMSettings } from "../../data/settings-store.js";
import { CHATGPT_PLAN_RESPONSES_URL } from "../../main/chatgpt-plan/endpoints.js";
import { createChatGptPlanRuntime } from "../../main/chatgpt-plan/runtime.js";
import { CHATGPT_PLAN_ACCOUNT_SECRET_KEY, type ChatGptPlanSecretStore } from "../../main/chatgpt-plan/session.js";
import { ChatGptPlanTransport } from "../../main/chatgpt-plan/transport.js";
import { createSubscriptionLlmProvider } from "../../main/subscription-llm-provider.js";
import type { SubscriptionTextSession } from "../../main/subscription-runtime-service.js";
import { subscriptionTransportFailure } from "../../main/subscription-transport-error-diagnostics.js";
import { getLlmVendorSettings } from "../../shared/llm-vendor-defaults.js";
import type { LLMProvider, StreamEvent } from "../llm/types.js";
import { FallbackProvider } from "../llm/vercel/fallback-chain.js";
import { createSystemSubagentProviderPlan } from "../system-subagent-route.js";
import { buildProvider } from "../turn/provider.js";

/**
 * Recovery from transient failures, measured at the wire. This file uses only what the base branch also has, so the
 * same file runs there: the numbers below are the base branch's, and retirement work must not move them.
 */

const TURN = { systemPrompt: "sys", messages: [{ role: "user" as const, content: "hi" }] };

interface Transient {
  name: string;
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
}

const TRANSIENTS = {
  timeout408: { name: "408 with retry-after-ms: 0", status: 408, headers: { "retry-after-ms": "0" } },
  conflict409: { name: "409 with retry-after-ms: 0", status: 409, headers: { "retry-after-ms": "0" } },
  bare429: { name: "bare 429", status: 429 },
  retryAfterSeconds503: { name: "503 with retry-after: 4", status: 503, headers: { "retry-after": "4" } },
  retryAfterMs503: { name: "503 with retry-after-ms: 10", status: 503, headers: { "retry-after-ms": "10" } },
  network: { name: "connection reset" },
  terminal400: { name: "terminal 400", status: 400 },
  usageLimit429: { name: "429 with a terminal usage-limit code", status: 429, body: { error: { code: "usage_limit_reached", message: "limit" } } },
} satisfies Record<string, Transient>;

function failureResponse(transient: Transient): Response {
  if (transient.status === undefined) {
    throw new TypeError("fetch failed", { cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) });
  }
  return Response.json(transient.body ?? { error: { message: "Request failed" } }, { status: transient.status, headers: transient.headers });
}

function completedChat(): Response {
  return sseResponse([
    { id: "turn", choices: [{ index: 0, delta: { content: "recovered" }, finish_reason: null }] },
    { id: "turn", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ]);
}

function completedResponse(): Response {
  return sseResponse([
    { type: "response.created", response: { id: "r1", created_at: 1, model: "gpt-6.1-sol" } },
    { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "m1", role: "assistant", content: [] } },
    { type: "response.output_text.delta", item_id: "m1", output_index: 0, content_index: 0, delta: "recovered" },
    { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "m1", role: "assistant", content: [{ type: "output_text", text: "recovered", annotations: [] }] } },
    { type: "response.completed", response: { id: "r1", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
  ]);
}

interface Observation {
  /** Requests that reached the wire, as milliseconds after the turn began. */
  requestsAtMs: number[];
  recovered: boolean;
}

/** One failing response, then success; everything is driven on a fake clock for two minutes. */
async function observe(
  transient: Transient,
  success: () => Response,
  run: (wire: typeof fetch) => Promise<{ text: string }>,
): Promise<Observation> {
  const startedAt = Date.now();
  const requestsAtMs: number[] = [];
  const wire: typeof fetch = async () => {
    requestsAtMs.push(Date.now() - startedAt);
    return requestsAtMs.length === 1 ? failureResponse(transient) : success();
  };
  const outcome = run(wire).then(({ text }) => text, () => "");
  await vi.advanceTimersByTimeAsync(120_000);
  return { requestsAtMs, recovered: (await outcome) === "recovered" };
}

function textOf(events: readonly StreamEvent[]): { text: string } {
  return { text: events.flatMap((event) => event.type === "text_delta" ? [event.text] : []).join("") };
}

function deepseekSettings(): LLMSettings {
  const llm = structuredClone(DEFAULT_SETTINGS.llm);
  llm.provider = "deepseek";
  llm.vendors.deepseek = { ...getLlmVendorSettings(llm.vendors, "deepseek"), model: "deepseek-flash" };
  return llm;
}

function settingsService(llm: LLMSettings) {
  return {
    get: (key: string) => key === "llm" ? structuredClone(llm) : { installedProviderPresets: [] },
    getSecret: async () => "fixture-key",
  };
}

async function viaChat(wire: typeof fetch): Promise<{ text: string }> {
  vi.stubGlobal("fetch", wire);
  const provider = await buildProvider({
    settingsService: settingsService(deepseekSettings()), networkFetch: unusedNetworkFetch,
  } as unknown as Parameters<typeof buildProvider>[0]);
  assert(provider);
  return textOf(await collect(provider.streamTurn({ ...TURN, model: "deepseek-flash" })));
}

async function viaReviewer(wire: typeof fetch): Promise<{ text: string }> {
  vi.stubGlobal("fetch", wire);
  const plan = createSystemSubagentProviderPlan({
    settingsService: settingsService(deepseekSettings()), networkFetch: unusedNetworkFetch,
  } as unknown as Parameters<typeof createSystemSubagentProviderPlan>[0], "deepseek");
  const provider = plan?.build("fixture-key");
  assert(provider);
  return new LlmReviewerProviderAdapter(provider).complete({ model: "deepseek-flash", systemPrompt: "sys", userPrompt: "review" });
}

class PlanSecrets implements ChatGptPlanSecretStore {
  private readonly values = new Map<string, string>([[CHATGPT_PLAN_ACCOUNT_SECRET_KEY, JSON.stringify({
    version: 1,
    issuer: "https://auth.openai.com",
    clientId: "oaiapp_1",
    subject: "user-sub",
    email: "user@example.com",
    tokens: {
      accessToken: "stored-access-token",
      refreshToken: "stored-refresh-token",
      idToken: "stored-id-token",
      expiresAt: Date.now() + 86_400_000,
      scopes: ["chatgpt.tokens.use.direct", "email", "offline_access", "openid", "profile", "resource.invoke"],
      savedAt: Date.now(),
    },
    welcomed: true,
  })]]);
  async isSecretStorageEncrypted(): Promise<boolean> { return true; }
  async getEncryptedSecret(key: string): Promise<string | null> { return this.values.get(key) ?? null; }
  async setSecret(key: string, value: string): Promise<void> { this.values.set(key, value); }
  async deleteSecret(key: string): Promise<void> { this.values.delete(key); }
}

async function viaPlan(wire: typeof fetch): Promise<{ text: string }> {
  const networkFetch: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url !== CHATGPT_PLAN_RESPONSES_URL) throw new Error("unexpected plan request");
    return wire(input, init);
  };
  const runtime = createChatGptPlanRuntime({
    secrets: new PlanSecrets(),
    networkFetch,
    namespace: createSubscriptionRuntimeNamespace(),
    startListener: async () => ({
      redirectUri: "http://127.0.0.1:1455/auth/callback",
      callback: new Promise<URL>(() => undefined),
      close: () => undefined,
    }),
  }, () => undefined);
  const transport = new ChatGptPlanTransport({ kind: "subscription", provider: "chatgpt-plan", model: "gpt-6.1-sol" }, async () => runtime);
  // Chat reaches the plan transport through the host walk, as the subscription branch of buildProvider wires it.
  const walk = new FallbackProvider({ vendor: "openai", streamTurn: (params) => transport.streamTurn(params) } as LLMProvider, [], () => "");
  return textOf(await collect(walk.streamTurn({ ...TURN, model: "gpt-6.1-sol" })));
}

/** A native subscription session that fails once with an HTTP status nested in its transport diagnostic. */
async function observeNativeSession(statusCode: number): Promise<{ sessions: number; recovered: boolean }> {
  let sessions = 0;
  const openTextSession = vi.fn(async (): Promise<SubscriptionTextSession> => {
    const first = ++sessions === 1;
    return {
      provider: "codex",
      stop: async () => undefined,
      streamTurn: () => ({
        async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
          if (first) {
            yield {
              type: "error",
              error: "native runtime failure",
              providerError: subscriptionTransportFailure({ phase: "native-request", kind: statusCode === 429 ? "rate-limit" : "server", statusCode }),
            };
            return;
          }
          yield { type: "text_delta", text: "recovered" };
          yield { type: "message_complete", stopReason: "end_turn" };
        },
      }),
    } as unknown as SubscriptionTextSession;
  });
  const provider = createSubscriptionLlmProvider({
    selection: { kind: "subscription", provider: "codex" },
    service: { openTextSession } as unknown as Parameters<typeof createSubscriptionLlmProvider>[0]["service"],
  });
  const outcome = collect(new FallbackProvider(provider, [], () => "").streamTurn({ ...TURN, model: "default" }))
    .then((events) => textOf(events).text, () => "");
  await vi.advanceTimersByTimeAsync(120_000);
  return { sessions, recovered: (await outcome) === "recovered" };
}

beforeAll(async () => {
  // The SDK wire loads lazily; load it before the clock is faked.
  await import("../llm/vercel/adapter.js");
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("transient failure recovery matches the base branch", () => {
  it.each([
    [TRANSIENTS.timeout408, { requestsAtMs: [0, 0], recovered: true }],
    [TRANSIENTS.conflict409, { requestsAtMs: [0, 0], recovered: true }],
    [TRANSIENTS.bare429, { requestsAtMs: [0, 2_000], recovered: true }],
    [TRANSIENTS.retryAfterSeconds503, { requestsAtMs: [0, 4_000], recovered: true }],
    [TRANSIENTS.retryAfterMs503, { requestsAtMs: [0, 10], recovered: true }],
    [TRANSIENTS.network, { requestsAtMs: [0, 2_000], recovered: true }],
    [TRANSIENTS.terminal400, { requestsAtMs: [0], recovered: false }],
  ])("API-key chat: %o", async (transient, expected) => {
    expect(await observe(transient, completedChat, viaChat)).toEqual(expected);
  });

  it.each([
    [TRANSIENTS.timeout408, { requestsAtMs: [0, 0], recovered: true }],
    [TRANSIENTS.bare429, { requestsAtMs: [0, 2_000], recovered: true }],
    [TRANSIENTS.retryAfterSeconds503, { requestsAtMs: [0, 4_000], recovered: true }],
    [TRANSIENTS.network, { requestsAtMs: [0, 2_000], recovered: true }],
    [TRANSIENTS.terminal400, { requestsAtMs: [0], recovered: false }],
  ])("permission reviewer: %o", async (transient, expected) => {
    expect(await observe(transient, completedChat, viaReviewer)).toEqual(expected);
  });

  it.each([
    [TRANSIENTS.timeout408, { requestsAtMs: [0, 0], recovered: true }],
    [TRANSIENTS.conflict409, { requestsAtMs: [0, 0], recovered: true }],
    [TRANSIENTS.bare429, { requestsAtMs: [0, 2_000], recovered: true }],
    [TRANSIENTS.retryAfterSeconds503, { requestsAtMs: [0, 4_000], recovered: true }],
    [TRANSIENTS.network, { requestsAtMs: [0, 2_000], recovered: true }],
    [TRANSIENTS.usageLimit429, { requestsAtMs: [0, 2_000], recovered: true }],
  ])("ChatGPT plan: %o", async (transient, expected) => {
    expect(await observe(transient, completedResponse, viaPlan)).toEqual(expected);
  });

  it.each([429, 503])("native subscription: a nested %i reopens the session", async (statusCode) => {
    expect(await observeNativeSession(statusCode)).toEqual({ sessions: 2, recovered: true });
  });
});
