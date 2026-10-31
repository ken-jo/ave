import type { BootHost } from "./host-runtime.js";
import type { AppServices, PaneChatLoops } from "./types.js";
import type { HostFetchTransport } from "../main/host-fetch-guard.js";
import type { WorkerEgressAllowlists } from "../permissions/egress-runtime.js";
/** Boot steps progressively populate one context with services and boot-only dependencies.
 * An exhaustive own-property gate proves required producers ran before assembly. */
import type { BrowserWindow } from "electron";
import type { AveHomeDocUpgradeMarker } from "../main/seed-ave-home-docs.js";
import type { PythonRuntimeBootstrapper } from "../main/python-runtime.js";
import type { BashAstValidator } from "../main/bash-ast-validator.js";
import type { AuditService } from "../main/audit-service.js";
import type { SettingsService } from "../data/settings-store.js";
import type { MemoryManager } from "../memory/memory-manager.js";
import type { MemoryCaptureService } from "../memory/memory-capture-service.js";
import type { InputClassifier } from "../core/input-classifier.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { RouteEngine } from "../core/route-engine.js";
import type { AuditLogger } from "../audit/audit-logger.js";
import type { LLMProvider } from "../engine/llm/types.js";
import type { NotificationService } from "../main/notification-service.js";
import type { ApprovalGate } from "../permissions/approval-gate.js";
import type { PermissionManager } from "../permissions/permission-manager.js";
import type { RoutinesStore } from "../main/routines-store.js";
import type { RoutinesScheduler } from "../main/routines-scheduler.js";
import type { PluginRuntime } from "../plugins/runtime.js";
import type { PluginDeploymentGuard } from "../plugins/deployment-guard.js";
import type { LateBindingRefs } from "./steps/plugin-runtime.js";
import type { WorkBoardStore } from "../main/work-board-store.js";
import type { AlertsService } from "../alerts/service.js";
import type { WorkBoardEngine } from "../core/work-board-engine.js";
import type { WorkBoardReporter } from "../work-board/work-report.js";
import type { SessionTasksStore } from "../main/session-tasks-store.js";
import type { SessionGoalStore } from "../main/session-goal-store.js";
import type { SkillStore } from "../main/skill-store.js";
import type { AgentProfileStore } from "../main/agent-profile-store.js";
import type { PersonaPromptStore } from "../main/persona-prompt-store.js";
import type { SkillOverlay } from "../main/skill-overlay.js";
import type { SkillApprovalsStore } from "../main/skill-approvals-store.js";
import type { AskUserQuestionGate } from "../main/ask-user-question-gate.js";
import type { SubAgentRunner } from "../engine/subagent-runner.js";
import type { IdleSchedulerService } from "../main/idle-scheduler.js";
import type { PluginMarketplaceService } from "../plugins/marketplace.js";
import type { SystemPromptBuilder } from "../prompts/system-prompt-builder.js";
import type { McpAppModelContextStore } from "../mcp/mcp-app-model-context.js";
import type { RoutineEngine } from "../routines/routine-engine.js";
import type { PostTurnHookChain } from "../hooks/post-turn-hook-chain.js";
import type { ConversationLoop } from "../engine/conversation-loop.js";
import type { PreferenceRefreshService } from "../memory/preference-refresh-service.js";
import type { AgentsDocMergeService } from "../memory/agents-doc-merge-service.js";
import type { MemoryConsolidationService, MemoryMaintenanceCoordinator } from "../memory/memory-consolidation-service.js";
import type { McpManager } from "../mcp/mcp-manager.js";
import type { PluginLoopbackManager } from "../mcp/plugin-loopback-manager.js";
import type { McpGovernance } from "../mcp/mcp-governance.js";
import type { StarredStore } from "../data/starred-store.js";
import type { FeedbackStore } from "../data/feedback-store.js";
import type { TelemetryService } from "../main/telemetry.js";
import type { PluginTelemetryClient } from "../telemetry/client.js";
import type { HookRunner } from "../hooks/hook-runner.js";
import type { ScriptHookManager } from "../hooks/script-hook-manager.js";
import type { RationaleScopeReviewer } from "../permissions/reviewer/rationale-scope-reviewer.js";
import type { ApprovalSentenceSelector } from "../permissions/reviewer/approval-sentence-selector.js";
import type { RationaleHostService } from "../tools/pipeline/rationale-host-service.js";
import type { A2ARemoteRuntime } from "../main/a2a-remote-runtime.js";
import type { A2ARemoteGateSnapshot } from "../main/a2a-remote-gates.js";
import type { RemoteA2AActionController } from "../main/remote-a2a-action-controller.js";
import type { PluginBundleLifecycle } from "../plugins/plugin-bundle-lifecycle.js";
import type { PluginOperationGrantCoordinator } from "../permissions/plugin-operation-grant.js";
import type { PluginOperationIdentityProvider } from "../tools/invocation-services.js";
import type { SubscriptionChatRuntimeSelection } from "../shared/subscription-runtime.js";
import type { TracingHandle } from "../engine/telemetry/tracing.js";

