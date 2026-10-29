import { useSyncExternalStore } from "react";

interface TerminalFileReviewState { readonly pending: number; readonly requested: boolean; readonly refreshFailed: boolean }
const listeners = new Set<() => void>();
let snapshot: ReadonlyMap<string, TerminalFileReviewState> = new Map();

function update(tabId: string, state: TerminalFileReviewState): void {
  const previous = snapshot.get(tabId);
  if (previous?.pending === state.pending && previous.requested === state.requested && previous.refreshFailed === state.refreshFailed) return;
  snapshot = new Map(snapshot).set(tabId, state);
  for (const listener of [...listeners]) listener();
}

/** The mounted view's pending count and whether its last refresh failed; the header badge is their only display. */
export function publishTerminalFileReview(tabId: string, pending: number, refreshFailed = false): void {
  update(tabId, { pending, requested: snapshot.get(tabId)?.requested ?? false, refreshFailed });
}

export function requestTerminalFileReview(tabId: string): void {
  const previous = snapshot.get(tabId);
  update(tabId, { pending: previous?.pending ?? 0, requested: true, refreshFailed: previous?.refreshFailed ?? false });
}

export function consumeTerminalFileReviewRequest(tabId: string): void {
  const previous = snapshot.get(tabId);
  update(tabId, { pending: previous?.pending ?? 0, requested: false, refreshFailed: previous?.refreshFailed ?? false });
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

/** Presentation summaries never admit terminal/file reads or grant permission. */
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

/** An inactive tab still needs its hash-based badge. Mounted views own their richer refresh. */
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
        publishTerminalFileReview(session.tabId, result.snapshot.files.filter((file) => !file.reviewed).length);
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
