import { createBootHostFixture } from "../../__tests__/support/host-runtime.js";
/** Boot integration checks service shape and construction order with heavy dependencies mocked.
 * It does not verify the behavior of closures wired to those mocks. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Use a hoisted recorder so mock factories can record construction order.
const h = vi.hoisted(() => {
  const order: string[] = [];
  const captured: Record<string, unknown> = { shutdownHooks: [] as string[] };
  const rec = (label: string) => {
    order.push(label);
  };
  const disposer = () => () => {};
  return { order, captured, rec, disposer };
});

// Use a real event emitter so listener-ceiling assertions observe actual runtime warnings.
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

// Mock shutdown implementation but assert registered hook names without importing the teardown graph.
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
        onChanged: vi.fn(() => () => {}),
        getSecret: vi.fn(() => undefined),
        getAll: vi.fn(() => ({})),
        deletePluginConfig: vi.fn(async () => undefined),
        deletePluginSecrets: vi.fn(async () => 0),
      },
      memoryManager: {},
      // The capture gateway reviewer is late-bound after the active loop exists.
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
      // Every reviewer rewire must apply the settings read fence.
      setBlockReadsOutsideWorkingDirectories: vi.fn(),
      getJudgeBreaker: vi.fn(() => ({})),
      setJudge: vi.fn(),
    };
  }),
  createPostTurnHookChain: vi.fn(() => ({ postTurnHookChain: {} })),
  createApprovalGate: vi.fn(async () => {
    h.rec("approvalGate");
    return { setConversationTitleResolver: vi.fn(), setOwnerAwayAutoSkipMinutes: vi.fn() };
  }),
  createHookRunner: vi.fn(() => ({})),
  createConversationLoop: vi.fn((deps) => {
    h.rec("conversationLoop");
    const calls = (h.captured["conversationDepsCalls"] ?? []) as unknown[];
    calls.push(deps);
    h.captured["conversationDepsCalls"] = calls;
    h.captured["mainConversationDeps"] = deps;
    return {
      getSessionId: vi.fn(() => "8e0967c0-7ae6-46b1-bac3-c6197562a52f"),
      getTurnAdditionalDirectories: vi.fn(() => []),
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

// Capture real boot closure arguments while mocking lifecycle implementations.
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
    bundledMcpCredentialSource = vi.fn(() => ({}));
  },
}));

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
    classifier: { classify: vi.fn(async () => ({ level: "low", reason: "fixture classification" })) },
    recentlyDenied: { setReplayResolver: vi.fn() },
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
    registerBundledCredentialSource = vi.fn();
  },
}));
vi.mock("../../mcp/mcp-elicitation-resolver.js", () => ({
  createElicitationResolverFactory: vi.fn(() => vi.fn()),
}));

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
  setShellSandboxRequestedAtBoot: vi.fn(),
  setPluginWorkerConfinementRequestedAtBoot: vi.fn(),
  setSandboxBootOutcome: vi.fn(),
  setWindowsSandboxSubstrate: vi.fn(),
  getWindowsSandboxSubstrate: vi.fn(() => null),
}));
vi.mock("../../permissions/asrt-sandbox.js", async () => {
  // Boot sweeps private roots; use an owned temporary home, never the real application home.
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
    closeAllEgressConnections: vi.fn(() => 0),
    isAsrtSandboxActive: vi.fn(() => false),
    normalizeUnionForAsrt: vi.fn(() => []),
    computeDynamicEndpointHosts: vi.fn(() => []),
  };
});
vi.mock("../../permissions/permission-settings-store.js", async () => {
  // No persisted judge block means judge off.
  const { normalizeJudgeSettings } = await import("../../permissions/judge/judge-settings.js");
  return {
    readPermissionSettings: vi.fn(() => ({
      permissions: { additionalDirectories: [] },
    })),
    readJudgeSettings: vi.fn(() => normalizeJudgeSettings(undefined)),
  };
});
vi.mock("../../permissions/user-approval-store.js", () => ({
  setApprovalConversationRootResolver: vi.fn(),
}));
vi.mock("../../permissions/manifest-integrity.js", () => ({
  bindManifestIntegrityAudit: vi.fn(),
  manifestIntegrityState: { onViolation: vi.fn() },
}));

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

// Mock the broadcaster to keep unrelated IPC implementations out of the boot graph.
vi.mock("../../ipc/domains/permissions.js", () => ({
  broadcastPermissionConfigChanged: vi.fn(),
}));

import { bootstrap, type AppServices } from "../../boot.js";
import { wireAnnouncementCheck } from "../steps/post-boot.js";
import { wireModelCatalogRefresh } from "../steps/model-catalog-refresh.js";

// Both boots need a scratch AVE_HOME because marketplace setup removes retired caches.
const savedAveHome = process.env["AVE_HOME"];
process.env["AVE_HOME"] = "/tmp/ave-boot-test/ave-home";
afterAll(() => {
  if (savedAveHome === undefined) delete process.env["AVE_HOME"];
  else process.env["AVE_HOME"] = savedAveHome;
});

/** Observe process warnings before boot and keep the real implementation so leak checks cannot silence their evidence. */
const emitWarningSpy = vi.spyOn(process, "emitWarning");

