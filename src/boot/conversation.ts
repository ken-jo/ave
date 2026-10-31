import type { SettingsService } from "../data/settings-store.js";
import type { MemoryManager, PromptMemorySource } from "../memory/memory-manager.js";
import type {
  AutomaticMemoryCaptureSubmitter,
  MemoryCaptureService,
} from "../memory/memory-capture-service.js";
import type { MemoryReviewerService } from "../memory/memory-reviewer-service.js";
import type { SkillCatalogEntry } from "../main/skill-store.js";
import type { InputClassifier } from "../core/input-classifier.js";
import type { RouteEngine } from "../core/route-engine.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { RoutineEngine } from "../routines/routine-engine.js";
import type { IdleSchedulerService } from "../main/idle-scheduler.js";
import type { BashAstValidator } from "../main/bash-ast-validator.js";
import type { PluginRuntime } from "../plugins/runtime.js";
import { SystemPromptBuilder } from "../prompts/system-prompt-builder.js";
import { PermissionManager } from "../permissions/permission-manager.js";
import { readPermissionSettings } from "../permissions/permission-settings-store.js";
import {
  ApprovalGate,
  type ApprovalSurfaceResolver,
} from "../permissions/approval-gate.js";
import { loadPolicy } from "../permissions/policy-store.js";
import { registerStandardCategories } from "../permissions/category-registry.js";
import { ConversationLoop } from "../engine/conversation-loop.js";
import type { RationaleCoordinatorFactory } from "../engine/turn/rationale-conversation-orchestration.js";
import { PostTurnHookChain } from "../hooks/post-turn-hook-chain.js";
import { HookRunner } from "../hooks/hook-runner.js";
import { AuditLogger } from "../audit/audit-logger.js";
import type { NotificationService } from "../main/notification-service.js";
import type { LLMProvider } from "../engine/llm/types.js";
import type { SubscriptionChatRuntimeSelection } from "../shared/subscription-runtime.js";
import type { ApprovalSurface } from "../shared/authorization-required.js";
import { isDefaultWorkspaceRoot } from "../main/default-workspace-root.js";
import {
  defaultWorkspaceProject,
  resolveAuthorizedWorkspaceProject,
} from "../main/project-root-authorization.js";

function authorizeWorkspaceProjectRoot(projectRoot: string, projectName?: string,
) {
  const resolved = resolveAuthorizedWorkspaceProject(projectRoot, projectName);
  return resolved.authorized ? resolved.project : null;
}

export function createSystemPromptBuilder(opts: {
  // Use the builder’s dependency contract rather than requiring the whole store.
  memoryManager: PromptMemorySource;
  toolRegistry: ToolRegistry;
  pluginRuntime: PluginRuntime;
  getAvailableSkills?: () => SkillCatalogEntry[];
  /** Routine allow-lists make disabled plugins requestable without enabling them globally. */
  getActivatablePluginIds?: () => ReadonlySet<string>;
  /** Main-chat card context only; omitted by routine and side-chat builders. */
  getAppModelContext?: (sessionId: string) => string;
  /** Discovery instructions are inert, untrusted context; only main chat wires them. */
  mcpServerGuidanceProvider?: () => Array<{ serverId: string; instructions: string }>;
}): SystemPromptBuilder {
  const { memoryManager, toolRegistry, pluginRuntime, getAvailableSkills, getActivatablePluginIds, getAppModelContext, mcpServerGuidanceProvider,
  } = opts;
  return new SystemPromptBuilder({
    memoryManager,
    toolRegistry,

    // Use the builder’s scoped registry so child prompts advertise only callable tools.
    getPluginCards: (registry) => pluginRuntime.listPluginCards(registry),
    getActivatablePluginIds,
    getAvailableSkills,
    getAppModelContext,
    mcpServerGuidanceProvider,
  });
}

