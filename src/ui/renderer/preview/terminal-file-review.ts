import { useSyncExternalStore } from "react";
import type { TerminalFileReviewSnapshot } from "../../../shared/terminal-file-review.js";

/** A request to show the changes view on `path`; `token` makes each click a new request. */
interface TerminalChangesReveal { readonly token: number; readonly path: string | null }
interface TerminalFileReviewState {
  /** The agent-changed files this terminal's commands used: the badge's count and the changes view's list. */
  readonly snapshot: TerminalFileReviewSnapshot | null;
  readonly changed: number;
  readonly refreshFailed: boolean;
  readonly reveal: TerminalChangesReveal | null;
}
const listeners = new Set<() => void>();
let snapshot: ReadonlyMap<string, TerminalFileReviewState> = new Map();
let revealTokens = 0;

function update(tabId: string, patch: Partial<Omit<TerminalFileReviewState, "changed">>): void {
  const previous = snapshot.get(tabId);
  const review = patch.snapshot !== undefined ? patch.snapshot : previous?.snapshot ?? null;
  const next: TerminalFileReviewState = {
    snapshot: review,
    changed: review?.files.length ?? 0,
    refreshFailed: patch.refreshFailed ?? previous?.refreshFailed ?? false,
    reveal: patch.reveal !== undefined ? patch.reveal : previous?.reveal ?? null,
  };
  if (previous && previous.snapshot === next.snapshot && previous.refreshFailed === next.refreshFailed && previous.reveal === next.reveal) return;
  snapshot = new Map(snapshot).set(tabId, next);
  for (const listener of [...listeners]) listener();
}

/** The latest evidence for a terminal and whether its last refresh failed; the badge and the changes view read it. */
export function publishTerminalFileReview(tabId: string, review: TerminalFileReviewSnapshot, refreshFailed = false): void {
  const previous = snapshot.get(tabId)?.snapshot;
  // An equal refresh keeps the same object, so views do not re-render on every poll.
  const same = previous !== undefined && previous !== null && JSON.stringify(previous) === JSON.stringify(review);
  update(tabId, { snapshot: same ? previous : review, refreshFailed });
}

export function publishTerminalFileReviewFailure(tabId: string): void {
  update(tabId, { refreshFailed: true });
}

/** Show this terminal's changes view, with `path` selected (the first changed file when null). */
export function requestTerminalFileReview(tabId: string, path: string | null = null): void {
  update(tabId, { reveal: { token: ++revealTokens, path } });
}

export function forgetTerminalFileReview(tabId: string): void {
  const observer = observers.get(tabId);
  if (observer) { stopObserver(observer); observers.delete(tabId); }
  if (!snapshot.has(tabId)) return;
  const next = new Map(snapshot);
  next.delete(tabId);
  snapshot = next;
  for (const listener of [...listeners]) listener();
}

/** Presentation state never admits terminal/file reads or grants permission. */
export function useTerminalFileReviewState(tabId: string): TerminalFileReviewState | undefined {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, () => snapshot.get(tabId));
}

interface TerminalReviewObserver {
  readonly api: import("../../../shared/terminal-session.js").TerminalApi;
  readonly session: import("../../../shared/terminal-session.js").TerminalSessionInfo;
  active: number;
  timer: ReturnType<typeof setInterval> | null;
  running: boolean;
}
const observers = new Map<string, TerminalReviewObserver>();
const INACTIVE_REVIEW_REFRESH_MS = 1500;

function stopObserver(observer: TerminalReviewObserver): void {
  if (observer.timer !== null) clearInterval(observer.timer);
  observer.timer = null;
}

/** An inactive tab still needs its changed-file badge. Mounted views own their richer refresh. */
export function observeTerminalFileReview(api: TerminalReviewObserver["api"], session: TerminalReviewObserver["session"]): () => void {
  let observer = observers.get(session.tabId);
  if (observer && (observer.api !== api || observer.session.terminalSessionId !== session.terminalSessionId)) {
    stopObserver(observer);
    observers.delete(session.tabId);
    observer = undefined;
  }
  if (!observer) {
    observer = { api, session, active: 0, timer: null, running: false };
    observers.set(session.tabId, observer);
  }
  observer.active++;
  stopObserver(observer);
  const current = observer;
  return () => {
    if (observers.get(session.tabId) !== current) return;
    current.active--;
    if (current.active > 0) return;
    const refresh = async () => {
      if (current.running || current.active > 0 || observers.get(session.tabId) !== current) return;
      current.running = true;
      try {
        const result = await current.api.listFileReviews(current.session);
        if (observers.get(session.tabId) !== current || current.active > 0) return;
        if (!result.ok) {
          forgetTerminalFileReview(session.tabId);
          return;
        }
        publishTerminalFileReview(session.tabId, result.snapshot);
      } catch {
        // A transport interruption leaves the last observed count; the next poll retries.
      } finally { current.running = false; }
    };
    current.timer = setInterval(() => { void refresh(); }, INACTIVE_REVIEW_REFRESH_MS);
  };
}

export function _clearTerminalFileReviewForTest(): void {
  for (const observer of observers.values()) stopObserver(observer);
  observers.clear();
  snapshot = new Map();
  for (const listener of [...listeners]) listener();
}
