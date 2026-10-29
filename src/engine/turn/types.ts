import type {
  GenericMessage,
  LLMProvider,
  TokenUsage,

  TokenUsageByModel,
  ToolSchema,
  TurnSummary,
  UserContentPart,
} from "../llm/types.js";
import type { ActiveRolePrompt } from "../../data/role-presets.js";
import type { A2AAgentCausalContext } from "../a2a-agent-message-envelope.js";
import type {
  SubscriptionChatRuntimeSelection,
  SubscriptionUsageTelemetry,
} from "../../shared/subscription-runtime.js";
import type { RequestInputProjection } from "../request-input-projection.js";
import type { CompressionStatus } from "../../shared/compact-status.js";
import type { FallbackStatus } from "../llm/vercel/fallback-chain.js";
import type { ToolCallMeta } from "../../tools/executor.js";
import type { ChatInputOrigin, RemoteControllerAuthority } from "../../shared/chat-origin.js";
import type { PermissionReviewEvent } from "../../shared/permission-review-status.js";
import type { ToolSource } from "../../tools/types.js";
import type { SettingsService } from "../../data/settings-store.js";
import type { SystemPromptBuilder } from "../../prompts/system-prompt-builder.js";
import type { InputClassifier } from "../../core/input-classifier.js";
import type { RouteEngine } from "../../core/route-engine.js";
import type { ToolRegistry } from "../../tools/registry.js";
import type { MemoryManager } from "../../memory/memory-manager.js";
import type { MemoryCaptureService } from "../../memory/memory-capture-service.js";
import type { MemoryReviewerService } from "../../memory/memory-reviewer-service.js";
import type { RoutineEngine } from "../../routines/routine-engine.js";
import type { IdleSchedulerService } from "../../main/idle-scheduler.js";
import type { PostTurnHookChain } from "../../hooks/post-turn-hook-chain.js";
import type { HookRunner } from "../../hooks/hook-runner.js";
import type { AuditLogger } from "../../audit/audit-logger.js";
import type { HookTrustCommandOptions } from "../../hooks/hook-trust-commands.js";
import type { RationaleCoordinatorFactory } from "./rationale-conversation-orchestration.js";
import type { ExecutionMode } from "../../shared/permission-mode.js";
import type {
  ApprovalSurface,
  AuthorizationRequiredState,
  UnattendedTurnAuthority,
} from "../../shared/authorization-required.js";

export interface WorkspaceRootRevocationOptions {
  // The removed root belonged to the pre-persist global scope snapshot.
  globalScopeWasAuthorized?: boolean;
  // Independently registered descendants retain their own authorization.
  preserveRoots?: readonly string[];
}

export interface GuidanceInjectionSource {
  kind: "sub-agent";
  // Omit a child title when multiple children share the batch.
  title?: string;
}

interface GuidanceInjectionRow {
  // Match live injected bubbles and reloaded row actions through one durable user-row ID.
  messageId: string;
  // Child-report framing applies only when every entry is child-authored.
  source?: GuidanceInjectionSource;
}

// Decisions classify loop branches, not individual provider calls.
export type TurnDecisionKind =
  | "tool_batch"
  | "tool_schema.drop"
  // Malformed argument calls receive an error result instead of execution.
  | "tool_call.invalid_arguments"
  | "length.continuation"
  | "reasoning_only.continuation"
  | "tool_search"
  | "plugin.expansion"
  | "compact.micro"
  | "progress.nudge"
  // In-turn preflight invokes summary compaction; micro-compaction only stubs stale wire results.
  | "compact.auto"
  | "early_exit";

export interface TurnDecisionEvent {
  kind: TurnDecisionKind;
  branch: string;
  reason?: string;
  // Export only branch counts and bounds, never prompts or tool input/output.
  data?: Record<string, string | number | boolean>;
}

