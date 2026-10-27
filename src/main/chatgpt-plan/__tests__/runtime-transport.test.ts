import { collectAsyncIterable as collect } from "../../../__tests__/test-helpers.js";
import { sseResponse } from "../../../__tests__/support/sse-response.js";
import { describe, expect, it, vi } from "vitest";
import { CHATGPT_PLAN_MODELS_URL, CHATGPT_PLAN_RESPONSES_URL, CHATGPT_PLAN_TOKEN_URL } from "../endpoints.js";
import { ChatGptPlanRuntime, ChatGptPlanRuntimeError, createChatGptPlanRuntime } from "../runtime.js";
import { CHATGPT_PLAN_ACCOUNT_SECRET_KEY, ChatGptPlanSession, type ChatGptPlanSecretStore } from "../session.js";
import { ChatGptPlanTransport } from "../transport.js";
import { SubscriptionRuntimeService, SubscriptionRuntimeServiceError } from "../../subscription-runtime-service.js";
import type { AcpSubscriptionRuntimeRegistry } from "../../subscription-runtime-service.js";
import type { CodexAppServerClient } from "../../codex-app-server-client.js";
import { claimFakeRuntimeDirectories, createSubscriptionRuntimeNamespace } from "../../../__tests__/support/subscription-runtime-namespace.js";
import { validateExternalUrl } from "../../../shared/external-url.js";
import { t } from "../../../i18n/index.js";
import type { ToolSchema } from "../../../engine/llm/types.js";
import { DEFAULT_SUBSCRIPTION_IMAGE_ATTACHMENT_LIMITS } from "../../subscription-attachment-input.js";

// Release metadata is fetched only by real Linux publisher verification; these services never reach it.
const RELEASE_FETCH = (async () => { throw new Error("Unexpected release metadata request"); }) as unknown as typeof fetch;

const PLAN_SCOPES = ["chatgpt.tokens.use.direct", "email", "offline_access", "openid", "profile", "resource.invoke"];
const IDENTITY_SCOPES = ["email", "offline_access", "openid", "profile"];
const NOW = Date.now();

class FakeSecrets implements ChatGptPlanSecretStore {
  readonly values = new Map<string, string>();
  isSecretStorageEncrypted(): boolean { return true; }
  getEncryptedSecret(key: string): string | null { return this.values.get(key) ?? null; }
  async setSecret(key: string, value: string): Promise<void> { this.values.set(key, value); }
  async deleteSecret(key: string): Promise<void> { this.values.delete(key); }
}

function storedSecrets(scopes: readonly string[] | null): FakeSecrets {
  const secrets = new FakeSecrets();
  if (scopes) {
    secrets.values.set(CHATGPT_PLAN_ACCOUNT_SECRET_KEY, JSON.stringify({
      version: 1,
      issuer: "https://auth.openai.com",
      clientId: "oaiapp_1",
      subject: "user-sub",
      email: "user@example.com",
      tokens: {
        accessToken: "stored-access-token",
        refreshToken: "stored-refresh-token",
        idToken: "stored-id-token",
        expiresAt: NOW + 3_600_000,
        scopes,
        savedAt: NOW,
      },
      welcomed: true,
    }));
  }
  return secrets;
}

const sse = sseResponse;

const PNG_SIGNATURE_BASE64 = "iVBORw0KGgo=";
const PNG_DATA_URL = (() => {
  const bytes = Buffer.alloc(32, 7);
  Buffer.from(PNG_SIGNATURE_BASE64, "base64").copy(bytes);
  return `data:image/png;base64,${bytes.toString("base64")}`;
})();

const COMPLETED_TURN = [
  { type: "response.created", response: { id: "r1", created_at: 1, model: "gpt-6.1-sol" } },
  { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "m1", role: "assistant", content: [] } },
  { type: "response.output_text.delta", item_id: "m1", output_index: 0, content_index: 0, delta: "Hello" },
  { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "m1", role: "assistant", content: [{ type: "output_text", text: "Hello", annotations: [] }] } },
  { type: "response.completed", response: { id: "r1", usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15, input_tokens_details: { cached_tokens: 2 }, output_tokens_details: { reasoning_tokens: 1 } } } },
];