type PluginPaths = ReturnType<typeof import("../plugins/plugin-paths.js").resolvePluginPaths>;
type WorkBoardStorage = ReturnType<typeof import("../work-board/storage.js").createDirStorage>;

export interface BootContextInputs {
  host: BootHost;
  projectRoot: string;
  mainWindow: BrowserWindow | null;
  getMainWindow: () => BrowserWindow | null;
}

export class BootContext {
  declare readonly host: BootHost;
  // ── Inputs (available immediately) ─────────────────────────────────────────
  declare readonly projectRoot: string;
  declare readonly mainWindow: BrowserWindow | null;
  declare readonly getMainWindow: () => BrowserWindow | null;

  // Always present, disabled unless `AVE_TELEMETRY` names a sink. Held on the context so
  // post-boot can flush it on quit and the conversation wiring can hand its tracer to the loops.
  declare tracing: TracingHandle;

  // ── Network fetch surface (setupNetworkFetch) ──────────────────────────────
  declare networkFetch: typeof fetch;
  declare singleHopNetworkFetch: HostFetchTransport;
  declare llmFetch: typeof fetch;

  // ── Home docs seed ─────────────────────────────────────────────────────────
  declare aveHomeDocUpgradeMarkers: AveHomeDocUpgradeMarker[];

  // ── Core services (bootstrapCoreServices) ──────────────────────────────────
  declare pythonPath: string | undefined;
  declare pythonRuntime: PythonRuntimeBootstrapper;
  declare bashAstValidator: BashAstValidator;
  declare auditService: AuditService;
  declare settingsService: SettingsService;
  declare a2aRemoteRuntime: A2ARemoteRuntime | undefined;
  declare remoteA2AActionController: RemoteA2AActionController | undefined;
  declare remoteA2AStartFailureReason: string | undefined;
  declare remoteA2ABootGates: Readonly<A2ARemoteGateSnapshot>;
  declare memoryManager: MemoryManager;
  declare memoryCaptureService: MemoryCaptureService;
  declare inputClassifier: InputClassifier;
  declare toolRegistry: ToolRegistry;
  declare routeEngine: RouteEngine;

  // ── Audit + notification (setupAuditAndNotification) ───────────────────────
  declare bootAuditLogger: AuditLogger;
  declare notificationService: NotificationService;

  // ── Approval / permission / routines (pre-plugin-runtime) ──────────────────
  declare approvalGate: ApprovalGate;
  declare permissionManager: PermissionManager;
  declare routinesStore: RoutinesStore;

  // ── Plugin runtime (initPluginRuntime) ─────────────────────────────────────
  declare pluginRuntime: PluginRuntime;
  declare deploymentGuard: PluginDeploymentGuard;
  declare lateBinding: LateBindingRefs;
  declare runPluginShutdownHandlers: () => Promise<void>;
  declare pluginPaths: PluginPaths;

  // ── Workflow services + stores ─────────────────────────────────────────────
  declare routinesScheduler: RoutinesScheduler;
  declare workBoardStore: WorkBoardStore;
  declare workBoardStorage: WorkBoardStorage;
  declare dueSoonTimer: ReturnType<typeof setInterval> | undefined;
  declare startWorkBoardDueSoon: () => void;
  declare alertsService: AlertsService;
  declare sessionTasksStore: SessionTasksStore;
  declare sessionGoalStore: SessionGoalStore;
  declare skillStore: SkillStore;
  declare agentProfileStore: AgentProfileStore;
  declare personaPromptStore: PersonaPromptStore;
  declare skillOverlay: SkillOverlay;
  declare skillApprovalsStore: SkillApprovalsStore;
  declare askUserQuestionGate: AskUserQuestionGate;
  declare subAgentRunnerRef: { fn: SubAgentRunner | undefined };
  /** Root conversation of a session (sub-agent ancestry); shared by session approvals and the judge. */
  declare resolveRootSessionId: (sessionId: string) => string;
  declare idleScheduler: IdleSchedulerService | undefined;