export interface TurnCallbacks {
  onReasoningDelta?: (text: string) => void;
  onTextDelta?: (text: string) => void;
  onToolStart?: (name: string, input: Record<string, unknown>, meta: ToolCallMeta,
  ) => void;
  onToolOutput?: (name: string, text: string, meta: ToolCallMeta) => void;
  onPermissionReview?: (event: PermissionReviewEvent) => void;
  onToolEnd?: (
    name: string,
    result: string,
    isError: boolean,
    meta: ToolCallMeta,
    uiPayload: import("../../mcp/types.js").McpUiPayload | undefined,
    durationMs: number,
  ) => void;
  onAssistantRound?: (round: {
    roundIndex: number;
    text: string;
    thought: string;
    stopReason: "end_turn" | "tool_use" | "max_tokens";
    hasToolCalls: boolean;
    messageId: string;
  }) => void;
  onTurnComplete?: (fullText: string) => void;
  onPermissionModeChanged?: (mode: ExecutionMode,
  ) => void;
  onError?: (error: string, systemNotice?: "context-error" | "stream-error",
    // Pass classification only; shared failure summaries must never receive raw error text.
    classifierCategory?: string,
    /** A failed maintenance operation does not terminate the chat turn. */
    operation?: "compaction",
  ) => void;
  onCompactOccurred?: (result: {
    removedMessages: number;
    freedTokens: number;
    // Renderer fullness uses the post-compact estimate, not freed tokens alone.
    estimatedAfter: number;
    trigger?: "auto-compact" | "manual";



    summary?: string;
    compactNum?: number;



    compactStatus?: CompressionStatus;



    truncatedDir?: string;
  }) => void;

  onCompactStarted?: (info: {
    triggerSource: CompactTriggerSource;
    estimatedBefore: number;
    preflight: number;
  }) => void;
  // Recovery exhaustion requires a persistent renderer notice that manual intervention is needed.
  onRecoveryExhausted?: () => void;
  onFallback?: (from: string, to: string) => void;
  onLlmStatus?: (status: FallbackStatus) => void;

  onGuidanceInjected?: (text: string, row: GuidanceInjectionRow) => void;
  // Report undelivered guidance at turn end so users know their adjustment was not applied.
  onGuidanceDropped?: (text: string) => void;
  // Decision observation cannot change behavior; tracing, event projection, and summaries share this signal.
  onDecision?: (event: TurnDecisionEvent) => void;
  // Emit completed-turn aggregate usage and duration once; omit per-tool breakdown when no tools ran.
  onTurnSummary?: (summary: TurnSummary) => void;
}

export interface RunTurnOptions {
  // Omitted attachment parts leave plain-string user input.
  attachments?: UserContentPart[];
  originSource?: string | null;
  // Round budgets stop cleanly between rounds and remain distinct from user cancellation.
  maxRounds?: number;
  // Child overrides attribute tool audits to the child session rather than the parent.
  sessionIdOverride?: string;
  // Spawn depth must reach execution so nested agent_spawn calls are refused.
  spawnDepth?: number;
  approvalReasonPrefix?: string;
  // Remote-controller authority is host-owned and never parsed from input.
  remoteControllerAuthority?: RemoteControllerAuthority;
  // Unattended authority is host-issued for one turn, never parsed from chat input.
  unattendedAuthority?: UnattendedTurnAuthority;
  // Join DLP-masked child messages only after the prompt gate.
  initialGuidance?: string;
  // Stamp the row actually holding child reports so reload cannot misattribute them to the user.
  subAgentReport?: { title?: string };
  a2aCausalContext?: A2AAgentCausalContext;
  inputOrigin: ChatInputOrigin;
  /** Required with `inputOrigin: "user-keyboard"` and spent by the turn; nothing else makes a turn the user's own. */
  userKeyboardIntent?: import("../../shared/chat-origin.js").VerifiedUserKeyboardIntent;
  requestAnchorRawIntent?: string;
  rolePrompt?: ActiveRolePrompt;
  // Preserve user display text when replay folds server attachment bodies into durable input.
  displayText?: string;
  // Host-exit continuation is a host instruction; retain the original user request as the title source.
  resumesInterruptedTurn?: true;
  // Use the caller-announced ID for the same appended user row.
  userMessageId?: string;
  // Clean child ends dispatch continuable SubagentStop; report dispatch to prevent runner duplication.
  subagentStop?: { agentId?: string; agentType?: string; onDispatched: () => void };
}

// Adding a stop reason requires auditing summary and notification gates against this shared union.
export type TurnStopReason =
  | "end_turn"
  | "tool_use"
  // Preserve residual output truncation after continuation exhaustion so UI can report it.
  | "max_tokens"
  | "interrupted"
  | "context-error"
  | "stream-error"
  // Round-cap is resumable partial success with usage, distinct from interruption and output limits.
  | "round-cap"
  // Input-required ends the loop; continuation rehydrates persisted state rather than parking a coroutine.
  | "input-required"
  // Authorization-required is terminal without a local approval surface; retries cannot repair authority.
  | "authorization-required"
  // Blocking hook refusal occurs before the model receives the prompt.
  | "blocked";

