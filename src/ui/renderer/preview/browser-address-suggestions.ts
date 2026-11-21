/**
 * Addresses the row offers while the user types, taken only from this device: the user's bookmarks and the user's own
 * history. Nothing is sent anywhere, and the agent's visits are not the user's and are never offered.
 */
import type { BrowserWorkspaceState } from "../../../shared/browser-workspace.js";

export interface BrowserAddressSuggestion { readonly url: string; readonly title: string; readonly source: "bookmark" | "history" }
export const BROWSER_ADDRESS_SUGGESTION_LIMIT = 6;

/** An address as a person types it: no scheme, no leading "www.". */
const typed = (url: string): string => url.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "");

export function browserAddressSuggestions(state: Pick<BrowserWorkspaceState, "bookmarks" | "history"> | null, text: string): BrowserAddressSuggestion[] {
  const needle = text.trim().toLowerCase();
  if (!state || needle === "") return [];
  const bare = typed(needle);
  const candidates: BrowserAddressSuggestion[] = [
    ...state.bookmarks.map((entry) => ({ url: entry.url, title: entry.title, source: "bookmark" as const })),
    ...state.history.filter((entry) => entry.by === "user").map((entry) => ({ url: entry.url, title: entry.title, source: "history" as const })),
  ];
  const seen = new Set<string>();
  const ranked: { suggestion: BrowserAddressSuggestion; rank: number; order: number }[] = [];
  candidates.forEach((suggestion, order) => {
    if (seen.has(suggestion.url)) return;
    const address = typed(suggestion.url);
    // An address that begins with what was typed comes before one that merely contains it, and that before a title match.
    const rank = bare !== "" && address.startsWith(bare) ? 0 : bare !== "" && address.includes(bare) ? 1 : suggestion.title.toLowerCase().includes(needle) ? 2 : -1;
    if (rank < 0) return;
    seen.add(suggestion.url);
    ranked.push({ suggestion, rank, order });
  });
  return ranked.sort((left, right) => left.rank - right.rank || left.order - right.order).slice(0, BROWSER_ADDRESS_SUGGESTION_LIMIT).map((entry) => entry.suggestion);
}
