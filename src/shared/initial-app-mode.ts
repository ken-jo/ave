/** Prime mode through additionalArguments so the first renderer frame uses the saved layout. */

export const INITIAL_APP_MODE_ARG_PREFIX = "--ave-initial-app-mode=";

/** Share the mode value set across main, preload, and renderer. */
export type InitialAppMode = "chat" | "work";

/** Normalize legacy persisted values only at boundaries; internals use work. */
const LEGACY_ACTION_APP_MODE = "action";

/** First-run default keeps the workspace expanded. */
export const DEFAULT_APP_MODE: InitialAppMode = "work";

export function normalizeAppMode(value: unknown): InitialAppMode | null {
  if (value === "chat" || value === "work") return value;
  if (value === LEGACY_ACTION_APP_MODE) return "work";
  return null;
}
