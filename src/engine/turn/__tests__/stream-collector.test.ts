import { afterEach, describe, expect, it, vi } from "vitest";

import type { LLMProvider, StreamEvent, StreamTurnParams } from "../../llm/types.js";
import { collectActiveRuntimeRoundStream, collectRoundStream } from "../stream-collector.js";
import { VercelUnifiedProvider } from "../../llm/vercel/adapter.js";
import { getLocale, setLocale } from "../../../i18n/index.js";

const initialLocale = getLocale();
afterEach(() => setLocale(initialLocale));

const LLM_SETTINGS = {
  streamSmoothing: "none" as const,
  enableThinking: false,
  thinkingBudgetTokens: 0,
};

class ScriptedProvider implements LLMProvider {
  readonly vendor = "openai" as const;
  lastParams: StreamTurnParams | null = null;
  constructor(private readonly events: readonly StreamEvent[]) {}

  async *streamTurn(params: StreamTurnParams): AsyncIterable<StreamEvent> {
    this.lastParams = params;
    yield* this.events;
  }
}

class SubscriptionCapturingProvider implements LLMProvider {
  readonly vendor = "openai" as const;
  readonly subscriptionRuntime = { kind: "subscription", provider: "codex" } as const;
  lastParams: StreamTurnParams | null = null;

  constructor(private readonly events: readonly StreamEvent[]) {}

  async *streamTurn(params: StreamTurnParams): AsyncIterable<StreamEvent> {
    this.lastParams = params;
    yield* this.events;
  }
}

async function collect(events: readonly StreamEvent[]) {
  return collectRoundStream({
    provider: new ScriptedProvider(events),
    model: "test-model",
    systemPrompt: "system",
    messages: [],
    toolSchemas: [],
    llmSettings: LLM_SETTINGS,
  });
}

describe("image capability refusal", () => {
  it.each([
    ["en", "Error: Images in this conversation cannot be sent to the selected model. Switch to an image-capable model, or start a new conversation without images. If this custom model supports images, set Image input to Supported under Settings → Model → Image input."],
    ["ko", "오류: 대화에 포함된 이미지를 선택한 모델로 보낼 수 없습니다. 이미지를 받는 모델로 바꾸거나, 이미지가 없는 새 대화를 시작해 주세요. 이 사용자 지정 모델이 이미지를 지원한다면 설정 → 모델 → 이미지 입력에서 이미지 입력을 지원으로 설정해 주세요."],
  ] as const)("localizes retained-image recovery in %s", async (locale, userMessage) => {
    setLocale(locale);
    const fetchResponse = vi.fn<typeof fetch>();
    const result = await collectRoundStream({
      provider: new VercelUnifiedProvider("openai", "fixture-key", undefined, fetchResponse),
      model: "gpt-4", systemPrompt: "Describe the image.", toolSchemas: [], llmSettings: LLM_SETTINGS,
      messages: [
        { role: "assistant", content: "", toolCalls: [{ id: "image-call", name: "view_image", input: {} }] },
        { role: "tool_result", toolUseId: "image-call", toolName: "view_image", content: "Image loaded", image: { mimeType: "image/png", data: "QUJD" } },
        { role: "user", content: "Describe it." },
      ],
    });
    expect(fetchResponse).not.toHaveBeenCalled();
    expect(result).toMatchObject({ kind: "stream_error", classification: "model", userMessage });
    expect(result).not.toHaveProperty("toolCalls");
  });
});