export async function createPermissionManager(): Promise<PermissionManager> {
  // Register category descriptors before any permission check; registration is idempotent.
  registerStandardCategories();
  const permissionManager = new PermissionManager(undefined, () => {
    const fault = readPermissionSettings().fault;
    return fault === null || fault.kind === "reviewer-mode-invalid" ? undefined : `Permission settings are unreadable (${fault.kind}: ${fault.filePath}).`;
  }, () => readPermissionSettings().fault?.kind === "reviewer-mode-invalid"
    ? "Permission reviewer settings are invalid; choose llm or disabled in Permissions settings." : undefined);

  // Standing allows belong only to host-registry reads without private-data access or network egress.
  permissionManager.setRules([
    { pattern: "skill_list", action: "allow" },
    { pattern: "agent_list", action: "allow" },
  ]);

  await permissionManager.loadRulesFromFile();
  return permissionManager;
}

export function createPostTurnHookChain(opts: {
  memoryManager: MemoryManager;
  idleScheduler?: IdleSchedulerService;
  settingsService: SettingsService;
  memoryCaptureService?: AutomaticMemoryCaptureSubmitter;
  /** Reuse the host audit logger to keep plugin and host trails unified. */
  auditLogger?: AuditLogger;
}): { postTurnHookChain: PostTurnHookChain; auditLogger: AuditLogger } {
  const auditLogger = opts.auditLogger ?? new AuditLogger();
  const postTurnHookChain = new PostTurnHookChain({
    memoryManager: opts.memoryManager,
    auditLogger,
    idleScheduler: opts.idleScheduler,
    settingsService: opts.settingsService,
    memoryCaptureService: opts.memoryCaptureService,
  });
  return { postTurnHookChain, auditLogger };
}

export async function createApprovalGate(
  /** Where each card is drawn, resolved per request; null for a headless run. */
  surface: ApprovalSurfaceResolver | null,
  auditLogger: AuditLogger,
  notificationService?: NotificationService,
): Promise<ApprovalGate> {

  const bootPolicy = await loadPolicy();
  return new ApprovalGate(
    surface,
    bootPolicy,
    5 * 60 * 1000,
    auditLogger,
    notificationService,
    surface === null ? {
      onDenied: (requestId, toolName) => {
        process.stderr.write(`exec: auto-denied approval ${requestId} tool=${toolName}\n`);
      },
    } : undefined,
  );
}

export function createHookRunner(): HookRunner {
  // External hooks share TOFU quarantine; only accepted, unchanged configs may contribute commands.
  return new HookRunner();
}

export interface ConversationDeps {
  settingsService: SettingsService;
  systemPromptBuilder: SystemPromptBuilder;
  inputClassifier: InputClassifier;
  routeEngine: RouteEngine;
  toolRegistry: ToolRegistry;
  /** Query-loop activates the guarded rationale path only when its factory is ready. */
  rationaleCoordinatorFactory?: RationaleCoordinatorFactory;
  closeRationaleSession?: (sessionId: string) => void;
  /** See ConversationLoopDeps.sessionHeldElsewhere — supplied by the host that owns every loop. */
  sessionHeldElsewhere?: (sessionId: string) => boolean;
  /** Factories copy dependencies by name; callers’ spread keys can otherwise disappear silently. */
  tracer?: import("@opentelemetry/api").Tracer;
  /** Host-owned capability; defaults false when omitted. */
  supportsA2AParentDelivery?: boolean;
  approvalSurface?: ApprovalSurface;
  memoryManager: MemoryManager;
  /** Main-chat explicit saves use the host's common memory-review path. */
  memoryCaptureService?: MemoryCaptureService;
  /** Main, routine, and side-chat recap share this host-owned reviewer lane. */
  memoryReviewer?: Pick<MemoryReviewerService, "review">;
  permissionManager: PermissionManager;
  routineEngine: RoutineEngine;
  /** Present only on loops that own a revival driver — see ConversationLoopDeps. */
  sessionGoalStore?: import("../main/session-goal-store.js").SessionGoalStore;
  idleScheduler?: IdleSchedulerService;
  postTurnHookChain: PostTurnHookChain;
  bashAstValidator: BashAstValidator;
  approvalGate: ApprovalGate;
  hookRunner: HookRunner;
  scriptHookManager?: import("../hooks/script-hook-manager.js").ScriptHookManager;
  pluginRuntime: PluginRuntime;
  pluginOperationGrants: import("../permissions/plugin-operation-grant.js").PluginOperationGrantCoordinator;
  pluginOperationIdentityProvider: import("../tools/invocation-services.js").PluginOperationIdentityProvider;
  additionalDirectories?: readonly string[];
  getAdditionalDirectories?: () => readonly string[];
  isDefaultProjectRoot?: (projectRoot: string) => boolean;
  getDefaultProject?: () => { projectRoot?: string; projectName?: string; isDefault?: boolean;
  };
  authorizeProject?: (
    projectRoot: string,
    projectName?: string,
  ) => { projectRoot: string; projectName?: string; isDefault?: boolean;
  } | null;
  /** Broadcast session-directory grants to all permission views, including grants made outside slash dispatch. */
  broadcastPermissionConfigChanged?: () => void;
  /** Per-conversation read-skill registry, cleared on newConversation(). */
  skillOverlay?: { clear(sessionId: string): void };
  /** Whether `/<name>` names an indexed skill (routes a typed skill slash to the model). */
  isSkillName?: (name: string) => boolean;
  notificationService?: NotificationService;
  auditLogger?: AuditLogger;
  rewireReviewerAgent?: () => void;
  llmFetch?: typeof fetch;
  networkFetch: typeof fetch;
  subscriptionProviderFactory?: (
    selection: SubscriptionChatRuntimeSelection,
    fallbackSelection?: SubscriptionChatRuntimeSelection,
  ) => LLMProvider | null;
}

