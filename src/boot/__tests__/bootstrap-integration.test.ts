import { createBootHostFixture } from "../../__tests__/support/host-runtime.js";
/**
 * bootstrap() integration lock — §4.2 Boot Sequence.
 *
 * `boot.ts::bootstrap()` is the thin orchestrator that assembles the entire
 * AppServices graph. It had ZERO integration coverage: every existing boot
 * test exercises an extracted helper (sandbox-gate, plugin-runtime, managed-
 * marketplace, bootstrap-status, …) but none runs `bootstrap()` end-to-end.
 *
 * This test locks the CURRENT observable contract of a successful boot before
 * the decomposition refactor (C18) rearranges it:
 *
 *   1. AppServices KEY SET — the exact set of assembled service keys
 *      (`toMatchInlineSnapshot`). This is the primary lock: a decomposition
 *      must not silently drop or rename a service.
 *   2. CONSTRUCTION-ORDER invariants — the documented ordering guarantees that
 *      matter for correctness (approvalGate / permissionManager / routinesStore
 *      built and revocations fed BEFORE initPluginRuntime; the plugin
 *      runtime built before the ConversationLoop; the ConversationLoop built
 *      before the late-bound SubAgentRunner). Captured via call-order recording
 *      on the mocked seams.
 *   3. Cheap high-value boot outputs — the deferred lifecycle handles main.ts
 *      depends on (`shutdown`, `startRoutinesScheduler`, `startWorkBoardDueSoon`,
 *      `registerPluginEventBridge`) are wired as callables.
 *
 * Everything heavy is mocked at the module seam (electron, the boot step
 * modules, every store/service class, MCP, ASRT sandbox). The OS sandbox gate
 * is held OFF (settings `osToolSandbox:false`, no `AVE_SANDBOX_ENABLED`) so the
 * boot takes the deterministic skip path and never touches @anthropic-ai/
 * sandbox-runtime. The server marketplace fetcher is always the disabled
 * variant (packages arrive through the git marketplace), which is why the
 * mcp/agent/skill artifact stores are absent from the graph.
 *
 * COVERAGE CAVEAT: this locks the service-assembly SHAPE + ordering, not the
 * runtime behavior of each wired closure (those closures capture mocked deps
 * and are exercised by their own unit tests). It is a structural regression
 * lock for the decomposition, deliberately GREEN against current code.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Shared call-order recorder. `vi.hoisted` guarantees this exists before the
// hoisted vi.mock factories run, so each mocked seam can record when it fires.
const h = vi.hoisted(() => {
  const order: string[] = [];
  const captured: Record<string, unknown> = { shutdownHooks: [] as string[] };
  const rec = (label: string) => {
    order.push(label);
  };
  const disposer = () => () => {};
  return { order, captured, rec, disposer };
});

// ── electron ───────────────────────────────────────────────────────────────
// `app` is backed by a REAL EventEmitter rather than bare spies: the listener
// ceiling this file locks (see the shutdown-listener describe at the bottom) is
// a property of the emitter, so a boot that added listeners past Node's default
// would have to make the emitter itself warn for the guard to mean anything.
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  const BrowserWindow = Object.assign(function BrowserWindow() {}, {
    getAllWindows: vi.fn(() => [] as unknown[]),
    getFocusedWindow: vi.fn(() => null),
  });
  const appEvents = new EventEmitter();
  h.captured["appEvents"] = appEvents;
  return {
    app: {
      getPath: vi.fn(() => "/tmp/ave-boot-test"),
      isPackaged: false,
      on: vi.fn((event: string, listener: (...a: unknown[]) => void) =>
        appEvents.on(event, listener),
      ),
      prependOnceListener: vi.fn((event: string, listener: (...a: unknown[]) => void) =>
        appEvents.prependOnceListener(event, listener),
      ),
      once: vi.fn((event: string, listener: (...a: unknown[]) => void) =>
        appEvents.once(event, listener),
      ),
    },
    net: { fetch: vi.fn() },
    session: {
      fromPartition: vi.fn(() => ({
        setProxy: vi.fn(async () => {}),
        fetch: vi.fn(),
      })),
    },
    shell: { openExternal: vi.fn() },
    safeStorage: { isEncryptionAvailable: vi.fn(() => false) },
    BrowserWindow,
  };
});

// The shutdown coordinator is a seam here for two reasons: importing it for
// real would drag every teardown target (servers, pty manager, host API) into
// this file's graph, and the hook NAMES are what the listener-ceiling suite
// asserts bootstrap registers.
vi.mock("../../main/app-shutdown.js", () => ({
  configureAppShutdownHost: vi.fn(),
  registerBootPluginShutdown: vi.fn(),
  registerBootMcpDisconnect: vi.fn(),
  registerShutdownHook: vi.fn((name: string) => {
    (h.captured["shutdownHooks"] as string[]).push(name);
  }),
  runShutdownHooks: vi.fn(),
  runAppShutdownCleanup: vi.fn(async () => "completed"),
}));

// ── boot step seams (the modules bootstrap orchestrates) ─────────────────────
vi.mock("../services.js", () => ({
  bootstrapCoreServices: vi.fn(async () => {
    h.rec("core");
    return {
      pythonPath: "/usr/bin/python3",
      pythonRuntime: { kind: "python-runtime-stub" },
      bashAstValidator: {},
      auditService: { stop: vi.fn(async () => {}) },
      settingsService: {
        get: vi.fn((key: string) => {
          switch (key) {
            case "marketplace":
              return {};
            case "llm":
              return { provider: "openai", vendors: { openai: { model: "gpt", baseUrl: undefined } },
              };
            case "features":
              return { osToolSandbox: false, hostClassifiesRisk: false, idlePreferenceRefresh: true,
              };
            default:
              return {};
          }
        }),
        getSecret: vi.fn(() => undefined),
        getAll: vi.fn(() => ({})),
        deletePluginConfig: vi.fn(async () => undefined),
        deletePluginSecrets: vi.fn(async () => 0),
      },
      memoryManager: {},
      // Core boot now owns a capture gateway whose reviewer is late-bound once
      // the active conversation loop has been created. Keep the integration
      // graph faithful to the production CoreServices contract.
      memoryCaptureService: { setMemoryReviewer: vi.fn() },
      inputClassifier: {},
      toolRegistry: { setDenyRules: vi.fn(), size: 0 },
      routeEngine: {},
    };
  }),
}));

vi.mock("../conversation.js", () => ({
  createSystemPromptBuilder: vi.fn(() => ({})),
  createPermissionManager: vi.fn(async () => {
    h.rec("permissionManager");
    return {
      getVisibilityDenyRules: vi.fn(() => []),
      setBroadcastUserApprovalHit: vi.fn(),
      setBroadcastConfigChanged: vi.fn(),
      // Boot pushes the Layer 1 read fence in from the settings file on every
      // reviewer re-wire, so a stub that omits it fails the whole bootstrap.
      setBlockReadsOutsideWorkingDirectories: vi.fn(),
      // Each re-wire attaches the configured judge chain and its shared breaker.
      getJudgeBreaker: vi.fn(() => ({})),
      setJudge: vi.fn(),
    };
  }),
  createPostTurnHookChain: vi.fn(() => ({ postTurnHookChain: {} })),
  createApprovalGate: vi.fn(async () => {
    h.rec("approvalGate");
    return {};
  }),
  createHookRunner: vi.fn(() => ({})),
  createConversationLoop: vi.fn((deps) => {
    h.rec("conversationLoop");
    const calls = (h.captured["conversationDepsCalls"] ?? []) as unknown[];
    calls.push(deps);
    h.captured["conversationDepsCalls"] = calls;
    h.captured["mainConversationDeps"] = deps;
    return {
      getSessionId: vi.fn(() => undefined),
      getTurnAdditionalDirectories: vi.fn(() => []),
      // Wiring subscribes the A2A bus to turn-settled notifications.
      onTurnSettled: vi.fn(() => () => {}),
    };
  }),
  createRoutineConversationLoop: vi.fn((deps) => {
    h.captured["routineLoopDeps"] = deps;
    return {};
  }),
  createSideChatConversationLoop: vi.fn((deps) => {
    h.captured["sideConversationDeps"] = deps;
    return {
      getSessionId: vi.fn(() => "side-1"),
      getTurnAdditionalDirectories: vi.fn(() => []),
    };
  }),
  createCallLlm: vi.fn(() => vi.fn()),
  createCallLlmForPlugin: vi.fn(() => vi.fn()),
}));

vi.mock("../routine.js", () => ({
  createRoutineEngine: vi.fn((options) => {
    h.captured["routineEngineOptions"] = options;
    return { runRoutine: vi.fn() };
  }),
}));

vi.mock("../steps/rationale-host-wiring.js", () => ({
  wireRationaleHost: vi.fn(async (ctx) => {
    ctx.rationaleHostService = {
      createCoordinatorFactory: vi.fn(() => vi.fn()),
      closeSession: vi.fn(),
      shutdown: vi.fn(),
    };
  }),
}));

vi.mock("../tools.js", () => ({
  registerBuiltinTools: vi.fn(),
  registerRequestPluginMetaTool: vi.fn(),
  registerToolSearchMetaTool: vi.fn(),
  wireIdleScheduler: vi.fn(async () => ({ stop: vi.fn() })),
}));

// Captures the dep bag each uninstall-lifecycle entry point receives FROM
// bootstrap(). These are the real closures boot.ts builds; the module behind
// them is stubbed so boot stays hermetic, but the arguments are production's.
vi.mock("../../plugins/uninstall-lifecycle.js", () => ({
  recoverPendingPluginUninstallCleanups: vi.fn(async (deps: unknown) => {
    h.captured["recoverCleanupDeps"] = deps;
    h.rec("uninstallCleanupReplay");
    return [] as string[];
  }),
}));

vi.mock("../steps/plugin-runtime.js", () => ({
  initPluginRuntime: vi.fn(async () => {
    h.rec("initPluginRuntime");
    return {
      pluginRuntime: {
        listPluginIds: vi.fn(() => [] as string[]),
        resolvePluginId: vi.fn((pluginId: string) => pluginId),
        getPluginManifest: vi.fn(() => null),
        setWildcardConfigOverride: vi.fn(),
        clearWildcardConfigOverride: vi.fn(),
        restartPlugin: vi.fn(async () => {}),
        setToolInvocationDelegate: vi.fn(),
        setGenerationAccess: vi.fn(),
      },
      deploymentGuard: {},
      lateBinding: {
        pluginToolInvokerRef: { fn: undefined },
        conversationLoopRef: { fn: undefined },
        llmCallerRef: { fn: undefined },
        pluginCallLlmRef: { fn: undefined },
      },
      runPluginShutdownHandlers: vi.fn(async () => {}),
      pluginPaths: {
        registryPath: "/tmp/ave-boot-test/plugins/registry.json",
        pluginsRoot: "/tmp/ave-boot-test/plugins",
        cacheRoot: "/tmp/ave-boot-test/plugins/.cache",
      },
      loopbackManager: {
        prepareGeneration: vi.fn(),
        prepareRemoval: vi.fn(),
        publishGeneration: vi.fn(),
        postPublishGeneration: vi.fn(),
        discardGeneration: vi.fn(async () => {}),
        retireGeneration: vi.fn(async () => {}),
      },
      setBundleLifecycleHandler: vi.fn(() => h.rec("lifecycleBound")),
      startPlugins: vi.fn(async () => h.rec("startPlugins")),
      admitPreStartOperation: vi.fn(async (operation) => operation()),
    };
  }),
}));

vi.mock("../../plugins/plugin-bundle-lifecycle.js", () => ({
  PluginBundleLifecycle: class {
    recoverRetirements = vi.fn(async () => h.rec("retirementsRecovered"));
  },
}));

// The revocation feed is mocked so the headless assertions below can read
// what boot hands it.
vi.mock("../steps/revocation-bootstrap.js", () => ({
  feedRevocationsFromSnapshots: vi.fn(async (input: { home: string; pluginRegistryPath: string }) => {
    h.captured["revocationFeed"] = { home: input.home, pluginRegistryPath: input.pluginRegistryPath };
    h.rec("revocation");
  }),
}));

vi.mock("../steps/ipc-bridge.js", () => ({
  registerPluginEventBridge: vi.fn(() => {
    h.rec("pluginEventBridge");
    return h.disposer();
  }),
}));

vi.mock("../steps/post-boot.js", () => ({
  wireReleasePrep: vi.fn((input: { discretionaryEgress: boolean }) => {
    h.captured["discretionaryEgress"] = input.discretionaryEgress;
    return {
      telemetry: { stop: vi.fn() },
      pluginTelemetry: { stop: vi.fn() },
      autoUpdaterStop: vi.fn(),
    };
  }),
  wireAnnouncementCheck: vi.fn(),
}));

vi.mock("../steps/model-catalog-refresh.js", () => ({
  wireModelCatalogRefresh: vi.fn(async () => {}),
}));

vi.mock("../steps/reviewer-wiring.js", () => ({
  wireReviewerAgent: vi.fn(() => ({
    rationaleScopeReviewer: { reevaluate: vi.fn() },
  })),
}));

vi.mock("../steps/hook-system-wiring.js", () => ({
  wireHookSystem: vi.fn(async () => ({
    manager: { setPluginGenerationAccess: vi.fn() },
  })),
}));

vi.mock("../steps/refresh-active-llm-wildcard.js", () => ({
  createRefreshActiveLlmWildcard: vi.fn(() => ({ refresh: vi.fn() })),
}));

vi.mock("../steps/watcher-telemetry-collector.js", () => ({
  startWatcherTelemetryCollector: vi.fn(() => ({ stop: vi.fn() })),
}));

vi.mock("../steps/alerts-setup.js", () => ({
  setupAlerts: vi.fn(async (ctx: { alertsService: unknown }) => {
    h.rec("alertsSetup");
    ctx.alertsService = { start: vi.fn(), stop: vi.fn() };
    return () => {};
  }),
}));

vi.mock("../steps/work-board-migration.js", () => ({
  migrateLegacyPluginBoardToWorkBoard: vi.fn(async () => false),
}));

vi.mock("../plugin-surface-permissions.js", () => ({
  createPluginSurfacePermissionScope: vi.fn(() => ({ createPermissionContext: vi.fn(),
    revokeWorkspaceRoot: vi.fn(() => ({ sessionDirectoriesRemoved: 0, turnDirectoriesRemoved: 0 })),
  })),
  setActivePluginSurfacePermissionScope: vi.fn(),
}));

// ── data / mcp ───────────────────────────────────────────────────────────────
vi.mock("../../data/starred-store.js", () => ({ StarredStore: class {} }));
vi.mock("../../data/feedback-store.js", () => ({ FeedbackStore: class {} }));

vi.mock("../../mcp/mcp-governance.js", () => ({
  McpGovernance: class {
    startPolicyRefresh = vi.fn();
    stopPolicyRefresh = vi.fn();
  },
}));
vi.mock("../../mcp/mcp-manager.js", () => ({
  McpManager: class {
    loadFromConfig = vi.fn(async () => [] as unknown[]);
    connectAll = vi.fn(async () => {});
    disconnectAll = vi.fn(async () => {});
    killSwitch = vi.fn(async () => {});
    listServers = vi.fn(() => [] as unknown[]);
    setPluginGenerationAccess = vi.fn();
  },
}));
vi.mock("../../mcp/mcp-elicitation-resolver.js", () => ({
  createElicitationResolverFactory: vi.fn(() => vi.fn()),
}));

// ── main/* services + helpers ────────────────────────────────────────────────
vi.mock("../../main/plugin-auth-partition-tracker.js", () => ({
  openAuthWindow: vi.fn(),
  clearAuthPartition: vi.fn(),
  forgetTrackedPluginAuthPartitions: vi.fn(),
  getTrackedPluginAuthPartitions: vi.fn(() => []),
  wirePluginAuthPartitionPersistence: vi.fn(),
  seedPluginAuthPartitions: vi.fn(),
}));
vi.mock("../../main/plugin-auth-partition-store.js", () => ({
  readPersistedPluginAuthPartitions: vi.fn(async () => null),
  writePersistedPluginAuthPartitions: vi.fn(async () => {}),
  deletePersistedPluginAuthPartitions: vi.fn(async () => {}),
  cleanupStaleTmpFiles: vi.fn(async () => {}),
}));
vi.mock("../../main/link-window-service.js", () => ({ openLinkWindow: vi.fn(),
}));
vi.mock("../../main/auth-partition-viewer-service.js", () => ({ openAuthPartitionViewer: vi.fn(),
}));
vi.mock("../../main/routines-store.js", () => ({
  RoutinesStore: class {
    constructor() {
      h.rec("routinesStore");
    }
    load = vi.fn(async () => {});
    update = vi.fn(async () => true);
    list = vi.fn(() => []);
  },
}));
vi.mock("../../main/routines-scheduler.js", () => ({
  RoutinesScheduler: class {
    constructor(_store: unknown, getInstalledPluginIds: () => Promise<readonly string[]>) {
      h.captured["routineInstalledPluginIds"] = getInstalledPluginIds;
    }
    onLlmSession = vi.fn();
    onNotification = vi.fn();
    start = vi.fn();
    stop = vi.fn();
  },
}));
vi.mock("../../plugins/registry.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../plugins/registry.js")>(),
  readPluginRegistry: vi.fn(async () => ({ plugins: [
    { id: "updating-plugin", pendingUpdate: { transactionId: "update" } },
    { id: "disabled-plugin", enabled: false },
  ] })),
}));
vi.mock("../../main/work-board-store.js", () => ({
  WorkBoardStore: class {
    load = vi.fn(async () => {});
    reconcileInterruptedRuns = vi.fn(async () => {});
  },
}));
vi.mock("../../main/session-tasks-store.js", () => ({ SessionTasksStore: class {},
}));
vi.mock("../../main/ask-user-question-gate.js", () => ({
  AskUserQuestionGate: class {
    disposeAll = vi.fn();
  },
}));
vi.mock("../../main/notification-service.js", () => ({
  NotificationService: class {
    fire = vi.fn();
  },
}));
vi.mock("../../main/safe-llm-fetch.js", () => ({ createSafeLlmFetch: vi.fn(() => vi.fn()),
}));
vi.mock("../../main/skill-store.js", () => ({
  SkillStore: class {
    listCatalogSync = vi.fn(() => []);
  },
}));
vi.mock("../../main/skill-overlay.js", () => ({
  SkillOverlay: class {
    buildSection = vi.fn(() => "");
  },
}));
vi.mock("../../main/skill-approvals-store.js", () => ({
  SkillApprovalsStore: class {
    load = vi.fn(async () => {});
  },
}));
vi.mock("../../main/agent-profile-store.js", () => ({
  AgentProfileStore: class {
    load = vi.fn(async () => null);
  },
}));
vi.mock("../../main/persona-prompt-store.js", () => ({ PersonaPromptStore: class {},
}));
vi.mock("../../main/storage/feature-namespace.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../main/storage/feature-namespace.js")>(),
  openFeatureNamespace: vi.fn(() => ({ dir: "/tmp/ave-boot-test/work-board",
  })),
}));
vi.mock("../../main/seed-ave-home-docs.js", () => ({
  configureHomeDocResources: vi.fn(),
  seedAveHomeDocs: vi.fn(() => ({ seeded: [], upgraded: [] })),
  listAveHomeDocUpgradeMarkers: vi.fn(() => []),
}));

vi.mock("../../memory/preference-refresh-service.js", () => ({
  PreferenceRefreshService: class {
    start = vi.fn();
    stop = vi.fn();
  },
}));

vi.mock("../../memory/memory-consolidation-service.js", () => ({
  MemoryConsolidationService: class {},
  MemoryMaintenanceCoordinator: class {
    start = vi.fn();
    stop = vi.fn();
  },
}));
vi.mock("../../engine/subagent-runner.js", () => ({
  SubAgentRunner: class {
    constructor(options: unknown) {
      h.rec("subAgentRunner");
      h.captured["subAgentOptions"] = options;
    }
  },
}));
vi.mock("../../engine/llm/provider-factory.js", () => ({
  createProvider: vi.fn(() => ({})),
  secretKeyFor: vi.fn((v: string) => `llm.apiKey.${v}`),
}));

vi.mock("../../tools/executor.js", () => ({ ToolExecutor: class {} }));
vi.mock("../../tools/write-diff-cache.js", () => ({
  purgeStaleSessionDiffDirs: vi.fn(async () => ({ swept: [], failed: [] })),
  clearSessionDiffCache: vi.fn(async () => {}),
}));

vi.mock("../../core/work-board-engine.js", () => ({
  createWorkBoardEngine: vi.fn(() => ({})),
}));
vi.mock("../../work-board/sample-data.js", () => ({
  seedSampleWorkBoard: vi.fn(async () => {}),
}));
vi.mock("../../work-board/due-soon.js", () => ({
  scanAndEmitDueSoon: vi.fn(async () => []),
}));
vi.mock("../../work-board/storage.js", () => ({
  createDirStorage: vi.fn(() => ({})),
}));
vi.mock("../../work-board/work-report.js", () => ({
  createWorkBoardReporter: vi.fn(() => ({})),
}));
vi.mock("../../work-board/work-memory.js", () => ({
  appendMemory: vi.fn(async () => {}),
}));

// ── plugins/* ────────────────────────────────────────────────────────────────
vi.mock("../../plugins/marketplace.js", () => ({
  PluginMarketplaceService: class {},
}));
vi.mock("../../plugins/plugin-artifact-store.js", () => ({
  PluginArtifactStore: class {},
}));
vi.mock("../../plugins/orphan-uninstall-sweeper.js", () => ({
  sweepOrphanUninstallDirs: vi.fn(async () => {
    h.rec("tombstonesSwept");
    return { swept: [], failed: [] };
  }),
}));
vi.mock("../../plugins/plugin-storage-layout.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../plugins/plugin-storage-layout.js")>(),
  sweepPluginSocketDiscardDirs: vi.fn(async () => {
    h.rec("socketDiscardSwept");
    return [] as string[];
  }),
  migratePluginHostStorage: vi.fn(async () => {
    h.rec("hostStorageMigrated");
    return { migrated: [], skipped: [], failed: [] };
  }),
}));
vi.mock("../../plugins/plugin-paths.js", () => ({
  resolvePluginPaths: vi.fn(() => ({
    pluginsRoot: "/tmp/ave-boot-test/plugins",
    registryPath: "/tmp/ave-boot-test/registry.json",
    cacheRoot: "/tmp/ave-boot-test/cache",
  })),
}));

// ── permissions/* (incl. dynamically imported sandbox modules) ───────────────
vi.mock("../../permissions/sandbox-capability.js", () => ({
  detectSandboxCapability: vi.fn(() => ({
    kind: "none",
    confidence: "verified",
    platform: process.platform,
    reason: "sandbox disabled by bootstrap integration fixture",
    confines: { filesystem: false, process: false, network: false },
  })),
  isActiveSandboxFilesystemContained: vi.fn(() => false),
  isActiveSandboxShellContained: vi.fn(() => false),
  isActiveSandboxFilesystemContainedForPluginEffects: vi.fn(() => false),
  setActiveSandboxCapability: vi.fn(),
  setSandboxRequestedAtBoot: vi.fn(),
  setSandboxBootOutcome: vi.fn(),
}));
vi.mock("../../permissions/asrt-sandbox.js", async () => {
  // The boot step sweeps both private roots and creates the HOME root, so they
  // live under a directory this file owns in the OS temp dir — never the real
  // AVE_HOME — whose parent can be created.
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { mkdirSync } = await import("node:fs");
  const roots = join(tmpdir(), "ave-bootstrap-integration-sandbox");
  return {
    subscribeAsrtViolations: vi.fn(async () => () => {}),
    appOwnedSandboxTempRoot: vi.fn(() => join(roots, "tmp")),
    appOwnedSandboxHomeRoot: vi.fn(() => join(roots, "home")),
    sandboxTempPrincipalDirsInUse: () => new Set<string>(),
    ensureSandboxPrivateRoot: (root: string) => {
      mkdirSync(root, { recursive: true, mode: 0o700 });
      return root;
    },
    initializeAsrtSandbox: vi.fn(async () => {}),
    useAppOwnedSandboxTempRoot: vi.fn(() => "/tmp/ave-test-sandbox-tmp"),
    checkAsrtDependencies: vi.fn(async () => ({ errors: [], warnings: [] })),
    isAsrtLinuxRuntimeProbeError: vi.fn(() => false),
    isAsrtMacRuntimeProbeError: vi.fn(() => false),
    isAsrtSandboxActive: vi.fn(() => false),
    updateAsrtSandboxConfig: vi.fn(async () => {}),
    computeUnionAllowedDomains: vi.fn(() => []),
    normalizeUnionForAsrt: vi.fn(() => []),
    computeDynamicEndpointHosts: vi.fn(() => []),
  };
});
vi.mock("../../permissions/permission-settings-store.js", async () => {
  // No judge block on disk: the store's own absent-file result (judge off).
  const { normalizeJudgeSettings } = await import("../../permissions/judge/judge-settings.js");
  return {
    readPermissionSettings: vi.fn(() => ({
      permissions: { additionalDirectories: [] },
    })),
    readJudgeSettings: vi.fn(() => normalizeJudgeSettings(undefined)),
  };
});
vi.mock("../../permissions/user-approval-store.js", () => ({
  migrateCanonicalization: vi.fn(async () => {}),
  setApprovalConversationRootResolver: vi.fn(),
}));
vi.mock("../../permissions/manifest-integrity.js", () => ({
  bindManifestIntegrityAudit: vi.fn(),
  manifestIntegrityState: { onViolation: vi.fn() },
}));

// ── audit/* (dynamically imported inside bootstrap) ──────────────────────────
vi.mock("../../audit/audit-logger.js", () => ({
  AuditLogger: class {
    setupPermissionAuditChain = vi.fn();
    log = vi.fn();
    logSandboxGate = vi.fn();
    flush = vi.fn(async () => {});
    close = vi.fn(async () => {});
    rotateAndPrune = vi.fn(async () => {});
    getAuditDir = vi.fn(() => "C:\\tmp\\ave-boot-test\\audit");
    getPermissionAuditSecret = vi.fn(() => "s".repeat(64));
    getPermissionAuditSealStore = vi.fn(() => ({
      read: vi.fn(() => null),
      write: vi.fn(),
    }));
  },
}));
vi.mock("../../audit/hmac-chain.js", () => ({
  FileSecretStore: class {},
  SafeStorageSecretStore: class {},
  ensureAuditSecret: vi.fn(() => ({})),
  computeLineHmac: vi.fn(() => "h".repeat(64)),
}));

// ── ipc/domains/permissions.js — mocked so the concurrently-edited IPC domain
//    tree is not pulled into this test (bootstrap only needs the broadcaster).
vi.mock("../../ipc/domains/permissions.js", () => ({
  broadcastPermissionConfigChanged: vi.fn(),
}));

import { bootstrap, type AppServices } from "../../boot.js";
import { wireAnnouncementCheck } from "../steps/post-boot.js";
import { wireModelCatalogRefresh } from "../steps/model-catalog-refresh.js";

// Boot resolves `~/.ave` through `AVE_HOME` (the retired-cache sweep in
// marketplace-setup removes directories under it), so both boots below run
// against a scratch home, never the developer's own.
const savedAveHome = process.env["AVE_HOME"];
process.env["AVE_HOME"] = "/tmp/ave-boot-test/ave-home";
afterAll(() => {
  if (savedAveHome === undefined) delete process.env["AVE_HOME"];
  else process.env["AVE_HOME"] = savedAveHome;
});

/**
 * Node reports a listener leak through `process.emitWarning`, so the spy has to
 * be in place before the first boot below runs. It keeps the real
 * implementation: the assertion is about what was emitted, not about silencing
 * it.
 */
