/** Wire loop-dependent services late; retain the event-bridge disposer for refresh and shutdown. */
import type { BrowserWindow } from "electron";
import { createRoutineEngine } from "../routine.js";
import { MAIN_CHAT_GROUP_ID, MAX_CHAT_GROUPS } from "../../contract/app-contract.js";
import {
  createPostTurnHookChain,
  createConversationLoop,
  createRoutineConversationLoop,
  createSideChatConversationLoop,
  createCallLlm,
  createCallLlmForPlugin,
} from "../conversation.js";
import { MemoryManager } from "../../memory/memory-manager.js";
import { openFeatureNamespace } from "../../main/storage/feature-namespace.js";
import { registerPluginEventBridge } from "./ipc-bridge.js";
import { readPermissionSettings } from "../../permissions/permission-settings-store.js";
import { approvalSurfaceRegistry } from "../../permissions/approval-surface-registry.js";
import { retainedDescendantWorkspaceRoots } from "../../permissions/workspace-root-reconciler.js";
import { broadcastPermissionConfigChangedFromHost } from "../permission-config-broadcast.js";
import { PreferenceRefreshService } from "../../memory/preference-refresh-service.js";
import { AgentsDocMergeService } from "../../memory/agents-doc-merge-service.js";
import { MemoryConsolidationService, MemoryMaintenanceCoordinator } from "../../memory/memory-consolidation-service.js";
import { MemoryReviewerService } from "../../memory/memory-reviewer-service.js";
import { SubAgentRunner } from "../../engine/subagent-runner.js";
import { A2ASubAgentMessageBus } from "../../engine/a2a-subagent-message-bus.js";
import { A2AAgentMessageBus } from "../../engine/a2a-agent-message-bus.js";
import { A2AAgentMessageMailbox } from "../../engine/a2a-agent-message-mailbox.js";
import { ParentDirectiveMailbox } from "../../engine/parent-directive-mailbox.js";
import { SubAgentMessageMailbox } from "../../engine/subagent-message-mailbox.js";
import { createWorkBoardEngine, type WorkBoardEngine,
} from "../../core/work-board-engine.js";
import { createWorkBoardReporter, type WorkBoardReporter,
} from "../../work-board/work-report.js";
import { appendMemory } from "../../work-board/work-memory.js";
import { WORK_BOARD } from "../../shared/ipc-channels.js";
import { fanOutToAllWindows } from "../../ipc/window-fanout.js";
import { emitEvent } from "../types.js";
import { createLogger } from "../../lib/logger.js";
import { createSubscriptionLlmProvider } from "../../main/subscription-llm-provider.js";
import {
  SubscriptionRuntimeServiceError,
  type SubscriptionRuntimeAuditSink,
} from "../../main/subscription-runtime-service.js";
import { validateExternalUrl } from "../../shared/external-url.js";
import type { LLMProvider } from "../../engine/llm/types.js";
import type { SubscriptionChatRuntimeSelection } from "../../shared/subscription-runtime.js";
import type { AuditLogger } from "../../audit/audit-logger.js";
import type { BootContext } from "../context.js";
import type { ConversationLoop } from "../../engine/conversation-loop.js";
import { captureRationalePolicyEpoch } from "../../tools/pipeline/rationale-policy-epoch.js";
import { localDateKey } from "../../shared/local-date.js";
import type { RationaleCoordinatorFactory } from "../../engine/turn/rationale-conversation-orchestration.js";
import type { ApprovalSurface } from "../../shared/authorization-required.js";

const log = createLogger("ave");

/** Read loops lazily and report only sessions held by a different loop. */
export function sessionHeldByOtherLoop(
  loops: () => Iterable<ConversationLoop>,
  self: () => ConversationLoop,
): (sessionId: string) => boolean {
  return (sessionId) => {
    const me = self();
    for (const loop of loops()) {
      if (loop !== me && loop.getSessionId() === sessionId) return true;
    }
    return false;
  };
}

export interface SubscriptionChatLoopBindings {
  readonly subscriptionProviderFactory: (
    selection: SubscriptionChatRuntimeSelection,
    fallbackSelection?: SubscriptionChatRuntimeSelection,
  ) => LLMProvider | null;
}

