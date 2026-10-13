import { describe, expect, it } from "vitest";
import { CATALOG_PROVIDERS_BY_VENDOR } from "../provider-map.js";
import {
  MODELS_DEV_MODEL_FIELDS,
  normalizeModelsDevProviders,
  pruneModelsDevDocument,
} from "../normalize.js";

/** One provider with the given model records, keyed by their ids. */
function sourceWith(...models: Array<Record<string, unknown>>): Record<string, unknown> {
  return { alpha: { id: "alpha", npm: "x", env: ["X"], models: Object.fromEntries(models.map((model) => [model.id as string, model])) } };
}

function normalizeOne(model: Record<string, unknown>) {
  const { providers, diagnostics } = normalizeModelsDevProviders(sourceWith(model), ["alpha"]);
  return { model: providers.alpha?.models[model.id as string], diagnostics };
}

describe("normalizeModelsDevProviders", () => {
  it("does not retain a catalog row for a retired vendor", () => {
    expect(Object.hasOwn(CATALOG_PROVIDERS_BY_VENDOR, "copilot")).toBe(false);
  });
  it("keeps an unstated fact absent instead of filling it in", () => {
    const { model, diagnostics } = normalizeOne({ id: "modelone" });
    expect(model).toEqual({ id: "modelone", limits: {} });
    expect(diagnostics).toEqual([]);
  });

  it("maps every carried field to its catalog name", () => {
    const { model } = normalizeOne({
      id: "modelone",
      name: "Model One",
      family: "one",
      canonical_model_id: "lab/modelone",
      limit: { context: 200_000, input: 150_000, output: 64_000 },
      modalities: { input: ["text", "image"], output: ["text"] },
      attachment: true,
      tool_call: true,
      structured_output: false,
      temperature: true,
      reasoning: true,
      reasoning_options: [
        { type: "toggle" },
        { type: "effort", values: ["low", "medium", "high", null] },
        { type: "budget_tokens", min: 1024, max: 32_000 },
      ],
      interleaved: { field: "reasoning_content" },
      cost: { input: 3, output: 15, reasoning: 15, cache_read: 0.3, cache_write: 3.75 },
      status: "beta",
      release_date: "2026-01-02",
      description: "not carried",
    });
    expect(model).toEqual({
      id: "modelone",
      name: "Model One",
      family: "one",
      canonicalId: "lab/modelone",
      limits: { context: 200_000, input: 150_000, output: 64_000 },
      modalities: { input: ["text", "image"], output: ["text"] },
      attachment: true,
      toolCall: true,
      structuredOutput: false,
      temperature: true,
      reasoning: {
        supported: true,
        toggle: true,
        effort: ["low", "medium", "high"],
        budgetTokens: { min: 1024, max: 32_000 },
      },
      interleaved: { field: "reasoning_content" },
      cost: { input: 3, output: 15, reasoning: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      status: "beta",
      releaseDate: "2026-01-02",
    });
  });

  it("keeps a listed zero price, which is not a claim the model is free", () => {
    const { model } = normalizeOne({ id: "modelone", cost: { input: 0, output: 0 } });
    expect(model?.cost).toEqual({ input: 0, output: 0 });
  });

  it("reads a zero token limit as unstated", () => {
    const { model } = normalizeOne({ id: "modelone", limit: { context: 128_000, output: 0 } });
    expect(model?.limits).toEqual({ context: 128_000 });
  });

  it("drops a model whose limit or price is the wrong type, and says why", () => {
    for (const bad of [
      { id: "modelone", limit: { context: "200k" } },
      { id: "modelone", limit: { context: 1.5 } },
      { id: "modelone", limit: { context: -1 } },
      { id: "modelone", cost: { input: "3" } },
      { id: "modelone", modalities: { input: "text", output: ["text"] } },
      { id: "modelone", reasoning: "yes" },
      { id: "modelone", reasoning: true, reasoning_options: [{ type: "budget_tokens", min: "1" }] },
    ]) {
      const { model, diagnostics } = normalizeOne(bad);
      expect(model, JSON.stringify(bad)).toBeUndefined();
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({ provider: "alpha", model: "modelone" });
      expect(diagnostics[0]?.message).toMatch(/^model dropped: /);
    }
  });

  it("drops a model whose id is missing or differs from its key", () => {
    const { providers, diagnostics } = normalizeModelsDevProviders(
      { alpha: { models: { modelone: { id: "modeltwo" }, modelthree: { name: "x" } } } },
      ["alpha"],
    );
    expect(providers.alpha?.models).toEqual({});
    expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
      "model dropped: id does not match its key",
      "model dropped: id is missing",
    ]);
  });

  it("drops only the field when an enumerated value is new, keeping the model's limits", () => {
    const { model, diagnostics } = normalizeOne({
      id: "modelone",
      limit: { context: 400_000 },
      status: "preview",
      reasoning: true,
      reasoning_options: [{ type: "effort", values: ["low", "ultra"] }, { type: "dial" }],
      release_date: "sometime in 2026",
    });
    expect(model).toEqual({ id: "modelone", limits: { context: 400_000 }, reasoning: { supported: true, effort: ["low"] } });
    expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
      'reasoning_options[0].values: unknown effort "ultra" dropped',
      'reasoning_options[1]: unknown control "dial" dropped',
      'status "preview" dropped',
      "release_date dropped: release_date is not a short string",
    ]);
  });

  it("reads a dynamic budget minimum as no minimum", () => {
    const { model } = normalizeOne({ id: "modelone", reasoning: true, reasoning_options: [{ type: "budget_tokens", min: -1, max: 24_576 }] });
    expect(model?.reasoning?.budgetTokens).toEqual({ max: 24_576 });
  });

  it("carries prompt-size price tiers in ascending order and ignores other tier kinds", () => {
    const { model } = normalizeOne({
      id: "modelone",
      cost: {
        input: 2,
        output: 12,
        tiers: [
          { input: 6, output: 18, tier: { type: "context", size: 1_000_000 } },
          { input: 4, output: 18, cache_read: 0.4, tier: { type: "context", size: 200_000 } },
          { input: 1, tier: { type: "batch" } },
        ],
      },
    });
    expect(model?.cost).toEqual({
      input: 2,
      output: 12,
      tiers: [
        { afterInputTokens: 200_000, input: 4, output: 18, cacheRead: 0.4 },
        { afterInputTokens: 1_000_000, input: 6, output: 18 },
      ],
    });
  });

  it("reads the older over-200K form as a tier when no tiers are listed", () => {
    const { model } = normalizeOne({ id: "modelone", cost: { input: 3, output: 15, context_over_200k: { input: 6, output: 22.5 } } });
    expect(model?.cost?.tiers).toEqual([{ afterInputTokens: 200_000, input: 6, output: 22.5 }]);
  });

  it("reports a provider the document does not have instead of inventing one", () => {
    const { providers, diagnostics } = normalizeModelsDevProviders(sourceWith({ id: "modelone" }), ["alpha", "beta"]);
    expect(Object.keys(providers)).toEqual(["alpha"]);
    expect(diagnostics).toEqual([{ provider: "beta", message: "provider is missing or has no models" }]);
  });

  it("produces the same output whatever order the source lists providers and models in", () => {
    const forward = normalizeModelsDevProviders(
      { alpha: { models: { modelone: { id: "modelone" }, modeltwo: { id: "modeltwo" } } }, beta: { models: { modelthree: { id: "modelthree" } } } },
      ["beta", "alpha"],
    );
    const backward = normalizeModelsDevProviders(
      { beta: { models: { modelthree: { id: "modelthree" } } }, alpha: { models: { modeltwo: { id: "modeltwo" }, modelone: { id: "modelone" } } } },
      ["alpha", "beta"],
    );
    expect(JSON.stringify(forward)).toBe(JSON.stringify(backward));
  });

  it("refuses a document that is not an object", () => {
    expect(() => normalizeModelsDevProviders([], ["alpha"])).toThrow(/not an object/);
  });
});

