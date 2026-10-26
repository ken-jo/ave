// Boot readers run before SettingsService exists. Missing, corrupt, or mistyped data returns undefined. Each caller owns its default; this shared parser
// must not invent one.
import { existsSync, readFileSync } from "node:fs";
import { settingsFilePath } from "../data/settings-store.js";

// Boot defaults on unreadable settings; the later asynchronous settings service reports parse errors with user-facing machinery.
export function readPersistedSystemSectionSync(
  userDataPath: string,
): Record<string, unknown> | undefined {
  const settingsPath = settingsFilePath(userDataPath);
  if (!existsSync(settingsPath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
    const system = parsed.system;
    return typeof system === "object" && system !== null
      ? (system as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

// A `system.<key>` boolean, or `undefined` when it is absent or not a boolean.
export function readPersistedSystemBooleanSync(
  userDataPath: string,
  key: string,
): boolean | undefined {
  const value = readPersistedSystemSectionSync(userDataPath)?.[key];
  return typeof value === "boolean" ? value : undefined;
}

// A `system.<key>` string, or `undefined` when it is absent, not a string, or blank. Blank counts as absent: a text field the user emptied is a field
// they left to the default, not an instruction to search for the empty name.
export function readPersistedSystemStringSync(
  userDataPath: string,
  key: string,
): string | undefined {
  const value = readPersistedSystemSectionSync(userDataPath)?.[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}