/** Accept normalized settings only; the shared runtime owns credentials and transport. */
export function createSubscriptionChatLoopBindings(input: {
  readonly shellOpenExternal: (url: string) => Promise<void>;
  readonly auditLogger: Pick<AuditLogger, "log">;
}): SubscriptionChatLoopBindings {
  const openExternal = async (url: string): Promise<void> => {
    const validated = validateExternalUrl(url);
    if (!validated.ok) {
      throw new SubscriptionRuntimeServiceError("subscription-verification-url-unavailable");
    }
    await input.shellOpenExternal(validated.url);
  };
  const audit: SubscriptionRuntimeAuditSink = (event) => {
    const requestKind = typeof event.requestKind === "string"
      && /^[a-z-]{1,80}$/.test(event.requestKind)
      ? event.requestKind
      : undefined;
    try {
      input.auditLogger.log({
        timestamp: new Date().toISOString(),
        sessionId: "subscription-runtime",
        type: "warn",
        input: JSON.stringify({
          provider: event.provider,
          outcome: event.outcome,
          ...(requestKind ? { requestKind } : {}),
        }),
      });
    } catch {
      // Audit availability must not make the provider usable or unusable.
    }
  };
  return Object.freeze({
    subscriptionProviderFactory: (
      selection: SubscriptionChatRuntimeSelection,
      fallbackSelection?: SubscriptionChatRuntimeSelection,
    ) => createSubscriptionLlmProvider({
      selection,
      ...(fallbackSelection ? { fallbackSelection } : {}),
      openExternal,
      runtimeServiceOptions: { audit },
    }),
  });
}

export interface IsolatedConversationMemoryManagers {
  sideChatMemoryManager: MemoryManager;
  subAgentMemoryManager: MemoryManager;
}

export interface LoopRationaleBindings {
  readonly rationaleCoordinatorFactory?: RationaleCoordinatorFactory;
  readonly closeRationaleSession?: (sessionId: string) => void;
}

export function createLoopRationaleBindings(input: {
  readonly service: BootContext["rationaleHostService"];
  readonly permissionManager: BootContext["permissionManager"];
  readonly hookRunner: BootContext["hookRunner"];
  readonly scriptHookManager: BootContext["scriptHookManager"];
  readonly getLoop: () => ConversationLoop;
}): LoopRationaleBindings {
  const service = input.service;
  if (!service) return {};

  const rationaleCoordinatorFactory = service.createCoordinatorFactory({
    getRationalePolicyEpoch: () =>
      captureRationalePolicyEpoch({
        permissionManager: input.permissionManager,
        hookRunner: input.hookRunner,
        scriptHookManager: input.scriptHookManager,
        additionalDirectories:
          input.getLoop().getTurnAdditionalDirectories(),
      }),
    isSessionCurrent: (sessionId) =>
      input.getLoop().getSessionId() === sessionId,
  });

  return {
    rationaleCoordinatorFactory,
    closeRationaleSession: (sessionId) => service.closeSession(sessionId),
  };
}

export function createIsolatedConversationMemoryManagers(): IsolatedConversationMemoryManagers {
  const sideChatMemoryManager = new MemoryManager({
    aveDir: openFeatureNamespace("side-chat").dir,
  });
  sideChatMemoryManager.load();
  const subAgentMemoryManager = new MemoryManager({
    aveDir: openFeatureNamespace("subagent").dir,
  });
  subAgentMemoryManager.load();
  return { sideChatMemoryManager, subAgentMemoryManager };
}

