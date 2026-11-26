import { embedMany } from "ai";
import { afterAll, expect, it, vi } from "vitest";
import { collectAsyncIterable } from "../../../__tests__/test-helpers.js";
import { createEmbeddingModel, createVercelTransport } from "../provider-factory.js";
import { findRetiredModelError, RetiredModelError } from "../retired-model-error.js";
import type { ProviderConfig } from "../types.js";

// Keep the installed factory and model dispatch. Replace credential lookup so the case is offline.
vi.mock("@ai-sdk/google-vertex", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ai-sdk/google-vertex")>();
  const authClient = { getAccessToken: async () => ({ token: "fixture-token" }) };
  return {
    ...actual,
    createVertex: (options: Parameters<typeof actual.createVertex>[0]) =>
      actual.createVertex({ ...options, googleAuthOptions: { authClient: authClient as never } }),
  };
});

type Route = {
  label: string;
  kind: "language" | "embedding";
  config: Pick<ProviderConfig, "vendor" | "baseUrl" | "openaiWire" | "vertexProject">;
};

const AZURE_BASE_URL = "https://fixture.openai.azure.com/openai/v1";
const COMPATIBLE_BASE_URL = "https://models.example.test/v1";
const MODEL_ID = "fixture-model";
const ROUTES: readonly Route[] = [
  { label: "Chat Completions", kind: "language", config: { vendor: "openai" } },
  { label: "Responses", kind: "language", config: { vendor: "openai", openaiWire: "responses" } },
  { label: "Messages", kind: "language", config: { vendor: "claude" } },
  { label: "Generative Language", kind: "language", config: { vendor: "gemini" } },
  { label: "Compatible Chat Completions", kind: "language", config: { vendor: "openai-compatible", baseUrl: COMPATIBLE_BASE_URL } },
  { label: "Hosted Responses", kind: "language", config: { vendor: "azure-foundry", baseUrl: AZURE_BASE_URL } },
  { label: "Cloud Generative Language", kind: "language", config: { vendor: "vertex-ai", vertexProject: "fixture-project" } },
  { label: "Embeddings", kind: "embedding", config: { vendor: "openai" } },
  { label: "Generative Language embeddings", kind: "embedding", config: { vendor: "gemini" } },
  { label: "Hosted embeddings", kind: "embedding", config: { vendor: "azure-foundry", baseUrl: AZURE_BASE_URL } },
  { label: "Compatible embeddings", kind: "embedding", config: { vendor: "openai-compatible", baseUrl: COMPATIBLE_BASE_URL } },
];

// Keep one spy while the lazy adapter is cached across cases.
const ambientFetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected global fetch"));
afterAll(() => ambientFetch.mockRestore());

it.each(ROUTES)("$label refuses a retired model before either fetch can send", async ({ kind, config: route }) => {
  ambientFetch.mockClear();
  const transport = vi.fn<typeof fetch>().mockRejectedValue(new Error("Unexpected transport call"));
  const getRetiredModelId = vi.fn((modelId: string) => modelId === MODEL_ID ? MODEL_ID : undefined);
  const config: ProviderConfig = { ...route, apiKey: "fixture-key", fetch: transport, getRetiredModelId };

  let call: Promise<unknown>;
  if (kind === "embedding") {
    const model = await createEmbeddingModel(config, MODEL_ID);
    call = embedMany({ model, values: ["text"], maxRetries: 0 });
  } else {
    const provider = createVercelTransport(config);
    call = collectAsyncIterable(provider.streamTurn({
      model: MODEL_ID,
      systemPrompt: "sys",
      messages: [{ role: "user", content: "hi" }],
    }));
  }

  const outcome = await call.catch((error: unknown) => error);
  expect(transport).not.toHaveBeenCalled();
  expect(ambientFetch).not.toHaveBeenCalled();
  expect(getRetiredModelId.mock.calls).toEqual([[MODEL_ID]]);
  const refusal = findRetiredModelError(outcome);
  expect(refusal).toBeInstanceOf(RetiredModelError);
  expect(refusal).toMatchObject({ model: MODEL_ID });
});
