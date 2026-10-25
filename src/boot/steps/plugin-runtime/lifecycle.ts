/** Read runtime and loopback bindings through getters; both are assigned after callback construction. */
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
    // Resync tools on enable; a sync failure must not turn a successful reload into a runtime failure.
    onEnable: (pluginId) => {
      reconcileAlerts();
      // Re-register partition preloads on every enable so refreshed views receive their bridge.
      installLoadedPluginPartitionPolicy(pluginId);
      // All plugin tool registration goes through loopback discovery.
      // Renderer refresh is best-effort; closed windows must not fail runtime reload.
      fanOutToAllWindows(deps.getAppWindows(), "ave:plugins:runtime-updated", { pluginId }, { logger: log });
    },
  };
}