interface Harness {
  readonly runtime: ChatGptPlanRuntime;
  readonly requests: { url: string; authorization: string | null; body: unknown }[];
  readonly opened: string[];
}

function harness(scopes: readonly string[] | null, responses: (url: string) => Response = () => sse(COMPLETED_TURN)): Harness {
  const requests: Harness["requests"] = [];
  const opened: string[] = [];
  const networkFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const body = typeof init?.body === "string" && url === CHATGPT_PLAN_RESPONSES_URL ? JSON.parse(init.body) : init?.body ?? null;
    requests.push({ url, authorization: new Headers(init?.headers).get("authorization"), body });
    return responses(url);
  }) as typeof fetch;
  const runtime = createChatGptPlanRuntime({
    secrets: storedSecrets(scopes),
    networkFetch,
    namespace: createSubscriptionRuntimeNamespace(),
    startListener: async () => ({
      redirectUri: "http://127.0.0.1:1455/auth/callback",
      callback: new Promise<URL>(() => undefined),
      close: () => undefined,
    }),
  }, (url) => {
    // The production opener: the same validation the subscription service applies before the system browser.
    const validated = validateExternalUrl(url);
    if (!validated.ok) throw new Error(validated.error);
    opened.push(validated.url);
  });
  return { runtime, requests, opened };
}


describe("ChatGPT plan runtime status", () => {
  it("is signed out with no stored record, and chat stays unavailable", () => {
    const status = harness(null).runtime.getStatus();
    expect(status).toMatchObject({ provider: "chatgpt-plan", runtime: "ready", connection: "signed-out", version: null });
    expect(status.capabilities.chat).toBe(false);
  });

  it("is connected with chat once a plan-usage grant is stored", () => {
    const status = harness(PLAN_SCOPES).runtime.getStatus();
    expect(status.connection).toBe("connected");
    expect(status.capabilities).toMatchObject({
      chat: true,
      tools: true,
      generateText: true,
      images: true,
      imageAttachmentLimits: DEFAULT_SUBSCRIPTION_IMAGE_ATTACHMENT_LIMITS,
    });
  });

  it("shows a sign-in without the plan grant as signed out, and asks for consent on the next sign-in", async () => {
    const h = harness(IDENTITY_SCOPES, () => new Response("{}", { status: 200 }));
    expect(h.runtime.getStatus()).toMatchObject({ connection: "signed-out", notice: "plan-usage-disabled" });
    expect(h.runtime.getStatus().capabilities.chat).toBe(false);
    // Discovery is fetched before the browser opens; answer it so the attempt reaches the browser.
    const discovery = {
      issuer: "https://auth.openai.com",
      authorization_endpoint: "https://auth.openai.com/api/accounts/authorize",
      token_endpoint: CHATGPT_PLAN_TOKEN_URL,
      jwks_uri: "https://auth.openai.com/.well-known/jwks.json",
      revocation_endpoint: "https://auth.openai.com/api/accounts/oauth/revoke",
    };
    const consent = harness(IDENTITY_SCOPES, () => new Response(JSON.stringify(discovery), { status: 200 }));
    const status = await consent.runtime.startLogin();
    expect(status).toMatchObject({ connection: "pending", pendingLogin: "browser" });
    const params = new URL(consent.opened[0]!).searchParams;
    expect(params.get("client_id")).toBe("oaiapp_1");
    expect(params.get("prompt")).toBe("consent");
    // The reauthorization carries the retained ID token as a hint, and still passes the opener's validation.
    expect(params.get("id_token_hint")).toBe("stored-id-token");
    consent.runtime.cancelLogin();
  });
});

