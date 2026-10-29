import type { BootHost } from "../host-runtime.js";
import type { HostFetchTransport } from "../../main/host-fetch-guard.js";
import { noteConfinedProcessesMayRun } from "../../lib/confined-process-phase.js";
/** Construct the runtime before activation; loop-dependent callers are late-bound after conversation setup. */
import type { BrowserWindow } from "electron";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { aveHome } from "../../shared/ave-home.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import { raceWithTimeout } from "../../shared/abortable-deadline.js";
import { registerBootPluginShutdown, registerShutdownHook } from "../../main/app-shutdown.js";
import { onEvent as onHostEvent } from "../types.js";
import { AuditLogger } from "../../audit/audit-logger.js";
import { PluginRuntime } from "../../plugins/runtime.js";
import { resolvePluginChildEntryPath } from "../../permissions/confined-child.js";
import { LeaseDenialAudit } from "../../plugins/secret-access/lease-denial-audit.js";
import type { PythonRuntimeBootstrapper } from "../../main/python-runtime.js";
import { startPluginDevWatcher } from "../../plugins/dev-watcher.js";
import { PluginDeploymentGuard } from "../../plugins/deployment-guard.js";
import { loadMarketplacePolicy } from "../../marketplace/sources/policy.js";
import {
  setIsPackaged,
  shouldWarnPackagedFlagsIgnored,
  tamperedVarsAtBoot,
} from "../dev-flags.js";
import { resolvePluginPaths } from "../../plugins/plugin-paths.js";
import type {
  AuthWindowCookie,
  OpenAuthWindowBaseOptions,
  OpenAuthWindowFinalUrlResult,
} from "../../plugins/types.js";
import type { ToolRegistry } from "../../tools/registry.js";
import type { SettingsService } from "../../data/settings-store.js";
import type { MemoryManager } from "../../memory/memory-manager.js";
import type { RoutinesStore } from "../../main/routines-store.js";
import { buildPluginConfigOverrides } from "../plugins.js";
import { PluginLoopbackManager } from "../../mcp/plugin-loopback-manager.js";
import type { PluginBundleLifecycleHandler } from "../../plugins/plugin-bundle-lifecycle.js";
import { createLogger } from "../../lib/logger.js";

import { approvalIssuerRegistry } from "./plugin-runtime/approval-gating.js";
import { buildAppPreferenceReader } from "./plugin-runtime/app-preference.js";
import { AuthRedirectCatchers } from "../../main/auth-redirect-catcher.js";
import { createHostApiFactory } from "./plugin-runtime/host-api-factory.js";
import { createLifecycleCallbacks } from "./plugin-runtime/lifecycle.js";
import { createRegistryEntryCache } from "./plugin-runtime/registry-cache.js";
import { grantEvidenceReader } from "./plugin-runtime/grant-evidence.js";
import { PluginRuntimePreStartPhase } from "./plugin-runtime/pre-start-phase.js";
import { stageInSuggestionsSession } from "../../main/suggestions-session.js";
const log = createLogger("ave");

// Preserve this module’s public export path.
export { declaresHostManagedPythonRuntime } from "./plugin-runtime/manifest.js";
export { approvalIssuerRegistry, auditApprovalViolation,
} from "./plugin-runtime/approval-gating.js";
export {
  HOST_PUBLIC_PREFERENCE_KEYS,
  buildAppPreferenceReader,
} from "./plugin-runtime/app-preference.js";
export type { HostPublicPreferenceKey } from "./plugin-runtime/app-preference.js";
export { EXTERNAL_LINK_PARTITION, routeExternalUrl,
} from "./plugin-runtime/external-url.js";
export {
  TRIGGER_CONVERSATION_DEDUPE_TTL_MS,
  TriggerConversationDedupe,
  TRIGGER_CONVERSATION_RATE_LIMIT_WINDOW_MS,
  TRIGGER_CONVERSATION_RATE_LIMIT_MAX_CALLS,
  sanitizePluginPendingPrompt,
  formatPluginPendingPrompt,
  OVERLAY_SUMMARY_DISPLAY_CAP,
  deriveOverlaySummaryForDisplay,
  TriggerConversationRateLimiter,
  TriggerDenyAuditThrottle,
  evaluateTriggerSpec,
  normalizeTriggerSpecFields,
} from "./plugin-runtime/trigger-gate.js";
export type {
  EvaluateTriggerSpecInput,
  EvaluateTriggerSpecOutcome,
} from "./plugin-runtime/trigger-gate.js";

