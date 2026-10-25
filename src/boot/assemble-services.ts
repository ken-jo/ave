import { requireDesktopHost } from "./host-runtime.js";
/** Lifecycle closures share mutable boot context so timers and event disposers survive window recreation. */
import {
  forgetTrackedPluginAuthPartitions as forgetPluginAuthPartitionsService,
  getTrackedPluginAuthPartitions as listPluginAuthPartitionsService,
} from "../main/plugin-auth-partition-tracker.js";
import type { AppServices } from "./types.js";
import type { ReadyBootContext } from "./context.js";

export function assembleAppServices(ctx: ReadyBootContext): AppServices {
  let shutdownPromise: Promise<void> | null = null;
  let activeLlmWildcardDisposed = false;

  // Dispose before plugin shutdown hooks so pending vendor-change work cannot restart plugins.
  const disposeActiveLlmWildcard = (): void => {
    if (activeLlmWildcardDisposed) return;
    ctx.disposeRefreshActiveLlmWildcard();
    activeLlmWildcardDisposed = true;
  };

  return {
    relaunchApp: () => ctx.host.relaunch(),
    pythonRuntime: ctx.pythonRuntime,
    pythonPath: ctx.pythonPath,
    pluginRuntime: ctx.pluginRuntime,
    pluginMarketplace: ctx.pluginMarketplace,
    settingsService: ctx.settingsService,
    flushTracing: () => ctx.tracing.forceFlush(),
    a2aRemoteRuntime: ctx.a2aRemoteRuntime,
    remoteA2AActionController: ctx.remoteA2AActionController,
    remoteA2AStartFailureReason: ctx.remoteA2AStartFailureReason,
    remoteA2ABootGates: ctx.remoteA2ABootGates,
    memoryManager: ctx.memoryManager,
    memoryCaptureService: ctx.memoryCaptureService,
    inputClassifier: ctx.inputClassifier,
    routeEngine: ctx.routeEngine,
    toolRegistry: ctx.toolRegistry,
    systemPromptBuilder: ctx.systemPromptBuilder,
    // Share the prompt builder’s context store; IPC is its only writer.
    mcpAppModelContext: ctx.mcpAppModelContext,
    conversationLoop: ctx.conversationLoop,
    sideChatConversationLoop: ctx.sideChatConversationLoop,
    paneChatLoops: ctx.paneChatLoops,
    sideChatMemoryManager: ctx.sideChatMemoryManager,
    // Pass group-loop resolution through to IPC so secondary chat groups can be built.
    resolveChatGroupLoop: ctx.resolveChatGroupLoop,
    releaseChatGroupLoop: ctx.releaseChatGroupLoop,
    findLoopBySessionId: ctx.findLoopBySessionId,
    findChatGroupLoop: ctx.findChatGroupLoop,
    routineEngine: ctx.routineEngine,
    mcpManager: ctx.mcpManager,
    pluginLoopbackManager: ctx.pluginLoopbackManager,
    pluginBundleLifecycle: ctx.pluginBundleLifecycle,
    getPluginToolInvoker: () => ctx.lateBinding.pluginToolInvokerRef.fn,
    requestPluginOperationGrant: ctx.requestPluginOperationGrant,
    revokePluginOperationSession: ctx.revokePluginOperationSession,
    idleScheduler: ctx.idleScheduler,
    preferenceRefreshService: ctx.preferenceRefreshService,
    agentsDocMergeService: ctx.agentsDocMergeService,
    memoryConsolidationService: ctx.memoryConsolidationService,
    memoryMaintenanceCoordinator: ctx.memoryMaintenanceCoordinator,
    bashAstValidator: ctx.bashAstValidator,
    auditService: ctx.auditService,
    auditLogger: ctx.bootAuditLogger,
    postTurnHookChain: ctx.postTurnHookChain,
    approvalGate: ctx.approvalGate,
    rewireReviewerAgent: ctx.rewireReviewerAgent,
    getApprovalSentenceSelector: () => ctx.approvalSentenceSelector,
    refreshActiveLlmWildcard: ctx.refreshActiveLlmWildcard,
    refreshSandboxNetworkConfig: ctx.refreshSandboxNetworkConfig,
    routinesStore: ctx.routinesStore,
    routinesScheduler: ctx.routinesScheduler,
    workBoardStore: ctx.workBoardStore,
    alertsService: ctx.alertsService,
    workBoardEngine: ctx.workBoardEngine,
    workBoardReport: ctx.workBoardReporter,
    sessionTasksStore: ctx.sessionTasksStore,
    sessionGoalStore: ctx.sessionGoalStore,
    getSubAgentRunner: () => ctx.subAgentRunnerRef.fn,
    askUserQuestionGate: ctx.askUserQuestionGate,
    skillStore: ctx.skillStore,
    agentProfileStore: ctx.agentProfileStore,
    personaPromptStore: ctx.personaPromptStore,
    starredStore: ctx.starredStore,
    feedbackStore: ctx.feedbackStore,
    notificationService: ctx.notificationService,
    scriptHookManager: ctx.scriptHookManager,
    singleHopNetworkFetch: ctx.singleHopNetworkFetch,
    telemetry: ctx.telemetry,
    pluginTelemetry: ctx.pluginTelemetry,
    autoUpdaterStop: ctx.autoUpdaterStop,
    runPluginShutdownHandlers: async () => {
      disposeActiveLlmWildcard();
      await ctx.runPluginShutdownHandlers();
    },
    pluginPaths: ctx.pluginPaths,
    clearAuthPartitionService: (partition) => requireDesktopHost(ctx.host).clearAuthPartitionService(partition),
    forgetPluginAuthPartitionsService,
    listPluginAuthPartitionsService,
    startRoutinesScheduler: () => ctx.routinesScheduler.start(),
    startWorkBoardDueSoon: ctx.startWorkBoardDueSoon,
    startAlerts: () => ctx.alertsService.start(),
    refreshPluginEventBridge: () => {
      ctx.refreshPluginEventBridges();
    },
    registerPluginEventBridge: ctx.addPluginEventBridgeWindow,
    shutdown: () => {
      if (shutdownPromise) return shutdownPromise;
      shutdownPromise = (async () => {
        const errors: unknown[] = [];
        const attempt = (operation: () => void): void => {
          try {
            operation();
          } catch (error) {
            errors.push(error);
          }
        };
        const attemptAsync = async (
          operation: () => Promise<void>,
        ): Promise<void> => {
          try {
            await operation();
          } catch (error) {
            errors.push(error);
          }
        };

        // Direct callers bypass the app-level plugin-shutdown phase.
        attempt(disposeActiveLlmWildcard);
        attempt(() => ctx.disposePluginEventBridge());
        attempt(() => ctx.autoUpdaterStop?.());
        attempt(() => ctx.telemetry?.stop());
        attempt(() => ctx.pluginTelemetry?.stop());
        attempt(() => ctx.memoryMaintenanceCoordinator.stop());
        attempt(() => ctx.memoryCaptureService.stop());
        attempt(() => ctx.preferenceRefreshService.stop());
        attempt(() => ctx.idleScheduler?.stop());
        attempt(() => ctx.a2aRemoteRuntime?.dispose());
        attempt(() => ctx.routinesScheduler.stop());
        if (ctx.dueSoonTimer) attempt(() => clearInterval(ctx.dueSoonTimer));
        attempt(() => ctx.alertsService.stop());

        attempt(() => ctx.conversationLoop.abortCurrentTurn(new Error("application shutdown"),
          ),
        );
        attempt(() => ctx.sideChatConversationLoop.abortCurrentTurn(new Error("application shutdown"),
          ),
        );
        for (const paneLoop of ctx.paneChatLoops.all()) {
          attempt(() => paneLoop.abortCurrentTurn(new Error("application shutdown")));
        }
        attempt(() => ctx.rationaleHostService?.shutdown());

        attempt(() => ctx.approvalGate.disposeAll());
        attempt(() => ctx.askUserQuestionGate.disposeAll());
        attempt(() => ctx.mcpGovernance.stopPolicyRefresh());
        await attemptAsync(() => ctx.mcpManager.disconnectAll());
        await attemptAsync(() => ctx.bootAuditLogger.close());
        await attemptAsync(() => ctx.auditService.stop());
        await attemptAsync(() => ctx.tracing.shutdown());

        if (errors.length > 0) {
          throw new AggregateError(errors, "application service shutdown failed",
          );
        }
      })();
      return shutdownPromise;
    },
  };
}
