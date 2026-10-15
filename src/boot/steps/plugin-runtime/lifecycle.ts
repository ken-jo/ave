/**
 * Boot §4.2 Step 3-5 — plugin lifecycle callbacks (C6 extraction).
 *
 * Behavior-preserving move of the preparePluginStart / onDisable /
 * onActiveStateChange / onEnable closures out of initPluginRuntime. These fire
 * on post-boot lifecycle events (and onEnable during startAll), so the mutable
 * `pluginRuntime` + `loopbackManager` bindings are read through getters — never
 * value-captured at factory construction (both are assigned AFTER this factory
 * is built).
 */
import type { BrowserWindow } from "electron";
import { t } from "../../../i18n/index.js";
import { createLogger } from "../../../lib/logger.js";
import { fanOutToAllWindows } from "../../../ipc/window-fanout.js";
import { declaresHostManagedPythonRuntime } from "./manifest.js";
import type { PluginRuntimeOptions,
} from "../../../plugins/runtime.js";
import type { PythonRuntimeBootstrapper } from "../../../main/python-runtime.js";
import type { LateBindingRefs } from "../plugin-runtime.js";
import type { PluginBundleLifecycleHandler } from "../../../plugins/plugin-bundle-lifecycle.js";

const log = createLogger("ave");

/** Explicit deps for the lifecycle callbacks. Lazy bindings arrive as getters. */
export interface LifecycleDeps {
  getAppWindows: () => BrowserWindow[];
  getAlertsService: () => import("../../../alerts/service.js").AlertsService | undefined;
  lateBinding: LateBindingRefs;
  getMainWindow?: () => BrowserWindow | null;
  mainWindow: BrowserWindow | null;
  pythonRuntime?: PythonRuntimeBootstrapper;
  installLoadedPluginPartitionPolicy: (pluginId: string) => void;
  getBundleLifecycle: () => PluginBundleLifecycleHandler | undefined;
}

/**
 * Build the four PluginRuntime lifecycle callbacks. Returned as a
 * `Pick<PluginRuntimeOptions, ...>` so the closure params keep the same
 * contextual types they had inline in `new PluginRuntime({...})`.
 */
export function createLifecycleCallbacks(
  deps: LifecycleDeps,
): Pick<PluginRuntimeOptions, "preparePluginStart" | "onDisable" | "onActiveStateChange" | "onEnable"> {
  const {
    lateBinding,
    getMainWindow,
    mainWindow,
    pythonRuntime,
    installLoadedPluginPartitionPolicy,
  } = deps;

  const reconcileAlerts = () => {
    void deps.getAlertsService()?.reconcileMigration().catch((error: unknown) => {
      log.warn({ error }, "alert inheritance lifecycle reconciliation failed");
    });
  };

  return {
    preparePluginStart: ({ pluginId, manifest, manifestPath, reportProgress,
    }) => {
      if (!pythonRuntime || !declaresHostManagedPythonRuntime(manifest)) return undefined;
      const win = getMainWindow?.() ?? mainWindow;
      return (async () => {
        reportProgress?.({
          phase: "pending",
          message: t("be_pluginRuntime.pluginRuntimePreparationStarting"),
          progressPct: 5,
        });
        const runtime = await pythonRuntime.ensureReadyForPluginManifest(manifestPath, win, (status) => {
          reportProgress?.({
            phase: status.phase,
            message: status.msg,
            progressPct: status.pct,
          });
        },
        );
        if (!runtime) {
          throw new Error(`plugin '${pluginId}' declares host-managed Python but no accessible lockfile was found`,
          );
        }
        reportProgress?.({
          phase: "ready",
          message: t("be_pluginRuntime.pluginRuntimeReady"),
          progressPct: 100,
        });
        log.info("plugin dependency runtime ready: %s -> %s", pluginId, runtime.pythonPath,
        );
        return { configOverride: { pythonExecutable: runtime.pythonPath } };
      })();
    },
    onDisable: (pluginId) => {
      reconcileAlerts();
      lateBinding.conversationLoopRef.fn?.onPluginDisabled(pluginId);
    },
    onActiveStateChange: async (pluginId, enabled) => {
      const bundleLifecycle = deps.getBundleLifecycle?.();
      if (!bundleLifecycle) {
        throw new Error(`plugin generation lifecycle is not bound for active-state change: ${pluginId}`,
        );
      }
      if (!enabled) {
        lateBinding.conversationLoopRef.fn?.onPluginDisabled(pluginId);
      }
    },
    // Symmetric to `onDisable` — re-registers tools after a successful
    // restart/add/reload. Without this every chat-surface tool call hits
    // `도구를 찾을 수 없습니다` post-restart. Non-fatal:
    // a sync exception is logged but does not become `runtime reload failed`.
    onEnable: (pluginId) => {
      reconcileAlerts();
      // Register the partition preload on every live enable/reload path so the
      // refreshed plugin UI receives window.avePlugin immediately.
      installLoadedPluginPartitionPolicy(pluginId);
      // legacy-removal flag-day: ALL plugins register through the loopback manager
      // (server/discover → tools/list → reverse projection from `_meta`) — the
      // legacy `pluginToolsForRegistration` direct path is gone.
      // Best-effort renderer refresh signal. Runtime/tool registry state is
      // already updated; a closed window must not make reload fail —
      // the fan-out owns the isDestroyed guard + send try/catch.
      fanOutToAllWindows(deps.getAppWindows(), "ave:plugins:runtime-updated", { pluginId }, { logger: log });
    },
  };
}