/** Each routine owns history and prompt state while sharing normal approval and pre-tool gates. */
export type RoutineConversationLoopDeps = Pick<
  ConversationDeps,
  | "settingsService"
  | "systemPromptBuilder"
  | "inputClassifier"
  | "routeEngine"
  | "toolRegistry"
  | "memoryManager"
  | "memoryReviewer"
  | "permissionManager"
  | "approvalGate"
  | "hookRunner"
  | "scriptHookManager"
  | "bashAstValidator"
  | "pluginRuntime"
  | "pluginOperationGrants"
  | "pluginOperationIdentityProvider"
  | "llmFetch"
  | "networkFetch"
  | "tracer"
  | "auditLogger"
  | "isDefaultProjectRoot"
  | "getDefaultProject"
  | "authorizeProject"
  | "subscriptionProviderFactory"
  | "broadcastPermissionConfigChanged"
  | "approvalSurface"
>;

export function createRoutineConversationLoop(
  deps: RoutineConversationLoopDeps,
  opts: { scope?: import("../shared/routines-types.js").RoutineScope } = {},
): ConversationLoop {
  // Normalize scope before building the prompt so requestable plugins match the session allow-list.
  const scope = opts.scope;
  let allowedPluginIds: Set<string>;
  if (!scope || scope.pluginIds.mode === "inherit") {
    // An unresolved inherited scope fails closed to an empty allow-list.
    allowedPluginIds = new Set();
  } else if (scope.pluginIds.mode === "deny-all") {
    allowedPluginIds = new Set();
  } else {
    allowedPluginIds = new Set(scope.pluginIds.ids);
  }
  // Separate prompt builders keep routine summary mode from leaking into concurrent chat turns.
  const routineSystemPromptBuilder = createSystemPromptBuilder({
    memoryManager: deps.memoryManager,
    toolRegistry: deps.toolRegistry,
    pluginRuntime: deps.pluginRuntime,
    // Routine activation is session-local; persisted plugin enablement stays unchanged.
    getActivatablePluginIds: () => allowedPluginIds,
    // Skill overlay is interactive-only — routine sessions are headless.
  });
  routineSystemPromptBuilder.setRoutineMode(true);
  const forcedActivePluginIds = new Set(scope?.forcedPluginIds ?? []);
  const forcedActiveToolNames = new Set(
    deps.toolRegistry
      .listAll()
      .filter((tool) => tool.source === "plugin" && tool.pluginId && forcedActivePluginIds.has(tool.pluginId),
      )
      .map((tool) => tool.name),
  );
  return new ConversationLoop({
    settingsService: deps.settingsService,
    systemPromptBuilder: routineSystemPromptBuilder,
    inputClassifier: deps.inputClassifier,
    routeEngine: deps.routeEngine,
    toolRegistry: deps.toolRegistry,
    memoryManager: deps.memoryManager,
    memoryReviewer: deps.memoryReviewer,
    permissionManager: deps.permissionManager,
    approvalGate: deps.approvalGate,
    hookRunner: deps.hookRunner,
    scriptHookManager: deps.scriptHookManager,
    bashAstValidator: deps.bashAstValidator,
    pluginRuntime: deps.pluginRuntime,
    pluginOperationGrants: deps.pluginOperationGrants,
    pluginOperationIdentityProvider: deps.pluginOperationIdentityProvider,
    auditLogger: deps.auditLogger,
    llmFetch: deps.llmFetch,
    networkFetch: deps.networkFetch,
    ...(deps.tracer ? { tracer: deps.tracer } : {}),
    isDefaultProjectRoot: deps.isDefaultProjectRoot ?? isDefaultWorkspaceRoot,
    getDefaultProject: deps.getDefaultProject ?? defaultWorkspaceProject,
    authorizeProject: deps.authorizeProject ?? authorizeWorkspaceProjectRoot,
    allowedPluginIds,
    forcedActivePluginIds,
    ...(forcedActiveToolNames.size > 0 ? { forcedActiveToolNames } : {}),
    additionalDirectories: scope?.directories ?? [],
    subscriptionProviderFactory: deps.subscriptionProviderFactory,
    broadcastPermissionConfigChanged: deps.broadcastPermissionConfigChanged,
    approvalSurface: deps.approvalSurface,
    headless: true,
    // Routine loops omit interactive hooks; normal session persistence still applies.
  });
}

