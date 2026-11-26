import { promises as dns } from "node:dns";
import { embedMany } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import { sseResponse } from "../../../__tests__/support/sse-response.js";
import { collectAsyncIterable as collect } from "../../../__tests__/test-helpers.js";
import { createGuardedModelProviderFetch } from "../marketplace-provider-fetch.js";
import { declareDeferredSend, gateModelFetch } from "../model-wire-gate.js";
import { createEmbeddingModel, createProvider } from "../provider-factory.js";
import { findRetiredModelError, RetiredModelError } from "../retired-model-error.js";
import type { LLMVendor, ProviderConfig } from "../types.js";

const DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1";
const TURN = { systemPrompt: "sys", messages: [{ role: "user" as const, content: "hi" }] };

function completedChat(text: string): Response {
  return sseResponse([
    { id: "turn", choices: [{ index: 0, delta: { content: text }, finish_reason: null }] },
    { id: "turn", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ]);
}

function rateLimited(): Response {
  return Response.json({ error: { message: "Rate limit exceeded" } }, { status: 429, headers: { "retry-after-ms": "0" } });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("gateModelFetch", () => {
  it("sends while the route is available and refuses with the named error once it is retired", async () => {
    let retired: string | undefined;
    const send = vi.fn<typeof fetch>(async () => new Response("ok"));
    const gated = gateModelFetch(send, () => retired);

    await expect(gated("https://models.example.test/v1")).resolves.toBeInstanceOf(Response);
    retired = "model-x";
    const refusal = await gated("https://models.example.test/v1").catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(RetiredModelError);
    expect(refusal).toMatchObject({ name: "RetiredModelError", model: "model-x" });
    // A cause would be read by the SDK as a network failure and retried.
    expect((refusal as Error).cause).toBeUndefined();
    expect(send).toHaveBeenCalledOnce();
  });

  it("reads the ambient fetch per request when the transport was given none", async () => {
    const gated = gateModelFetch(undefined, () => undefined);
    const ambient = vi.fn<typeof fetch>(async () => new Response("ok"));
    vi.stubGlobal("fetch", ambient);

    await gated("https://models.example.test/v1");

    expect(ambient).toHaveBeenCalledOnce();
  });

  it("checks after a declared wait instead of before it", async () => {
    let retired: string | undefined;
    const send = vi.fn<typeof fetch>(async () => new Response("ok"));
    let releaseWait!: () => void;
    const wait = new Promise<void>((resolve) => { releaseWait = resolve; });
    const build = (inner: typeof fetch): typeof fetch => async (input, init) => {
      await wait;
      return inner(input, init);
    };
    const waiting = build(send);
    declareDeferredSend(waiting, (wrapSend) => build(wrapSend(send)));

    const pending = gateModelFetch(waiting, () => retired)("https://models.example.test/v1").catch((error: unknown) => error);
    retired = "model-x";
    releaseWait();

    expect(await pending).toBeInstanceOf(RetiredModelError);
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses a route that is already retired before the declared wait begins", async () => {
    const waited = vi.fn();
    const send = vi.fn<typeof fetch>(async () => new Response("ok"));
    const build = (inner: typeof fetch): typeof fetch => async (input, init) => {
      waited();
      return inner(input, init);
    };
    const waiting = build(send);
    declareDeferredSend(waiting, (wrapSend) => build(wrapSend(send)));

    const refusal = await gateModelFetch(waiting, () => "model-x")("https://models.example.test/v1").catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(RetiredModelError);
    expect(waited).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("finds the refusal inside the error an SDK builds after a retry", () => {
    const refusal = new RetiredModelError("model-x");
    const wrapped = Object.assign(new Error("Failed after 2 attempts"), { errors: [new Error("429"), refusal], lastError: refusal });

    expect(findRetiredModelError(wrapped)).toBe(refusal);
    expect(findRetiredModelError(new Error("outer", { cause: refusal }))).toBe(refusal);
    expect(findRetiredModelError(new Error("429"))).toBeUndefined();
  });
});

describe("model transports send through the retirement gate", () => {
  const ROUTES: readonly (Pick<ProviderConfig, "vendor" | "baseUrl" | "wire"> & { name: string })[] = [
    { name: "OpenAI Responses", vendor: "openai" },
    { name: "Anthropic Messages", vendor: "claude" },
    { name: "Gemini", vendor: "gemini" },
    { name: "OpenAI-compatible Chat Completions", vendor: "deepseek" as LLMVendor, baseUrl: DEEPSEEK_BASE_URL },
    { name: "Azure Foundry", vendor: "azure-foundry", baseUrl: "https://fixture.openai.azure.com/openai/v1" },
  ];

  it.each(ROUTES)("$name issues no request for a retired model", async ({ name: _name, ...route }) => {
    const wireFetch = vi.fn<typeof fetch>(async () => completedChat("unexpected"));
    vi.stubGlobal("fetch", wireFetch);
    const probed: string[] = [];
    const provider = createProvider({
      ...route,
      apiKey: "fixture-key",
      fetch: wireFetch,
      getRetiredModelId: (model) => {
        probed.push(model);
        return model;
      },
    });

    const outcome = await collect(provider.streamTurn({ ...TURN, model: "fixture-model" })).catch((error: unknown) => error);

    expect(outcome).toMatchObject({ name: "RetiredModelError", model: "fixture-model" });
    expect(outcome).toBeInstanceOf(RetiredModelError);
    // The probe is asked about the model that is on the wire, not one fixed at construction.
    expect(probed).toEqual(["fixture-model"]);
    expect(wireFetch).not.toHaveBeenCalled();
  });

  it.each([
    { name: "stops the SDK's own retry once the model retires during its backoff", retires: true, fetched: 1 },
    { name: "leaves the SDK's own retry alone while the model stays available", retires: false, fetched: 2 },
  ])("$name", async ({ retires, fetched }) => {
    let retired: string | undefined;
    const wireFetch = vi.fn<typeof fetch>()
      .mockImplementationOnce(async () => {
        if (retires) retired = "deepseek-v4-pro";
        return rateLimited();
      })
      .mockImplementation(async () => completedChat("recovered"));
    const provider = createProvider({
      vendor: "deepseek" as LLMVendor, apiKey: "fixture-key", baseUrl: DEEPSEEK_BASE_URL, fetch: wireFetch,
      getRetiredModelId: () => retired,
    });

    const outcome = await collect(provider.streamTurn({ ...TURN, model: "deepseek-v4-pro" })).catch((error: unknown) => error);

    expect(wireFetch).toHaveBeenCalledTimes(fetched);
    if (retires) {
      expect(outcome).toBeInstanceOf(RetiredModelError);
      expect(outcome).toMatchObject({ model: "deepseek-v4-pro" });
    } else {
      expect(outcome).toEqual(expect.arrayContaining([expect.objectContaining({ type: "text_delta", text: "recovered" })]));
    }
  });

  it.each([
    { name: "refuses a model retired while the guarded fetch validates the address", retires: true, sent: 0 },
    { name: "sends through the guarded fetch when nothing retires during address validation", retires: false, sent: 1 },
  ])("$name", async ({ retires, sent }) => {
    let retired: string | undefined;
    let releaseLookup!: () => void;
    const lookupStarted = new Promise<void>((started) => {
      vi.spyOn(dns, "lookup").mockImplementation((async () => {
        started();
        await new Promise<void>((release) => { releaseLookup = release; });
        return [{ address: "10.20.30.40", family: 4 }];
      }) as unknown as typeof dns.lookup);
    });
    const networkFetch = vi.fn<typeof fetch>(async () => completedChat("sent"));
    const baseUrl = "http://models.internal.test:8080/v1";
    // Credentialed cleartext is allowed only for this exact guarded fetch; the gate must not replace its identity.
    const provider = createProvider({
      vendor: "openai-compatible",
      apiKey: "fixture-key",
      baseUrl,
      fetch: createGuardedModelProviderFetch(baseUrl, networkFetch),
      getRetiredModelId: () => retired,
    });

    const pending = collect(provider.streamTurn({ ...TURN, model: "local-model" })).catch((error: unknown) => error);
    await lookupStarted;
    expect(networkFetch).not.toHaveBeenCalled();
    if (retires) retired = "local-model";
    releaseLookup();
    const outcome = await pending;

    expect(networkFetch).toHaveBeenCalledTimes(sent);
    if (retires) {
      expect(outcome).toBeInstanceOf(RetiredModelError);
    } else {
      expect(outcome).toEqual(expect.arrayContaining([expect.objectContaining({ type: "text_delta", text: "sent" })]));
    }
  });

  it("refuses to build a wire that has no retirement evidence", async () => {
    const { VercelUnifiedProvider } = await import("../vercel/adapter.js");
    type Extras = ConstructorParameters<typeof VercelUnifiedProvider>[4];

    expect(() => new VercelUnifiedProvider("openai", "fixture-key", undefined, undefined, {} as Extras))
      .toThrow("VercelUnifiedProvider requires getRetiredModelId");
    expect(() => new VercelUnifiedProvider("openai", "fixture-key", undefined, undefined, undefined as unknown as Extras))
      .toThrow("VercelUnifiedProvider requires getRetiredModelId");
  });

  it("gates an embedding transport the same way", async () => {
    const wireFetch = vi.fn<typeof fetch>(async () => Response.json({ data: [{ embedding: [0.1] }] }));
    const model = await createEmbeddingModel({
      vendor: "openai", apiKey: "fixture-key", fetch: wireFetch, getRetiredModelId: (modelId) => modelId,
    }, "fixture-embedding");

    const outcome = await embedMany({ model, values: ["text"], maxRetries: 0 }).catch((error: unknown) => error);

    expect(findRetiredModelError(outcome)).toMatchObject({ model: "fixture-embedding" });
    expect(wireFetch).not.toHaveBeenCalled();
  });
});