describe("ChatGPT plan transport", () => {
  it("streams a turn on the Responses wire with the session token and reports non-billable plan usage", async () => {
    const h = harness(PLAN_SCOPES);
    const transport = new ChatGptPlanTransport(
      { kind: "subscription", provider: "chatgpt-plan", model: "gpt-6.1-sol" },
      async () => h.runtime,
    );
    const events = await collect(transport.streamTurn({
      model: "ignored-by-plan-transport",
      systemPrompt: "You are helpful.",
      messages: [{ role: "user", content: "hi" }],
      // A background ceiling never reaches the route that refuses max_output_tokens.
      outputTokenLimit: 64,
    }));
    expect(events.find((event) => event.type === "error")).toBeUndefined();
    const request = h.requests.find((entry) => entry.url === CHATGPT_PLAN_RESPONSES_URL)!;
    expect(request.authorization).toBe("Bearer stored-access-token");
    expect(request.body).toMatchObject({ model: "gpt-6.1-sol", store: false, stream: true });
    expect(request.body).not.toHaveProperty("max_output_tokens");
    const complete = events.find((event) => event.type === "message_complete");
    expect(complete).toBeDefined();
    expect(complete).not.toHaveProperty("usage");
    expect(complete).toMatchObject({
      subscriptionUsage: {
        provider: "chatgpt-plan",
        model: "gpt-6.1-sol",
        source: "provider-reported",
        billable: false,
        inputTokens: 12,
        outputTokens: 3,
      },
    });
  });

  it("ends a usage-limit failure with the plan's own message and no retry", async () => {
    const h = harness(PLAN_SCOPES, () => new Response(JSON.stringify({
      error: { code: "subscription_sharing_usage_limit_exceeded", message: "limit for user@example.com" },
    }), { status: 429, headers: { "x-request-id": "req_9" } }));
    const transport = new ChatGptPlanTransport(
      { kind: "subscription", provider: "chatgpt-plan", model: "gpt-6.1-sol" },
      async () => h.runtime,
    );
    const events = await collect(transport.streamTurn({ model: "m", systemPrompt: "s", messages: [{ role: "user", content: "hi" }] }));
    const error = events.find((event) => event.type === "error");
    expect(error).toMatchObject({
      classification: "chatgpt-plan-usage-limit",
      providerError: { statusCode: 429, providerCode: "subscription_sharing_usage_limit_exceeded", isRetryable: false },
    });
    expect(JSON.stringify(error)).not.toContain("user@example.com");
    expect(JSON.stringify(error)).not.toContain("stored-access-token");
    // The main-process catalog resolves the message; a raw key would mean the fragment is not loaded.
    expect(error).toMatchObject({ error: t("subscriptionProvidersSection.chatgptPlanErrorUsageLimit") });
    expect((error as { error: string }).error).not.toMatch(/^subscriptionProvidersSection\./);
  });

  const STREAM_START = [
    { type: "response.created", sequence_number: 0, response: { id: "r1", created_at: 1, model: "gpt-6.1-sol" } },
    { type: "response.output_item.added", sequence_number: 1, output_index: 0, item: { type: "message", id: "m1", role: "assistant", content: [] } },
    { type: "response.output_text.delta", sequence_number: 2, item_id: "m1", output_index: 0, content_index: 0, delta: "He" },
  ];

  async function streamWith(terminal: Record<string, unknown>, runtime?: ChatGptPlanRuntime) {
    const h = harness(PLAN_SCOPES, () => sse([...STREAM_START, terminal]));
    const planRuntime = runtime ?? h.runtime;
    const transport = new ChatGptPlanTransport(
      { kind: "subscription", provider: "chatgpt-plan", model: "gpt-6.1-sol" },
      async () => planRuntime,
    );
    return collect(transport.streamTurn({ model: "m", systemPrompt: "s", messages: [{ role: "user", content: "hi" }] }));
  }

  it("classifies a usage limit that arrives as response.failed after streaming began, without its text", async () => {
    const events = await streamWith({
      type: "response.failed",
      sequence_number: 3,
      response: {
        id: "r1",
        status: "failed",
        error: { code: "subscription_sharing_usage_limit_exceeded", message: "limit for user@example.com" },
        usage: null,
      },
    });
    expect(events[0]).toEqual({ type: "text_delta", text: "He" });
    const error = events.at(-1)!;
    expect(error).toMatchObject({
      type: "error",
      error: t("subscriptionProvidersSection.chatgptPlanErrorUsageLimit"),
      classification: "chatgpt-plan-usage-limit",
      providerError: { providerCode: "subscription_sharing_usage_limit_exceeded", isRetryable: false },
    });
    expect(error).not.toHaveProperty("providerError.statusCode", 500);
    expect(JSON.stringify(events)).not.toContain("user@example.com");
  });

  it("confirms the session when a stream error says the subscriber context was not accepted", async () => {
    const invalidUser = {
      type: "error", sequence_number: 3, code: "subscription_sharing_invalid_user", message: "bad user@example.com", param: null,
    };
    const h = harness(PLAN_SCOPES, () => sse([...STREAM_START, invalidUser]));
    const confirmSession = vi.spyOn(h.runtime, "confirmSession").mockResolvedValue(undefined);
    const events = await streamWith(invalidUser, h.runtime);
    expect(confirmSession).toHaveBeenCalledOnce();
    expect(events.at(-1)).toMatchObject({ type: "error", classification: "chatgpt-plan-permission-denied" });
    expect(JSON.stringify(events)).not.toContain("user@example.com");
  });

  it("never passes on the text of an uncoded stream failure", async () => {
    const events = await streamWith({
      type: "response.failed",
      sequence_number: 3,
      response: { id: "r1", status: "failed", error: { message: "account user@example.com hit an internal error" }, usage: null },
    });
    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: t("subscriptionProvidersSection.chatgptPlanErrorRequestFailed"),
      classification: "chatgpt-plan-request-failed",
    });
    expect(JSON.stringify(events)).not.toContain("user@example.com");
  });

  it("still hands a context-length failure to compaction in fixed wording", async () => {
    const events = await streamWith({
      type: "response.failed",
      sequence_number: 3,
      response: { id: "r1", status: "failed", error: { code: "context_length_exceeded", message: "Your input for user@example.com exceeds the context window" }, usage: null },
    });
    expect(events.at(-1)).toMatchObject({
      type: "error",
      providerError: { providerCode: "context_length_exceeded", messagePreview: "maximum context length exceeded" },
    });
    expect(JSON.stringify(events)).not.toContain("user@example.com");
  });

  it("keeps the session when a refresh cannot reach the provider, and says to retry rather than sign in", async () => {
    const secrets = storedSecrets(PLAN_SCOPES);
    const record = JSON.parse(secrets.values.get(CHATGPT_PLAN_ACCOUNT_SECRET_KEY)!);
    record.tokens.expiresAt = NOW - 1;
    secrets.values.set(CHATGPT_PLAN_ACCOUNT_SECRET_KEY, JSON.stringify(record));
    const runtime = createChatGptPlanRuntime({
      secrets,
      networkFetch: (async () => new Response("unavailable", { status: 503 })) as typeof fetch,
      namespace: createSubscriptionRuntimeNamespace(),
    }, () => undefined);
    const transport = new ChatGptPlanTransport(
      { kind: "subscription", provider: "chatgpt-plan", model: "gpt-6.1-sol" },
      async () => runtime,
    );
    const events = await collect(transport.streamTurn({ model: "m", systemPrompt: "s", messages: [{ role: "user", content: "hi" }] }));
    expect(events.at(-1)).toMatchObject({ type: "error", classification: "chatgpt-plan-temporarily-unavailable" });
    expect(runtime.getStatus().connection).toBe("connected");
  });

  it("fails clearly when signed out, without making an inference request", async () => {
    const h = harness(null);
    const transport = new ChatGptPlanTransport(
      { kind: "subscription", provider: "chatgpt-plan", model: "gpt-6.1-sol" },
      async () => h.runtime,
    );
    const events = await collect(transport.streamTurn({ model: "m", systemPrompt: "s", messages: [{ role: "user", content: "hi" }] }));
    expect(events.at(-1)).toMatchObject({ type: "error", classification: "chatgpt-plan-reconnect-required" });
    expect(h.requests.some((entry) => entry.url === CHATGPT_PLAN_RESPONSES_URL)).toBe(false);
  });

  it.each([
    { effort: "high" as const, sent: "high" },
    { effort: "medium" as const, sent: "medium" },
    // gpt-6.1-sol does not accept `none`, so Instant runs at its lowest accepted level.
    { effort: "none" as const, sent: "low" },
  ])("asks for reasoning effort $effort as $sent with a streamed summary", async ({ effort, sent }) => {
    const h = harness(PLAN_SCOPES);
    const transport = new ChatGptPlanTransport(
      { kind: "subscription", provider: "chatgpt-plan", model: "gpt-6.1-sol" },
      async () => h.runtime,
    );
    const events = await collect(transport.streamTurn({
      model: "m",
      systemPrompt: "s",
      messages: [{ role: "user", content: "hi" }],
      enableThinking: true,
      reasoningEffort: effort,
    }));
    expect(events.find((event) => event.type === "error")).toBeUndefined();
    const body = h.requests.find((entry) => entry.url === CHATGPT_PLAN_RESPONSES_URL)!.body;
    expect(body).toMatchObject({ reasoning: { effort: sent, summary: "detailed" }, store: false });
  });

  it("replays a reasoning turn's tool round without stored item references, since the route keeps nothing", async () => {
    const h = harness(PLAN_SCOPES);
    const transport = new ChatGptPlanTransport(
      { kind: "subscription", provider: "chatgpt-plan", model: "gpt-6.1-sol" },
      async () => h.runtime,
    );
    const events = await collect(transport.streamTurn({
      model: "m",
      systemPrompt: "s",
      enableThinking: true,
      reasoningEffort: "medium",
      tools: [{ name: "read_file", description: "Read a file", inputSchema: { type: "object", properties: {} } }],
      messages: [
        { role: "user", content: "read it" },
        { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "read_file", input: {} }] },
        { role: "tool_result", toolUseId: "call_1", toolName: "read_file", content: "file text" },
      ],
    }));
    expect(events.find((event) => event.type === "error")).toBeUndefined();
    const body = h.requests.find((entry) => entry.url === CHATGPT_PLAN_RESPONSES_URL)!.body as { input: unknown[] };
    const wire = JSON.stringify(body.input);
    expect(wire).toContain('"type":"function_call_output"');
    expect(wire).not.toContain("item_reference");
  });

  it("feeds a streamed function call back by its call id, never the stored item id the route does not keep", async () => {
    let round = 0;
    const h = harness(PLAN_SCOPES, (url) => {
      if (url !== CHATGPT_PLAN_RESPONSES_URL) return sse(COMPLETED_TURN);
      round += 1;
      return round === 1
        ? sse([
          { type: "response.created", response: { id: "r1", created_at: 1, model: "gpt-6.1-sol" } },
          { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_file", arguments: "" } },
          { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, delta: "{}" },
          { type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_file", arguments: "{}", status: "completed" } },
          { type: "response.completed", response: { id: "r1", usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 } } },
        ])
        : sse(COMPLETED_TURN);
    });
    const transport = new ChatGptPlanTransport(
      { kind: "subscription", provider: "chatgpt-plan", model: "gpt-6.1-sol" },
      async () => h.runtime,
    );
    const tools: ToolSchema[] = [{ name: "read_file", description: "Read a file", inputSchema: { type: "object", properties: {} } }];
    const first = await collect(transport.streamTurn({
      model: "m", systemPrompt: "s", enableThinking: true, reasoningEffort: "medium", tools,
      messages: [{ role: "user", content: "read it" }],
    }));
    const call = first.find((event) => event.type === "tool_call");
    expect(call).toMatchObject({ type: "tool_call", name: "read_file" });
    const callId = (call as { id: string }).id;
    await collect(transport.streamTurn({
      model: "m", systemPrompt: "s", enableThinking: true, reasoningEffort: "medium", tools,
      messages: [
        { role: "user", content: "read it" },
        { role: "assistant", content: "", toolCalls: [{ id: callId, name: "read_file", input: {} }] },
        { role: "tool_result", toolUseId: callId, toolName: "read_file", content: "file text" },
      ],
    }));
    const second = JSON.stringify(h.requests.filter((entry) => entry.url === CHATGPT_PLAN_RESPONSES_URL)[1]!.body);
    expect(second).toContain('"call_id":"call_1"');
    expect(second).not.toContain("fc_1");
  });

  it("sends no reasoning field for a model that takes no reasoning setting, as the speed menu says", async () => {
    const h = harness(PLAN_SCOPES);
    const transport = new ChatGptPlanTransport(
      { kind: "subscription", provider: "chatgpt-plan", model: "gpt-4o" },
      async () => h.runtime,
    );
    const events = await collect(transport.streamTurn({
      model: "m", systemPrompt: "s", messages: [{ role: "user", content: "hi" }], enableThinking: true, reasoningEffort: "medium",
    }));
    expect(events.find((event) => event.type === "error")).toBeUndefined();
    expect(h.requests.find((entry) => entry.url === CHATGPT_PLAN_RESPONSES_URL)!.body).not.toHaveProperty("reasoning");
  });

  it("sends the newest turn's image natively to a model that accepts images", async () => {
    const h = harness(PLAN_SCOPES);
    const transport = new ChatGptPlanTransport(
      { kind: "subscription", provider: "chatgpt-plan", model: "gpt-6.1-sol" },
      async () => h.runtime,
    );
    const events = await collect(transport.streamTurn({
      model: "m",
      systemPrompt: "s",
      messages: [{ role: "user", content: [{ type: "text", text: "what is this?" }, { type: "image", image: PNG_DATA_URL }] }],
    }));
    expect(events.find((event) => event.type === "error")).toBeUndefined();
    const body = h.requests.find((entry) => entry.url === CHATGPT_PLAN_RESPONSES_URL)!.body as { input: unknown[] };
    expect(JSON.stringify(body.input)).toContain('"type":"input_image"');
  });

  it("refuses an image for a model that does not accept images, before any inference request", async () => {
    const h = harness(PLAN_SCOPES);
    const transport = new ChatGptPlanTransport(
      { kind: "subscription", provider: "chatgpt-plan", model: "gpt-oss-120b" },
      async () => h.runtime,
    );
    const events = await collect(transport.streamTurn({
      model: "m",
      systemPrompt: "s",
      messages: [{ role: "user", content: [{ type: "image", image: PNG_DATA_URL }] }],
    }));
    expect(events.at(-1)).toMatchObject({ type: "error", code: "image-input-unsupported" });
    expect(h.requests.some((entry) => entry.url === CHATGPT_PLAN_RESPONSES_URL)).toBe(false);
  });

  it("refuses an image beyond the attachment budget with the fixed subscription error", async () => {
    const h = harness(PLAN_SCOPES);
    const transport = new ChatGptPlanTransport(
      { kind: "subscription", provider: "chatgpt-plan", model: "gpt-6.1-sol" },
      async () => h.runtime,
    );
    const tooMany = Array.from(
      { length: DEFAULT_SUBSCRIPTION_IMAGE_ATTACHMENT_LIMITS.maxCount + 1 },
      () => ({ type: "image" as const, image: PNG_DATA_URL }),
    );
    const events = await collect(transport.streamTurn({
      model: "m",
      systemPrompt: "s",
      messages: [{ role: "user", content: tooMany }],
    }));
    expect(events).toEqual([expect.objectContaining({ type: "error", classification: "subscription-attachment-too-large" })]);
    expect(h.requests.some((entry) => entry.url === CHATGPT_PLAN_RESPONSES_URL)).toBe(false);
  });

  it("fails clearly without a model, since plan usage has no default", async () => {
    const runtime = vi.fn(async () => harness(PLAN_SCOPES).runtime);
    const transport = new ChatGptPlanTransport({ kind: "subscription", provider: "chatgpt-plan" }, runtime);
    const events = await collect(transport.streamTurn({ model: "m", systemPrompt: "s", messages: [{ role: "user", content: "hi" }] }));
    expect(events).toEqual([expect.objectContaining({ type: "error", classification: "chatgpt-plan-model-unavailable" })]);
    expect(runtime).not.toHaveBeenCalled();
  });

  it("lists the account's models through the egress-limited fetch", async () => {
    const h = harness(PLAN_SCOPES, (url) => url === CHATGPT_PLAN_MODELS_URL
      ? new Response(JSON.stringify({ models: [
        { slug: "gpt-6.1-sol", display_name: "GPT-6.1 Sol", visibility: "list" },
        { slug: "hidden", display_name: "Hidden", visibility: "hide" },
      ] }), { status: 200 })
      : new Response("{}", { status: 404 }));
    const listed = await h.runtime.listModels();
    expect(listed.models).toEqual([{ id: "gpt-6.1-sol", displayName: "GPT-6.1 Sol", isDefault: false }]);
    expect(h.requests[0]).toMatchObject({ url: CHATGPT_PLAN_MODELS_URL, authorization: "Bearer stored-access-token" });
  });

  it("refuses any request outside the plan's documented endpoints", async () => {
    const h = harness(PLAN_SCOPES);
    await expect(h.runtime.fetch("https://api.openai.com/v1/chat/completions", { method: "POST" })).rejects.toThrow(/egress refused/);
    expect(h.requests).toHaveLength(0);
  });
});

