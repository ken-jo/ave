import { resolveActiveChatModel } from "../../../../shared/active-chat-model.js";
import { describe, expect, it } from "vitest";
import { fakeLlmSettings } from "../../../../shared/__tests__/fake-llm-settings.js";
import { modelCardChoices } from "../use-settings.js";
import type { AppSettings } from "../../types.js";
import { fakeAppSettings } from "../../../../../test/renderer/fake-app-settings.js";

function llm(overrides: Partial<AppSettings["llm"]>): AppSettings["llm"] {
  return { ...fakeAppSettings({ llm: fakeLlmSettings({ provider: "openai", model: "gpt-5.4" }) }).llm, ...overrides };
}

function apiChoices(settings: AppSettings["llm"]) {
  return modelCardChoices(settings, resolveActiveChatModel(settings, true));
}

describe("modelCardChoices", () => {
  it.each([{ pinnedModels: [] }, { pinnedModels: ["gpt-5.4"] }])("offers the migrated model as an unresolved choice without duplicates: %j", ({ pinnedModels }) => {
    const choices = apiChoices(llm({ retiredProvider: "copilot", pinnedModels }));
    expect(choices).toEqual([
      expect.objectContaining({ vendor: "openai", modelId: "gpt-5.4", current: false }),
    ]);
  });

  it("does not offer a retired or deprecated model, saved or pinned (design §6.1)", () => {
    // o4-mini: deprecated in the bundled catalog. The deprecated tier sets no marker, and the saved model is still hidden from
    // the card.
    const deprecated = apiChoices(llm({
      vendors: { openai: { model: "o4-mini" } } as never,
      pinnedModels: ["o4-mini", "gpt-5.4"],
    }));
    expect(deprecated.map((c) => [c.modelId, c.current])).toEqual([["gpt-5.4", false]]);
    // The retired tier: the load's marker names a model the listing dropped.
    const marked = apiChoices(llm({
      retiredProvider: { vendor: "openai", model: "gpt-4o", reason: "unlisted" },
      vendors: { openai: { model: "gpt-4o" } } as never,
      pinnedModels: ["gpt-4o", "gpt-5.4"],
    }));
    expect(marked.map((c) => [c.modelId, c.current])).toEqual([["gpt-5.4", false]]);
    const listed = apiChoices(llm({
      pinnedModels: ["gpt-5.4-mini", "gpt-5.4"],
      modelListCache: {
        "openai\n\n": {
          vendor: "openai",
          endpoint: "https://api.openai.com/v1/models",
          models: ["gpt-5.4"],
          complete: true,
          fetchedAt: "2026-10-13T00:00:00.000Z",
        },
      },
    }));
    expect(listed.map((c) => c.modelId)).toEqual(["gpt-5.4"]);
  });

  it("keeps pinned order and drops a pin nothing offers", () => {
    const choices = apiChoices(llm({
      pinnedModels: ["nowhere", "gpt-5.4-mini", "gpt-5.4"],
    }));
    expect(choices.map((c) => c.modelId)).toEqual(["gpt-5.4-mini", "gpt-5.4"]);
  });

  it("checks a pinned model on the configured route even if an old endpoint still lists it", () => {
    const choices = apiChoices(llm({
      pinnedModels: ["gpt-4o"],
      modelListCache: {
        "openai\n\n": {
          vendor: "openai", endpoint: "https://api.openai.com/v1/models",
          models: ["gpt-5.4"], complete: true, fetchedAt: "2026-11-01T00:00:00Z",
        },
        "openai\nhttps://gateway.invalid/v1\n": {
          vendor: "openai", baseUrl: "https://gateway.invalid/v1", endpoint: "https://gateway.invalid/v1/models",
          models: ["gpt-4o"], fetchedAt: "2026-11-01T00:00:00Z",
        },
      },
    }));
    expect(choices).toEqual([expect.objectContaining({ modelId: "gpt-5.4", current: true })]);
  });

  it("leads with the current model when it is not pinned — even one no catalogue offers", () => {
    const choices = apiChoices(llm({ pinnedModels: ["gpt-5.4-mini"] }));
    expect(choices.map((c) => [c.modelId, c.current])).toEqual([["gpt-5.4", true], ["gpt-5.4-mini", false]]);
    const unlisted = apiChoices(llm({ pinnedModels: [], vendors: { openai: { model: "retired-model" } } as never }));
    expect(unlisted).toEqual([expect.objectContaining({ vendor: "openai", modelId: "retired-model", current: true })]);
  });

  it("resolves a pin through a synced catalogue to the vendor that serves it", () => {
    const choices = apiChoices(llm({
      pinnedModels: ["qwen3.8-27b-gguf"],
      modelListCache: {
        "openai-compatible\nhttp://llm.example.test/v1\n": {
          vendor: "openai-compatible",
          baseUrl: "http://llm.example.test/v1",
          endpoint: "http://llm.example.test/v1/models",
          models: ["qwen3.8-27b-gguf"],
          fetchedAt: "2026-08-27T00:00:00.000Z",
        },
      },
    }));
    expect(choices).toEqual([
      expect.objectContaining({ vendor: "openai", modelId: "gpt-5.4", current: true }),
      expect.objectContaining({ vendor: "openai-compatible", modelId: "qwen3.8-27b-gguf", current: false }),
    ]);
  });

  it("marks the model the chat is on, and only under its own vendor", () => {
    const choices = apiChoices(llm({ pinnedModels: ["gpt-5.4"] }));
    expect(choices).toEqual([expect.objectContaining({ vendor: "openai", current: true })]);
  });

  it("is the current model alone with no pins", () => {
    expect(apiChoices(llm({ pinnedModels: [] }))).toEqual([expect.objectContaining({ modelId: "gpt-5.4", current: true })]);
    expect(apiChoices(llm({}))).toEqual([expect.objectContaining({ modelId: "gpt-5.4", current: true })]);
  });

  it("checks the subscription provider, not the API model it happens to share settings with, while a subscription runtime is active", () => {
    const choices = modelCardChoices(llm({
      pinnedModels: ["gpt-5.4"],
      activeChatRuntime: { kind: "subscription", provider: "codex", model: "gpt-5.1-codex" },
    }), { kind: "subscription", provider: "codex", model: "gpt-5.1-codex" });
    expect(choices).toEqual([
      expect.objectContaining({ kind: "subscription", provider: "codex", vendorLabel: "ChatGPT", modelId: "gpt-5.1-codex", current: true }),
      expect.objectContaining({ kind: "api", vendor: "openai", modelId: "gpt-5.4", current: false }),
    ]);
  });

  it("names the subscription provider alone when the runtime has no model of its own", () => {
    const choices = modelCardChoices(llm({
      pinnedModels: [],
      activeChatRuntime: { kind: "subscription", provider: "kimi-code" },
    }), { kind: "subscription", provider: "kimi-code", model: null });
    expect(choices).toEqual([
      expect.objectContaining({ kind: "subscription", provider: "kimi-code", vendorLabel: "Kimi", modelId: null, current: true }),
    ]);
  });

  it.each(["codex", "unknown-runtime"])("leaves every model unchecked for an unavailable saved runtime (%s)", (provider) => {
    const choices = modelCardChoices(llm({
      pinnedModels: ["gpt-5.4"],
      activeChatRuntime: { kind: "subscription", provider } as never,
    }), { kind: "none", reason: "no-connected-provider" });
    expect(choices).toEqual([
      expect.objectContaining({ kind: "api", vendor: "openai", modelId: "gpt-5.4", current: false }),
    ]);
  });

  it("does not borrow a label or current marker for an invalid projected runtime", () => {
    const runtime = { kind: "subscription", provider: "unknown-runtime", model: null } as const;
    expect(modelCardChoices(llm({
      pinnedModels: ["gpt-5.4"],
      activeChatRuntime: runtime as never,
    }), runtime as never)).toEqual([
      expect.objectContaining({ kind: "api", vendor: "openai", modelId: "gpt-5.4", current: false }),
    ]);
  });
});
