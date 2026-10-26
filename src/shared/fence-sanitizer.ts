/** Fence tags are host-owned constants; each builder must neutralize untrusted text so it cannot escape provenance. */

export type FenceTag =
  | "app-message"
  | "imported-from-proactive"
  | "mcp-app-context"
  | "ave-mcp-server-guidance"
  | "mcp-prompt"
  | "plugin-prompt"
  | "ave-user-preferences"
  | "ave-memory-index"
  | "ave-user-memory"
  | "ave-preference-source"
  | "ave-agents-merge-source"
  | "ave-memory-consolidation-source"
  | "ave-long-term-memory-overview"
  | "ave-parent-directive"
  | "prior-context-summary"
  | "compact-focus"
  | "mcp-resource"
  | "web-content"
  | "terminal-output"
  | "browser-content";

/** Match case and spacing variants without requiring > or bounding trailing junk; both alternatives create escape or quadratic-scan risks. Preserve spelling and intentionally over-escape hyphenated siblings. */
export function neutralizeFenceClose(text: string, tag: FenceTag): string {
  return text.replace(
    new RegExp(`<\\s*/\\s*${tag}\\b`, "gi"),
    (match) => `<\\${match.slice(1)}`,
  );
}

/** Neutralize opening tags only where frame count is security-relevant, preventing forged frames from exhausting attachment budgets. */
export function neutralizeFenceOpen(text: string, tag: FenceTag): string {
  return text.replace(new RegExp(`<\\s*${tag}\\b`, "gi"), (match) => `<\\${match.slice(1)}`);
}

/** Strip quotes, angle brackets, and line structure from external attributes so they cannot forge host framing; validate closed identifiers instead. */
export function fenceAttrValue(value: string, maxChars: number): string {
  return value.slice(0, maxChars).replace(/["<>]/g, "").replace(/\s+/g, " ").trim();
}
