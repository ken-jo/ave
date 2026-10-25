/** Share one live location per home-card id, separate from per-mount model-context ids. Independent transcript and preview
 * homes remain separate instances; reviveCardIfAt must reject stale locations to prevent duplicate live bridges. */
import type { McpUiPayload } from "../../../mcp/types.js";

/** A location OTHER than the card's home mount — one single-occupant slot each, presented by its own component
 * (`McpAppPipPanel`, `McpAppFullscreenPanel`). */
export type McpAppAwaySlot = "pip" | "fullscreen";

/** Where a card's ONE live mount currently is. */
export type McpAppCardLocation =
  | { readonly kind: "inline" }
  | { readonly kind: "pip" }
  | { readonly kind: "fullscreen" };

/** A location other than home, as the location type — what `moveCard` accepts. */
export type McpAppAwayLocation = Exclude<McpAppCardLocation, { kind: "inline" }>;

/** The card's HOME location — the default for any id with no registry entry. */
const INLINE: McpAppCardLocation = { kind: "inline" };

/** What an AWAY mount needs to render on the home mount's behalf. */
export interface McpAppSlotOccupant {
  readonly cardId: string;
  readonly payload: McpUiPayload;
  readonly originSessionId: string;
}

interface CardRecord {
  location: McpAppCardLocation;
  payload: McpUiPayload;
  originSessionId: string;
}

// Module-level singletons — the whole point is that every mount (home + away) reads and writes the SAME map, never a
// per-mount copy.
const cards = new Map<string, CardRecord>();
const cardListeners = new Map<string, Set<() => void>>();
const slotListeners = new Map<McpAppAwaySlot, Set<() => void>>();

/** Cache each slot snapshot until occupancy changes; a fresh object per getSnapshot would cause infinite external-store
 * rerenders. */
const slotOccupantCache = new Map<McpAppAwaySlot, McpAppSlotOccupant | null>();

function isAwaySlot(kind: McpAppCardLocation["kind"]): kind is McpAppAwaySlot {
  return kind !== "inline";
}

function recomputeSlotOccupantCache(slot: McpAppAwaySlot): void {
  for (const [cardId, record] of cards) {
    if (record.location.kind === slot) {
      slotOccupantCache.set(slot, {
        cardId,
        payload: record.payload,
        originSessionId: record.originSessionId,
      });
      return;
    }
  }
  slotOccupantCache.set(slot, null);
}

function notifyCard(cardId: string): void {
  for (const listener of cardListeners.get(cardId) ?? []) listener();
}

function notifySlot(slot: McpAppAwaySlot): void {
  recomputeSlotOccupantCache(slot);
  for (const listener of slotListeners.get(slot) ?? []) listener();
}

/** Absent from the registry ⇒ `inline` — a card that has never left its home mount. */
export function getCardLocation(cardId: string): McpAppCardLocation {
  return cards.get(cardId)?.location ?? INLINE;
}

/** Subscribe to ONE card's location changes (a home mount's `useSyncExternalStore` source). */
export function subscribeCardLocation(cardId: string, listener: () => void): () => void {
  let set = cardListeners.get(cardId);
  if (!set) {
    set = new Set();
    cardListeners.set(cardId, set);
  }
  set.add(listener);
  return () => {
    set!.delete(listener);
    if (set!.size === 0) cardListeners.delete(cardId);
  };
}

/**
 * Who currently occupies `slot`, or `null` if nobody does. Single-occupant by design.
 * Returns the CACHED value (see `slotOccupantCache` above) — referentially stable
 * across calls until an actual occupancy change of that slot, which
 * `useSyncExternalStore` requires of a `getSnapshot` function.
 */
export function getSlotOccupant(slot: McpAppAwaySlot): McpAppSlotOccupant | null {
  return slotOccupantCache.get(slot) ?? null;
}

/** Subscribe to "who occupies `slot`" changes (that surface's ONE source). */
export function subscribeSlotOccupant(slot: McpAppAwaySlot, listener: () => void): () => void {
  let set = slotListeners.get(slot);
  if (!set) {
    set = new Set();
    slotListeners.set(slot, set);
  }
  set.add(listener);
  return () => {
    set!.delete(listener);
    if (set!.size === 0) slotListeners.delete(slot);
  };
}

/** Only live mounts move cards; taking an occupied away slot revives the evicted card at home instead of stranding it. */
export function moveCard(
  cardId: string,
  next: McpAppAwayLocation,
  content: { payload: McpUiPayload; originSessionId: string },
): void {
  const prevKind = cards.get(cardId)?.location.kind;

  for (const [otherId, record] of cards) {
    if (otherId !== cardId && record.location.kind === next.kind) {
      cards.delete(otherId);
      notifyCard(otherId);
    }
  }

  cards.set(cardId, { location: next, payload: content.payload, originSessionId: content.originSessionId });
  notifyCard(cardId);

  // The slot the card LEFT changes occupancy too (pip → fullscreen vacates pip), so
  // both ends of the move notify — never just the destination. The destination always
  // notifies: even a same-slot re-claim replaces the cached occupant's payload.
  if (prevKind !== undefined && isAwaySlot(prevKind) && prevKind !== next.kind) notifySlot(prevKind);
  notifySlot(next.kind);
}

/**
 * Send a card back to its home mount — GUARDED on `expected` (see the module doc for
 * why: this is what prevents the pip→fullscreen hazard). Returns whether the revive
 * actually applied; a caller that gets `false` must NOT assume its home mount is live
 * — the card is genuinely somewhere else now.
 */
export function reviveCardIfAt(
  cardId: string,
  expected: McpAppAwayLocation,
): boolean {
  const current = cards.get(cardId)?.location ?? INLINE;
  if (current.kind !== expected.kind) return false;
  cards.delete(cardId);
  notifyCard(cardId);
  notifySlot(expected.kind);
  return true;
}

/** Test-only: clear the module-level singletons so tests never leak into each other. */
export function __resetMcpAppCardLocationStoreForTests(): void {
  cards.clear();
  cardListeners.clear();
  slotListeners.clear();
  slotOccupantCache.clear();
}