describe("pruneModelsDevDocument", () => {
  it("keeps only the requested providers, their models, and the fields the normalizer reads", () => {
    const pruned = pruneModelsDevDocument(
      {
        ...sourceWith({ id: "modelone", limit: { context: 1 }, description: "dropped", benchmarks: [1], weights: "x" }),
        gamma: { models: { modelfour: { id: "modelfour" } } },
      },
      ["alpha"],
    );
    expect(pruned).toEqual({ alpha: { models: { modelone: { id: "modelone", limit: { context: 1 } } } } });
  });

  it("passes a malformed model through so the normalizer still reports it", () => {
    const pruned = pruneModelsDevDocument({ alpha: { models: { modelone: "bad" } } }, ["alpha"]);
    expect(pruned.alpha?.models.modelone).toBe("bad");
    expect(normalizeModelsDevProviders(pruned, ["alpha"]).diagnostics).toHaveLength(1);
  });

  it("does not change what the normalizer produces", () => {
    const source = sourceWith({ id: "modelone", limit: { context: 8 }, cost: { input: 1 }, links: {}, reasoning: false });
    expect(normalizeModelsDevProviders(pruneModelsDevDocument(source, ["alpha"]), ["alpha"])).toEqual(
      normalizeModelsDevProviders(source, ["alpha"]),
    );
    expect(MODELS_DEV_MODEL_FIELDS).toContain("limit");
  });
});