function emittedWarningNames(): string[] {
  return emitWarningSpy.mock.calls.map(([warning]) =>
    typeof warning === "string" ? warning : String((warning as Error)?.name ?? warning),
  );
}

function fakeWindow() {
  return {
    isDestroyed: () => false,
    webContents: { send: vi.fn(), isDestroyed: () => false },
  } as unknown as import("electron").BrowserWindow;
}

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

function bootWithWindow(
  window: Parameters<typeof bootstrap>[1],
  mode: Parameters<typeof bootstrap>[3],
) {
  return bootstrap("/tmp/ave-boot-test/project", window, () => window, mode, createBootHostFixture());
}

describe("bootstrap() integration lock", () => {
  let services: AppServices;
  let savedSandboxEnv: string | undefined;

  // Allow for transforming the whole service graph on Windows; the extra hook budget covers import cost.
  beforeAll(async () => {
    // Keep OS isolation off for a deterministic boot path without native runtime initialization.
    savedSandboxEnv = process.env["AVE_SANDBOX_ENABLED"];
    delete process.env["AVE_SANDBOX_ENABLED"];
    const win = fakeWindow();
    services = await bootWithWindow(win, "interactive");
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

  it("registers the app-plugin MCP credential source over a registry that must exist to vouch", async () => {
    const lifecycle = services.pluginBundleLifecycle as unknown as { bundledMcpCredentialSource: ReturnType<typeof vi.fn> };
    const mcp = services.mcpManager as unknown as { registerBundledCredentialSource: ReturnType<typeof vi.fn> };
    const [installedPackages] = lifecycle.bundledMcpCredentialSource.mock.calls[0] as [() => Promise<ReadonlySet<string> | undefined>];
    expect(mcp.registerBundledCredentialSource).toHaveBeenCalledWith("plugin", lifecycle.bundledMcpCredentialSource.mock.results[0]!.value);
    // An existing empty registry would retire every sign-in; use a nonexistent path.
    await expect(installedPackages()).resolves.toBeUndefined();
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
        "relaunchApp",
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
    assertBefore("core", "approvalGate");
    // Build approval, permission, and routine services before plugin construction consumes their HostApi dependencies.
    assertBefore("approvalGate", "initPluginRuntime");
    assertBefore("permissionManager", "initPluginRuntime");
    assertBefore("routinesStore", "initPluginRuntime");
    // Revocations must reach the load gate before any plugin loads.
    assertBefore("revocation", "initPluginRuntime");
    // Create plugin runtime before the conversation loop captures it.
    assertBefore("initPluginRuntime", "conversationLoop");
    // Create the loop before the late-bound sub-agent runner reuses its dependencies.
    assertBefore("conversationLoop", "subAgentRunner");
    assertBefore("lifecycleBound", "retirementsRecovered");
    assertBefore("retirementsRecovered", "startPlugins");
    // Finish boot sweeps before any confined process can write into trees scheduled for deletion.
    assertBefore("tombstonesSwept", "startPlugins");
    assertBefore("socketDiscardSwept", "startPlugins");
    // Copy state from data/ to storage/ before confined processes start; plugin loading refuses unmigrated roots.
    assertBefore("hostStorageMigrated", "initPluginRuntime");
    assertBefore("hostStorageMigrated", "startPlugins");
    // Start alert listeners before uninstall replay encounters plugin alert kinds.
    assertBefore("alertsSetup", "uninstallCleanupReplay");
    assertBefore("alertsSetup", "startPlugins");
  });

  // Drive the actual boot closures and require emitHostEvent on every uninstall path; an omitted optional callback silently loses uninstall events.
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
    // Interactive boot must wire both teardown paths without adding application listeners.
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

/** Headless boot suppresses discretionary network refreshes while retaining local revocations and plugin loading. */
describe("bootstrap() headless launch opens no discretionary service connection", () => {
  let headlessServices: AppServices;
  let savedSandboxEnv: string | undefined;

  beforeAll(async () => {
    savedSandboxEnv = process.env["AVE_SANDBOX_ENABLED"];
    delete process.env["AVE_SANDBOX_ENABLED"];
    // Assertions here isolate the headless boot from the interactive control's recorded calls.
    vi.mocked(wireAnnouncementCheck).mockClear();
    vi.mocked(wireModelCatalogRefresh).mockClear();
    h.order.length = 0;
    (h.captured["shutdownHooks"] as string[]).length = 0;
    headlessServices = await bootWithWindow(null, "headless");
  }, 180_000);

  afterAll(() => {
    if (savedSandboxEnv === undefined)
      delete process.env["AVE_SANDBOX_ENABLED"];
    else process.env["AVE_SANDBOX_ENABLED"] = savedSandboxEnv;
  });

  it("still feeds the plugin trust chain", () => {
    // Revocations and secret grants read local snapshots only.
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
    // Suppress network refresh without dropping the registry snapshot.
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
    // One-shot execution keeps main-chat tool and egress scope; unattended authority is host-issued per turn and must not be inferred from headless flags.
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
    // One-shot stderr exposes listener leaks; unordered teardown hooks must share the main process listener.
    expect((h.captured["shutdownHooks"] as string[])).toEqual([
      "watcher-telemetry",
      "diff-cache",
    ]);
    expect(h.captured["appEvents"]).toBeUndefined();
    expect(emittedWarningNames()).not.toContain("MaxListenersExceededWarning");
  });
});
