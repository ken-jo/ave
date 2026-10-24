import { describe, expect, it } from "vitest";
import {
  claudeBetaHeaders,
  claudeRequestShape,
  DEFAULT_LLM_OUTPUT_TOKEN_LIMIT,
  FALLBACK_CONTEXT_WINDOW,
  hostTpmDefault,
  MAX_CREDIBLE_CONTEXT_WINDOW,
} from "../model-host-policy.js";

describe("catalog request controls", () => {
  it("sends no inferred control for an unknown entry", () => {
    expect(claudeRequestShape(undefined)).toEqual({ adaptiveThinking: false, numericThinking: false, interleavedNumericThinking: false });
    expect(claudeBetaHeaders({ interleavedThinking: false })).toEqual([]);
  });

  it("uses an explicitly declared numeric budget even when effort is also offered", () => {
    expect(claudeRequestShape({ id: "opaque-deployment", limits: {}, reasoning: { supported: true, budgetTokens: { min: 1024 }, effort: ["low", "high"] } }))
      .toEqual({ adaptiveThinking: false, numericThinking: true, interleavedNumericThinking: false });
  });

  it("uses adaptive thinking for qualitative-only reasoning, independent of the id", () => {
    expect(claudeRequestShape({ id: "opaque-deployment", limits: {}, reasoning: { supported: true, effort: ["low", "high"] } }).adaptiveThinking).toBe(true);
    expect(claudeRequestShape({ id: "claude-sonnet-99", limits: {}, reasoning: { supported: false } }).adaptiveThinking).toBe(false);
  });

  it("requires an explicit interleaving declaration for the beta opt-in", () => {
    const model = { id: "opaque-deployment", limits: {}, reasoning: { supported: true, budgetTokens: {} } };
    expect(claudeRequestShape({ ...model, interleaved: true }).interleavedNumericThinking).toBe(true);
    expect(claudeRequestShape(model).interleavedNumericThinking).toBe(false);
    expect(claudeBetaHeaders({ interleavedThinking: true })).toEqual(["interleaved-thinking-2025-05-14"]);
  });
});

describe("host budget defaults", () => {
  it("pins the values the host owns", () => {
    expect(DEFAULT_LLM_OUTPUT_TOKEN_LIMIT).toBe(32_000);
    expect(FALLBACK_CONTEXT_WINDOW).toBe(128_000);
    expect(MAX_CREDIBLE_CONTEXT_WINDOW).toBe(4_000_000);
  });
});

describe("host TPM default", () => {
  it.each([
    ["openai", "gpt-5.4-mini"],
    ["openai", "gpt-5.4-nano"],
    ["openai", "GPT-5.4-Mini-2026-03-17"],
    ["azure-foundry", "gpt-5.4-nano"],
  ])("%s %s is throttled at 200K tokens per minute", (vendor, model) => {
    expect(hostTpmDefault(vendor, model)).toBe(200_000);
  });

  it.each([
    ["openai", "gpt-5.4"],
    ["openai", "gpt-4o-mini"],
    ["openai-compatible", "gpt-5.4-mini"],
    ["openrouter", "gpt-5.4-mini"],
    ["claude", "claude-sonnet-4-6"],
  ])("%s %s has none", (vendor, model) => {
    expect(hostTpmDefault(vendor, model)).toBeUndefined();
  });
});
