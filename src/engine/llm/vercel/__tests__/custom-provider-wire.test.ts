import { describe, expect, it, vi } from "vitest";
import { createProvider } from "../../provider-factory.js";
import type { ProviderConfig } from "../../types.js";
import { collectStreamEvents } from "./test-helpers.js";

const WIRES = ["openai-chat", "openai-responses", "anthropic-messages", "google-gemini"] as const;

async function request(wire: string, baseUrl: string, apiKey = "fixture-key") {
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response("", { status: 200, headers: { "content-type": "text/event-stream" } }));
  const provider = createProvider({ vendor: "openai-compatible", apiKey, baseUrl, wire, fetch: fetchImpl } as ProviderConfig);
  const events = await collectStreamEvents(provider.streamTurn({
    model: "fixture-model", systemPrompt: "Return a value.",
    messages: [{ role: "user", content: "Hello" }], tools: [],
    enableThinking: false, thinkingBudgetTokens: 0, outputTokenLimit: 256,
  }));
  return { fetchImpl, events };
}

describe("custom provider wire transport", () => {
  it.each([
    ["openai-chat", "/chat/completions", "authorization"],
    ["openai-responses", "/responses", "authorization"],
    ["anthropic-messages", "/messages", "x-api-key"],
    ["google-gemini", "/models/fixture-model:streamGenerateContent?alt=sse", "x-goog-api-key"],
  ])("routes %s to its selected protocol", async (wire, suffix, authHeader) => {
    const { fetchImpl } = await request(wire, "https://custom.example/v1");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(`https://custom.example/v1${suffix}`);
    expect(new Headers(init?.headers).get(authHeader)).toContain("fixture-key");
  });

  it.each(WIRES)("rejects remote HTTP for %s even without credentials", async (wire) => {
    const { fetchImpl, events } = await request(wire, "http://custom.example/v1", "");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(events.some((event) => event.type === "error")).toBe(true);
  });

  it.each(WIRES)("accepts keyless loopback for %s", async (wire) => {
    const { fetchImpl } = await request(wire, "http://localhost:9000/v1", "");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(WIRES)("retains the credentialed HTTPS check for %s", async (wire) => {
    const { fetchImpl, events } = await request(wire, "http://localhost:9000/v1");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(events.some((event) => event.type === "error" && /https/i.test(event.error))).toBe(true);
  });
});