describe("provider completion boundary", () => {
  it.each([
    ["en", "Error: The selected model could not be found. Please check the model in your settings."],
    ["ko", "오류: 선택한 모델을 찾을 수 없습니다. 설정에서 모델을 확인해주세요."],
  ] as const)("localizes a subscription model refusal in %s without exposing diagnostics", async (locale, userMessage) => {
    setLocale(locale);
    const result = await collectRoundStream({
      provider: new SubscriptionCapturingProvider([{
        type: "error", error: "subscription-model-not-supported",
        providerError: { origin: "unknown", providerCode: "subscription-model-not-supported",
          messagePreview: "private runtime diagnostic", isRetryable: false },
      }]),
      model: "test-model", systemPrompt: "system", messages: [], toolSchemas: [], llmSettings: LLM_SETTINGS,
    });
    expect(result).toMatchObject({ kind: "stream_error", classification: "model", userMessage });
  });

  it.each(["started", "cancelled", "runtime-switched"] as const)(
    "records dispatch only after the guards pass: %s", async (state) => {
      const provider = new ScriptedProvider([{ type: "message_complete", stopReason: "end_turn" }]);
      const controller = new AbortController();
      if (state === "cancelled") controller.abort();
      const onRequestStarted = vi.fn();
      await collectActiveRuntimeRoundStream({ provider, model: "test-model", systemPrompt: "system", messages: [],
        toolSchemas: [], llmSettings: LLM_SETTINGS, abortSignal: controller.signal, onRequestStarted },
        state === "runtime-switched" ? { kind: "subscription", provider: "codex", model: "gpt-5.5-codex" } : undefined,
        () => {});
      expect(onRequestStarted).toHaveBeenCalledTimes(state === "started" ? 1 : 0);
      expect(provider.lastParams === null).toBe(state !== "started");
    },
  );

  it.each<{ label: string; events: StreamEvent[] }>([
    { label: "empty stream", events: [] },
    { label: "partial text", events: [{ type: "text_delta", text: "partial-response" }] },
    { label: "reasoning only", events: [{ type: "reasoning_delta", text: "private-thought" }] },
    {
      label: "tool call",
      events: [{ type: "tool_call", id: "pending-call", name: "bash", input: { command: "pwd" } }],
    },
  ])("rejects EOF after $label without committing a successful round", async ({ events }) => {
    const result = await collect(events);

    expect(result).toMatchObject({
      kind: "stream_error",
      classification: "unknown",
      providerError: { messagePreview: "model stream ended without message_complete" },
    });
    expect(result).not.toHaveProperty("toolCalls");
    expect(result).not.toHaveProperty("stopReason");
    expect(JSON.stringify(result)).not.toMatch(/partial-response|private-thought/);
  });

  it("accepts an explicitly completed empty response", async () => {
    expect(await collect([{ type: "message_complete", stopReason: "end_turn" }])).toMatchObject({
      kind: "ok", text: "", thought: "", toolCalls: [], stopReason: "end_turn",
    });
  });

  it("keeps caller cancellation distinct from unexpected provider termination", async () => {
    const controller = new AbortController();
    const provider: LLMProvider = {
      vendor: "openai",
      async *streamTurn() {
        yield { type: "text_delta", text: "visible-prefix" };
        controller.abort();
      },
    };
    expect(await collectRoundStream({
      provider, model: "test-model", systemPrompt: "system", messages: [], toolSchemas: [],
      llmSettings: LLM_SETTINGS, abortSignal: controller.signal,
    })).toEqual({ kind: "interrupted", text: "visible-prefix" });
  });

  it("reports an unsolicited provider abort as a stream error", async () => {
    const provider: LLMProvider = {
      vendor: "openai",
      async *streamTurn() {
        yield { type: "text_delta", text: "visible-prefix" };
        throw new DOMException("Provider request aborted unexpectedly", "AbortError");
      },
    };
    expect(await collectRoundStream({
      provider, model: "test-model", systemPrompt: "system", messages: [], toolSchemas: [],
      llmSettings: LLM_SETTINGS,
    })).toMatchObject({ kind: "stream_error" });
  });
});