/** Side chat owns history, storage, and prompt state while sharing the main chat’s model and permission policy. */
export type SideChatConversationLoopDeps = Pick<
  ConversationDeps,
  | "settingsService"
  | "inputClassifier"
  | "routeEngine"
  | "toolRegistry"
  | "permissionManager"
  | "approvalGate"
  | "memoryReviewer"
  | "hookRunner"
  | "scriptHookManager"
  | "bashAstValidator"
  | "pluginRuntime"
  | "pluginOperationGrants"
  | "pluginOperationIdentityProvider"
  | "llmFetch"
  | "networkFetch"
  | "tracer"
  | "rationaleCoordinatorFactory"
  | "closeRationaleSession"
  | "auditLogger"
  | "subscriptionProviderFactory"
  | "broadcastPermissionConfigChanged"
  | "approvalSurface"
  | "sessionHeldElsewhere"
> & {
  /** Isolated MemoryManager rooted at `~/.ave/side-chat/`. */
  sideChatMemoryManager: MemoryManager;
  /** Shared settings service — reads `additionalDirectories` at each turn. */
  getAdditionalDirectories?: () => readonly string[];
  isDefaultProjectRoot?: (projectRoot: string) => boolean;
  getDefaultProject?: () => { projectRoot?: string; projectName?: string; isDefault?: boolean;
  };
  authorizeProject?: (
    projectRoot: string,
    projectName?: string,
  ) => { projectRoot: string; projectName?: string; isDefault?: boolean;
  } | null;
};