  // ── Marketplace (setupMarketplace) ─────────────────────────────────────────
  declare pluginMarketplace: PluginMarketplaceService;
  declare refreshActiveLlmWildcard: () => void;
  declare disposeRefreshActiveLlmWildcard: () => void;
  declare refreshSandboxNetworkConfig: () => Promise<void>;
  declare buildWorkerEgressAllowlists: () => Promise<WorkerEgressAllowlists>;

  // ── Prompt / reviewer wiring ───────────────────────────────────────────────
  declare systemPromptBuilder: SystemPromptBuilder;
  /** One main-owned subscription transport factory shared by reviewer and chat loops. */
  declare subscriptionProviderFactory: (
    selection: SubscriptionChatRuntimeSelection,
    fallbackSelection?: SubscriptionChatRuntimeSelection,
  ) => LLMProvider | null;
  /** Gated IPC writes card context slots; prompt construction reads them at turn build, with no push-triggered turns. */
  declare mcpAppModelContext: McpAppModelContextStore;
  declare rationaleScopeReviewer: RationaleScopeReviewer;
  declare approvalSentenceSelector: ApprovalSentenceSelector;
  declare rationaleHostService: RationaleHostService | undefined;
  declare rewireReviewerAgent: () => void;

  // ── Hooks + plugin tool execution surface ──────────────────────────────────
  declare hookRunner: HookRunner;
  declare scriptHookManager: ScriptHookManager;
  declare pluginBundleLifecycle: PluginBundleLifecycle | undefined;
  declare pluginOperationGrants: PluginOperationGrantCoordinator;
  declare pluginOperationIdentityProvider: PluginOperationIdentityProvider;
  declare requestPluginOperationGrant: AppServices["requestPluginOperationGrant"];
  declare revokePluginOperationGeneration: (pluginId: string, generationId: string,
  ) => void;
  declare revokePluginOperationSession: (appSessionId: string) => void;

  // ── Conversation / agent loop ──────────────────────────────────────────────
  declare routineEngine: RoutineEngine;
  declare postTurnHookChain: PostTurnHookChain;
  declare conversationLoop: ConversationLoop;
  /** Side-chat (workspace rail); 2nd loop with isolated `~/.ave/side-chat/` store. */
  declare sideChatConversationLoop: ConversationLoop;
  declare paneChatLoops: PaneChatLoops;
  /** The side-chat store; the conversation list reads it beside the main one. */
  declare sideChatMemoryManager: MemoryManager;
  declare resolveChatGroupLoop: (chatGroupId: string) => ConversationLoop;
  declare releaseChatGroupLoop: (chatGroupId: string) => void;
  declare findLoopBySessionId: (sessionId: string) => ConversationLoop | undefined;
  declare findChatGroupLoop: (chatGroupId: string) => ConversationLoop | undefined;
  declare preferenceRefreshService: PreferenceRefreshService;
  declare agentsDocMergeService: AgentsDocMergeService;
  declare memoryConsolidationService: MemoryConsolidationService;
  declare memoryMaintenanceCoordinator: MemoryMaintenanceCoordinator;
  declare workBoardEngine: WorkBoardEngine;
  declare workBoardReporter: WorkBoardReporter;

  // Dispose every main window's plugin event bridge.
  declare disposePluginEventBridge: () => void;
  declare addPluginEventBridgeWindow: (win: BrowserWindow | null) => void;
  declare refreshPluginEventBridges: () => void;

  declare mcpGovernance: McpGovernance;
  declare mcpManager: McpManager;
  /** Owns each plugin's loopback MCP host; the loopback-first arm of the render IPC's `ui://` resolver. */
  declare pluginLoopbackManager: PluginLoopbackManager;

  // ── Starred / feedback ─────────────────────────────────────────────────────
  declare starredStore: StarredStore;
  declare feedbackStore: FeedbackStore;

  // ── Post-boot release prep ─────────────────────────────────────────────────
  declare telemetry: TelemetryService | undefined;
  declare pluginTelemetry: PluginTelemetryClient | undefined;
  declare autoUpdaterStop: (() => void) | undefined;

