import { afterEach, describe, expect, it, vi } from "vitest";
import { activeModelCatalog, installModelCatalog } from "../../../../shared/model-catalog/active.js";
import { resolveToolCallSupport } from "../../../../shared/context-budget.js";
import type { LLMProvider, StreamTurnParams } from "../../types.js";
import { VercelUnifiedProvider } from "../adapter.js";
import { FallbackProvider } from "../fallback-chain.js";
import { collectStreamEvents } from "./test-helpers.js";

const IMAGE_MESSAGES: StreamTurnParams["messages"] = [{
  role: "user",
  content: [{ type: "image", image: "data:image/png;base64,iVBORw0KGgo=", mimeType: "image/png" }],
}];
const TOOLS: NonNullable<StreamTurnParams["tools"]> = [
  { name: "agent_spawn", description: "Start a child task", inputSchema: { type: "object", properties: {} } },
  { name: "request_approval", description: "Request approval", inputSchema: { type: "object", properties: {} } },
  { name: "plugin_read", description: "Read plugin data", inputSchema: { type: "object", properties: {} } },
  { name: "mcp_read", description: "Read external data", inputSchema: { type: "object", properties: {} } },
];
const bundled = activeModelCatalog();
afterEach(() => {
  installModelCatalog(bundled);
  vi.useRealTimers();
});

function wireFixture(vendor: LLMProvider["vendor"] = "openai") {
  const fetchResponse = vi.fn<typeof fetch>(async () => new Response("refused", { status: 400 }));
  return {
    fetchResponse,
    provider: new VercelUnifiedProvider(vendor, "fixture-key", vendor === "openrouter" ? "https://provider.invalid/v1" : undefined, fetchResponse),
    body: () => JSON.parse(String(fetchResponse.mock.calls[0]![1]!.body)) as Record<string, unknown>,
  };
}

function request(model: string, overrides: Partial<StreamTurnParams> = {}): StreamTurnParams {
  return {
    model,
    systemPrompt: "Report the result.",
    messages: [{ role: "user", content: "Continue." }],
    enableThinking: false,
    ...overrides,
  };
}

describe("image capability at the wire boundary", () => {
  it("refuses direct image requests to a text-only catalog model before fetching", async () => {
    const fixture = wireFixture();
    const events = await collectStreamEvents(fixture.provider.streamTurn(request("gpt-4", { messages: IMAGE_MESSAGES })));
    expect(fixture.fetchResponse).not.toHaveBeenCalled();
    expect(events).toEqual([expect.objectContaining({ type: "error", classification: "model" })]);
  });

  it("honors the route's endpoint report above catalog image support", async () => {
    const fixture = wireFixture();
    await collectStreamEvents(fixture.provider.streamTurn(request("gpt-4o", {
      messages: IMAGE_MESSAGES,
      modelCapabilities: { inputModalities: { input: ["text"], source: "provider-reported" } },
    })));
    expect(fixture.fetchResponse).not.toHaveBeenCalled();
  });

  it("allows images the endpoint reports even when the catalog denies them", async () => {
    const fixture = wireFixture();
    await collectStreamEvents(fixture.provider.streamTurn(request("gpt-4", {
      messages: IMAGE_MESSAGES,
      modelCapabilities: { inputModalities: { input: ["text", "image"], source: "provider-reported" } },
    })));
    expect(fixture.fetchResponse).toHaveBeenCalledOnce();
  });

  it("keeps a resolved unknown route on the name rule without a second catalog match", async () => {
    const fixture = wireFixture();
    await collectStreamEvents(fixture.provider.streamTurn(request("gpt-4", {
      messages: IMAGE_MESSAGES, modelCapabilities: {},
    })));
    expect(fixture.fetchResponse).toHaveBeenCalledOnce();
  });

  it("refuses retained tool-result images on a text-only route", async () => {
    const fixture = wireFixture();
    await collectStreamEvents(fixture.provider.streamTurn(request("gpt-4", {
      messages: [
        { role: "assistant", content: "", toolCalls: [{ id: "image-call", name: "view_image", input: {} }] },
        { role: "tool_result", toolUseId: "image-call", toolName: "view_image", content: "Image loaded", image: { mimeType: "image/png", data: "iVBORw0KGgo=" } },
        { role: "user", content: "Describe it." },
      ],
    })));
    expect(fixture.fetchResponse).not.toHaveBeenCalled();
  });

  it("does not inherit a primary endpoint's image capability on fallback", async () => {
    vi.useFakeTimers();
    const primary: LLMProvider = {
      vendor: "openai",
      async *streamTurn() { yield { type: "error", error: "503 fixture unavailable", classification: "network" }; },
    };
    const fixture = wireFixture();
    const fallback = new FallbackProvider(primary, [{ provider: "openai", model: "gpt-4" }], () => "fixture-key", () => fixture.provider);
    const pending = collectStreamEvents(fallback.streamTurn(request("gpt-4o", {
      messages: IMAGE_MESSAGES,
      modelCapabilities: { inputModalities: { input: ["text", "image"], source: "provider-reported" } },
    })));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await pending).toEqual([expect.objectContaining({ type: "error", classification: "model" })]);
    expect(fixture.fetchResponse).not.toHaveBeenCalled();
  });
});

