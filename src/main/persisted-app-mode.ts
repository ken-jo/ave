// Read persisted mode before asynchronous settings initialization so the first window has the correct size and mode.
import { readPersistedSystemSectionSync } from "./persisted-settings-sync.js";
import { DEFAULT_APP_MODE, normalizeAppMode, type InitialAppMode } from "../shared/initial-app-mode.js";

// Missing or invalid values use the default; legacy action mode normalizes to work.
export function readPersistedAppModeSync(userDataPath: string): InitialAppMode {
  const mode = readPersistedSystemSectionSync(userDataPath)?.appMode;
  return normalizeAppMode(mode) ?? DEFAULT_APP_MODE;
}