const emitWarningSpy = vi.spyOn(process, "emitWarning");

/** Names of the warnings Node raised while the boots below ran. */
function emittedWarningNames(): string[] {
  return emitWarningSpy.mock.calls.map(([warning]) =>
    typeof warning === "string" ? warning : String((warning as Error)?.name ?? warning),
  );
}

function fakeWindow() {
  return {
    isDestroyed: () => false,
    webContents: { send: vi.fn() },
  } as unknown as import("electron").BrowserWindow;
}

/** Assert both labels were recorded and `a` fired strictly before `b`. */
function assertBefore(a: string, b: string) {
  const ia = h.order.indexOf(a);
  const ib = h.order.indexOf(b);
  expect(ia, `${a} was not recorded`).toBeGreaterThanOrEqual(0);
  expect(ib, `${b} was not recorded`).toBeGreaterThanOrEqual(0);
  expect(
    ia,
    `expected ${a} before ${b} (order: ${h.order.join(" -> ")})`,
  ).toBeLessThan(ib);
}

describe("bootstrap() integration lock", () => {
  let services: AppServices;
  let savedSandboxEnv: string | undefined;

  // A whole-app boot, not an ordinary fixture. The suite-wide 45s hook budget is
  // sized for the latter, and this hook lands within a few seconds of it on
  // Windows once the runner transforms the full service graph on demand — so a
  // loaded full-suite run times the hook out and skips all nine assertions. The
  // headroom is for the runner's import cost, not for the product's boot.
  beforeAll(async () => {
    // Hold the OS-sandbox gate OFF for a deterministic skip path (no ASRT init).
    savedSandboxEnv = process.env["AVE_SANDBOX_ENABLED"];
    delete process.env["AVE_SANDBOX_ENABLED"];
    const win = fakeWindow();
    services = await bootstrap(
      "/tmp/ave-boot-test/project",
      win,
      () => win,
      "interactive",
      createBootHostFixture(),
    );
  }, 180_000);

  afterAll(() => {
    if (savedSandboxEnv === undefined)
      delete process.env["AVE_SANDBOX_ENABLED"];
    else process.env["AVE_SANDBOX_ENABLED"] = savedSandboxEnv;
  });

  it("reads installed routine plugins from the live registry including pending updates and disabled entries", async () => {
    const getIds = h.captured["routineInstalledPluginIds"] as () => Promise<readonly string[]>;
    expect(await getIds()).toEqual(["updating-plugin", "disabled-plugin"]);
    const { readPluginRegistry } = await import("../../plugins/registry.js");
    expect(readPluginRegistry).toHaveBeenLastCalledWith("/tmp/ave-boot-test/plugins/registry.json");
    vi.mocked(readPluginRegistry).mockResolvedValueOnce({ version: 1, plugins: [] });
    expect(await getIds()).toEqual([]);
  });

  it("dispatches a routine whose canonical plugin ID differs from its registry install ID", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { RoutinesStore } = await vi.importActual<typeof import("../../main/routines-store.js")>("../../main/routines-store.js");
    const { RoutinesScheduler } = await vi.importActual<typeof import("../../main/routines-scheduler.js")>("../../main/routines-scheduler.js");
    const { readPluginRegistry } = await import("../../plugins/registry.js");
    const dir = await mkdtemp(join(tmpdir(), "ave-routine-alias-"));
    try {
      const store = new RoutinesStore(join(dir, "routines.json"));
      const routine = await store.add({
        trigger: "schedule",
        execution: "llm-session",
        prePrompt: "Use the installed plugin",
        schedule: { at: new Date(Date.now() - 1000).toISOString() },
        scope: {
          pluginIds: { mode: "allow", ids: ["manifest-fresh"] },
          forcedPluginIds: [],
          directories: [],
        },
      });
      vi.mocked(readPluginRegistry).mockResolvedValueOnce({
        version: 1,
        plugins: [{ id: "catalog-fresh", manifestPath: join(dir, "plugin.json") }],
      });
      vi.mocked(services.pluginRuntime.resolvePluginId).mockImplementationOnce((id) => {
        expect(id).toBe("catalog-fresh");
        return "manifest-fresh";
      });
      const getIds = h.captured["routineInstalledPluginIds"] as () => Promise<readonly string[]>;
      const scheduler = new RoutinesScheduler(store, getIds);
      const fired = vi.fn();
      scheduler.onLlmSession(fired);
      await scheduler.checkAndFire();
      expect(fired).toHaveBeenCalledOnce();
      const persisted = new RoutinesStore(join(dir, "routines.json"));
      await persisted.load();
      const record = persisted.list().find((entry) => entry.id === routine.id);
      expect(record).toMatchObject({ id: routine.id, lastFiredAt: expect.any(String) });
      expect(record?.lastSkippedReason).toBeUndefined();
      expect(record?.needsAttention).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("assembles the exact AppServices key set (C18 must not drop/rename a service)", () => {
    expect(Object.keys(services).sort()).toMatchInlineSnapshot(`
      [
        "a2aRemoteRuntime",
        "agentProfileStore",
        "agentsDocMergeService",
        "alertsService",
        "approvalGate",
        "askUserQuestionGate",
        "auditLogger",
        "auditService",
        "autoUpdaterStop",
        "bashAstValidator",
        "clearAuthPartitionService",
        "conversationLoop",
        "feedbackStore",
        "findChatGroupLoop",
        "findLoopBySessionId",
        "flushTracing",
        "forgetPluginAuthPartitionsService",
        "getApprovalSentenceSelector",
        "getPluginToolInvoker",
        "getSubAgentRunner",
        "idleScheduler",
        "inputClassifier",
        "listPluginAuthPartitionsService",
        "mcpAppModelContext",
        "mcpManager",
        "memoryCaptureService",
        "memoryConsolidationService",
        "memoryMaintenanceCoordinator",
        "memoryManager",
        "notificationService",
        "paneChatLoops",
        "personaPromptStore",
        "pluginBundleLifecycle",
        "pluginLoopbackManager",
        "pluginMarketplace",
        "pluginPaths",
        "pluginRuntime",
        "pluginTelemetry",
        "postTurnHookChain",
        "preferenceRefreshService",
        "pythonPath",
        "pythonRuntime",
        "refreshActiveLlmWildcard",
        "refreshPluginEventBridge",
        "refreshSandboxNetworkConfig",
        "registerPluginEventBridge",
        "releaseChatGroupLoop",
        "remoteA2AActionController",
        "remoteA2ABootGates",
        "remoteA2AStartFailureReason",
        "requestPluginOperationGrant",
        "resolveChatGroupLoop",
        "revokePluginOperationSession",
        "rewireReviewerAgent",
        "routeEngine",
        "routineEngine",
        "routinesScheduler",
        "routinesStore",
        "runPluginShutdownHandlers",
        "scriptHookManager",
        "sessionGoalStore",
        "sessionTasksStore",
        "settingsService",
        "shutdown",
        "sideChatConversationLoop",
        "sideChatMemoryManager",
        "singleHopNetworkFetch",
        "skillStore",
        "starredStore",
        "startAlerts",
        "startRoutinesScheduler",
        "startWorkBoardDueSoon",
        "systemPromptBuilder",
        "telemetry",
        "toolRegistry",
        "workBoardEngine",
        "workBoardReport",
        "workBoardStore",
      ]
    `);
  });

  it("enforces the documented construction-order invariants", () => {
    // Core services are the foundation — everything else depends on them.
    assertBefore("core", "approvalGate");
    // §B1/§F7 + cluster M1 + Routines-SOT: the ApprovalGate,
    // PermissionManager, and RoutinesStore are ALL built before
    // initPluginRuntime, because the per-plugin HostApi factory wires against
    // each of them at plugin construction time.
    assertBefore("approvalGate", "initPluginRuntime");
    assertBefore("permissionManager", "initPluginRuntime");
    assertBefore("routinesStore", "initPluginRuntime");
    // Revocations reach the load gate before any plugin can load.
    assertBefore("revocation", "initPluginRuntime");
    // The plugin runtime exists before the ConversationLoop is composed (the
    // loop captures pluginRuntime among its deps).
    assertBefore("initPluginRuntime", "conversationLoop");
    // The ConversationLoop is built before the late-bound SubAgentRunner, which
    // reuses the loop's dep set.
    assertBefore("conversationLoop", "subAgentRunner");
    assertBefore("lifecycleBound", "retirementsRecovered");
    assertBefore("retirementsRecovered", "startPlugins");
    // Runtime deletes of trees a confined child may still write wait for these
    // boot sweeps, which must finish before any plugin starts.
    assertBefore("tombstonesSwept", "startPlugins");
    assertBefore("socketDiscardSwept", "startPlugins");
    // Storage written before the host-only directory existed is copied out of
    // `data/` before any plugin (or other confined process) can run.
    // Loading a plugin (inside initPluginRuntime) refuses a root whose data/
    // holds state but has no storage/ yet, so the copy precedes the load too.
    assertBefore("hostStorageMigrated", "initPluginRuntime");
    assertBefore("hostStorageMigrated", "startPlugins");
    // Plugins register their alert kinds as they start, and a boot-time
    // uninstall replay must find the alerts pipeline listening.
    assertBefore("alertsSetup", "uninstallCleanupReplay");
    assertBefore("alertsSetup", "startPlugins");
  });

  // ── plugin-state cleanup dep bag ────────────────────────────────────────
  //
  // `plugin.uninstalled` is what drops the stale registry-entry cache entry
  // (src/boot/steps/plugin-runtime.ts:555 → refreshRegistryEntryCache, whose
  // comment says "so a re-install does not inherit the previous Tier-3 bypass
  // or manifest SHA decision") and what every per-plugin
  // `onEvent("plugin.uninstalled")` subscriber hangs off. It is optional on
  // `PluginUninstallLifecycleDeps`, so a wiring that forgets it type-checks and
  // silently emits nothing.
  //
  // boot.ts used to hand-spell the dep bag three times and pass `emitHostEvent`
  // in exactly ONE of them. These assertions drive the REAL closure bootstrap()
  // built and check the arguments that actually reach the lifecycle module.
  describe("plugin-state cleanup dep bag", () => {
    function bagFor(key: string): Record<string, unknown> {
      const bag = h.captured[key];
      expect(bag, `${key} was never captured`).toBeDefined();
      return bag as Record<string, unknown>;
    }

    it("gives boot-time cleanup recovery the host event emitter", () => {
      expect(typeof bagFor("recoverCleanupDeps")["emitHostEvent"]).toBe("function");
    });
  });

  it("exposes the deferred lifecycle handles main.ts drives after boot", () => {
    expect(typeof services.shutdown).toBe("function");
    expect(typeof services.startRoutinesScheduler).toBe("function");
    expect(typeof services.startWorkBoardDueSoon).toBe("function");
    expect(typeof services.registerPluginEventBridge).toBe("function");
    expect(typeof services.refreshPluginEventBridge).toBe("function");
  });

  it("wires the core, conversation, and plugin-runtime seams into the graph", () => {
    // Present as assembled objects (the graph is wired, not partial).
    expect(services.conversationLoop).toBeDefined();
    expect(services.approvalGate).toBeDefined();
    expect(services.pluginRuntime).toBeDefined();
    expect(services.toolRegistry).toBeDefined();
    expect(services.settingsService).toBeDefined();
  });

  it("keeps rationale interactive while wiring the subscription runtime across execution loops", () => {
    const mainDeps = h.captured["mainConversationDeps"] as {
      rationaleCoordinatorFactory?: unknown;
      closeRationaleSession?: unknown;
      pluginOperationGrants?: unknown;
      pluginOperationIdentityProvider?: unknown;
      subscriptionProviderFactory?: unknown;
    };
    const sideDeps = h.captured["sideConversationDeps"] as {
      rationaleCoordinatorFactory?: unknown;
      closeRationaleSession?: unknown;
      subscriptionProviderFactory?: unknown;
    };

    expect(typeof mainDeps.rationaleCoordinatorFactory).toBe("function");
    expect(typeof sideDeps.rationaleCoordinatorFactory).toBe("function");
    expect(mainDeps.rationaleCoordinatorFactory).not.toBe(
      sideDeps.rationaleCoordinatorFactory,
    );
    expect(typeof mainDeps.closeRationaleSession).toBe("function");
    expect(typeof sideDeps.closeRationaleSession).toBe("function");
    expect(typeof mainDeps.subscriptionProviderFactory).toBe("function");
    expect(typeof sideDeps.subscriptionProviderFactory).toBe("function");

    const routineEngineOptions = h.captured["routineEngineOptions"] as {
      createConversationLoop: (input: { scope: unknown }) => unknown;
    };
    routineEngineOptions.createConversationLoop({ scope: {} });
    const routineDeps = h.captured["routineLoopDeps"] as Record<
      string,
      unknown
    >;
    expect(routineDeps["rationaleCoordinatorFactory"]).toBeUndefined();
    expect(routineDeps["closeRationaleSession"]).toBeUndefined();
    expect(typeof routineDeps["subscriptionProviderFactory"]).toBe("function");

    const subAgentOptions = h.captured["subAgentOptions"] as {
      parentDeps: Record<string, unknown>;
    };
    expect(
      subAgentOptions.parentDeps["rationaleCoordinatorFactory"],
    ).toBeUndefined();
    expect(subAgentOptions.parentDeps["closeRationaleSession"]).toBeUndefined();
    expect(typeof subAgentOptions.parentDeps["subscriptionProviderFactory"]).toBe("function");
    expect(subAgentOptions.parentDeps["pluginOperationGrants"]).toBe(
      mainDeps["pluginOperationGrants"],
    );
    expect(subAgentOptions.parentDeps["pluginOperationIdentityProvider"]).toBe(
      mainDeps["pluginOperationIdentityProvider"],
    );
  });

  it("stops its own timers and watchers through the shutdown coordinator, not its own listeners", () => {
    // The interactive launch still wires both of bootstrap's teardown paths —
    // it just no longer spends an Electron listener on either.
    expect(h.captured["shutdownHooks"]).toEqual(["watcher-telemetry", "diff-cache"]);
    expect(h.captured["appEvents"]).toBeUndefined();
  });

  it("opens the host's own service connections (interactive launch is unchanged)", () => {
    expect(h.captured["discretionaryEgress"]).toBe(true);
    expect(vi.mocked(wireAnnouncementCheck)).toHaveBeenCalled();
    expect(vi.mocked(wireModelCatalogRefresh)).toHaveBeenCalledTimes(1);
    expect(
      (h.captured["mainConversationDeps"] as Record<string, unknown>)["approvalSurface"],
    ).toBe("interactive");
  });
});

/**
 * A headless `--exec` boot opens no DISCRETIONARY service connection.
 *
 * The rule is one fact — the `launch` argument — and this suite is what proves
 * each consequence comes off it: neither the release check, the telemetry
 * uploaders, the announcement poll nor the model catalog refresh are started. (The git marketplace's sync starts with the window, in main.ts, so
 * a headless boot never reaches it.) It also proves the halves of the
 * boundary that are NOT discretionary: revocations are still fed from the
 * local snapshots, and plugins on disk still load. The interactive boot above
 * is the control; both run against the same mocked seams.
 */
describe("bootstrap() headless launch opens no discretionary service connection", () => {
  let headlessServices: AppServices;
  let savedSandboxEnv: string | undefined;

  beforeAll(async () => {
    savedSandboxEnv = process.env["AVE_SANDBOX_ENABLED"];
    delete process.env["AVE_SANDBOX_ENABLED"];
    // The interactive boot above already called each of these, and recorded its
    // own ordering; the assertions here are about what THIS boot does.
    vi.mocked(wireAnnouncementCheck).mockClear();
    vi.mocked(wireModelCatalogRefresh).mockClear();
    h.order.length = 0;
    (h.captured["shutdownHooks"] as string[]).length = 0;
    headlessServices = await bootstrap(
      "/tmp/ave-boot-test/project",
      null,
      () => null,
      "headless",
      createBootHostFixture(),
    );
  }, 180_000);

  afterAll(() => {
    if (savedSandboxEnv === undefined)
      delete process.env["AVE_SANDBOX_ENABLED"];
    else process.env["AVE_SANDBOX_ENABLED"] = savedSandboxEnv;
  });

  it("still feeds the plugin trust chain", () => {
    // Revocations and host-secret grants read only local snapshots.
    expect(h.order).toContain("revocation");
    expect(h.captured["revocationFeed"]).toEqual({ home: expect.any(String), pluginRegistryPath: expect.stringMatching(/registry\.json$/u) });
  });

  it("starts neither the release check nor the telemetry uploaders", () => {
    expect(h.captured["discretionaryEgress"]).toBe(false);
  });

  it("does not schedule the announcement poll", () => {
    expect(vi.mocked(wireAnnouncementCheck)).not.toHaveBeenCalled();
  });

  it("does not refresh the model catalog", () => {
    expect(vi.mocked(wireModelCatalogRefresh)).not.toHaveBeenCalled();
  });

  it("still loads the plugins already on disk", () => {
    // The point of the cut: what is dropped is the network refresh in front of
    // the registry snapshot, never the snapshot itself.
    expect(h.order).toContain("initPluginRuntime");
    expect(h.order).toContain("startPlugins");
    expect(headlessServices.pluginRuntime.listPluginIds()).toEqual([]);
  });

  it("marks every windowless conversation lane as lacking a local approval surface", () => {
    const routineEngineOptions = h.captured["routineEngineOptions"] as {
      createConversationLoop: (input: { scope: unknown }) => unknown;
    };
    routineEngineOptions.createConversationLoop({ scope: {} });
    const mainDeps = h.captured["mainConversationDeps"] as Record<string, unknown>;
    expect(mainDeps["approvalSurface"]).toBe("unavailable");
    // Native --exec keeps the ordinary main-chat tool and egress scope. The
    // approval capability must never be inferred from the routine-only
    // `headless` scope switch; the unattended policy lane is a host-issued
    // per-turn authority minted by exec-mode, not a loop flag.
    expect(mainDeps["headless"]).toBeUndefined();
    expect(mainDeps["allowedPluginIds"]).toBeUndefined();
    expect(mainDeps["toolRegistry"]).toBe(headlessServices.toolRegistry);
    expect(mainDeps["pluginRuntime"]).toBe(headlessServices.pluginRuntime);
    expect(
      (h.captured["sideConversationDeps"] as Record<string, unknown>)["approvalSurface"],
    ).toBe("unavailable");
    expect(
      (h.captured["routineLoopDeps"] as Record<string, unknown>)["approvalSurface"],
    ).toBe("unavailable");
    expect(
      (h.captured["subAgentOptions"] as { parentDeps: Record<string, unknown> })
        .parentDeps["approvalSurface"],
    ).toBe("unavailable");
    expect(headlessServices.resolveChatGroupLoop).toBeTypeOf("function");
    const groupLoop = headlessServices.resolveChatGroupLoop?.("authorization-group");
    expect(groupLoop).toBeDefined();
    const conversationDepsCalls = h.captured["conversationDepsCalls"] as Record<
      string,
      unknown
    >[];
    expect(conversationDepsCalls.at(-1)?.["approvalSurface"]).toBe("unavailable");
  });

  it("adds no `before-quit` listener of its own, and Node never reports a leak", () => {
    // A one-shot run writes its stderr straight to whoever launched it, so a
    // `MaxListenersExceededWarning` there reads as a defect in the run. The
    // count is bounded by construction: teardown that needs no ordering is a
    // shutdown hook, and both hooks below share the single listener `main.ts`
    // owns — which this file's Electron seam never installs.
    expect((h.captured["shutdownHooks"] as string[])).toEqual([
      "watcher-telemetry",
      "diff-cache",
    ]);
    expect(h.captured["appEvents"]).toBeUndefined();
    expect(emittedWarningNames()).not.toContain("MaxListenersExceededWarning");
  });
});
