import { DEFAULT_APP_MODE, normalizeAppMode } from "../../../shared/initial-app-mode.js";
import type { AppMode } from "../MainToolbar.js";

/** Seed workspace mode from preload before paint to avoid a wrong-layout flash; use the work default when no prime exists. */
export function readInitialAppMode(): AppMode {
  if (typeof window === "undefined") return DEFAULT_APP_MODE;
  const raw = (window as { __aveInitialAppMode?: unknown }).__aveInitialAppMode;
  return normalizeAppMode(raw) ?? DEFAULT_APP_MODE;
}