  constructor(inputs: BootContextInputs) {
    this.host = inputs.host;
    this.projectRoot = inputs.projectRoot;
    this.mainWindow = inputs.mainWindow;
    this.getMainWindow = inputs.getMainWindow;
    this.dueSoonTimer = undefined;
  }
}

const BOOT_CONTEXT_FIELDS = [
  "host",
  "projectRoot",
  "mainWindow",
  "getMainWindow",
  "tracing",
  "networkFetch",
  "singleHopNetworkFetch",
  "llmFetch",
  "aveHomeDocUpgradeMarkers",
  "pythonPath",
  "pythonRuntime",
  "bashAstValidator",
  "auditService",
  "settingsService",
  "a2aRemoteRuntime",
  "remoteA2AActionController",
  "remoteA2AStartFailureReason",
  "remoteA2ABootGates",
  "memoryManager",
  "memoryCaptureService",
  "inputClassifier",
  "toolRegistry",
  "routeEngine",
  "bootAuditLogger",
  "notificationService",
  "approvalGate",
  "permissionManager",
  "routinesStore",
  "pluginRuntime",
  "deploymentGuard",
  "lateBinding",
  "runPluginShutdownHandlers",
  "pluginPaths",
  "routinesScheduler",
  "workBoardStore",
  "workBoardStorage",
  "dueSoonTimer",
  "startWorkBoardDueSoon",
  "alertsService",
  "sessionTasksStore",
  "sessionGoalStore",
  "skillStore",
  "agentProfileStore",
  "personaPromptStore",
  "skillOverlay",
  "skillApprovalsStore",
  "askUserQuestionGate",
  "subAgentRunnerRef",
  "resolveRootSessionId",
  "idleScheduler",
  "pluginMarketplace",
  "refreshActiveLlmWildcard",
  "disposeRefreshActiveLlmWildcard",
  "refreshSandboxNetworkConfig",
  "buildWorkerEgressAllowlists",
  "systemPromptBuilder",
  "subscriptionProviderFactory",
  "mcpAppModelContext",
  "rationaleScopeReviewer",
  "approvalSentenceSelector",
  "rationaleHostService",
  "rewireReviewerAgent",
  "hookRunner",
  "scriptHookManager",
  "pluginBundleLifecycle",
  "pluginOperationGrants",
  "pluginOperationIdentityProvider",
  "requestPluginOperationGrant",
  "revokePluginOperationGeneration",
  "revokePluginOperationSession",
  "routineEngine",
  "postTurnHookChain",
  "conversationLoop",
  "sideChatConversationLoop",
  "paneChatLoops",
  "sideChatMemoryManager",
  "resolveChatGroupLoop",
  "releaseChatGroupLoop",
  "findLoopBySessionId",
  "findChatGroupLoop",
  "preferenceRefreshService",
  "agentsDocMergeService",
  "memoryConsolidationService",
  "memoryMaintenanceCoordinator",
  "workBoardEngine",
  "workBoardReporter",
  "disposePluginEventBridge",
  "addPluginEventBridgeWindow",
  "refreshPluginEventBridges",
  "mcpGovernance",
  "mcpManager",
  "pluginLoopbackManager",
  "starredStore",
  "feedbackStore",
  "telemetry",
  "pluginTelemetry",
  "autoUpdaterStop",
] as const satisfies readonly (keyof BootContext)[];

type MissingBootContextField = Exclude<keyof BootContext,
  (typeof BOOT_CONTEXT_FIELDS)[number]>;
const bootContextFieldListIsExhaustive: MissingBootContextField extends never ? true : never = true;
void bootContextFieldListIsExhaustive;

declare const READY_BOOT_CONTEXT: unique symbol;
export type ReadyBootContext = BootContext & { readonly [READY_BOOT_CONTEXT]: true;
};

/** Own-property checks distinguish explicitly produced undefined from a producer that never ran. */
export function assertBootContextReady(ctx: BootContext,
): asserts ctx is ReadyBootContext {
  const missing = BOOT_CONTEXT_FIELDS.filter((field) => !Object.hasOwn(ctx, field),
  );
  if (missing.length > 0) {
    throw new Error(`boot-context-incomplete: missing ${missing.join(", ")}`);
  }
}

/** Staged fields become own properties only when their producer assigns them; assert readiness before assembly. */
export function createBootContext(inputs: BootContextInputs): BootContext {
  return new BootContext(inputs);
}
