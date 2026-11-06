// Reject slash-command prefixes in suggested replies; keep dismissal latched for the turn until a new user message. See
// docs/architecture/proposals/suggested-replies-ghost-text.md.
import { useEffect, useSyncExternalStore } from "react";
import { getApi } from "../api-client.js";

export interface SuggestedRepliesSnapshot {
  /** The one suggested next input, rendered as ghost text. */
  text: string | null;
  isDismissed: boolean;
}

const EMPTY_SNAPSHOT: SuggestedRepliesSnapshot = {
  text: null,
  isDismissed: false,
};

// A suggestion matching this pattern is dropped before it reaches the store.
// Spec §10 / #980 intent = drop LLM-generated executable command payloads
// even when they are single-token host commands (`/clear`, `/help`, `!ls`)
// because Tab-accept fills the composer and the next Enter can execute it
// unintentionally. `$` is limited to env-assignment shape so natural
// currency/prose suggestions are not silently removed.
const COMMAND_PREFIX_PATTERN = /^(?:\/\S*|!\S*|\$[A-Za-z_][A-Za-z0-9_]*=)/;

// Module-level store — single source of truth for all subscribers. Reset to
// `EMPTY_SNAPSHOT` on every empty push so React's `Object.is` snapshot check
// correctly skips renders when nothing changed (object identity stable
// across pushes that yield no reply).
let snapshot: SuggestedRepliesSnapshot = EMPTY_SNAPSHOT;
const subscribers = new Set<() => void>();

// Dismiss-memory: when the user hits Escape, we latch a flag so any
// subsequent push *within the same turn* (rare but possible — e.g. a plugin
// re-emit) keeps the snapshot dismissed. `clearDismissedReplies()` is called
// by the Composer when the user sends a new message, releasing the latch so
// the next turn's suggestion renders fresh.
let dismissLatch = false;

function notify(): void {
  for (const cb of subscribers) cb();
}

function subscribe(cb: () => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

function getSnapshot(): SuggestedRepliesSnapshot {
  return snapshot;
}

function sanitizeReply(reply: unknown): string | null {
  if (typeof reply !== "string") return null;
  const trimmed = reply.trim();
  if (trimmed.length === 0 || COMMAND_PREFIX_PATTERN.test(trimmed)) return null;
  return reply;
}

export function pushSuggestedReply(reply: string | null): void {
  // Command filter runs *before* the empty-check so a command-prefixed reply correctly collapses to "no suggestion".
  const text = sanitizeReply(reply);

  if (text === null) {
    if (snapshot === EMPTY_SNAPSHOT) return;
    snapshot = EMPTY_SNAPSHOT;
    notify();
    return;
  }

  // Dismiss-memory: if the latch is set, the new push remains dismissed so the user's prior Escape decision is honored
  // across the (rare) intra-turn re-push. `clearDismissedReplies()` releases the latch.
  snapshot = {
    text,
    isDismissed: dismissLatch,
  };
  notify();
}

export function dismissSuggestedReplies(): void {
  if (snapshot.isDismissed) return;
  if (snapshot.text === null) return;
  snapshot = { ...snapshot, isDismissed: true };
  dismissLatch = true;

  notify();
}

/**
 * Reset the dismiss latch. Called by the Composer
 * when the user sends a new message — at that point the prior turn is over
 * and the next push (next turn) should render fresh.
 *
 * Idempotent. Safe to call when nothing is dismissed.
 */
export function clearDismissedReplies(): void {
  dismissLatch = false;
}

export function acceptSuggestedReply(): void {
  if (snapshot === EMPTY_SNAPSHOT) return;

  snapshot = EMPTY_SNAPSHOT;
  // Accept also releases the dismiss latch — the snapshot was consumed, so the next push should render fresh regardless of
  // any prior Escape.
  dismissLatch = false;
  notify();
}

/** Clear singleton suggestions on session replacement or rewind. */
export function resetSuggestedReplies(): void {
  dismissLatch = false;
  if (snapshot === EMPTY_SNAPSHOT) return;
  snapshot = EMPTY_SNAPSHOT;
  notify();
}

// Test-only: reset between cases.
export function __resetSuggestedRepliesStoreForTests(): void {
  snapshot = EMPTY_SNAPSHOT;
  dismissLatch = false;
}

let ipcWired = false;
let ipcUnsub: (() => void) | null = null;

/**
 * Wire renderer IPC listener exactly once per process. Idempotent — multiple
 * `useSuggestedReplies` consumers share the same subscription, and the
 * subscription is never torn down because the store outlives any individual
 * view (Composer remount during chat session change must not lose the reply).
 */
function ensureIpcWired(): void {
  if (ipcWired) return;
  try {
    const api = getApi();
    ipcUnsub = api.onChatStream((ev) => {
      if (ev.type !== "suggested_replies") return;
      const reply = (ev as { reply?: unknown }).reply;
      pushSuggestedReply(typeof reply === "string" ? reply : null);
    });
    // Only mark wired after successful subscription — if getApi() / onChatStream
    // throws, leave `ipcWired = false` so the next consumer can retry once the
    // bridge is available (e.g. SSR-then-hydrate, or test that wires the stub
    // after first render).
    ipcWired = true;
  } catch {
    ipcUnsub = null;
  }
}

// Test-only: detach the IPC listener and re-arm for the next ensure call.
export function __teardownSuggestedRepliesIpcForTests(): void {
  if (ipcUnsub) {
    ipcUnsub();
    ipcUnsub = null;
  }
  ipcWired = false;
}

export function useSuggestedReplies(): SuggestedRepliesSnapshot {
  useEffect(() => {
    ensureIpcWired();
  }, []);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

// Dispose hot-reloaded IPC subscriptions so old closures cannot duplicate events; narrow import.meta.hot locally.
const hot = (import.meta as { hot?: { dispose: (cb: () => void) => void } }).hot;
if (hot) {
  hot.dispose(() => {
    __teardownSuggestedRepliesIpcForTests();
  });
}