export async function wireConversation(
  ctx: BootContext,
  removedWorkspaceRoots: readonly string[],
  isolatedMemoryManagers: IsolatedConversationMemoryManagers,
  approvalSurface: ApprovalSurface,
): Promise<void> {
  const {
    settingsService,
    systemPromptBuilder,
    inputClassifier,
    routeEngine,
    toolRegistry,
    memoryManager,
    memoryCaptureService,
    permissionManager,
    approvalGate,
    hookRunner,
    scriptHookManager,
    rationaleHostService,
    bashAstValidator,
    pluginRuntime,
    pluginOperationGrants,
    pluginOperationIdentityProvider,
    bootAuditLogger,
    llmFetch,
    singleHopNetworkFetch,
    idleScheduler,
    skillOverlay,
    notificationService,
    rewireReviewerAgent,
    lateBinding,
    subAgentRunnerRef,
    workBoardStore,
    workBoardStorage,
    agentProfileStore,
    mainWindow,
    subscriptionProviderFactory,
  } = ctx;
  // User-typed skill names route to the model for skill_load.
  const isSkillName = (name: string): boolean =>
    ctx.skillStore?.listCatalogSync().some((skill) => skill.name === name) ?? false;

  const { sideChatMemoryManager, subAgentMemoryManager } = isolatedMemoryManagers;

  // Resolve the active provider when queued memory review runs, not when it is queued.
  const memoryReviewer = new MemoryReviewerService({
    resolveActiveChatOneShot: () => lateBinding.llmCallerRef.fn,
  });

  const routineLoopDeps = {
    settingsService,
    systemPromptBuilder,
    ...(ctx.tracing.enabled ? { tracer: ctx.tracing.tracer } : {}),
    inputClassifier,
    routeEngine,
    toolRegistry,
    memoryManager,
    memoryReviewer,
    permissionManager,
    approvalGate,
    approvalSurface,
    hookRunner,
    scriptHookManager,
    bashAstValidator,
    pluginRuntime,
    pluginOperationGrants,
    pluginOperationIdentityProvider,
    auditLogger: bootAuditLogger,
    llmFetch,
    networkFetch: singleHopNetworkFetch,
    subscriptionProviderFactory,
    broadcastPermissionConfigChanged: () => broadcastPermissionConfigChangedFromHost(ctx.host.desktop?.getAppWindows() ?? []),
  };
  const routineEngine = createRoutineEngine({
    createConversationLoop: (input) => createRoutineConversationLoop(
      routineLoopDeps,
      { scope: input.scope }),
    // Resolve inherited routine scope from the live active set at fire time.
    getActivePluginIds: () => pluginRuntime.listPluginIds(),
  });
  // Keep routine scope fail-closed even if durable pruning fails.
  const retainedWorkspaceRoots = readPermissionSettings().permissions.additionalDirectories;
  for (const root of removedWorkspaceRoots) {
    routineEngine.revokeWorkspaceRoot(root, {
      preserveRoots: retainedDescendantWorkspaceRoots(root, retainedWorkspaceRoots,
      ),
    });
  }

  // Maintain one event bridge per live window; adding a window must not dispose other bridges.
  const pluginEventBridges = new Map<BrowserWindow, () => void>();
  ctx.addPluginEventBridgeWindow = (win: BrowserWindow | null) => {
    if (!win) return;
    pluginEventBridges.get(win)?.();
    pluginEventBridges.delete(win);
    if (win.isDestroyed()) return;
    const dispose = registerPluginEventBridge(pluginRuntime, win,
    );
    pluginEventBridges.set(win, dispose);
  };
  ctx.refreshPluginEventBridges = () => {
    for (const win of [...pluginEventBridges.keys()]) ctx.addPluginEventBridgeWindow(win);
  };
  ctx.disposePluginEventBridge = () => {
    for (const dispose of pluginEventBridges.values()) dispose();
    pluginEventBridges.clear();
  };
  ctx.addPluginEventBridgeWindow(mainWindow);

  const { postTurnHookChain } = createPostTurnHookChain({
    memoryManager,
    idleScheduler,
    settingsService,
    memoryCaptureService,
    auditLogger: bootAuditLogger,
  });

  let conversationLoop!: ConversationLoop;
  // Main and group loops share storage, so held-session checks must inspect every other loop.
  const groupLoops = new Map<string, ConversationLoop>();
  const sessionHeldElsewhereFor = (self: () => ConversationLoop) =>
    sessionHeldByOtherLoop(() => [conversationLoop, ...groupLoops.values()], self);
  const rationaleBindings = createLoopRationaleBindings({
    service: rationaleHostService,
    permissionManager,
    hookRunner,
    scriptHookManager,
    getLoop: () => conversationLoop,
  });
  conversationLoop = createConversationLoop({
    settingsService,
    systemPromptBuilder,
    inputClassifier,
    routeEngine,
    toolRegistry,
    supportsA2AParentDelivery: true,
    memoryManager,
    memoryCaptureService,
    memoryReviewer,
    permissionManager,
    routineEngine,
    idleScheduler,
    postTurnHookChain,
    sessionGoalStore: ctx.sessionGoalStore,
    bashAstValidator,
    approvalGate,
    approvalSurface,
    hookRunner,
    scriptHookManager,
    getAdditionalDirectories: () => readPermissionSettings().permissions.additionalDirectories,
    // Every loop shares the permission-mutation broadcast callback without importing IPC.
    broadcastPermissionConfigChanged: () => broadcastPermissionConfigChangedFromHost(ctx.host.desktop?.getAppWindows() ?? []),
    pluginRuntime,
    pluginOperationGrants,
    pluginOperationIdentityProvider,
    skillOverlay,
    isSkillName,
    notificationService,
    auditLogger: bootAuditLogger,
    rewireReviewerAgent,
    llmFetch,
    networkFetch: singleHopNetworkFetch,
    subscriptionProviderFactory,
    sessionHeldElsewhere: sessionHeldElsewhereFor(() => conversationLoop),
    ...(ctx.tracing.enabled ? { tracer: ctx.tracing.tracer } : {}),
    ...rationaleBindings,
  });
  approvalSurfaceRegistry.register(conversationLoop.getSessionId(), mainWindow?.webContents ?? null);

  // Side chat uses its own feature namespace while sharing main-chat model and permission policy.
  let sideChatConversationLoop!: ConversationLoop;
  const sideChatRationaleBindings = createLoopRationaleBindings({
    service: rationaleHostService,
    permissionManager,
    hookRunner,
    scriptHookManager,
    getLoop: () => sideChatConversationLoop,
  });
  // Declare pane loops before the rail so both can check held sessions in their shared store.
  const paneLoops = new Map<string, { windowId: number; tabId: string; loop: ConversationLoop }>();
  const sideSessionHeldElsewhereFor = (self: () => ConversationLoop) =>
    sessionHeldByOtherLoop(() => [sideChatConversationLoop, ...[...paneLoops.values()].map((entry) => entry.loop)], self);
  const sideChatLoopDeps = {
    settingsService,
    ...(ctx.tracing.enabled ? { tracer: ctx.tracing.tracer } : {}),
    inputClassifier,
    routeEngine,
    toolRegistry,
    permissionManager,
    memoryReviewer,
    approvalGate,
    approvalSurface,
    hookRunner,
    scriptHookManager,
    bashAstValidator,
    pluginRuntime,
    pluginOperationGrants,
    pluginOperationIdentityProvider,
    auditLogger: bootAuditLogger,
    llmFetch,
    networkFetch: singleHopNetworkFetch,
    sideChatMemoryManager,
    getAdditionalDirectories: () => readPermissionSettings().permissions.additionalDirectories,
    subscriptionProviderFactory,
    broadcastPermissionConfigChanged: () => broadcastPermissionConfigChangedFromHost(ctx.host.desktop?.getAppWindows() ?? []),
  };
  sideChatConversationLoop = createSideChatConversationLoop({
    ...sideChatLoopDeps,
    sessionHeldElsewhere: sideSessionHeldElsewhereFor(() => sideChatConversationLoop),
    ...sideChatRationaleBindings,
  });
  ctx.sideChatConversationLoop = sideChatConversationLoop;

  // Each pane owns a loop, rationale bindings, and post-turn chain for concurrent streaming.
  const paneKey = (windowId: number, tabId: string) => `${windowId}\u0000${tabId}`;
  ctx.paneChatLoops = {
    resolve: (windowId, tabId) => {
      const existing = paneLoops.get(paneKey(windowId, tabId));
      if (existing) return existing.loop;
      let paneLoop!: ConversationLoop;
      paneLoop = createSideChatConversationLoop({
        ...sideChatLoopDeps,
        sessionHeldElsewhere: sideSessionHeldElsewhereFor(() => paneLoop),
        ...createLoopRationaleBindings({
          service: rationaleHostService,
          permissionManager,
          hookRunner,
          scriptHookManager,
          getLoop: () => paneLoop,
        }),
      });
      const owner = ctx.host.desktop?.getAppWindows().find((window) => window.id === windowId);
      approvalSurfaceRegistry.register(paneLoop.getSessionId(), owner?.webContents ?? null);
      paneLoops.set(paneKey(windowId, tabId), { windowId, tabId, loop: paneLoop });
      return paneLoop;
    },
    get: (windowId, tabId) => paneLoops.get(paneKey(windowId, tabId))?.loop,
    release: (windowId, tabId) => {
      const entry = paneLoops.get(paneKey(windowId, tabId));
      if (!entry) return undefined;
      paneLoops.delete(paneKey(windowId, tabId));
      entry.loop.abortCurrentTurn(new Error("pane chat ended"));
      approvalSurfaceRegistry.release(entry.loop.getSessionId());
      return entry.loop;
    },
    inWindow: (windowId) => [...paneLoops.values()]
      .filter((entry) => entry.windowId === windowId)
      .map(({ tabId, loop }) => ({ tabId, loop })),
    holding: (sessionId) => [...paneLoops.values()].find((entry) => entry.loop.getSessionId() === sessionId),
    all: () => [...paneLoops.values()].map((entry) => entry.loop),
  };
  ctx.sideChatMemoryManager = sideChatMemoryManager;

  // Each streaming tile needs its own loop; main-chat tiles share the main session store.
  // Only the primary loop drives window-wide idle and memory-capture services.
  const resolveChatGroupLoop = (chatGroupId: string): ConversationLoop => {
    if (chatGroupId === MAIN_CHAT_GROUP_ID) return conversationLoop;
    const existing = groupLoops.get(chatGroupId);
    if (existing) return existing;
    // The cap counts the primary loop, which is not in the map.
    if (groupLoops.size + 1 >= MAX_CHAT_GROUPS) {
      throw new Error("chat-group-limit-reached");
    }
    let groupLoop!: ConversationLoop;
    const groupRationaleBindings = createLoopRationaleBindings({
      service: rationaleHostService,
      permissionManager,
      hookRunner,
      scriptHookManager,
      getLoop: () => groupLoop,
    });
    // Each group needs its own post-turn chain to attribute persistence to the right session.
    const { postTurnHookChain: groupPostTurnHookChain } = createPostTurnHookChain({
      memoryManager,
      settingsService,
      ...(bootAuditLogger ? { auditLogger: bootAuditLogger } : {}),
    });
    groupLoop = createConversationLoop({
      settingsService,
      systemPromptBuilder,
      inputClassifier,
      routeEngine,
      toolRegistry,
      supportsA2AParentDelivery: true,
      memoryManager,
      memoryReviewer,
      permissionManager,
      routineEngine,
      postTurnHookChain: groupPostTurnHookChain,
      sessionGoalStore: ctx.sessionGoalStore,
      bashAstValidator,
      approvalGate,
      approvalSurface,
      hookRunner,
      scriptHookManager,
      getAdditionalDirectories: () => readPermissionSettings().permissions.additionalDirectories,
      broadcastPermissionConfigChanged: () => broadcastPermissionConfigChangedFromHost(ctx.host.desktop?.getAppWindows() ?? []),
      pluginRuntime,
      pluginOperationGrants,
      pluginOperationIdentityProvider,
      skillOverlay,
      isSkillName,
      notificationService,
      auditLogger: bootAuditLogger,
      rewireReviewerAgent,
      llmFetch,
      networkFetch: singleHopNetworkFetch,
      subscriptionProviderFactory,
      sessionHeldElsewhere: sessionHeldElsewhereFor(() => groupLoop),
      ...(ctx.tracing.enabled ? { tracer: ctx.tracing.tracer } : {}),
      ...groupRationaleBindings,
    });
    groupLoops.set(chatGroupId, groupLoop);
    return groupLoop;
  };
  ctx.resolveChatGroupLoop = resolveChatGroupLoop;
  // Remove closed tile loops; reloads must create fresh loops rather than reuse stale state.
  ctx.releaseChatGroupLoop = (chatGroupId: string): void => {
    const loop = groupLoops.get(chatGroupId);
    if (!loop) return;
    loop.abortCurrentTurn();
    approvalSurfaceRegistry.release(loop.getSessionId());
    groupLoops.delete(chatGroupId);
  };

  // Resolve session ownership across live loops; the primary loop cannot represent every tile.
  ctx.findLoopBySessionId = (sessionId: string): ConversationLoop | undefined =>
    [conversationLoop, ...groupLoops.values()]
      .find((loop) => loop.getSessionId() === sessionId);

  // Chrome actions target an existing tile by id; missing ids have no loop.
  ctx.findChatGroupLoop = (chatGroupId: string): ConversationLoop | undefined =>
    chatGroupId === MAIN_CHAT_GROUP_ID ? conversationLoop : groupLoops.get(chatGroupId);

  lateBinding.conversationLoopRef.fn = conversationLoop;
  lateBinding.llmCallerRef.fn = createCallLlm(conversationLoop);
  memoryCaptureService.setMemoryReviewer(memoryReviewer);
  lateBinding.pluginCallLlmRef.fn = createCallLlmForPlugin(conversationLoop, bootAuditLogger,
  );
  log.info("boot: plugin callLlm ready (rate-limited)");

  const preferenceRefreshService = new PreferenceRefreshService({
    memoryManager,
    memoryReviewer,
    isIdleRefreshEnabled: () => settingsService.get("features")?.idlePreferenceRefresh ?? false,
  });
  const agentsDocMergeService = new AgentsDocMergeService({
    memoryManager,
    memoryReviewer,
  });
  const memoryConsolidationService = new MemoryConsolidationService({
    memoryManager,
    memoryReviewer,
    isIdleConsolidationEnabled: () => settingsService.get("features")?.idleMemoryConsolidation ?? false,
  });
  // One idle listener serializes preference refresh before memory consolidation.
  const memoryMaintenanceCoordinator = new MemoryMaintenanceCoordinator({
    memoryCaptureService,
    idleScheduler,
    preferenceRefreshService,
    memoryConsolidationService,
    getCurrentProject: () => conversationLoop.getSessionProjectIsDefault?.()
      ? undefined
      : conversationLoop.getSessionMemoryProjectContext?.(),
  });
  memoryMaintenanceCoordinator.start();

  // Use a dedicated feature namespace so sub-agent transcripts stay out of the main session list.
  const subAgentMessagingNamespace = openFeatureNamespace("subagent-messaging");
  const subAgentMessageMailbox = new SubAgentMessageMailbox(
    subAgentMessagingNamespace,
  );
  const subAgentMessageBus = new A2ASubAgentMessageBus({
    parentLoop: conversationLoop,
    mailbox: subAgentMessageMailbox,
    settingsService,
    auditLogger: bootAuditLogger,
    resolveChildAddress: async (parentSessionId, childSessionId, messageId) => {
      const runner = subAgentRunnerRef.fn;
      return runner
        ? await runner.resolveSubAgentAddress(parentSessionId, childSessionId, messageId,
          )
        : null;
    },
    releaseEphemeralChildAddress: (parentSessionId, childSessionId, messageId,
    ) =>
      subAgentRunnerRef.fn?.releaseEphemeralParentDelivery(
        parentSessionId,
        childSessionId,
        messageId,
      ),
  });
  // Wake pending messages after the parent releases its turn, even without a round boundary.
  conversationLoop.onTurnSettled((sessionId) => {
    subAgentMessageBus.notifyTurnSettled(sessionId);
  });
  const agentMessageMailbox = new A2AAgentMessageMailbox(
    subAgentMessagingNamespace,
  );
  // Keep one messaging domain directory and a separate store for each edge.
  const parentDirectiveMailbox = new ParentDirectiveMailbox(
    subAgentMessagingNamespace,
  );
  const agentMessageBus = new A2AAgentMessageBus({
    parentBus: subAgentMessageBus,
    mailbox: agentMessageMailbox,
    auditLogger: bootAuditLogger,
    isOriginActive: (originSessionId) =>
      subAgentRunnerRef.fn?.isSubAgentOriginActive(originSessionId) ?? true,
    resolveSender: async (senderChildSessionId) => {
      const runner = subAgentRunnerRef.fn;
      return runner ? await runner.resolveSubAgentSender(senderChildSessionId) : null;
    },
    resolvePeer: async (
      senderChildSessionId,
      recipientChildSessionId) => {
      const runner = subAgentRunnerRef.fn;
      return runner
        ? await runner.resolveSubAgentPeer(
            senderChildSessionId,
            recipientChildSessionId,
          )
        : { ok: false, reason: "unknown-sender" };
    },
  });

  // Reuse parent dependencies, but construct a fresh loop for each sub-agent.
  subAgentRunnerRef.fn = new SubAgentRunner({
    parentDeps: {
      settingsService,
      systemPromptBuilder,
      inputClassifier,
      routeEngine,
      toolRegistry,
      memoryManager,
      memoryReviewer,
      permissionManager,
      approvalGate,
      approvalSurface,
      bashAstValidator,
      hookRunner,
      scriptHookManager,
      pluginOperationGrants,
      pluginOperationIdentityProvider,
      auditLogger: bootAuditLogger,
      getAdditionalDirectories: () => readPermissionSettings().permissions.additionalDirectories,
      ...(conversationLoop.deps?.isDefaultProjectRoot
        ? { isDefaultProjectRoot: conversationLoop.deps.isDefaultProjectRoot }
        : {}),
      ...(conversationLoop.deps?.getDefaultProject
        ? { getDefaultProject: conversationLoop.deps.getDefaultProject }
        : {}),
      ...(conversationLoop.deps?.authorizeProject
        ? { authorizeProject: conversationLoop.deps.authorizeProject }
        : {}),
      rewireReviewerAgent,
      llmFetch,
      networkFetch: singleHopNetworkFetch,
      subscriptionProviderFactory,
    },
    toolRegistry,
    subAgentMemoryManager,
    messageBus: subAgentMessageBus,
    agentMessageBus,
    parentDirectiveMailbox,
  });
  // Skill bodies are tool results; skill_load records authorization for later skill_read calls.

  // Create the Work Board engine after its runner dependency exists.
  const workBoardEngine: WorkBoardEngine = createWorkBoardEngine({
    store: workBoardStore,
    getRunner: () => subAgentRunnerRef.fn,
    approvalGate,
    getAgentProfile: (name) => agentProfileStore.load(name),
    emitProgress: (event) => {
      // Broadcast run progress to every open window so detached panels stay current.
      fanOutToAllWindows(ctx.host.desktop?.getAppWindows() ?? [], WORK_BOARD.runProgress, event, {
        logger: log,
      },
      );
    },
    // Append bounded project learnings best-effort; memory failures must not fail a run.
    onRunComplete: ({ itemId, title, projectRoot }) =>
      appendMemory(workBoardStorage, [
        `${localDateKey(new Date())}: autonomous run completed — #${itemId} ${title}`,
        ],
        projectRoot ? { projectRoot } : undefined,
      ),
    // Persist each run’s conversations so context survives restart and accumulates across reruns.
    transcriptStorage: workBoardStorage,
  });

  const workBoardReporter: WorkBoardReporter = createWorkBoardReporter({
    store: workBoardStore,
    storage: workBoardStorage,
    callLlm: lateBinding.llmCallerRef.fn,
    emit: emitEvent,
  });

  ctx.routineEngine = routineEngine;
  ctx.postTurnHookChain = postTurnHookChain;
  ctx.conversationLoop = conversationLoop;
  ctx.preferenceRefreshService = preferenceRefreshService;
  ctx.agentsDocMergeService = agentsDocMergeService;
  ctx.memoryConsolidationService = memoryConsolidationService;
  ctx.memoryMaintenanceCoordinator = memoryMaintenanceCoordinator;
  ctx.workBoardEngine = workBoardEngine;
  ctx.workBoardReporter = workBoardReporter;
}
