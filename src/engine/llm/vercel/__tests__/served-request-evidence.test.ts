/** The usage a request reports carries the address the installed SDK actually sent it to. */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StreamEvent, StreamTurnParams } from "../../types.js";
import { VercelUnifiedProvider } from "../adapter.js";
import { collectStreamEvents as collect } from "./test-helpers.js";

const TURN: StreamTurnParams = {
  model: "fixture-model",
  systemPrompt: "Complete the requested operation.",
  messages: [{ role: "user", content: "Return the result." }],
};

function sse(events: readonly unknown[], done = false): Response {
  return new Response(
    `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}${done ? "data: [DONE]\n\n" : ""}`,
    { headers: { "content-type": "text/event-stream" } },
  );
}

const chat = (model: string): Response => sse([{
  id: "fixture-response", object: "chat.completion.chunk", created: 0, model,
  choices: [{ index: 0, delta: { role: "assistant", content: "answer" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 6, completion_tokens: 2, total_tokens: 8 },
}], true);

const responses = (model: string): Response => sse([
  { type: "response.created", response: { id: "fixture", created_at: 1, model } },
  { type: "response.output_item.added", output_index: 0, item: { id: "fixture-message", type: "message", role: "assistant" } },
  { type: "response.output_text.delta", item_id: "fixture-message", output_index: 0, delta: "answer" },
  { type: "response.completed", response: { usage: { input_tokens: 6, output_tokens: 2, total_tokens: 8 } } },
]);

const messages = (model: string): Response => sse([
  { type: "message_start", message: { id: "fixture", model, role: "assistant", usage: { input_tokens: 6 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "answer" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } },
  { type: "message_stop" },
]);

const generated = (): Response => sse([{
  candidates: [{ content: { parts: [{ text: "answer" }] }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 6, candidatesTokenCount: 2, totalTokenCount: 8 },
}]);

function requestUrl(input: Parameters<typeof fetch>[0] | undefined): URL {
  if (input === undefined) throw new Error("No request was sent");
  return new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
}

function servedRequestUrl(events: readonly StreamEvent[]): string | undefined {
  const complete = events.find((event) => event.type === "message_complete");
  if (complete?.type !== "message_complete") throw new Error(`No completed message: ${JSON.stringify(events)}`);
  return complete.usage?.servedRequestUrl;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("served request evidence", () => {
  it.each([
    ["OPENAI_BASE_URL", "openai", () => chat(TURN.model), "https://proxy.invalid/v1/chat/completions"],
    ["ANTHROPIC_BASE_URL", "claude", () => messages(TURN.model), "https://proxy.invalid/v1/messages"],
  ] as const)("records the proxy an %s override sends a request to when no endpoint is configured", async (variable, vendor, respond, expected) => {
    vi.stubEnv(variable, "https://proxy.invalid/v1");
    // No transport is supplied either: the request goes to the runtime's fetch, as it does without the observer.
    const runtimeFetch = vi.fn<typeof fetch>(async () => respond());
    vi.stubGlobal("fetch", runtimeFetch);
    const events = await collect(new VercelUnifiedProvider(vendor, "fixture-key").streamTurn(TURN));
    expect(runtimeFetch).toHaveBeenCalledOnce();
    expect(requestUrl(runtimeFetch.mock.calls[0]?.[0]).href).toBe(expected);
    expect(servedRequestUrl(events)).toBe(expected);
  });

  it.each([
    ["claude", "https://api.anthropic.com", () => messages(TURN.model), TURN.model],
    ["claude", "https://api.anthropic.com/", () => messages(TURN.model), TURN.model],
    ["azure-foundry", "https://fixture.services.ai.azure.com/OPENAI/v1", () => responses("fixture-deployment"), "fixture-deployment"],
    ["azure-foundry", "https://fixture.openai.azure.com/openai/deployments/fixture-deployment/chat/completions?api-version=2024-10-21", () => responses("fixture-deployment"), "fixture-deployment"],
    ["openai", "https://proxy.invalid/v1/", () => chat(TURN.model), TURN.model],
    ["gemini", undefined, generated, TURN.model],
  ] as const)("records what the installed SDK sends for %s at %s, after its own address normalization", async (vendor, baseUrl, respond, model) => {
    const transport = vi.fn<typeof fetch>(async () => respond());
    const events = await collect(new VercelUnifiedProvider(vendor, "fixture-key", baseUrl, transport).streamTurn({ ...TURN, model }));
    expect(transport).toHaveBeenCalledOnce();
    const sent = requestUrl(transport.mock.calls[0]?.[0]);
    // Nothing is predicted: the evidence is the address the transport received, without its query.
    expect(servedRequestUrl(events)).toBe(`${sent.origin}${sent.pathname}`);
    expect(servedRequestUrl(events)).not.toContain("?");
  });

  it("pins the installed SDK's Anthropic and Foundry addresses the evidence reports", async () => {
    const anthropic = vi.fn<typeof fetch>(async () => messages(TURN.model));
    const foundry = vi.fn<typeof fetch>(async () => responses("fixture-deployment"));
    expect(servedRequestUrl(await collect(
      new VercelUnifiedProvider("claude", "fixture-key", "https://api.anthropic.com", anthropic).streamTurn(TURN),
    ))).toBe("https://api.anthropic.com/v1/messages");
    expect(servedRequestUrl(await collect(
      new VercelUnifiedProvider("azure-foundry", "fixture-key", "https://fixture.services.ai.azure.com/OPENAI/v1", foundry)
        .streamTurn({ ...TURN, model: "fixture-deployment" }),
    ))).toBe("https://fixture.services.ai.azure.com/OPENAI/v1/responses");
  });

  it.each(["OPENAI_BASE_URL", "ANTHROPIC_BASE_URL"] as const)("sends nothing when %s is set but empty", async (variable) => {
    vi.stubEnv(variable, "");
    const runtimeFetch = vi.fn<typeof fetch>(async () => chat(TURN.model));
    vi.stubGlobal("fetch", runtimeFetch);
    const vendor = variable === "OPENAI_BASE_URL" ? "openai" : "claude";
    const events = await collect(new VercelUnifiedProvider(vendor, "fixture-key").streamTurn(TURN));
    // The SDK rejects the empty override itself; the host never substitutes a default address for it.
    expect(runtimeFetch).not.toHaveBeenCalled();
    expect(events.map((event) => event.type)).toEqual(["error"]);
  });

  it("keeps each concurrent request's own address on one provider", async () => {
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const transport = vi.fn<typeof fetch>(async (input) => {
      if (requestUrl(input).pathname.includes("first-model")) await firstHeld;
      return generated();
    });
    const provider = new VercelUnifiedProvider("gemini", "fixture-key", undefined, transport);
    const first = collect(provider.streamTurn({ ...TURN, model: "first-model" }));
    const second = await collect(provider.streamTurn({ ...TURN, model: "second-model" }));
    releaseFirst();
    expect(servedRequestUrl(second)).toContain("/models/second-model:");
    expect(servedRequestUrl(await first)).toContain("/models/first-model:");
  });

  it("drops credentials and the query from the recorded address", async () => {
    const transport = vi.fn<typeof fetch>(async () => chat(TURN.model));
    const provider = new VercelUnifiedProvider(
      "openai-compatible", "fixture-key", "https://user:secret@gateway.invalid/v1", transport,
    );
    const events = await collect(provider.streamTurn(TURN));
    expect(transport).toHaveBeenCalledOnce();
    expect(servedRequestUrl(events)).toBe("https://gateway.invalid/v1/chat/completions");
  });
});