/** Late-binding container the ConversationLoop fills in after it exists. */
export interface LateBindingRefs {
  llmCallerRef: {
    fn:
      | ((prompt: string, opts?: { maxTokens?: number; systemPrompt?: string; signal?: AbortSignal;
          },
        ) => Promise<string>)
      | null;
  };
  pluginCallLlmRef: {
    fn:
      | ((
          pluginId: string,
          prompt: string,
          opts?: { maxTokens?: number; systemPrompt?: string; signal?: AbortSignal;
          },
        ) => Promise<string>)
      | null;
  };
  conversationLoopRef: {
    fn: import("../../engine/conversation-loop.js").ConversationLoop | null;
  };
  pluginToolInvokerRef: {
    // Derive delegate types from the shared origin contract so new origins cannot silently diverge.
    fn: import("../../plugins/runtime.js").PluginToolInvocationDelegate | null;
  };
}

export interface InitPluginRuntimeInput {
  host: BootHost;
  projectRoot: string;
  settingsService: SettingsService;
  _onCredentialIssuanceStageForTest?: (
    stage: import("../../main/host-api/resolve-api-key.js").CredentialIssuanceStage,
  ) => Promise<void> | void;
  memoryManager: MemoryManager;
  toolRegistry: ToolRegistry;
  pythonPath: string | undefined;
  pythonRuntime?: PythonRuntimeBootstrapper;
  bootAuditLogger: AuditLogger;
  mainWindow: BrowserWindow | null;
  /** Use OS proxy and trust-store routing for gated hostFetch; transport exists at boot. */
  networkFetch: HostFetchTransport;
  getMainWindow?: () => BrowserWindow | null;
  openAuthWindowService: (
    parent: BrowserWindow,
    opts: OpenAuthWindowBaseOptions & { returnFinalUrl?: boolean },
  ) => Promise<AuthWindowCookie[] | OpenAuthWindowFinalUrlResult>;
  /** In-app link viewing has no auth cookie or completion-pattern behavior. */
  openLinkWindowService: (
    parent: BrowserWindow,
    opts: { url: string; windowTitle?: string; persistPartition?: string },
  ) => Promise<void>;
  /** Open inside the caller’s auth partition to reuse its sign-in cookies. */
  openAuthPartitionViewerService: (
    parent: BrowserWindow,
    opts: import("../../main/auth-partition-viewer-service.js").OpenAuthPartitionViewerOptions,
  ) => Promise<void>;
  /** Clear only the caller’s auth partitions after user sign-out. */
  clearAuthPartitionService: (partition: string) => Promise<void>;
  shellOpenExternal: (url: string) => Promise<void>;
  /** Production supplies the live permission manager so rule changes abort outstanding bearer requests. */
  permissionManager?: import("../../permissions/permission-manager.js").PermissionManager;
  /** The approval gate must exist before runtime creation so plugin handlers can settle approvals. */
  approvalGate: import("../../permissions/approval-gate.js").ApprovalGate;
  /** Routine storage must exist before startAll creates plugin HostApi instances. */
  routinesStore: RoutinesStore;
  /** Resolve Work Board storage late; it is built after this step but before plugins start. */
  getWorkBoardStore: () => import("../../main/work-board-store.js").WorkBoardStore | undefined;
  /** Resolve alerts late; setup runs before any plugin start. */
  getAlertsService: () => import("../../alerts/service.js").AlertsService | undefined;
  /** Production defers activation until Skill/Hook/MCP lifecycle wiring exists. */
  deferStart?: boolean;
  /** Refresh manifest domains after load and before startAll can spawn confined children. */
  refreshSandboxUnionDomains?: () => Promise<void>;
  /** Renderer authority revocation hook owned by the IPC layer. */
  onPluginUiRevisionChange?: (pluginId: string) => void;
}