export function createSideChatConversationLoop(
  deps: SideChatConversationLoopDeps,
): ConversationLoop {
  // Bind side-chat prompt memory to its own namespace and keep routine mode disabled.
  const sideChatSystemPromptBuilder = createSystemPromptBuilder({
    memoryManager: deps.sideChatMemoryManager,
    toolRegistry: deps.toolRegistry,
    pluginRuntime: deps.pluginRuntime,
  });
  // Persist side-chat turns separately; side chat does not drive idle refresh.
  const { postTurnHookChain } = createPostTurnHookChain({
    memoryManager: deps.sideChatMemoryManager,
    settingsService: deps.settingsService,
    ...(deps.auditLogger ? { auditLogger: deps.auditLogger } : {}),
  });
  return new ConversationLoop({
    settingsService: deps.settingsService,
    systemPromptBuilder: sideChatSystemPromptBuilder,
    inputClassifier: deps.inputClassifier,
    routeEngine: deps.routeEngine,
    toolRegistry: deps.toolRegistry,
    memoryManager: deps.sideChatMemoryManager,
    memoryReviewer: deps.memoryReviewer,
    permissionManager: deps.permissionManager,
    approvalGate: deps.approvalGate,
    hookRunner: deps.hookRunner,
    scriptHookManager: deps.scriptHookManager,
    bashAstValidator: deps.bashAstValidator,
    pluginRuntime: deps.pluginRuntime,
    pluginOperationGrants: deps.pluginOperationGrants,
    pluginOperationIdentityProvider: deps.pluginOperationIdentityProvider,
    postTurnHookChain,
    auditLogger: deps.auditLogger,
    ...(deps.rationaleCoordinatorFactory
      ? { rationaleCoordinatorFactory: deps.rationaleCoordinatorFactory }
      : {}),
    ...(deps.closeRationaleSession
      ? { closeRationaleSession: deps.closeRationaleSession }
      : {}),
    llmFetch: deps.llmFetch,
    networkFetch: deps.networkFetch,
    ...(deps.tracer ? { tracer: deps.tracer } : {}),
    subscriptionProviderFactory: deps.subscriptionProviderFactory,
    broadcastPermissionConfigChanged: deps.broadcastPermissionConfigChanged,
    approvalSurface: deps.approvalSurface,
    isDefaultProjectRoot: deps.isDefaultProjectRoot ?? isDefaultWorkspaceRoot,
    getDefaultProject: deps.getDefaultProject ?? defaultWorkspaceProject,
    authorizeProject: deps.authorizeProject ?? authorizeWorkspaceProjectRoot,
    ...(deps.getAdditionalDirectories
      ? { getAdditionalDirectories: deps.getAdditionalDirectories }
      : {}),
    // Rail and pane chats share storage but cannot load sessions held by another view.
    ...(deps.sessionHeldElsewhere ? { sessionHeldElsewhere: deps.sessionHeldElsewhere } : {}),
  });
}

export function createConversationLoop(deps: ConversationDeps,
): ConversationLoop {
  const loop = new ConversationLoop({
    settingsService: deps.settingsService,
    systemPromptBuilder: deps.systemPromptBuilder,
    inputClassifier: deps.inputClassifier,
    routeEngine: deps.routeEngine,
    toolRegistry: deps.toolRegistry,
    supportsA2AParentDelivery: deps.supportsA2AParentDelivery === true,
    approvalSurface: deps.approvalSurface,
    ...(deps.rationaleCoordinatorFactory
      ? { rationaleCoordinatorFactory: deps.rationaleCoordinatorFactory }
      : {}),
    ...(deps.closeRationaleSession
      ? { closeRationaleSession: deps.closeRationaleSession }
      : {}),
    memoryManager: deps.memoryManager,
    memoryCaptureService: deps.memoryCaptureService,
    memoryReviewer: deps.memoryReviewer,
    permissionManager: deps.permissionManager,
    broadcastPermissionConfigChanged: deps.broadcastPermissionConfigChanged,
    routineEngine: deps.routineEngine,
    sessionGoalStore: deps.sessionGoalStore,
    idleScheduler: deps.idleScheduler,
    postTurnHookChain: deps.postTurnHookChain,
    bashAstValidator: deps.bashAstValidator,
    approvalGate: deps.approvalGate,
    hookRunner: deps.hookRunner,
    scriptHookManager: deps.scriptHookManager,
    additionalDirectories: deps.additionalDirectories,
    getAdditionalDirectories: deps.getAdditionalDirectories,
    isDefaultProjectRoot: deps.isDefaultProjectRoot ?? isDefaultWorkspaceRoot,
    getDefaultProject: deps.getDefaultProject ?? defaultWorkspaceProject,
    authorizeProject: deps.authorizeProject ?? authorizeWorkspaceProjectRoot,

    pluginRuntime: deps.pluginRuntime,
    pluginOperationGrants: deps.pluginOperationGrants,
    pluginOperationIdentityProvider: deps.pluginOperationIdentityProvider,
    skillOverlay: deps.skillOverlay,
    isSkillName: deps.isSkillName,
    notificationService: deps.notificationService,
    auditLogger: deps.auditLogger,
    rewireReviewerAgent: deps.rewireReviewerAgent,
    llmFetch: deps.llmFetch,
    networkFetch: deps.networkFetch,
    ...(deps.tracer ? { tracer: deps.tracer } : {}),
    subscriptionProviderFactory: deps.subscriptionProviderFactory,
    sessionHeldElsewhere: deps.sessionHeldElsewhere,
  });
  loop.initializeConversation("main");
  return loop;
}

