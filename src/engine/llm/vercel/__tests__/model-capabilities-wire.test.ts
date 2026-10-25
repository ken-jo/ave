import { afterEach, describe, expect, it, vi } from "vitest";
import { activeModelCatalog, installModelCatalog } from "../../../../shared/model-catalog/active.js";
import { resolveContextWindowForRoute, resolveInputModalities, resolveToolCallSupport } from "../../../../shared/context-budget.js";
import { freshAllVendorBlocks, llmImageInputKey } from "../../../../shared/llm-vendor-defaults.js";
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
    provider: new VercelUnifiedProvider(vendor, "fixture-key", vendor === "openrouter" || vendor === "openai-compatible" ? "https://provider.invalid/v1" : undefined, fetchResponse),
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
  it.each([undefined, true, false])("uses saved image declarations for an unknown custom model at the HTTP boundary: %s", async (imageInput) => {
    const fixture = wireFixture("openai-compatible");
    const vendors = freshAllVendorBlocks();
    vendors["openai-compatible"].model = "opaque-model";
    vendors["openai-compatible"].imageInput = imageInput === undefined ? undefined : { [llmImageInputKey("opaque-model")]: imageInput };
    const modelCapabilities = resolveContextWindowForRoute({ provider: "openai-compatible", vendors });
    const events = await collectStreamEvents(fixture.provider.streamTurn(request("opaque-model", { messages: IMAGE_MESSAGES, modelCapabilities })));
    expect(fixture.fetchResponse).toHaveBeenCalledTimes(imageInput === true ? 1 : 0);
    if (imageInput !== true) expect(events).toEqual([expect.objectContaining({ type: "error", code: "image-input-unsupported", classification: "model" })]);
  });

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

  it.each([
    { catalogModel: "openai/gpt-4", reported: ["text", "image"], calls: 0 },
    { catalogModel: "openai/gpt-4o", reported: ["text"], calls: 1 },
  ])("keeps a named image capability above the endpoint at the HTTP boundary: %j", async ({ catalogModel, reported, calls }) => {
    const fixture = wireFixture("openai-compatible");
    const vendors = freshAllVendorBlocks();
    vendors["openai-compatible"].model = "opaque-model";
    vendors["openai-compatible"].catalogModel = catalogModel;
    const inputModalities = resolveInputModalities({ vendor: "openai-compatible", model: "opaque-model", catalogModel, reported });
    await collectStreamEvents(fixture.provider.streamTurn(request("opaque-model", { messages: IMAGE_MESSAGES, modelCapabilities: { inputModalities } })));
    expect(fixture.fetchResponse).toHaveBeenCalledTimes(calls);
  });

  it("allows images the endpoint reports even when the catalog denies them", async () => {
    const fixture = wireFixture();
    await collectStreamEvents(fixture.provider.streamTurn(request("gpt-4", {
      messages: IMAGE_MESSAGES,
      modelCapabilities: { inputModalities: { input: ["text", "image"], source: "provider-reported" } },
    })));
    expect(fixture.fetchResponse).toHaveBeenCalledOnce();
  });

  it("refuses images on a resolved route that states no modalities, without a second catalog match", async () => {
    // Unstated route image support must not be re-inferred from the catalog name.
    const fixture = wireFixture();
    await collectStreamEvents(fixture.provider.streamTurn(request("gpt-4o", {
      messages: IMAGE_MESSAGES, modelCapabilities: {},
    })));
    expect(fixture.fetchResponse).not.toHaveBeenCalled();
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

  it("allows tool-result images on an unknown served id when the endpoint reports image input", async () => {
    const fixture = wireFixture("openai-compatible");
    await collectStreamEvents(fixture.provider.streamTurn(request("vision-model", {
      modelCapabilities: { inputModalities: { input: ["text", "image"], source: "provider-reported" } },
      messages: [
        { role: "assistant", content: "", toolCalls: [{ id: "image-call", name: "view_image", input: {} }] },
        { role: "tool_result", toolUseId: "image-call", toolName: "view_image", content: "Image loaded", image: { mimeType: "image/png", data: "QUJD" } },
      ],
    })));
    expect(fixture.fetchResponse).toHaveBeenCalledOnce();
    const messages = fixture.body().messages as Array<{ role: string; content: unknown }>;
    const toolIndex = messages.findIndex((message) => message.role === "tool");
    expect(toolIndex).toBeGreaterThanOrEqual(0);
    expect(messages[toolIndex]).toMatchObject({ tool_call_id: "image-call", content: "Image loaded" });
    expect(messages[toolIndex + 1]).toMatchObject({ role: "user", content: [
      { type: "text", text: expect.stringContaining('call "image-call"') },
      { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
    ] });
  });

  it("refuses tool-result images when the endpoint reports text only despite an image-capable name", async () => {
    const fixture = wireFixture("openai-compatible");
    const events = await collectStreamEvents(fixture.provider.streamTurn(request("gpt-5.4-mini", {
      modelCapabilities: { inputModalities: { input: ["text"], source: "provider-reported" } },
      messages: [
        { role: "assistant", content: "", toolCalls: [{ id: "image-call", name: "view_image", input: {} }] },
        { role: "tool_result", toolUseId: "image-call", toolName: "view_image", content: "Image loaded", image: { mimeType: "image/png", data: "QUJD" } },
      ],
    })));
    expect(fixture.fetchResponse).not.toHaveBeenCalled();
    expect(events).toEqual([expect.objectContaining({ type: "error", classification: "model" })]);
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
  it("withholds HTTP tools for the user's named no-tools entry despite endpoint support", async () => {
    const fixture = wireFixture("openai-compatible");
    const toolCall = resolveToolCallSupport({
      vendor: "openai-compatible", model: "a-served-model",
      catalogModel: "openai/gpt-3.5-turbo", reported: ["tools"],
    });
    await collectStreamEvents(fixture.provider.streamTurn(request("a-served-model", {
      tools: TOOLS, modelCapabilities: { toolCall },
    })));
    expect(fixture.fetchResponse).toHaveBeenCalledOnce();
    expect(fixture.body()).not.toHaveProperty("tools");
  });

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

  it("keeps tools on direct calls to a same-name alias at another host", async () => {
    // A gateway alias does not establish the catalog model tool capability.
    const fetchResponse = vi.fn<typeof fetch>(async () => new Response("refused", { status: 400 }));
    const provider = new VercelUnifiedProvider("openai", "fixture-key", "https://gateway.invalid/v1", fetchResponse);
    await collectStreamEvents(provider.streamTurn(request("gpt-3.5-turbo", { tools: TOOLS })));
    expect(fetchResponse).toHaveBeenCalledOnce();
    const body = JSON.parse(String(fetchResponse.mock.calls[0]![1]!.body)) as Record<string, unknown>;
    expect(body.tools).toHaveLength(TOOLS.length);
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
