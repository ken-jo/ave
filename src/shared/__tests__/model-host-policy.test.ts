import { describe, expect, it } from "vitest";
import {
  claudeBetaHeaders,
  claudeRequestShape,
  DEFAULT_LLM_OUTPUT_TOKEN_LIMIT,
  FALLBACK_CONTEXT_WINDOW,
  hostTpmDefault,
  MAX_CREDIBLE_CONTEXT_WINDOW,
} from "../model-host-policy.js";

describe("request shape — Claude 1M window", () => {
  it.each([
    "claude-sonnet-4-6",
    "claude-opus-4-6",
    "claude-sonnet-4-6-20260217",
    "claude-opus-5-5",
    "claude-sonnet-4-5",
  ])("%s asks for no context-1m beta header (1M is the default where a model has it)", (model) => {
    expect(claudeRequestShape(model)).not.toHaveProperty("context1MBeta");
    expect(claudeBetaHeaders({ interleavedThinking: false })).toEqual([]);
  });
});

describe("request shape — interleaved numeric thinking", () => {
  it.each([
    "claude-opus-4",
    "claude-opus-4-0",
    "claude-opus-4-1",
    "claude-opus-4-5",
    "claude-sonnet-4",
    "claude-sonnet-4-0",
    "claude-sonnet-4-5",
    "claude-sonnet-4-20250514",
    "claude-opus-4-1-20250805",
    "claude-sonnet-4-5-latest",
    "CLAUDE-OPUS-4-5",
  ])("%s supports a budget across tool calls", (model) => {
    expect(claudeRequestShape(model).interleavedNumericThinking).toBe(true);
  });

  it.each([
    "claude-sonnet-4-1",
    "claude-sonnet-4-6",
    "claude-opus-4-6",
    "claude-haiku-4-5",
    "claude-3-7-sonnet-20250219",
    "claude-opus-4-5-preview",
  ])("%s does not", (model) => {
    expect(claudeRequestShape(model).interleavedNumericThinking).toBe(false);
  });
});

describe("request shape — beta header values", () => {
  it("carries interleaved thinking only when the request asks for it", () => {
    expect(claudeBetaHeaders({ interleavedThinking: true })).toEqual(["interleaved-thinking-2025-05-14"]);
    expect(claudeBetaHeaders({ interleavedThinking: false })).toEqual([]);
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