describe("SubscriptionRuntimeService with ChatGPT plan usage", () => {
  async function service(chatGptPlanRuntime: ChatGptPlanRuntime | null) {
    return SubscriptionRuntimeService.create(async () => undefined, { claudeCodeReleaseFetch: RELEASE_FETCH,
      namespace: createSubscriptionRuntimeNamespace(),
      claimRuntimeDirectories: claimFakeRuntimeDirectories,
      codexClient: { stop: vi.fn() } as unknown as CodexAppServerClient,
      acpRegistry: { stopAll: vi.fn(async () => undefined) } as unknown as AcpSubscriptionRuntimeRegistry,
      chatGptPlanRuntime,
    });
  }

  it("reports not-configured and refuses sign-in when boot supplied no plan runtime", async () => {
    const svc = await service(null);
    try {
      await expect(svc.getStatus("chatgpt-plan")).resolves.toMatchObject({ runtime: "not-configured", connection: "unknown" });
      await expect(svc.startLogin("chatgpt-plan", "browser")).rejects.toMatchObject({ code: "subscription-runtime-not-configured" });
      expect(() => svc.requireChatGptPlan()).toThrow(SubscriptionRuntimeServiceError);
    } finally {
      await svc.stop();
    }
  });

  it("serves status, verification and models from the plan runtime, never a CLI", async () => {
    const h = harness(PLAN_SCOPES, (url) => url === CHATGPT_PLAN_MODELS_URL
      ? new Response(JSON.stringify({ models: [{ slug: "gpt-6.1-sol", display_name: "GPT-6.1 Sol", visibility: "list" }] }), { status: 200 })
      : new Response("{}", { status: 404 }));
    const svc = await service(h.runtime);
    try {
      await expect(svc.verify("chatgpt-plan")).resolves.toMatchObject({ connection: "connected", capabilities: { chat: true } });
      await expect(svc.listModels("chatgpt-plan")).resolves.toMatchObject({ models: [{ id: "gpt-6.1-sol" }] });
      await expect(svc.startLogin("chatgpt-plan", "device-code")).rejects.toMatchObject({ code: "subscription-provider-not-supported" });
      await expect(svc.chooseExecutable("chatgpt-plan", "/tmp/x")).rejects.toMatchObject({ code: "subscription-provider-not-supported" });
      await expect(svc.acknowledgeNotice("chatgpt-plan")).resolves.toMatchObject({ notice: null });
      await expect(svc.acknowledgeNotice("codex")).rejects.toMatchObject({ code: "subscription-provider-not-supported" });
      await expect(svc.openTextSession({ kind: "subscription", provider: "chatgpt-plan", model: "gpt-6.1-sol" }))
        .rejects.toMatchObject({ code: "subscription-chat-unavailable" });
    } finally {
      await svc.stop();
    }
  });

  it("maps a session failure to a stable runtime code", async () => {
    const session = { status: () => { throw new Error("broken record"); } } as unknown as ChatGptPlanSession;
    const runtime = new ChatGptPlanRuntime(session, (async () => new Response()) as typeof fetch);
    expect(runtime.getStatus()).toMatchObject({ runtime: "unavailable", connection: "unknown" });
    await expect(runtime.startLogin()).rejects.toBeInstanceOf(ChatGptPlanRuntimeError);
  });
});
