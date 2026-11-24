import { describe, expect, it } from "vitest";
import {
  HARD_BYTES_CEILING,
  MAX_TOOL_RESULT_TOKENS,
  trimOversizedToolResult,
} from "../tool-result-trim.js";

describe("trimOversizedToolResult (Issue #902)", () => {
  it("passes small content unchanged (no truncated info)", () => {
    const result = trimOversizedToolResult("hello\nworld");
    expect(result.truncated).toBeUndefined();
  });

  it("passes content right at the token limit", () => {
    const lines = "x".repeat((MAX_TOOL_RESULT_TOKENS - 1) * 4);
    const result = trimOversizedToolResult(lines);
    expect(result.truncated).toBeUndefined();
  });

  it("keeps a small multiline snapshot within the token budget", () => {
    const lines = Array.from({ length: 220 }, (_, i) => `page outline element ${i}`).join("\n");
    expect(lines.length).toBeGreaterThan(5_000);
    expect(trimOversizedToolResult(lines).truncated).toBeUndefined();
  });

  it("trips truncated on single-line content above token limit (long-line shape)", () => {
    const oneLong = "x".repeat(12_000);
    const result = trimOversizedToolResult(oneLong);
    expect(result.truncated).toBeDefined();
    expect(result.truncated!.originalLines).toBe(1);
    expect(result.truncated!.originalTokens).toBeGreaterThan(MAX_TOOL_RESULT_TOKENS);
  });

  it("trimmedAt is a valid ISO timestamp", () => {
    const lines = "x".repeat(MAX_TOOL_RESULT_TOKENS * 4 + 1);
    const result = trimOversizedToolResult(lines);
    expect(result.truncated!.trimmedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(Number.isNaN(Date.parse(result.truncated!.trimmedAt))).toBe(false);
  });

  it("empty content passes unchanged", () => {
    const result = trimOversizedToolResult("");
    expect(result.truncated).toBeUndefined();
  });

  it("hard byte ceiling short-circuits exact scan with sentinel -1 counts", () => {
    const huge = "x".repeat(HARD_BYTES_CEILING + 1);
    const result = trimOversizedToolResult(huge);
    expect(result.truncated).toBeDefined();
    expect(result.truncated!.originalLines).toBe(-1);
    expect(result.truncated!.originalTokens).toBe(-1);
    expect(result.truncated!.originalBytes).toBe(huge.length);
  });
});
