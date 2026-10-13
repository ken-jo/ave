import { describe, expect, it } from "vitest";
import { claudeBetaHeaders, claudeRequestShape } from "../model-host-policy.js";

describe("request shape — Claude 1M beta header", () => {
  it.each([
    "claude-sonnet-4-6",
    "claude-opus-4-6",
    "Claude-Sonnet-4-6",
    "claude-sonnet-4-6-20260217",
    "claude-opus-4-6-latest",
  ])("%s needs the context-1m beta header", (model) => {
    expect(claudeRequestShape(model).context1MBeta).toBe(true);
  });

  it.each([
    "claude-sonnet-4-5",
    "claude-opus-4-7",
    "claude-opus-5-5",
    "claude-sonnet-5",
    "claude-3-5-sonnet-20241022",
    "claude-haiku-4-5",
    "claude-sonnet-4-20250514",
  ])("%s does not", (model) => {
    expect(claudeRequestShape(model).context1MBeta).toBe(false);
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
  it("joins the 1M opt-in before interleaved thinking", () => {
    expect(claudeBetaHeaders({ context1MBeta: true, interleavedThinking: true }))
      .toEqual(["context-1m-2025-08-07", "interleaved-thinking-2025-05-14"]);
    expect(claudeBetaHeaders({ context1MBeta: false, interleavedThinking: true }))
      .toEqual(["interleaved-thinking-2025-05-14"]);
    expect(claudeBetaHeaders({ context1MBeta: false, interleavedThinking: false })).toEqual([]);
  });
});
