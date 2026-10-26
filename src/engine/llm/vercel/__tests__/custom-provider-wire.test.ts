import { describe, expect, it, vi } from "vitest";
import { createProvider } from "../../provider-factory.js";
import type { ProviderConfig } from "../../types.js";
import { collectStreamEvents } from "./test-helpers.js";
import { createGuardedModelProviderFetch } from "../../marketplace-provider-fetch.js";
import * as networkGuard from "../../../../core/network-guard.js";

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

  it.each(WIRES)("accepts keyless HTTP for %s", async (wire) => {
    const { fetchImpl, events } = await request(wire, "http://custom.example/v1", "");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(events.some((event) => event.type === "error" && /baseUrl/.test(event.error))).toBe(false);
  });

  it.each([
    ["openai-responses", "http://10.10.2.100:30000/v1"],
    ["anthropic-messages", "http://192.168.1.20/v1"],
    ["google-gemini", "http://gpu-box.lan/v1"],
  ])("accepts a saved private %s endpoint only with its guarded fetch", async (wire, baseUrl) => {
    const transport = vi.fn<typeof fetch>(async () => new Response("", { headers: { "content-type": "text/event-stream" } }));
    const guard = vi.spyOn(networkGuard, "fetchPublicHttpResponse").mockImplementation(async (url, options) => {
      expect(typeof options?.allowPrivateNetworks === "function" && options.allowPrivateNetworks(new URL(url))).toBe(true);
      expect(typeof options?.allowPrivateNetworks === "function" && options.allowPrivateNetworks(new URL("http://other.lan/v1"))).toBe(false);
      expect(options?.maxRedirects).toBe(0);
      return options!.fetchImpl!(url, options);
    });
    try {
      const guardedFetch = createGuardedModelProviderFetch(baseUrl, transport);
      const provider = createProvider({ vendor: "openai-compatible", apiKey: "fixture-key", baseUrl, wire, fetch: guardedFetch } as ProviderConfig);
      await collectStreamEvents(provider.streamTurn({ model: "fixture-model", systemPrompt: "Hello", messages: [{ role: "user", content: "Hi" }], tools: [] }));
      expect(guard).toHaveBeenCalledTimes(1);
      expect(transport).toHaveBeenCalledTimes(1);
      const header = wire === "anthropic-messages" ? "x-api-key" : wire === "google-gemini" ? "x-goog-api-key" : "authorization";
      expect(new Headers(transport.mock.calls[0]![1]?.headers).get(header)).toContain("fixture-key");
      await expect(guardedFetch("http://other.lan/v1")).rejects.toThrow(/configured origin/);
      expect(guard).toHaveBeenCalledTimes(1);
    } finally {
      guard.mockRestore();
    }
  });

  it.each(WIRES)("requires a custom endpoint for %s", async (wire) => {
    const { fetchImpl, events } = await request(wire, "");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(events.some((event) => event.type === "error" && /baseUrl is required/.test(event.error))).toBe(true);
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