export interface InitPluginRuntimeOutput {
  pluginRuntime: PluginRuntime;
  deploymentGuard: PluginDeploymentGuard;
  lateBinding: LateBindingRefs;
  pluginShutdownHandlers: Array<{ pluginId: string; handler: () => void | Promise<void>;
  }>;
  runPluginShutdownHandlers: () => Promise<void>;
  /** Share the marketplace deployment guard with the update detector. */
  pluginPaths: ReturnType<typeof resolvePluginPaths>;
  /** Try plugin loopback hosts before external MCP clients when resolving UI resources. */
  loopbackManager: PluginLoopbackManager;
  /** Late-bind bundle projections after workflow, Hook, and MCP services exist. */
  setBundleLifecycleHandler: (handler: PluginBundleLifecycleHandler) => void;
  /** Idempotent cold-start entrypoint used after bundle lifecycle wiring. */
  startPlugins: () => Promise<void>;
  /** Admit one durable managed operation while the boot runtime is unsealed. */
  admitPreStartOperation: <T>(operation: () => Promise<T>) => Promise<T>;
}

export async function initPluginRuntime(
  input: InitPluginRuntimeInput,
): Promise<InitPluginRuntimeOutput> {
  const {
    projectRoot,
    settingsService,
    toolRegistry,
    pythonPath,
    pythonRuntime,
    bootAuditLogger,
    mainWindow,
    networkFetch,
    getMainWindow,
    openAuthWindowService,
    openLinkWindowService,
    openAuthPartitionViewerService,
    clearAuthPartitionService,
    shellOpenExternal,
    approvalGate,
    permissionManager,
    routinesStore,
    getWorkBoardStore,
    getAlertsService,
  } = input;

  // Read public preferences live so settings edits take effect without plugin reload.
  const readAppPreference = buildAppPreferenceReader(settingsService, log);

  const pluginShutdownHandlers: Array<{ pluginId: string; handler: () => void | Promise<void>;
  }> = [];
  let pluginShutdownRan = false;
  let pluginShutdownPromise: Promise<void> | null = null;
  const runPluginShutdownHandlers = (): Promise<void> => {
    if (pluginShutdownRan) return pluginShutdownPromise ?? Promise.resolve();
    if (pluginShutdownHandlers.length === 0) return Promise.resolve();
    pluginShutdownRan = true;
    pluginShutdownPromise = (async () => {
      await Promise.allSettled(
        pluginShutdownHandlers.map(async ({ pluginId, handler }) => {
          try {
            await raceWithTimeout(
              Promise.resolve().then(() => handler()),
              TOOL_TIMEOUT_POLICY.pluginShutdownHandlerMs,
              () => new Error(`shutdown handler timeout [plugin:${pluginId}]`),
            );
          } catch (err) {
            log.warn(
              `shutdown handler error [plugin:${pluginId}]: %s`,
              (err as Error).message,
            );
          }
        }),
      );
    })();
    return pluginShutdownPromise;
  };
  // Before services publish, this listener defers quit for plugin cleanup; ordered shutdown owns later quits.
  input.host.desktop?.onBootShutdown(runPluginShutdownHandlers,
    () => pluginShutdownHandlers.length > 0 && !pluginShutdownRan);

  const configOverrides = buildPluginConfigOverrides(settingsService);
  if (pythonPath) {
    configOverrides["*"] = {
      ...(configOverrides["*"] ?? {}),
      pythonExecutable: pythonPath,
    };
  }

  // All installs resolve through the single app-home plugin root, including isolated test homes.
  const pluginPaths = resolvePluginPaths();
  // Create the trust root before realpath checks or first-install writes.
  mkdirSync(pluginPaths.pluginsRoot, { recursive: true });
  // Only managed-policy required installs lock plugins; unreadable policy locks none.
  const deploymentGuard = new PluginDeploymentGuard({
    registryPath: pluginPaths.registryPath,
    pluginsRoot: pluginPaths.pluginsRoot,
    requiredInstalls: async () => {
      const load = await loadMarketplacePolicy();
      return load.ok ? load.policy.requiredInstalls : [];
    },
  });

  // Trust lookups use host-verified source and manifest pins, never plugin.json claims.
  const { refreshRegistryEntryCache, refreshRegistryEntryCacheIfChanged, getRegistryEntry } =
    createRegistryEntryCache({
      registryPath: pluginPaths.registryPath,
      log,
    });
  await refreshRegistryEntryCache();

  const lateBinding: LateBindingRefs = {
    llmCallerRef: { fn: null },
    pluginCallLlmRef: { fn: null },
    conversationLoopRef: { fn: null },
    pluginToolInvokerRef: { fn: null },
  };

  // Seed packaged state before downstream flag reads; packaged tampering produces one audit warning.
  setIsPackaged(input.host.isPackaged);
  if (shouldWarnPackagedFlagsIgnored()) {
    // Report pre-scrub flag names so operators can identify stale launchers and tampering.
    const names = tamperedVarsAtBoot();
    log.error(`Forbidden development/test env ignored in packaged build: ${names.join(", ")}`);
  }

  // Auth capability metadata is advisory; plugins own their authorization flows.
  let pluginRuntime!: PluginRuntime;
  // Bind loopback hosts before plugin activation callbacks can use them.
  let loopbackManager!: PluginLoopbackManager;
  let bundleLifecycle: PluginBundleLifecycleHandler | undefined;

  const installLoadedPluginPartitionPolicy = (pluginId: string): void => {
    input.host.desktop?.installPluginPartition(pluginId, pluginRuntime.getPluginRoot(pluginId));
  };

  // Deployment trust comes from install provenance and receipts, not an unsigned-plugin opt-in.
  // Pass runtime and loopback getters because both assignments happen after factory construction.
  // Share one runtime audit transport so storage refusals use the same record contract.
  const pluginRuntimeAuditLog = (
    level: "info" | "warn" | "error",
    message: string,
    data?: unknown,
  ): void => {
    try {
      bootAuditLogger.log({
        timestamp: new Date().toISOString(),
        sessionId: "plugin-runtime",
        type: level === "error" ? "error" : "tool_call",
        input: `[${level.toUpperCase()}] ${message}`,
        output:
          data === undefined ? undefined : JSON.stringify(data).slice(0, 500),
      });
    } catch (error) {
      log.error({ err: error }, "plugin runtime audit sink failed");
    }
  };
  /** The catcher registry must not outlive the runtime that owns its bound ports. */
  const authRedirectCatchers = new AuthRedirectCatchers();
  const leaseDenialAudit = new LeaseDenialAudit(bootAuditLogger);
  const createHostApi = createHostApiFactory({
    host: input.host,
    getPluginRuntime: () => pluginRuntime,
    lateBinding,
    getRegistryEntry,
    refreshRegistryEntryCacheIfChanged,
    grantEvidence: grantEvidenceReader({ paths: pluginPaths, marketplacesRoot: join(aveHome(), "marketplaces") }),
    pluginShutdownHandlers,
    readAppPreference,
    settingsService,
    ...(input._onCredentialIssuanceStageForTest
      ? { _onCredentialIssuanceStageForTest: input._onCredentialIssuanceStageForTest }
      : {}),
    bootAuditLogger,
    leaseDenialAudit,
    pluginRuntimeAuditLog,
    networkFetch,
    mainWindow,
    getMainWindow,
    openAuthWindowService,
    openLinkWindowService,
    openAuthPartitionViewerService,
    clearAuthPartitionService,
    authRedirectCatchers,
    shellOpenExternal,
    approvalGate,
    permissionManager,
    routinesStore,
    getWorkBoardStore,
    getAlertsService,
    stageInSuggestionsSession: () => stageInSuggestionsSession(input.memoryManager),
  });
  const { preparePluginStart, onDisable, onActiveStateChange, onEnable } =
    createLifecycleCallbacks({
      getAlertsService,
      getAppWindows: () => input.host.desktop?.getAppWindows() ?? [],
      lateBinding,
      getMainWindow,
      mainWindow,
      pythonRuntime,
      installLoadedPluginPartitionPolicy,
      getBundleLifecycle: () => bundleLifecycle,
    });

  pluginRuntime = new PluginRuntime({
    encryption: input.host.encryption,
    hostRoot: projectRoot,
    childEntryPath: resolvePluginChildEntryPath(),
    pluginsRoot: pluginPaths.pluginsRoot,
    registryPath: pluginPaths.registryPath,
    configOverrides,
    deploymentGuard,
    installReceiptCacheRoot: pluginPaths.cacheRoot,
    auditLog: pluginRuntimeAuditLog,
    onMalformedCredentialSelector: (pluginId) => {
      leaseDenialAudit.record(pluginId, "hostFetch", { code: "credential-conflict" });
    },
    preparePluginStart,
    onDisable,
    onActiveStateChange,
    onEnable,
    onPluginUiRevisionChange: input.onPluginUiRevisionChange,
    createHostApi,
  });
  registerBootPluginShutdown({
    runShutdownHandlers: runPluginShutdownHandlers,
    closeAdmission: () => pluginRuntime.beginShutdown(),
    stopRuntime: (signal) => pluginRuntime.stopAll({ signal }),
  });

  // Sweep abandoned approval issuers; gate timeouts do not remove them from this registry.
  const APPROVAL_REGISTRY_PURGE_MAX_AGE_MS = 5 * 60 * 1000;
  const APPROVAL_REGISTRY_PURGE_INTERVAL_MS = 60 * 1000;
  const approvalRegistryPurgeTimer = setInterval(() => {
    try {
      const purged = approvalIssuerRegistry.purgeStalerThan(
        APPROVAL_REGISTRY_PURGE_MAX_AGE_MS,
      );
      if (purged > 0) {
        log.info("approval issuer registry purged %d stale entries", purged);
      }
    } catch (err) {
      log.warn("approval registry purge failed: %s", (err as Error).message);
    }
  }, APPROVAL_REGISTRY_PURGE_INTERVAL_MS);
  // Don't keep the event loop alive solely for this housekeeping timer.
  approvalRegistryPurgeTimer.unref?.();
  registerShutdownHook("approval-issuer-registry-purge", () => {
    clearInterval(approvalRegistryPurgeTimer);
  });

  // Bind loopback management before startAll fires activation callbacks.
  loopbackManager = new PluginLoopbackManager(pluginRuntime, toolRegistry);

  const preStartPhase = new PluginRuntimePreStartPhase();
  const startPluginsOnce = async (): Promise<void> => {
    // After plugin processes may start, delete plugin trees only during boot.
    noteConfinedProcessesMayRun();
    // Refresh the final durable registry before HostApi creation and trust decisions.
    if (input.deferStart) await refreshRegistryEntryCache();
    // Install partition handlers before starting plugins; webviews bind URL loaders on first load.
    // Load manifests cheaply before activation, then repeat policy installation for runtime-resolved roots.
    await pluginRuntime.load();
    for (const pluginId of pluginRuntime.listPluginIds()) {
      installLoadedPluginPartitionPolicy(pluginId);
    }
    // Refresh confinement domains from loaded manifests before any child can spawn.
    await input.refreshSandboxUnionDomains?.();
    await pluginRuntime.startAll();
    log.info("boot: plugins loaded: %s", pluginRuntime.listToolNames());

    // Sandboxed webviews need session-registered preloads; preload attributes do not apply.
    for (const pluginId of pluginRuntime.listPluginIds()) {
      installLoadedPluginPartitionPolicy(pluginId);
    }
  };
  const startPlugins = (): Promise<void> => preStartPhase.start(startPluginsOnce);
  if (!input.deferStart) await startPlugins();
  // Install partition policy for post-boot arrivals too; they missed the initial loaded-plugin pass.
  // Partition policy follows installs; tool resync belongs to runtime activation callbacks.
  onHostEvent("plugin.installed", (data) => {
    const pluginId = (data as { pluginId?: string } | undefined)?.pluginId;
    if (typeof pluginId !== "string") return;
    installLoadedPluginPartitionPolicy(pluginId);
    // Refresh trust metadata before a new plugin’s first call.
    void refreshRegistryEntryCache();
  });

  // Bundle lifecycle owns uninstall projection; legacy sync can admit tools outside the generation barrier.
  onHostEvent("plugin.uninstalled", (data) => {
    const pluginId = (data as { pluginId?: string } | undefined)?.pluginId;
    if (typeof pluginId !== "string") return;
    // Drop removed cache entries so reinstall cannot inherit old trust decisions.
    void refreshRegistryEntryCache();
  });

  // Reload already resyncs tools through onEnable; the watcher only reports the result.
  const pluginDevWatcher = startPluginDevWatcher({
    pluginRuntime,
    onReloaded: (pluginId) => {
      const manifest = pluginRuntime.getPluginManifest(pluginId);
      if (!manifest) return;
      log.info(`plugin:${pluginId} hot-reloaded (${manifest.tools.length} tools)`,
      );
    },
  });
  registerShutdownHook("plugin-dev-watcher", () => {
    pluginDevWatcher.stop();
  });

  return {
    pluginRuntime,
    deploymentGuard,
    lateBinding,
    pluginShutdownHandlers,
    runPluginShutdownHandlers,
    pluginPaths,
    loopbackManager,
    setBundleLifecycleHandler: (handler) => {
      bundleLifecycle = handler;
    },
    startPlugins,
    admitPreStartOperation: (operation) => preStartPhase.admit(operation),
  };
}

export type { BrowserWindow };
