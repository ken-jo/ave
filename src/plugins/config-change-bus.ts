import { createLogger } from "../lib/logger.js";
const log = createLogger("plugin-config-change");

// Config events stay plugin-scoped; secret updates carry the redaction sentinel, never secret values.
// The shared sentinel lives in the wire module because child imports must not initialize stdout logging.
export { SECRET_REDACTED_SENTINEL } from "./isolation/host-api-wire.js";

type ConfigChangeListener = (key: string, value: unknown) => void;

interface PluginListenerRecord {
  /** key → set of listeners. `*` matches every key for this plugin. */
  byKey: Map<string, Set<ConfigChangeListener>>;
}

const listenersByPlugin = new Map<string, PluginListenerRecord>();

function getOrCreatePluginRecord(pluginId: string): PluginListenerRecord {
  let rec = listenersByPlugin.get(pluginId);
  if (!rec) {
    rec = { byKey: new Map() };
    listenersByPlugin.set(pluginId, rec);
  }
  return rec;
}

/** Return a disposer; listeners never observe another plugin config. */
export function subscribePluginConfigChange(
  pluginId: string,
  key: string,
  listener: ConfigChangeListener,
): () => void {
  const rec = getOrCreatePluginRecord(pluginId);
  let set = rec.byKey.get(key);
  if (!set) {
    set = new Set();
    rec.byKey.set(key, set);
  }
  set.add(listener);
  return () => {
    const current = listenersByPlugin.get(pluginId);
    if (!current) return;
    const bucket = current.byKey.get(key);
    if (!bucket) return;
    bucket.delete(listener);
    if (bucket.size === 0) current.byKey.delete(key);
    if (current.byKey.size === 0) listenersByPlugin.delete(pluginId);
  };
}

/** Emit once per saved key, or "*" for a full overwrite, only within the affected plugin. */
export function emitPluginConfigChange(
  pluginId: string,
  key: string,
  value: unknown,
): void {
  const rec = listenersByPlugin.get(pluginId);
  if (!rec) return;
  const bucket = rec.byKey.get(key);
  if (bucket) {
    for (const listener of bucket) {
      try {
        listener(key, value);
      } catch (err) {
        // eslint-disable-next-line no-console
        log.warn(
          `listener failed for plugin=${pluginId} key=${key}: %s`,
          (err as Error).message,
        );
      }
    }
  }
  const wildcardBucket = rec.byKey.get("*");
  if (wildcardBucket) {
    for (const listener of wildcardBucket) {
      try {
        listener(key, value);
      } catch (err) {
        // eslint-disable-next-line no-console
        log.warn(
          `wildcard listener failed for plugin=${pluginId} key=${key}: %s`,
          (err as Error).message,
        );
      }
    }
  }
}

export function _resetPluginConfigChangeBus(): void {
  listenersByPlugin.clear();
}