export interface TurnInputRequired {
  reason: "question";
  prompt: string;
}

export interface TurnResult {
  text: string;
  toolCalls: Array<{ name: string; input: Record<string, unknown>; result: string;
  }>;
  route: string;
  usage?: TokenUsage;
  usageByModel?: TokenUsageByModel[];
  subscriptionUsage?: SubscriptionUsageTelemetry[];
  stopReason?: TurnStopReason;
  inputRequired?: TurnInputRequired;
  authorizationRequired?: AuthorizationRequiredState;
}

export interface ConversationLoopDeps {
  settingsService: SettingsService;
  // Subscription factories accept only normalized runtime selection and retain ordinary loop gates.
  subscriptionProviderFactory?: (
    selection: SubscriptionChatRuntimeSelection,
    fallbackSelection?: SubscriptionChatRuntimeSelection,
  ) => LLMProvider | null;
  systemPromptBuilder: SystemPromptBuilder;
  inputClassifier: InputClassifier;
  routeEngine: RouteEngine;
  toolRegistry: ToolRegistry;
  // Enable rationale orchestration only with a concrete host runtime; otherwise preserve legacy approval flow.
  rationaleCoordinatorFactory?: RationaleCoordinatorFactory;
  closeRationaleSession?: (sessionId: string) => void;
  // One loop may own a session file; simultaneous owners would overwrite each other on save.
  sessionHeldElsewhere?: (sessionId: string) => boolean;
  // Ignore this override outside exact test NODE_ENV.
  enableDormantRationaleForTesting?: boolean;
  // Background parent delivery requires explicit host capability.
  supportsA2AParentDelivery?: boolean;
  memoryManager: MemoryManager;
  // Explicit memory writes require the host-owned review gate.
  memoryCaptureService?: Pick<MemoryCaptureService, "captureExplicit">;
  // Recap generation shares the no-tool reviewer lane.
  memoryReviewer?: Pick<MemoryReviewerService, "review">;
  // Executor-side directory grants must notify permission views in every renderer window.
  broadcastPermissionConfigChanged?: () => void;
  permissionManager?: import("../../permissions/permission-manager.js").PermissionManager;
  routineEngine?: RoutineEngine;
  // Register goals only on loops with a revival driver; other loops must report unavailability.
  sessionGoalStore?: import("../../main/session-goal-store.js").SessionGoalStore;

  idleScheduler?: IdleSchedulerService;
  postTurnHookChain?: PostTurnHookChain;

  bashAstValidator?: import("../../main/bash-ast-validator.js").BashAstValidator;

  approvalGate?: import("../../permissions/approval-gate.js").ApprovalGate;
  // In-process hooks serve focused tests; production policy uses the trusted script manager.
  hookRunner?: HookRunner;

