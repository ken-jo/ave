/** Publish allow-listed preference changes so synchronous child-process snapshots stay current. */
import { emitAppPreferenceChange } from "../../../plugins/config-change-bus.js";
import type { SettingsService } from "../../../data/settings-store.js";

/** Public preference keys must exclude secrets and host-private state; the reader switch is exhaustive. */
export const HOST_PUBLIC_PREFERENCE_KEYS = [
  "webView.preferredFlow",
] as const;

export type HostPublicPreferenceKey = (typeof HOST_PUBLIC_PREFERENCE_KEYS)[number];

function isHostPublicPreferenceKey(key: string): key is HostPublicPreferenceKey {
  return (HOST_PUBLIC_PREFERENCE_KEYS as readonly string[]).includes(key);
}

/** Reads and change detection share one reader so plugin-visible values cannot diverge. */
function readHostPublicPreference(
  settingsService: SettingsService,
  key: HostPublicPreferenceKey,
): unknown {
  switch (key) {
    case "webView.preferredFlow":
      return settingsService.get("webView")?.preferredFlow;
    default: {
      const _exhaustive: never = key;
      void _exhaustive;
      return undefined;
    }
  }
}

/** The first post-write observation must publish; treating it as a baseline drops the first edit. */
let lastPublishedPreferenceSignature: string | undefined;

/** Compare values in allow-list order; null and unset are equivalent because current keys cannot be null. */
export function publishAppPreferenceChange(settingsService: SettingsService): void {
  const signature = JSON.stringify(
    HOST_PUBLIC_PREFERENCE_KEYS.map((key) => {
      const value = readHostPublicPreference(settingsService, key);
      return [key, value === undefined ? null : value];
    }),
  );
  if (signature === lastPublishedPreferenceSignature) return;
  lastPublishedPreferenceSignature = signature;
  emitAppPreferenceChange();
}

export function _resetAppPreferencePublisher(): void {
  lastPublishedPreferenceSignature = undefined;
}

/** Read live settings; warn at most once per plugin and rejected key. */
export function buildAppPreferenceReader(
  settingsService: SettingsService,
  warnLogger: { warn: (msg: string) => void },
): (pluginId: string, key: string) => unknown {
  const warnedPerPlugin = new Map<string, Set<string>>();
  const recordWarn = (pluginId: string, key: string) => {
    let set = warnedPerPlugin.get(pluginId);
    if (!set) {
      set = new Set();
      warnedPerPlugin.set(pluginId, set);
    }
    if (set.has(key)) return false;
    set.add(key);
    return true;
  };

  return (pluginId, key) => {
    if (typeof key !== "string" || key.length === 0) {
      if (recordWarn(pluginId, String(key))) {
        warnLogger.warn(
          `plugin:${pluginId} getAppPreference: invalid key`,
        );
      }
      return undefined;
    }
    if (!isHostPublicPreferenceKey(key)) {
      if (recordWarn(pluginId, key)) {
        warnLogger.warn(
          `plugin:${pluginId} getAppPreference: key not on host public allowlist key=${key}`,
        );
      }
      return undefined;
    }
    return readHostPublicPreference(settingsService, key);
  };
}