/** Rate limits apply per plugin; rejected attempts still enter the audit log. */
export interface CallLlmRateLimitOptions {
  /** Per-plugin max calls inside the window. Default 20. */
  maxCalls?: number;
  /** Window size in ms. Default 10 minutes. */
  windowMs?: number;
}

type CallLlmOptions = {
  maxTokens?: number;
  systemPrompt?: string;
  signal?: AbortSignal;
};

/** Translate the public maxTokens field into the host-owned background output ceiling. */
function callLlmWithOptionalOutputLimit(
  conversationLoop: ConversationLoop,
  prompt: string,
  opts?: CallLlmOptions,
): Promise<string> {
  return opts?.maxTokens === undefined
    ? conversationLoop.generateText(prompt, opts?.systemPrompt, opts?.signal)
    : conversationLoop.generateText(
      prompt, opts?.systemPrompt, opts?.signal, { outputTokenLimit: opts.maxTokens },
    );
}

export function createCallLlmForPlugin(
  conversationLoop: ConversationLoop,
  auditLogger: AuditLogger,
  options: CallLlmRateLimitOptions = {},
): (pluginId: string, prompt: string, opts?: { maxTokens?: number; systemPrompt?: string; signal?: AbortSignal },
) => Promise<string> {
  const maxCalls = options.maxCalls ?? 20;
  const windowMs = options.windowMs ?? 10 * 60 * 1000;
  const buckets = new Map<string, number[]>();

  return async (pluginId, prompt, opts) => {
    const now = Date.now();
    const arr = buckets.get(pluginId) ?? [];
    const fresh = arr.filter((t) => now - t < windowMs);
    if (fresh.length >= maxCalls) {
      try {
        auditLogger.log({
          timestamp: new Date().toISOString(),
          sessionId: "plugin",
          type: "error",
          input: `[plugin:${pluginId}] callLlm rate-limit exceeded (${fresh.length}/${maxCalls} in ${windowMs}ms)`,
        });
      } catch {}
      throw new Error(
        `[plugin:${pluginId}] callLlm rate-limit exceeded — ${maxCalls} calls per ${windowMs}ms`,
      );
    }
    fresh.push(now);
    buckets.set(pluginId, fresh);

    try {
      auditLogger.log({
        timestamp: new Date().toISOString(),
        sessionId: "plugin",
        type: "tool_call",
        input: `[plugin:${pluginId}] callLlm promptLen=${prompt.length}`,
      });
    } catch {}

    return callLlmWithOptionalOutputLimit(conversationLoop, prompt, opts);
  };
}

/** Non-plugin callers have no pluginId and are not rate-limited. */
export function createCallLlm(
  conversationLoop: ConversationLoop,
): (
  prompt: string,
  opts?: { maxTokens?: number; systemPrompt?: string; signal?: AbortSignal },
) => Promise<string> {
  return (prompt, opts) => {
    return callLlmWithOptionalOutputLimit(conversationLoop, prompt, opts);
  };
}
