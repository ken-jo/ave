/** Measure and mark oversized results without changing in-memory content; wire serialization bounds previews and session saves use stubs plus artifacts. */

import { estimateTokens } from "./token-estimate.js";

export const MAX_TOOL_RESULT_LINES = 100;

export const MAX_TOOL_RESULT_TOKENS = 2_000;

/** Skip exact scans above the byte ceiling so adversarial payloads cannot monopolize the event loop. */
export const HARD_BYTES_CEILING = 50_000_000;

/** Undefined truncated means no metadata marking is needed. */
export interface TrimmedToolResult {
  truncated?: {
    originalLines: number;
    originalTokens: number;
    originalBytes: number;
    trimmedAt: string;
  };
}

export function trimOversizedToolResult(content: string): TrimmedToolResult {
  // Use originalLines:-1 to signal that the hard byte ceiling skipped exact scanning.
  if (content.length > HARD_BYTES_CEILING) {
    return {
      truncated: {
        originalLines: -1,
        originalTokens: -1,
        originalBytes: content.length,
        trimmedAt: new Date().toISOString(),
      },
    };
  }
  const originalLines = countLines(content);
  if (originalLines <= MAX_TOOL_RESULT_LINES) {
    const originalTokens = estimateTokens(content);
    if (originalTokens <= MAX_TOOL_RESULT_TOKENS) {
      return {};
    }
    return {
      truncated: {
        originalLines,
        originalTokens,
        originalBytes: content.length,
        trimmedAt: new Date().toISOString(),
      },
    };
  }
  return {
    truncated: {
      originalLines,
      originalTokens: estimateTokens(content),
      originalBytes: content.length,
      trimmedAt: new Date().toISOString(),
    },
  };
}

export function countLines(s: string): number {
  if (s.length === 0) return 0;
  let count = 1;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 10) count++;
  }
  return count;
}
