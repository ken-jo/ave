/**
 * "Don't show again" for notices that repeat. The choice is a per-window-profile view preference, like the work board's
 * schedule toggle, so it lives in renderer storage rather than host settings. Only notices whose producer marks them
 * `suppressible` can be silenced; errors never are.
 */
const STORAGE_KEY = "ave.notices.suppressed";

function read(): Set<string> {
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (raw === null) return new Set();
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
    throw new Error(`[notices] ${STORAGE_KEY} is not a string array`);
  }
  return new Set(parsed);
}

export function isNoticeSuppressed(kind: string): boolean {
  return read().has(kind);
}

export function suppressNotice(kind: string): void {
  const kinds = read();
  kinds.add(kind);
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...kinds]));
}

/** Whether any notice kind is silenced, so the settings reset can say there is nothing to undo. */
export function hasSuppressedNotices(): boolean {
  return read().size > 0;
}

/** Undo every "Don't show again": the silenced kinds show again from the next notice on. */
export function clearSuppressedNotices(): void {
  window.localStorage.removeItem(STORAGE_KEY);
}