  pluginRuntime?: {
    listPluginIds(): string[];
    getGenerationAccess?():
      | import("../../plugins/plugin-host-generation.js").PluginRuntimeGenerationAccess | undefined;
    // Undefined enabled state is migration-safe active; false removes plugin model scope.
    isPluginEnabled?(pluginId: string): boolean;
    // Session-only activation must not persist enabled state or affect other sessions.
    setSessionActivated?(sessionId: string, pluginId: string): void;
    // Clear only the named session on reset or discarded routine completion.
    clearSessionActivated?(sessionId: string): void;
  };
  pluginOperationGrants?: import("../../permissions/plugin-operation-grant.js").PluginOperationGrantCoordinator;
  pluginOperationIdentityProvider?: import("../../tools/invocation-services.js").PluginOperationIdentityProvider;
  forcedActivePluginIds?: ReadonlySet<string>;
  forcedActiveToolNames?: ReadonlySet<string>;
  // Session and profile overrides replace API model selection; verify subscription candidates against the live catalog.
  // Runtimes without model selection retain their persisted defaults.
  modelOverride?: string;
  // Intersect forced scope and plugin activations with this hard allowlist.
  allowedPluginIds?: ReadonlySet<string>;
  // Background writes must ask and cannot rely on automatic or cached allows.
  headless?: boolean;
  // Approval UI capability is independent of routine tool scope.
  approvalSurface?: ApprovalSurface;
  additionalDirectories?: readonly string[];
  getAdditionalDirectories?: () => readonly string[];
  isDefaultProjectRoot?: (projectRoot: string) => boolean;
  getDefaultProject?: () => { projectRoot?: string; projectName?: string; isDefault?: boolean;
  };
  // Reauthorize and canonicalize roots from persisted state or renderer input.
  authorizeProject?: (
    projectRoot: string,
    projectName?: string,
  ) => { projectRoot: string; projectName?: string; isDefault?: boolean;
  } | null;
  // Boot owns hook discovery and trust; execution invokes only the trusted contract.
  scriptHookManager?: import("../../hooks/script-hook-manager.js").ScriptHookManager;
  hookTrustCommandOptions?: Omit<HookTrustCommandOptions, "manager">;
  // Isolated children must not write normal main-session persistence.
  disableSessionPersistence?: boolean;
  // Skill registry authorizes reads but holds no bodies; clear it only when replacing the conversation.
  skillOverlay?: { clear(sessionId: string): void };
  // Indexed non-builtin slash names run as model skill requests rather than unknown commands.
  isSkillName?: (name: string) => boolean;
  // Omit notifications for background loops to avoid turn-end spam.
  notificationService?: import("../../main/notification-service.js").NotificationService;
  // Tool audits append to the shared authenticated chain.
  auditLogger?: AuditLogger;
  rewireReviewerAgent?: () => void;
  llmFetch?: typeof fetch;
  // Require host outbound transport so guarded calls honor machine proxy and trust-store configuration.
  networkFetch: typeof fetch;
  // Missing tracer means no provider registration or span allocation.
  tracer?: import("@opentelemetry/api").Tracer;
}

export interface RequestProjectionContext {
  systemPrompt: string;
  toolSchemas: ToolSchema[];
  estimateCurrent: () => RequestInputProjection;
}

export type ToolSourceCounts = Record<ToolSource, number>;

export type CompactTriggerSource =
  | "estimate" | "context-tokens" | "manual" | "force-recover" | "rate-limit";

export interface PreflightGuardOptions {
  forceReason?: "rate-limit";
  // Mid-turn preservation counts assistant tool rounds; user-turn floors would prevent active-turn reduction.
  intraTurn?: boolean;
}

export interface ToolScope {
  activePluginIds: Set<string>;

  activeToolNames: Set<string>;
  forcedToolNames: Set<string>;
  includeBuiltins: boolean;
  // Arbitrary model-chosen egress is off for unattended lanes.
  includeEgress: boolean;
  includeMcp: boolean;
  // Eager mode exposes all eligible schemas; deferral loads active names and catalogs the remainder.
  deferral: boolean;
}

export interface ToolExposureMetrics {
  loadedToolCount: number;
  loadedToolSourceCounts: ToolSourceCounts;
  deferredCatalogCount: number;
  deferredCatalogSourceCounts: Pick<ToolSourceCounts, "plugin" | "mcp">;
  promotedToolNames: string[];
  loadedPluginIds: string[];
  loadedMcpServerIds: string[];
  deferredPluginIds: string[];
  deferredMcpServerIds: string[];
  toolSchemaTokens: number;
  projectedRequestInputTokens: number | null;
  // Ratio counts only plugin/MCP tools: deferred / (deferred + loaded eligible).
  // Return null for an empty universe; builtins would dilute the metric.
  deferralEligibleLoadedCount: number;
  deferredLoadedRatio: number | null;
}

export interface ProviderRequestDiagnostics {
  sessionId: string;
  round: number;
  assistantRoundIndex: number;
  inputOrigin: ChatInputOrigin;
  runtimeIdentity: string;
  model: string;
  preflightThresholdTokens: number;
  promptChars: number;
  messageCount: number;
  messageRoleCounts: Record<GenericMessage["role"], number>;
  projection: RequestInputProjection;
  toolResultCount: number;
  toolResultChars: number;
  toolResultTokens: number;
  compactedToolResultCount: number;
  truncatedToolResultCount: number;
  serializedStubToolResultCount: number;
  assistantToolCallCount: number;
  loadedToolNames: string[];
  loadedToolNamesTruncated: number;
  activePluginIds: string[];
  toolExposure: ToolExposureMetrics;
}
