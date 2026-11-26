/** The usage a request reports carries what its transport established about where the installed SDK was answered from. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { noRetirementEvidence } from "../../model-wire-gate.js";
import { configuredEndpointId, createConfiguredEndpointIdentifier } from "../../pricing.js";
import type { StreamEvent, StreamTurnParams } from "../../types.js";
import { VercelUnifiedProvider } from "../adapter.js";
import { collectStreamEvents as collect } from "./test-helpers.js";

// The installed Vertex factory builds the address; only its credential lookup, which needs
// application credentials and the network, is replaced.
vi.mock("@ai-sdk/google-vertex", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ai-sdk/google-vertex")>();
  const authClient = { getAccessToken: async () => ({ token: "fixture-token" }) };
  return {
    ...actual,
    createVertex: (options: Parameters<typeof actual.createVertex>[0]) =>
      actual.createVertex({ ...options, googleAuthOptions: { authClient: authClient as never } }),
  };
});

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

function completion(events: readonly StreamEvent[]) {
  const complete = events.find((event) => event.type === "message_complete");
  if (complete?.type !== "message_complete") throw new Error(`No completed message: ${JSON.stringify(events)}`);
  return complete;
}

const servedRoute = (events: readonly StreamEvent[]) => completion(events).usage?.servedRoute;

/** A response as a real transport returns it: carrying its own final address. */
function answeredFrom(response: Response, url: string, redirected = false): Response {
  Object.defineProperty(response, "url", { value: url });
  Object.defineProperty(response, "redirected", { value: redirected });
  return response;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("served route evidence", () => {
  it.each([
    ["OPENAI_BASE_URL", "openai", () => chat(TURN.model), "https://proxy.invalid/v1/chat/completions"],
    ["ANTHROPIC_BASE_URL", "claude", () => messages(TURN.model), "https://proxy.invalid/v1/messages"],
  ] as const)("places nothing when an %s override sends an unconfigured route to a proxy", async (variable, vendor, respond, sentTo) => {
    vi.stubEnv(variable, "https://proxy.invalid/v1");
    // No transport is supplied either: the request goes to the runtime's fetch, as it does without the observer.
    const runtimeFetch = vi.fn<typeof fetch>(async () => respond());
    vi.stubGlobal("fetch", runtimeFetch);
    const events = await collect(new VercelUnifiedProvider(vendor, "fixture-key", undefined, undefined, { getRetiredModelId: noRetirementEvidence }).streamTurn(TURN));
    expect(runtimeFetch).toHaveBeenCalledOnce();
    expect(requestUrl(runtimeFetch.mock.calls[0]?.[0]).href).toBe(sentTo);
    expect(servedRoute(events)).toEqual({ kind: "unknown", origin: "https://proxy.invalid" });
  });

  it.each([
    ["claude", undefined, () => messages(TURN.model), TURN.model, "https://api.anthropic.com/v1"],
    ["claude", "https://api.anthropic.com", () => messages(TURN.model), TURN.model, "https://api.anthropic.com/v1"],
    ["claude", "https://api.anthropic.com/", () => messages(TURN.model), TURN.model, "https://api.anthropic.com/v1"],
    ["openai", undefined, () => chat(TURN.model), TURN.model, "https://api.openai.com/v1"],
    ["openai", "https://eu.api.openai.com/v1/", () => chat(TURN.model), TURN.model, "https://eu.api.openai.com/v1"],
    ["gemini", undefined, generated, TURN.model, "https://generativelanguage.googleapis.com/v1beta"],
    ["openrouter", "https://openrouter.ai/api/v1", () => chat(TURN.model), TURN.model, "https://openrouter.ai/api/v1"],
  ] as const)("names the vendor's own base for %s configured at %s, from what the installed SDK sends", async (vendor, baseUrl, respond, model, base) => {
    const transport = vi.fn<typeof fetch>(async () => respond());
    const events = await collect(new VercelUnifiedProvider(vendor, "fixture-key", baseUrl, transport, { getRetiredModelId: noRetirementEvidence }).streamTurn({ ...TURN, model }));
    expect(transport).toHaveBeenCalledOnce();
    // A configured endpoint is named too, so its own report can be told from another setting's.
    expect(servedRoute(events)).toEqual({
      kind: "vendor-native", base, ...(baseUrl !== undefined ? { configuredBaseId: configuredEndpointId(baseUrl) } : {}),
    });
  });

  it.each([
    ["global", "https://aiplatform.googleapis.com"],
    ["us-central1", "https://us-central1-aiplatform.googleapis.com"],
    ["eu", "https://aiplatform.eu.rep.googleapis.com"],
    ["us", "https://aiplatform.us.rep.googleapis.com"],
  ] as const)("names the host the installed Vertex SDK builds for location %s", async (vertexLocation, origin) => {
    const transport = vi.fn<typeof fetch>(async () => generated());
    const provider = new VercelUnifiedProvider("vertex-ai", "", undefined, transport, { vertexProject: "fixture-project", vertexLocation, getRetiredModelId: noRetirementEvidence });
    const events = await collect(provider.streamTurn({ ...TURN, model: "gemini-2.5-pro" }));
    expect(transport).toHaveBeenCalledOnce();
    const sent = requestUrl(transport.mock.calls[0]?.[0]);
    expect(sent.origin).toBe(origin);
    expect(sent.pathname).toBe(`/v1beta1/projects/fixture-project/locations/${vertexLocation}/publishers/google/models/gemini-2.5-pro:streamGenerateContent`);
    expect(servedRoute(events)).toEqual({ kind: "vendor-native", base: `${origin}/v1beta1` });
  });

  it.each([
    ["openai", "https://proxy.invalid/v1/", () => chat(TURN.model), TURN.model, "/v1/chat/completions"],
    ["claude", "https://proxy.invalid", () => messages(TURN.model), TURN.model, "/messages"],
    ["azure-foundry", "https://fixture.services.ai.azure.com/OPENAI/v1", () => responses("fixture-deployment"), "fixture-deployment", "/OPENAI/v1/responses"],
    ["azure-foundry", "https://fixture.openai.azure.com/openai/deployments/fixture-deployment/chat/completions?api-version=2024-10-21", () => responses("fixture-deployment"), "fixture-deployment", "/openai/v1/responses"],
    // Another product on the vendor's own host is a configured endpoint, not the vendor's API.
    ["openai", "https://api.openai.com/gateway/v1", () => chat(TURN.model), TURN.model, "/gateway/v1/chat/completions"],
    ["openrouter", "https://openrouter.ai/api/alpha/v1", () => chat(TURN.model), TURN.model, "/api/alpha/v1/chat/completions"],
  ] as const)("names a configured endpoint only by a keyed id of its setting: %s at %s", async (vendor, baseUrl, respond, model, sentPath) => {
    const transport = vi.fn<typeof fetch>(async () => respond());
    const events = await collect(new VercelUnifiedProvider(vendor, "fixture-key", baseUrl, transport, { getRetiredModelId: noRetirementEvidence }).streamTurn({ ...TURN, model }));
    expect(transport).toHaveBeenCalledOnce();
    // The installed SDK's own normalization of the address, pinned.
    const sent = requestUrl(transport.mock.calls[0]?.[0]);
    expect(sent.pathname).toBe(sentPath);
    expect(servedRoute(events)).toEqual({
      kind: "configured-endpoint", origin: sent.origin, configuredBaseId: configuredEndpointId(baseUrl),
    });
  });

  it("takes the answering address after a redirect, not the one the request was sent to", async () => {
    const entry = "https://entry.invalid/v1";
    const moved = vi.fn<typeof fetch>(async () => answeredFrom(chat(TURN.model), "https://serving.invalid/inference/chat/completions", true));
    expect(servedRoute(await collect(new VercelUnifiedProvider("openai", "fixture-key", entry, moved, { getRetiredModelId: noRetirementEvidence }).streamTurn(TURN))))
      .toEqual({ kind: "unknown", origin: "https://serving.invalid" });
    // A transport that followed a redirect and does not say where to establishes nothing.
    const hidden = vi.fn<typeof fetch>(async () => answeredFrom(chat(TURN.model), "", true));
    expect(servedRoute(await collect(new VercelUnifiedProvider("openai", "fixture-key", entry, hidden, { getRetiredModelId: noRetirementEvidence }).streamTurn(TURN))))
      .toEqual({ kind: "unknown" });
    // The same configured endpoint answering for itself.
    const direct = vi.fn<typeof fetch>(async () => answeredFrom(chat(TURN.model), `${entry}/chat/completions`));
    expect(servedRoute(await collect(new VercelUnifiedProvider("openai", "fixture-key", entry, direct, { getRetiredModelId: noRetirementEvidence }).streamTurn(TURN))))
      .toEqual({ kind: "configured-endpoint", origin: "https://entry.invalid", configuredBaseId: configuredEndpointId(entry) });
    // An answer from outside the configured endpoint establishes nothing, even from the vendor's own API.
    const handedOn = vi.fn<typeof fetch>(async () => answeredFrom(chat(TURN.model), "https://api.openai.com/v1/chat/completions", true));
    expect(servedRoute(await collect(new VercelUnifiedProvider("openai", "fixture-key", entry, handedOn, { getRetiredModelId: noRetirementEvidence }).streamTurn(TURN))))
      .toEqual({ kind: "unknown", origin: "https://api.openai.com" });
  });

  it.each([
    ["openai", "https://api.openai.com/v1/tenant-a", "https://api.openai.com/v1/tenant-b/chat/completions"],
    // A sibling whose name merely starts the same way is another path segment.
    ["openai", "https://api.openai.com/v1/tenant-a", "https://api.openai.com/v1/tenant-ab/chat/completions"],
    ["openai", "https://api.openai.com/v1/tenant-a", "https://api.openai.com/v1/chat/completions"],
    ["openai-compatible", "https://entry.invalid/v1/tenant-a", "https://entry.invalid/v1/tenant-b/chat/completions"],
  ] as const)("places nothing when %s configured at %s is answered from %s", async (vendor, baseUrl, answeredAt) => {
    const transport = vi.fn<typeof fetch>(async () => answeredFrom(chat(TURN.model), answeredAt, true));
    const events = await collect(new VercelUnifiedProvider(vendor, "fixture-key", baseUrl, transport, { getRetiredModelId: noRetirementEvidence }).streamTurn(TURN));
    expect(requestUrl(transport.mock.calls[0]?.[0]).href).toBe(`${baseUrl}/chat/completions`);
    expect(servedRoute(events)).toEqual({ kind: "unknown", origin: new URL(answeredAt).origin });
  });

  it("names the configured path when a vendor's own host answers from under it", async () => {
    const baseUrl = "https://api.openai.com/v1/tenant-a";
    const transport = vi.fn<typeof fetch>(async () => answeredFrom(chat(TURN.model), `${baseUrl}/chat/completions`));
    const events = await collect(new VercelUnifiedProvider("openai", "fixture-key", baseUrl, transport, { getRetiredModelId: noRetirementEvidence }).streamTurn(TURN));
    expect(servedRoute(events)).toEqual({
      kind: "vendor-native", base: "https://api.openai.com/v1", configuredBaseId: configuredEndpointId(baseUrl),
    });
  });

  it.each(["OPENAI_BASE_URL", "ANTHROPIC_BASE_URL"] as const)("sends nothing when %s is set but empty", async (variable) => {
    vi.stubEnv(variable, "");
    const runtimeFetch = vi.fn<typeof fetch>(async () => chat(TURN.model));
    vi.stubGlobal("fetch", runtimeFetch);
    const vendor = variable === "OPENAI_BASE_URL" ? "openai" : "claude";
    const events = await collect(new VercelUnifiedProvider(vendor, "fixture-key", undefined, undefined, { getRetiredModelId: noRetirementEvidence }).streamTurn(TURN));
    // The SDK rejects the empty override itself; the host never substitutes a default address for it.
    expect(runtimeFetch).not.toHaveBeenCalled();
    expect(events.map((event) => event.type)).toEqual(["error"]);
  });

  it("keeps each concurrent request's own evidence on one provider", async () => {
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const transport = vi.fn<typeof fetch>(async (input) => {
      const sent = requestUrl(input);
      if (!sent.pathname.includes("first-model")) return generated();
      await firstHeld;
      return answeredFrom(generated(), "https://elsewhere.invalid/moved", true);
    });
    const provider = new VercelUnifiedProvider("gemini", "fixture-key", undefined, transport, { getRetiredModelId: noRetirementEvidence });
    const first = collect(provider.streamTurn({ ...TURN, model: "first-model" }));
    const second = await collect(provider.streamTurn({ ...TURN, model: "second-model" }));
    releaseFirst();
    expect(servedRoute(second)).toEqual({ kind: "vendor-native", base: "https://generativelanguage.googleapis.com/v1beta" });
    expect(servedRoute(await first)).toEqual({ kind: "unknown", origin: "https://elsewhere.invalid" });
  });

  it("carries no part of the request address: a credential in the path, the user info or the query stays in the transport", async () => {
    const transport = vi.fn<typeof fetch>(async () => chat(TURN.model));
    const baseUrl = "https://user:fixture-user-secret@entry.invalid/gateway/fixture-path-credential/v1?key=fixture-query-secret";
    const provider = new VercelUnifiedProvider("openai-compatible", "fixture-key", baseUrl, transport, { getRetiredModelId: noRetirementEvidence });
    const events = await collect(provider.streamTurn(TURN));
    expect(transport).toHaveBeenCalledOnce();
    expect(requestUrl(transport.mock.calls[0]?.[0]).pathname).toContain("fixture-path-credential");
    expect(servedRoute(events)).toEqual({
      kind: "configured-endpoint", origin: "https://entry.invalid", configuredBaseId: configuredEndpointId(baseUrl),
    });
    const carried = JSON.stringify(events);
    for (const secret of ["fixture-path-credential", "fixture-user-secret", "fixture-query-secret", "/gateway/"]) {
      expect(carried).not.toContain(secret);
    }
  });

  it("names a setting under a key only this process holds", async () => {
    const baseUrl = "https://entry.invalid/gateway/fixture-path-credential/v1";
    const transport = vi.fn<typeof fetch>(async () => chat(TURN.model));
    const evidence = servedRoute(await collect(new VercelUnifiedProvider("openai-compatible", "fixture-key", baseUrl, transport, { getRetiredModelId: noRetirementEvidence }).streamTurn(TURN)));
    if (evidence?.kind !== "configured-endpoint") throw new Error(`Unexpected evidence: ${JSON.stringify(evidence)}`);
    const captured = evidence.configuredBaseId;
    // The process that produced it matches it again; that is all the query loop needs.
    expect(captured).toBe(configuredEndpointId(baseUrl));
    expect(captured).toBe(configuredEndpointId(` ${baseUrl} `));
    expect(captured).not.toBe(configuredEndpointId(baseUrl.replace("fixture-path-credential", "another-credential")));
    // Knowing the exact setting is not enough without the key: an unkeyed digest of it,
    // and the same setting named by another process's key, both miss.
    const { createHash } = await import("node:crypto");
    expect(captured).not.toBe(createHash("sha256").update(baseUrl).digest("hex"));
    const otherProcess = createConfiguredEndpointIdentifier();
    const anotherProcess = createConfiguredEndpointIdentifier();
    expect(otherProcess(baseUrl)).not.toBe(captured);
    expect(otherProcess(baseUrl)).not.toBe(anotherProcess(baseUrl));
    expect(otherProcess(baseUrl)).toBe(otherProcess(baseUrl));
    // The key is what decides the name: the same key names the same setting the same way.
    const key = randomBytes(32);
    expect(createConfiguredEndpointIdentifier(key)(baseUrl)).toBe(createConfiguredEndpointIdentifier(key)(baseUrl));
  });
});
