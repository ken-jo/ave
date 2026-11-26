// This route requires project/location and service-account credentials rather than an API key.
import { describe, it, expect, vi } from "vitest";
import { collectStreamEvents as collect } from "./test-helpers.js";
import { noRetirementEvidence } from "../../model-wire-gate.js";

describe("VercelUnifiedProvider vertex-ai", () => {
  it("creates the Vertex client with project + default location", async () => {
    vi.resetModules();
    const modelFactory = vi.fn(() => ({ __mock: "vertex" }));
    const createVertexSpy = vi.fn(() => modelFactory);

    vi.doMock("ai", async () => {
      const actual = await vi.importActual<typeof import("ai")>("ai");
      return {
        ...actual,
        streamText: vi.fn(() => ({
          stream: (async function* () {
            yield { type: "text-delta", id: "t1", text: "ok" };
            yield {
              type: "finish",
              finishReason: "stop",
              totalUsage: { inputTokens: 1, outputTokens: 1 },
            };
          })(),
        })),
      };
    });
    vi.doMock("@ai-sdk/google-vertex", () => ({
      createVertex: createVertexSpy,
    }));

    const { VercelUnifiedProvider } = await import("../adapter.js");
    const provider = new VercelUnifiedProvider(
      "vertex-ai",
      "",
      undefined,
      undefined,
      { vertexProject: "my-proj", getRetiredModelId: noRetirementEvidence },
    );

    const events = await collect(
      provider.streamTurn({
        model: "gemini-2.5-flash",
        systemPrompt: "sys",
        messages: [{ role: "user", content: "hi" }],
      }),
    );

    expect(createVertexSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        project: "my-proj",
        location: "us-central1",
      }),
    );
    expect(modelFactory).toHaveBeenCalledWith("gemini-2.5-flash");
    expect(events.at(-1)?.type).toBe("message_complete");

    vi.doUnmock("ai");
    vi.doUnmock("@ai-sdk/google-vertex");
  });

  it("honors custom location override", async () => {
    vi.resetModules();
    const createVertexSpy = vi.fn(() => vi.fn(() => ({ __mock: "v" })));

    vi.doMock("ai", async () => {
      const actual = await vi.importActual<typeof import("ai")>("ai");
      return {
        ...actual,
        streamText: vi.fn(() => ({
          stream: (async function* () {
            yield {
              type: "finish",
              finishReason: "stop",
              totalUsage: { inputTokens: 0, outputTokens: 0 },
            };
          })(),
        })),
      };
    });
    vi.doMock("@ai-sdk/google-vertex", () => ({
      createVertex: createVertexSpy,
    }));

    const { VercelUnifiedProvider } = await import("../adapter.js");
    const provider = new VercelUnifiedProvider(
      "vertex-ai",
      "",
      undefined,
      undefined,
      { vertexProject: "p1", vertexLocation: "europe-west4", getRetiredModelId: noRetirementEvidence },
    );

    await collect(
      provider.streamTurn({
        model: "gemini-2.5-pro",
        systemPrompt: "sys",
        messages: [{ role: "user", content: "hi" }],
      }),
    );

    expect(createVertexSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        project: "p1",
        location: "europe-west4",
      }),
    );

    vi.doUnmock("ai");
    vi.doUnmock("@ai-sdk/google-vertex");
  });

  it("surfaces an error when project is missing (no env, no extras)", async () => {
    vi.resetModules();
    const prev = {
      GOOGLE_CLOUD_PROJECT: process.env.GOOGLE_CLOUD_PROJECT,
      GCLOUD_PROJECT: process.env.GCLOUD_PROJECT,
    };
    delete process.env.GOOGLE_CLOUD_PROJECT;
    delete process.env.GCLOUD_PROJECT;

    vi.doMock("ai", async () => {
      const actual = await vi.importActual<typeof import("ai")>("ai");
      return {
        ...actual,
        streamText: vi.fn(() => ({
          stream: (async function* () {  })(),
        })),
      };
    });
    vi.doMock("@ai-sdk/google-vertex", () => ({
      createVertex: vi.fn(() => vi.fn()),
    }));

    const { VercelUnifiedProvider } = await import("../adapter.js");
    const provider = new VercelUnifiedProvider("vertex-ai", "", undefined, undefined, { getRetiredModelId: noRetirementEvidence });

    const events = await collect(
      provider.streamTurn({
        model: "gemini-2.5-flash",
        systemPrompt: "sys",
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    expect(events.some((e) => e.type === "error")).toBe(true);

    if (prev.GOOGLE_CLOUD_PROJECT !== undefined) process.env.GOOGLE_CLOUD_PROJECT = prev.GOOGLE_CLOUD_PROJECT;
    if (prev.GCLOUD_PROJECT !== undefined) process.env.GCLOUD_PROJECT = prev.GCLOUD_PROJECT;
    vi.doUnmock("ai");
    vi.doUnmock("@ai-sdk/google-vertex");
  });

  it("hands the Vertex factory a fetch that refuses a retired model without sending", async () => {
    vi.resetModules();
    vi.doMock("ai", async () => {
      const actual = await vi.importActual<typeof import("ai")>("ai");
      return { ...actual, streamText: vi.fn(() => ({ stream: (async function* () {  })() })) };
    });
    const createVertex = vi.fn((_options: { fetch?: typeof fetch }) => vi.fn());
    vi.doMock("@ai-sdk/google-vertex", () => ({ createVertex }));
    try {
      const { VercelUnifiedProvider } = await import("../adapter.js");
      const { RetiredModelError } = await import("../../retired-model-error.js");
      const send = vi.fn<typeof fetch>(async () => new Response("ok"));
      const probed: string[] = [];
      let retired: string | undefined = "gemini-2.5-flash";
      const provider = new VercelUnifiedProvider("vertex-ai", "", undefined, send, {
        vertexProject: "fixture-project",
        getRetiredModelId: (model) => {
          probed.push(model);
          return retired;
        },
      });
      await collect(provider.streamTurn({ model: "gemini-2.5-flash", systemPrompt: "sys", messages: [{ role: "user", content: "hi" }] }));
      const wireFetch = createVertex.mock.calls[0]?.[0].fetch;
      if (!wireFetch) throw new Error("the Vertex factory was given no fetch");

      const refusal = await wireFetch("https://us-central1-aiplatform.googleapis.com/v1/fixture").catch((error: unknown) => error);

      expect(refusal).toBeInstanceOf(RetiredModelError);
      expect(refusal).toMatchObject({ model: "gemini-2.5-flash" });
      expect(probed).toEqual(["gemini-2.5-flash"]);
      expect(send).not.toHaveBeenCalled();
      // Control: the same fetch sends through the configured transport while the route is available.
      retired = undefined;
      await wireFetch("https://us-central1-aiplatform.googleapis.com/v1/fixture");
      expect(send).toHaveBeenCalledOnce();
    } finally {
      vi.doUnmock("ai");
      vi.doUnmock("@ai-sdk/google-vertex");
    }
  });

  it("is vercel-routed via factory", async () => {
    vi.resetModules();
    const { createProvider } = await import("../../provider-factory.js");
    const p = createProvider({ getRetiredModelId: noRetirementEvidence, vendor: "vertex-ai", apiKey: "", vertexProject: "p" });
    // Expose vendor identity synchronously while deferring adapter loading until first stream.
    expect(p.constructor.name).toBe("LazyVercelProvider");
    expect(p.vendor).toBe("vertex-ai");
  });
});
