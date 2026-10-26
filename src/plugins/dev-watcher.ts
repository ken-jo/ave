/** Dev reload watches entry directories with debounce; packaged builds must never activate it. */
import { watch, type FSWatcher } from "node:fs";
import { resolve } from "node:path";
import type { PluginRuntime } from "./runtime.js";
import { devPluginReloadEnabled } from "../boot/dev-flags.js";
import { createLogger } from "../lib/logger.js";
const log = createLogger("dev-watcher");

export interface PluginDevWatcherOptions {
  pluginRuntime: PluginRuntime;
  debounceMs?: number;
  onReloaded?: (pluginId: string) => void;
  log?: (level: "info" | "warn" | "error", message: string) => void;
}

export interface PluginDevWatcherHandle {
  /** Stop is idempotent. */
  stop(): void;
}

/** Return an empty handle unless dev reload is explicitly enabled. */
export function startPluginDevWatcher(
  opts: PluginDevWatcherOptions,
): PluginDevWatcherHandle {
  // The dev flag is also gated on !app.isPackaged.
  if (!devPluginReloadEnabled()) {
    return { stop: () => {} };
  }

  const debounceMs = opts.debounceMs ?? 500;
  const localLog = opts.log ?? ((level: "info" | "warn" | "error", msg: string) => {
    if (level === "error") log.error(msg);
    else if (level === "warn") log.warn(msg);
    else log.info(msg);
  });

  const watchers = new Map<string, FSWatcher>();
  const pending = new Map<string, NodeJS.Timeout>();
  let stopped = false;

  const scheduleReload = (pluginId: string): void => {
    if (stopped) return;
    const existing = pending.get(pluginId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      pending.delete(pluginId);
      localLog("info", `[plugin-dev-watcher] reloading ${pluginId}`);
      opts.pluginRuntime
        .reloadPlugin(pluginId)
        .then(() => {
          localLog("info", `[plugin-dev-watcher] reloaded ${pluginId}`);
          opts.onReloaded?.(pluginId);
        })
        .catch((err: Error) => {
          localLog("error", `[plugin-dev-watcher] reload failed for ${pluginId}: ${err.message}`);
        });
    }, debounceMs);
    pending.set(pluginId, timer);
  };

  for (const pluginId of opts.pluginRuntime.listPluginIds()) {
    const manifest = opts.pluginRuntime.getPluginManifest(pluginId);
    if (!manifest) continue;
    const entryDir = opts.pluginRuntime.getPluginEntryDir(pluginId);
    if (!entryDir) {
      localLog("warn", `[plugin-dev-watcher] skip ${pluginId}: no entryDir`);
      continue;
    }
    try {
      const watcher = watch(
        resolve(entryDir),
        { recursive: true },
        (_eventType, filename) => {
          if (!filename) return;
          // Ignore source maps and other non-code writes to avoid duplicate reloads.
          if (!/\.(m?js|cjs)$/i.test(String(filename))) return;
          scheduleReload(pluginId);
        },
      );
      watcher.on("error", (err) => {
        localLog("error", `[plugin-dev-watcher] ${pluginId} watcher error: ${err.message}`);
      });
      watchers.set(pluginId, watcher);
      localLog("info", `[plugin-dev-watcher] watching ${pluginId} at ${entryDir}`);
    } catch (err) {
      localLog("warn", `[plugin-dev-watcher] failed to watch ${pluginId}: ${(err as Error).message}`);
    }
  }

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      for (const t of pending.values()) clearTimeout(t);
      pending.clear();
      for (const w of watchers.values()) {
        try { w.close(); } catch {  }
      }
      watchers.clear();
    },
  };
}
