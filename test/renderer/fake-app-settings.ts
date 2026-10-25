import { DEFAULT_SETTINGS } from "../../src/data/settings-defaults.js";
import type { AppSettings, DeepPartial } from "../../src/ui/renderer/types.js";
import { resolveActiveChatModel } from "../../src/shared/active-chat-model.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeDeep<T>(base: T, patch: DeepPartial<T>): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) return (patch === undefined ? base : patch) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    out[key] = isPlainObject(value) && isPlainObject(out[key]) ? mergeDeep(out[key], value) : value;
  }
  return out as T;
}

// Match the renderer settings response rather than main-only defaults; apply deep overrides.
export function fakeAppSettings(overrides: DeepPartial<AppSettings> = {}): AppSettings {
  const { a2aRemote: _mainOnly, ...stored } = structuredClone(DEFAULT_SETTINGS);
  const { activeChatModel: activeOverride, ...storedOverrides } = overrides;
  const merged = mergeDeep(stored, storedOverrides as DeepPartial<typeof stored>);
  return {
    ...merged,
    activeChatModel: (activeOverride as AppSettings["activeChatModel"] | undefined)
      ?? resolveActiveChatModel(merged.llm, true),
  };
}