describe("tool capability at the wire boundary", () => {
  it("sends tools when the endpoint explicitly supports them despite the catalog", async () => {
    const fixture = wireFixture();
    const toolCall = resolveToolCallSupport({ vendor: "openai", model: "gpt-3.5-turbo", reported: ["tools"] });
    await collectStreamEvents(fixture.provider.streamTurn(request("gpt-3.5-turbo", {
      tools: TOOLS, modelCapabilities: { toolCall },
    })));
    expect(fixture.body().tools).toHaveLength(TOOLS.length);
  });

  it("omits every tool definition on direct calls to a no-tools catalog model", async () => {
    const fixture = wireFixture();
    await collectStreamEvents(fixture.provider.streamTurn(request("gpt-3.5-turbo", { tools: TOOLS })));
    expect(fixture.body()).not.toHaveProperty("tools");
  });

  it("uses the resolved named entry instead of a conflicting name match", async () => {
    const fixture = wireFixture();
    await collectStreamEvents(fixture.provider.streamTurn(request("gpt-3.5-turbo", {
      tools: TOOLS,
      modelCapabilities: { toolCall: { supported: true, source: "model-catalog", catalogEntry: "openai/gpt-4o" } },
    })));
    expect(fixture.body().tools).toHaveLength(TOOLS.length);
  });

  it("honors a resolved no-tools entry on a name whose catalog match permits tools", async () => {
    const fixture = wireFixture();
    await collectStreamEvents(fixture.provider.streamTurn(request("gpt-4o", {
      tools: TOOLS,
      modelCapabilities: { toolCall: { supported: false, source: "model-catalog", catalogEntry: "openai/gpt-3.5-turbo" } },
    })));
    expect(fixture.body()).not.toHaveProperty("tools");
  });

  it("keeps tools when the resolved named entry states nothing", async () => {
    const fixture = wireFixture();
    await collectStreamEvents(fixture.provider.streamTurn(request("gpt-3.5-turbo", {
      tools: TOOLS, modelCapabilities: {},
    })));
    expect(fixture.body().tools).toHaveLength(TOOLS.length);
  });

  it("keeps tools for an ambiguous gateway suffix instead of choosing a no-tools entry", async () => {
    installModelCatalog({ ...bundled, providers: {
      ...bundled.providers,
      openrouter: { models: {
        "one/shared": { id: "one/shared", limits: {}, toolCall: false },
        "two/shared": { id: "two/shared", limits: {}, toolCall: true },
      } },
    } });
    const fixture = wireFixture("openrouter");
    await collectStreamEvents(fixture.provider.streamTurn(request("other/shared", { tools: TOOLS })));
    expect(fixture.body().tools).toHaveLength(TOOLS.length);
  });

  it("omits tools for the fallback's model after a tool-capable primary fails", async () => {
    vi.useFakeTimers();
    const primary: LLMProvider = {
      vendor: "openai",
      async *streamTurn() { yield { type: "error", error: "503 fixture unavailable", classification: "network" }; },
    };
    const fixture = wireFixture();
    const fallback = new FallbackProvider(primary, [{ provider: "openai", model: "gpt-3.5-turbo" }], () => "fixture-key", () => fixture.provider);
    const pending = collectStreamEvents(fallback.streamTurn(request("gpt-4o", {
      tools: TOOLS,
      modelCapabilities: { toolCall: { supported: true, source: "model-catalog", catalogEntry: "openai/gpt-4o" } },
    })));
    await vi.advanceTimersByTimeAsync(5_000);
    await pending;
    expect(fixture.body()).not.toHaveProperty("tools");
  });
});
