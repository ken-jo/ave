import { afterEach, describe, it, expect } from "vitest";
import { activeModelCatalog, installModelCatalog } from "../../../shared/model-catalog/active.js";
import type { ModelCatalogDocument } from "../../../shared/model-catalog/types.js";
import {
  providerPackageSupportsReviewerAdapter,
  supportsVision,
  vendorSupportsLengthContinuation,
} from "../vendor-capabilities.js";

describe("supportsVision", () => {
  it("claude-sonnet-4-6 supports vision", () => {
    expect(supportsVision("claude", "claude-sonnet-4-6")).toBe(true);
  });

  it("o1-mini does NOT support vision", () => {
    expect(supportsVision("openai", "o1-mini")).toBe(false);
  });

  it("o3-mini does NOT support vision", () => {
    expect(supportsVision("openai", "o3-mini")).toBe(false);
  });

  it("gemini-2.5-flash supports vision", () => {
    expect(supportsVision("gemini", "gemini-2.5-flash")).toBe(true);
  });

  it("gpt-5 supports vision", () => {
    expect(supportsVision("openai", "gpt-5.4")).toBe(true);
  });

  it("gpt-3.5-turbo does NOT support vision", () => {
    expect(supportsVision("openai", "gpt-3.5-turbo")).toBe(false);
  });

  it("gpt-4o supports vision", () => {
    expect(supportsVision("openai", "gpt-4o")).toBe(true);
  });

  it("claude-2 (legacy) does NOT support vision", () => {
    expect(supportsVision("claude", "claude-2.1")).toBe(false);
  });

  it("empty model name returns false", () => {
    expect(supportsVision("claude", "")).toBe(false);
  });
});

describe("supportsVision — the model's stated input modalities decide", () => {
  const bundled = activeModelCatalog();
  afterEach(() => installModelCatalog(bundled));

  it.each([
    // [vendor, model, the catalog's answer] — each one the name rules got wrong.
    ["openai", "o3", true],
    ["openai", "o1", true],
    ["openai", "o4-mini", true],
    ["xai", "grok-4.20-0309-non-reasoning", true],
    ["openai", "gpt-4", false],
    ["zai-coding-plan", "glm-5.2", false],
  ] as const)("%s %s takes images: %s, as the catalog lists", (vendor, model, expected) => {
    expect(supportsVision(vendor, model)).toBe(expected);
  });

  it("follows the route's modalities, and the name rule when the route states none", () => {
    // The route said text only for a name the rules would let through.
    expect(supportsVision("openai", "gpt-4o", { inputModalities: { input: ["text"], source: "provider-reported" } })).toBe(false);
    expect(supportsVision("openai-compatible", "a-served-model", { inputModalities: { input: ["text", "image"], source: "provider-reported" } })).toBe(true);
    // A route with nothing stated is not re-resolved by name: the name rule decides
    // (the catalog lists gpt-4 as text only, the rule says images).
    expect(supportsVision("openai", "gpt-4", {})).toBe(true);
  });

  it("does not read a model that takes file attachments as taking images", () => {
    // The composer sends a file as a path the agent reads; `attachment` is not an image input.
    installModelCatalog({
      ...bundled,
      providers: {
        ...bundled.providers,
        openai: { models: { "gpt-4o": { id: "gpt-4o", limits: { context: 128_000 }, modalities: { input: ["text", "pdf"], output: ["text"] }, attachment: true } } },
      },
    } as ModelCatalogDocument);
    expect(supportsVision("openai", "gpt-4o")).toBe(false);
  });
});

describe("vendorSupportsLengthContinuation", () => {
  it("lights up for the self-hosted vLLM class (native continue_final_message)", () => {
    expect(vendorSupportsLengthContinuation("openai-compatible")).toBe(true);
    expect(vendorSupportsLengthContinuation("ollama")).toBe(true);
    expect(vendorSupportsLengthContinuation("lmstudio")).toBe(true);
    expect(vendorSupportsLengthContinuation("litellm")).toBe(true);
  });

  it("is OFF for commercial gateways and non-self-hosted vendors", () => {
    // Commercial OpenAI-compatible gateways do not honor continue_final_message.
    expect(vendorSupportsLengthContinuation("openrouter")).toBe(false);
    expect(vendorSupportsLengthContinuation("groq")).toBe(false);
    expect(vendorSupportsLengthContinuation("together")).toBe(false);
    expect(vendorSupportsLengthContinuation("openai")).toBe(false);
    expect(vendorSupportsLengthContinuation("claude")).toBe(false);
    expect(vendorSupportsLengthContinuation("gemini")).toBe(false);
  });
});

describe("providerPackageSupportsReviewerAdapter", () => {
  it("requires explicit package metadata opt-in", () => {
    expect(providerPackageSupportsReviewerAdapter(undefined)).toBe(false);
    expect(providerPackageSupportsReviewerAdapter({ capabilities: {} })).toBe(false);
    expect(providerPackageSupportsReviewerAdapter({
      capabilities: { reviewerAdapter: false },
    })).toBe(false);
    expect(providerPackageSupportsReviewerAdapter({
      capabilities: { reviewerAdapter: true },
    })).toBe(true);
  });
});
