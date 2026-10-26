/** Expose only non-secret API-vendor metadata; seed once at boot, then debounce restarts on vendor changes. */

import { createLogger } from "../../lib/logger.js";
import type { LLMSettings } from "../../data/settings-store.js";

const log = createLogger("ave");

export interface RefreshActiveLlmWildcardDeps {
  /** Active API provider id. Undefined for subscription or unresolved retired profiles. */
  getActiveVendor: () => string | undefined;
  setWildcardConfigOverride: (config: Record<string, unknown>) => void;
  clearWildcardConfigOverride: (keys: string[]) => void;
  listPluginIds: () => string[];
  restartPlugin: (pluginId: string) => Promise<void>;
  /** Cancel in-flight replacements so shutdown prevents candidate publication after timers have fired. */
  cancelPendingRestarts: () => void;
  /** Debounce window for the post-vendor-change restart sweep (ms). Default 200. */
  debounceMs?: number;

  setTimeoutFn?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void;
}

/** Subscription and unresolved retired profiles must not expose retained API-provider identity. */
export function activeHostApiVendor(
  llm: Pick<LLMSettings, "activeChatRuntime" | "provider" | "retiredProvider">,
): string | undefined {
  if (llm.activeChatRuntime?.kind === "subscription" || llm.retiredProvider) return undefined;
  const vendor = typeof llm.provider === "string" ? llm.provider.trim() : "";
  return vendor || undefined;
}

export interface RefreshActiveLlmWildcardHandle {
  /** Idempotent refresh. Safe to call on boot and on every llm-settings IPC change. */
  refresh: () => void;
  dispose: () => void;
}

export function createRefreshActiveLlmWildcard(
  deps: RefreshActiveLlmWildcardDeps,
): RefreshActiveLlmWildcardHandle {
  const debounceMs = deps.debounceMs ?? 200;
  const setT = deps.setTimeoutFn ?? setTimeout;
  const clearT = deps.clearTimeoutFn ?? clearTimeout;

  let hasRefreshed = false;
  let lastWildcardVendor: string | undefined;
  let disposed = false;
  // Timer handles differ between browser and server runtimes; keep the injected boundary opaque.
  let restartTimer: unknown = null;

  const refresh = (): void => {
    if (disposed) return;
    const raw = deps.getActiveVendor();
    const activeVendor = typeof raw === "string" ? raw.trim() || undefined : undefined;

    // Remove stale wildcard secret slots on every refresh, including soft reloads.
    deps.clearWildcardConfigOverride(["hostApiKey", "hostApiVendor"]);
    if (activeVendor) {
      deps.setWildcardConfigOverride({ hostApiVendor: activeVendor });
    }

    if (hasRefreshed && lastWildcardVendor !== activeVendor) {
      if (restartTimer !== null) {
        clearT(restartTimer as ReturnType<typeof setTimeout>);
      }
      restartTimer = setT(() => {
        restartTimer = null;
        const ids = deps.listPluginIds();
        for (const pid of ids) {
          deps.restartPlugin(pid).catch((err: unknown) => {
            log.warn(`restartPlugin(${pid}) after vendor change failed: ${(err as Error).message}`);
          });
        }
      }, debounceMs);
    }
    lastWildcardVendor = activeVendor;
    hasRefreshed = true;
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    if (restartTimer !== null) {
      clearT(restartTimer as ReturnType<typeof setTimeout>);
      restartTimer = null;
    }
    // Cancel runtime restart tokens as well as timers; started replacements may otherwise publish during shutdown.
    try {
      deps.cancelPendingRestarts();
    } catch (err) {
      // Shutdown remains best-effort; a failure to signal cancellation must
      log.warn(`cancelPendingRestarts during active LLM wildcard disposal failed: ${(err as Error).message}`);
    }
  };

  return { refresh, dispose };
}