describe("collectRoundStream tool call IDs", () => {
  it("forwards thinking controls to a marked subscription runtime", async () => {
    const provider = new SubscriptionCapturingProvider([
      { type: "message_complete", stopReason: "end_turn" },
    ]);

    await collectRoundStream({
      provider,
      model: "subscription-model",
      systemPrompt: "subscription-system",
      messages: [],
      toolSchemas: [],
      llmSettings: {
        streamSmoothing: "none",
        enableThinking: true,
        thinkingBudgetTokens: 10_000,
      },
    });

    expect(provider.lastParams).toMatchObject({
      enableThinking: true,
      thinkingBudgetTokens: 10_000,
    });
  });

  it.each([
    ["empty", ""],
    ["over UTF-8 byte limit", "😀".repeat(65)],
    ["NUL", "raw-secret\u0000invalid-id"],
    ["C0", "raw-secret\ninvalid-id"],
    ["C1", "raw-secret\u0085invalid-id"],
  ])("rejects an %s ID without exposing it or tool input", async (_label, id) => {
    const result = await collect([
      {
        type: "tool_call",
        id,
        name: "bash",
        input: { command: "raw-secret-tool-input" },
      },
      { type: "message_complete", stopReason: "tool_use" },
    ]);

    expect(result).toMatchObject({
      kind: "stream_error",
      classification: "unknown",
      providerError: {
        messagePreview: "invalid tool_call id in assistant response",
      },
    });
    expect(JSON.stringify(result)).not.toContain("raw-secret");
    expect(result).not.toHaveProperty("toolCalls");
  });

  it("accepts a valid tool event from a subscription runtime", async () => {
    const provider = new SubscriptionCapturingProvider([
      {
        type: "tool_call",
        id: "subscription-tool",
        name: "read_file",
        input: { path: "src/index.ts" },
      },
      { type: "message_complete", stopReason: "tool_use" },
    ]);

    const result = await collectRoundStream({
      provider,
      model: "subscription-model",
      systemPrompt: "subscription-system",
      messages: [],
      toolSchemas: [],
      llmSettings: LLM_SETTINGS,
    });

    expect(result).toMatchObject({
      kind: "ok",
      stopReason: "tool_use",
      toolCalls: [{
        id: "subscription-tool",
        name: "read_file",
        input: { path: "src/index.ts" },
      }],
    });
  });

  it("accepts a distinct ID at exactly 256 UTF-8 bytes", async () => {
    const id = "😀".repeat(64);
    const result = await collect([
      { type: "tool_call", id, name: "read_file", input: { path: "one" } },
      { type: "message_complete", stopReason: "tool_use" },
    ]);

    expect(result).toMatchObject({
      kind: "ok",
      toolCalls: [{ id, name: "read_file", input: { path: "one" } }],
    });
  });

  it("rejects duplicate IDs without exposing tool inputs in diagnostics", async () => {
    const secret = "raw-secret-tool-input";
    const result = await collect([
      { type: "tool_call", id: "duplicate", name: "read_file", input: { path: "safe" } },
      { type: "tool_call", id: "duplicate", name: "bash", input: { command: secret } },
      { type: "message_complete", stopReason: "tool_use" },
    ]);

    expect(result).toMatchObject({
      kind: "stream_error",
      classification: "unknown",
      providerError: {
        origin: "unknown",
        classification: "unknown",
        messagePreview: "duplicate tool_call id in one assistant response",
      },
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result).not.toHaveProperty("toolCalls");
  });

  it("preserves distinct tool calls in provider order", async () => {
    const result = await collect([
      { type: "tool_call", id: "first", name: "read_file", input: { path: "one" } },
      { type: "tool_call", id: "second", name: "bash", input: { command: "pwd" } },
      { type: "message_complete", stopReason: "tool_use" },
    ]);

    expect(result).toMatchObject({
      kind: "ok",
      stopReason: "tool_use",
      toolCalls: [
        { id: "first", name: "read_file", input: { path: "one" } },
        { id: "second", name: "bash", input: { command: "pwd" } },
      ],
    });
  });
});
describe("per-vendor output ceiling", () => {
  // Gateways may reserve credit against maximum output; a request ceiling can make capped keys usable.
  it("forwards a configured ceiling to the provider", async () => {
    const provider = new ScriptedProvider([
      { type: "message_complete", stopReason: "end_turn" },
    ]);
    await collectRoundStream({
      provider,
      model: "test-model",
      systemPrompt: "system",
      messages: [],
      toolSchemas: [],
      llmSettings: { ...LLM_SETTINGS, outputTokenLimit: 2048 },
    });
    expect(provider.lastParams?.outputTokenLimit).toBe(2048);
  });

  it("sends nothing when no ceiling is configured", async () => {
    const provider = new ScriptedProvider([
      { type: "message_complete", stopReason: "end_turn" },
    ]);
    await collectRoundStream({
      provider,
      model: "test-model",
      systemPrompt: "system",
      messages: [],
      toolSchemas: [],
      llmSettings: LLM_SETTINGS,
    });
    expect(provider.lastParams).not.toHaveProperty("outputTokenLimit");
  });
});
