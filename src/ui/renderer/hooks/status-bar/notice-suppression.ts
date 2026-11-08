/**
 * "Don't show again" for notices that repeat. The choice is a per-window-profile view preference, like the work board's
 * schedule toggle, so it lives in renderer storage rather than host settings. Only notices whose producer marks them
 * `suppressible` can be silenced; errors never are.
 */
const STORAGE_KEY = "ave.notices.suppressed";

/** Read the silenced kinds. The value is user-local state at an external boundary (another build, a hand edit, a cleared
 * profile can leave anything there), so an unreadable value has one deterministic recovery: warn with the key, drop it, and
 * continue with nothing silenced. Reading never throws into a notice producer. */
function read(): Set<string> {
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (raw === null) return new Set();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
    console.warn(`[notices] ${STORAGE_KEY} held an unreadable value; it was removed and no notice is silenced`);
    window.localStorage.removeItem(STORAGE_KEY);
    return new Set();
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
