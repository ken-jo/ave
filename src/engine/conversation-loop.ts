import { normalizeToolOutputArtifactInfo } from "../shared/tool-output-artifact.js";

import { appendRequestOnlyText } from "./turn/request-only-text.js";
import { ConversationHistory } from "./conversation-history.js";
import { ToolExecutor } from "../tools/executor.js";
import { endShellSession } from "../tools/shell-tools.js";
import { disposeSessionFileReads } from "../tools/file-read-state.js";
import { isActiveSandboxFilesystemContainedForPluginEffects } from "../permissions/sandbox-capability.js";
import { baseAllowedDirectories } from "../permissions/base-allowed-directories.js";
import { registerWorkspaceDirectorySource } from "../permissions/workspace-authorized-roots.js";
import { getWorkspaceRootLifecycle } from "../permissions/workspace-root-lifecycle.js";
import { updateApprovalSurface } from "../permissions/approval-surface-registry.js";
import { HookRunner } from "../hooks/hook-runner.js";
import type { LifecycleHookEvent } from "../hooks/script-hook-types.js";
import {
  estimateRequestInputProjection,
  type RequestInputProjection,
  type RequestInputProjectionInput,
} from "./request-input-projection.js";

import type {
  GenericMessage,
  LLMProvider,
  ToolSchema,
  TokenUsage,
} from "./llm/types.js";
import type { ReadableToolResult } from "../tools/tool-result-chunk.js";
import type { SessionKind } from "../memory/memory-manager.js";
import type { ActiveRolePrompt } from "../data/role-presets.js";
import { AuditLogger } from "../audit/audit-logger.js";
import type { ChatInputOrigin } from "../shared/chat-origin.js";

import {
  resolveTurnExtensionPolicy,
  turnExtensionPolicyContext,
} from "../shared/turn-extension-policy.js";
import type { AiProviderPingResult } from "../shared/ai-provider-ping.js";
import { isToolResultStubContent } from "../shared/tool-result-stub.js";
import { createDlpSafeUuid } from "../shared/dlp-safe-id.js";
import { createTracer, type ConversationTracer } from "../observability/conversation-trace.js";
import { t } from "../i18n/index.js";
import { selectedCompactionModel } from "../shared/compaction-model.js";
import { buildProvider, cleanModelOverride, generateText, pingProvider, resolveVendorName, AI_PROVIDER_PING_TIMEOUT_MS } from "./turn/provider.js";
import type { GenerateTextOptions } from "./turn/provider.js";
import { fireLifecycleEvent, fireUserPromptSubmit } from "./turn/lifecycle-hooks.js";
import {
  resolveToolScope,
  rebuildToolSchemas,
  shouldDeferToolSchemas,
  filterAllowedPluginIds,
  nextCarryForwardToolNames,
} from "./turn/tool-scope.js";
import { buildToolExposureMetrics, buildProviderRequestDiagnostics } from "./turn/tool-exposure.js";
import { handleCommand, handlePermissionCommand } from "./turn/commands.js";
import {
  newConversation,
  initializeConversation,
  loadSession,
  resetAndResume,
  branchFromCheckpoint,
  startRoutineConversation,
  revokeWorkspaceRoot,
  type WorkspaceRootRevocationResult,
  type SessionProjectContext,
} from "./turn/session.js";
import { manualCompact, runPreflightGuard, applyBoundaryToSession, type ManualCompactOptions } from "./turn/compaction.js";
import { GUIDE_MAX_ENTRIES, GUIDE_MAX_CHARS } from "./turn/guidance-limits.js";
import { runTurn } from "./turn/run-turn.js";
import type { A2AAgentCausalContext } from "./a2a-agent-message-envelope.js";
import type {
  TurnCallbacks,
  RunTurnOptions,

  TurnResult,
  ConversationLoopDeps,
  RequestProjectionContext,
  PreflightGuardOptions,
  ToolScope,
  ToolExposureMetrics,
  ProviderRequestDiagnostics,
  WorkspaceRootRevocationOptions,
} from "./turn/types.js";
export type { TurnCallbacks, TurnResult, ConversationLoopDeps, RunTurnOptions } from "./turn/types.js";

export type GuidanceDropReason = "joined-limit" | "turn-ended";

export interface GuidanceQueueEntry {
  text: string;
  /** Called only after the guidance was appended to the receiver's history. */
  onInjected?: () => void | Promise<void>;
  /** Called when a queued item cannot reach a round boundary. */
  onDropped?: (reason: GuidanceDropReason) => void | Promise<void>;
  /** DLP-masked sender provenance applied to receiver ApprovalGate reasons after injection. */
  approvalReasonPrefix?: string;
  /** Host-owned hop context for a message-triggered receiver turn. */
  a2aCausalContext?: A2AAgentCausalContext;
  // Structured child provenance prevents quoted labels from impersonating a child report.
  subAgentTitle?: string;
}

export interface SessionTransitionLease {
  readonly sessionId: string;
  readonly sessionEpoch: number;
  readonly reason: string;
}
type GuidanceDisposition = Pick<
  GuidanceQueueEntry,
  "onInjected" | "onDropped" | "approvalReasonPrefix" | "a2aCausalContext" | "subAgentTitle"
>;

export class ConversationLoop {
  readonly deps: ConversationLoopDeps;
  // Cache first-touch ignore verdicts per session to avoid repeated subprocesses.
  readonly gitIgnoreVerdicts = new Map<string, boolean>();
  /** The model override this loop was constructed with; a session switch restores it. */
  private readonly constructedModelOverride: string | undefined;
  readonly history: ConversationHistory;
  readonly toolExecutor: ToolExecutor;
  readonly auditLogger: AuditLogger;
  provider: LLMProvider | null = null;
  private approvalSessionId = createDlpSafeUuid();
  get sessionId(): string {
    return this.approvalSessionId;
  }
  set sessionId(sessionId: string) {
    updateApprovalSurface({ kind: "move", previousSessionId: this.approvalSessionId, sessionId });
    this.approvalSessionId = sessionId;
  }
  /** Monotonic host generation; increments on every active-session replacement. */
  sessionEpoch = 0;
  sessionKind: SessionKind = "main";
  sessionRoutineId: string | null = null;
  sessionRoutineTitle: string | null = null;
  sessionProjectRoot: string | null = null;
  sessionProjectName: string | null = null;
  sessionProjectIsDefault = false;
  // Fire SessionStart once per session; switching sessions resets the marker.
  sessionStartFiredFor: string | null = null;
  sessionSource: "startup" | "resume" | "clear" = "startup";

  tracer: ConversationTracer = createTracer(this.sessionId);
  cumulativeUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

  lastRoundProviderInputTokens = 0;
  /** Latest exact Codex context window, kept only for the matching runtime model. */
  lastReportedSubscriptionContextWindow: {
    readonly provider: "codex";
    readonly model: string;
    readonly contextWindow: number;
  } | null = null;
  // Exact latest request projection, including prompt, wire messages, and tool schemas.
  lastRoundInputProjection: RequestInputProjection | null = null;
  // Context fill uses final projected input; in-flight provider input is only a calibration anchor.
  lastContextInputTokens = 0;
  /** Local full-request projection corresponding to `lastContextInputTokens`. */
  lastContextInputProjectionTokens = 0;
  currentAbortController: AbortController | null = null;
  activeTurnJournal: import("./turn/turn-journal.js").TurnJournal | null = null;

  lastTurnScope: Set<string> | null = null;

  lastTurnToolNames: Set<string> | null = null;
  sessionPluginExpansions = 0;
  // Session-only activations may expose allowlisted disabled plugins without persisting enabled state.
  // Clear them on reset; main chat cannot activate disabled plugins.
  sessionActivatedPluginIds = new Set<string>();
  sessionToolSearches = 0;
  sessionAdditionalDirectories: string[] = [];

  turnAdditionalDirectories: string[] = [];

  isCompacting: boolean = false;

  compactNum: number = 0;

  contextErrorPending: boolean = false;

  contextErrorRecoveryCount: number = 0;

  recoveryExhausted: boolean = false;
  // Try TPM recovery once per error series; re-arm only after a clean turn.
  rateLimitRecoveryAttempted: boolean = false;
  // Drain bounded guidance at round boundaries without aborting the active model or tool call.
  guidanceQueue: GuidanceQueueEntry[] = [];

  // Turn settlement is the mailbox wake seam after unreachable guidance has been dropped.
  private readonly turnSettledListeners = new Set<(sessionId: string) => void>();
  private activeSessionTransition: SessionTransitionLease | null = null;
  private readonly sessionTransitionSettledListeners = new Set<() => void>();

  constructor(deps: ConversationLoopDeps) {
    this.deps = deps;
    this.constructedModelOverride = deps.modelOverride;
    this.history = new ConversationHistory();
    this.toolExecutor = new ToolExecutor(
      deps.toolRegistry,
      deps.hookRunner ?? new HookRunner(),
      deps.permissionManager,
      deps.bashAstValidator,
      deps.approvalGate,
      deps.scriptHookManager,
      deps.auditLogger,
      () => deps.settingsService.get("features")?.hostClassifiesRisk ?? false,
      // Relax plugin reads only for tracked workers under active filesystem confinement.
      // Host-shell sandboxing alone never authorizes worker read relaxation.
      isActiveSandboxFilesystemContainedForPluginEffects,
      // Resolve the shared workspace authority lazily so all loop instances see current directory grants.
      getWorkspaceRootLifecycle,
      deps.pluginOperationGrants,
      () => deps.pluginRuntime?.getGenerationAccess?.(),
      deps.pluginOperationIdentityProvider,
    );
    this.auditLogger = deps.auditLogger ?? new AuditLogger();
    this.refreshProvider();
    registerWorkspaceDirectorySource(this);
    // Hosts bind a trusted surface before starting an interactive run. A run
    // created without one has no surface for manual approval.
    updateApprovalSurface({ kind: "attach", sessionId: this.sessionId, surface: null });
  }

  get permissionManager(): import("../permissions/permission-manager.js").PermissionManager | undefined {
    return this.deps.permissionManager;
  }

  onPluginDisabled(pluginId: string): void {
    this.lastTurnScope?.delete(pluginId);
  }

  abortCurrentTurn(reason: Error = new Error("user cancelled turn")): void {
    this.currentAbortController?.abort(reason);
  }

  /** Queue non-interrupting guidance only while a turn is active; reject overflow atomically.
   * Callers must surface rejection so the renderer retains unsent text. */
  queueGuidance(text: string): "queued" | "no-active-turn" | "queue-full" | "too-long" | "empty" | "session-transition" {
    return this.enqueueGuidance(text);
  }

  /** Acknowledge durable guidance only after injection, never after enqueue alone. */
  queueGuidanceWithDisposition(
    text: string,
    disposition: GuidanceDisposition,
  ): "queued" | "no-active-turn" | "queue-full" | "too-long" | "empty" | "session-transition" {
    return this.enqueueGuidance(text, disposition);
  }

  private enqueueGuidance(
    text: string,
    disposition: GuidanceDisposition = {},
  ): "queued" | "no-active-turn" | "queue-full" | "too-long" | "empty" | "session-transition" {
    if (this.activeSessionTransition !== null) return "session-transition";
    const trimmed = text.trim();
    if (trimmed.length === 0) return "empty";
    if (trimmed.length > GUIDE_MAX_CHARS) return "too-long";
    if (this.currentAbortController === null) return "no-active-turn";
    if (this.guidanceQueue.length >= GUIDE_MAX_ENTRIES) return "queue-full";
    this.guidanceQueue.push({ text: trimmed, ...disposition });
    return "queued";
  }

  /** Detach the queue before callbacks so overlapping cleanup cannot deliver duplicate dispositions. */
  async dropPendingGuidance(
    reason: GuidanceDropReason,
    callbacks?: Pick<TurnCallbacks, "onGuidanceDropped">,
  ): Promise<void> {
    if (this.guidanceQueue.length === 0) return;

    const dropped = this.guidanceQueue;
    this.guidanceQueue = [];
    const droppedJoined = dropped.map((entry) => entry.text).join("\n\n");
    await Promise.allSettled(
      dropped.map((entry) => Promise.resolve().then(() => entry.onDropped?.(reason))),
    );
    try {
      callbacks?.onGuidanceDropped?.(droppedJoined);
    } catch {
      // Renderer notification failure must never mask the turn's real result.
    }
  }

  hasActiveTurn(): boolean {
    return this.currentAbortController !== null;
  }

  onTurnSettled(listener: (sessionId: string) => void): () => void {
    this.turnSettledListeners.add(listener);
    return () => {
      this.turnSettledListeners.delete(listener);
    };
  }

  /** Notify after controller release and guidance dispositions; isolate listener failures. */
  emitTurnSettled(sessionId: string): void {
    for (const listener of this.turnSettledListeners) {
      try {
        listener(sessionId);
      } catch {
      }
    }
  }

  refreshProvider(): void {
    // Clear before rebuilding so failed subscription activation cannot leave an API-key transport usable.
    this.provider = null;
    this.lastReportedSubscriptionContextWindow = null;
    this.provider = buildProvider(this.deps);
  }

  hasProvider(): boolean {
    return this.provider !== null;
  }

  /** Rebuild the provider with the session model override; undefined restores the constructed default. */
  setSessionModelOverride(model: string | undefined): void {
    this.deps.modelOverride = model ?? this.constructedModelOverride;
    this.refreshProvider();
  }

  /** Drop a `/model` choice when the loop moves to another session. */
  resetSessionModelOverride(): void {
    if (this.deps.modelOverride === this.constructedModelOverride) return;
    this.setSessionModelOverride(undefined);
  }

  async generateText(
    prompt: string,
    systemPrompt = t("be_conversationLoop.generateTextSystemPrompt"),
    abortSignal?: AbortSignal,
    options?: GenerateTextOptions,
  ): Promise<string> {
    return generateText(this.provider, this.deps.settingsService, prompt, systemPrompt, abortSignal, options);
  }

  /** A recap may choose another model, while keeping the active authentication and endpoint boundary. */
  async generateCompactionText(
    prompt: string,
    systemPrompt?: string,
    abortSignal?: AbortSignal,
    outputTokenLimit?: number,
  ): Promise<string> {
    const llm = this.deps.settingsService.get("llm");
    const modelOverride = cleanModelOverride(selectedCompactionModel(llm, this.deps.settingsService.get("marketplace").installedProviderPresets));
    const options = { ...(outputTokenLimit === undefined ? {} : { outputTokenLimit }) };
    if (!modelOverride) {
      return this.generateText(prompt, systemPrompt, abortSignal, { ...options, modelOverride: this.deps.modelOverride });
    }
    // Explicit recap selection permits retries, but never substitution by a chat fallback route.
    const provider = buildProvider({ ...this.deps, modelOverride }, { fallbackEnabled: false });
    return generateText(provider, this.deps.settingsService, prompt, systemPrompt, abortSignal, { ...options, modelOverride });
  }

  /** Probe connectivity without adding a chat-history turn. */
  async pingProvider(timeoutMs = AI_PROVIDER_PING_TIMEOUT_MS): Promise<AiProviderPingResult> {
    return pingProvider(this.provider, this.deps.settingsService, timeoutMs);
  }

  getVendor(): string {
    return resolveVendorName(this.provider);
  }

  buildSystemPromptForScope(
    scope: ToolScope,
    rolePrompt?: ActiveRolePrompt,
    appContextSessionId = this.sessionId,
  ): string {
    this.deps.systemPromptBuilder.setToolScope?.(scope);
    this.deps.systemPromptBuilder.setActiveSessionId?.(appContextSessionId);
    this.deps.systemPromptBuilder.setActiveRolePrompt?.(rolePrompt ?? null);
    try {
      return this.deps.systemPromptBuilder.build();
    } finally {
      this.deps.systemPromptBuilder.setActiveSessionId?.(null);
      this.deps.systemPromptBuilder.setActiveRolePrompt?.(null);
    }
  }

  projectProviderRequestInput(input: RequestInputProjectionInput): RequestInputProjection {
    return estimateRequestInputProjection(input, this.provider ?? undefined);
  }

  // Append varying turn context only inside a request user message; never persist it.
  buildTurnContext(memoryQuery: string, originSource: string | null): string {
    return this.deps.systemPromptBuilder.buildTurnContext?.(memoryQuery, originSource) ?? "";
  }

  estimateCurrentRequestProjection(params: {
    systemPrompt: string;
    toolSchemas: ToolSchema[];
    turnContext?: string;
  }): RequestInputProjection {
    const history = this.history.getMessages();
    return this.projectProviderRequestInput({
      systemPrompt: params.systemPrompt,
      messages: params.turnContext && history[history.length - 1]?.role === "user"
        ? appendRequestOnlyText(history, [params.turnContext])
        : history,
      toolSchemas: params.toolSchemas,
    });
  }

  createRequestProjectionContext(
    scope: ToolScope,
    originSource: string | null,
    rolePrompt: ActiveRolePrompt | undefined,
    toolSchemas: ToolSchema[],
    appContextSessionId = this.sessionId,
    memoryQuery = "",
  ): RequestProjectionContext {
    const buildSystemPrompt = () => this.buildSystemPromptForScope(
      scope,
      rolePrompt,
      appContextSessionId,
    );
    const turnContext = this.buildTurnContext(memoryQuery, originSource);
    return {
      systemPrompt: buildSystemPrompt(),
      toolSchemas,
      estimateCurrent: () => this.estimateCurrentRequestProjection({
        systemPrompt: buildSystemPrompt(),
        toolSchemas,
        ...(turnContext ? { turnContext } : {}),
      }),
    };
  }

  shouldAutoCompactForRateLimit(stream: {
    classification: string;
    providerError: {
      providerType?: string;
      providerCode?: string;
      rateLimit?: { kind: "tokens-per-minute" | "requests-per-minute" | "unknown" };
    };
  }): boolean {
    const providerCode = stream.providerError.providerCode;
    const providerType = stream.providerError.providerType;
    const rateLimitKind = stream.providerError.rateLimit?.kind;
    return (
      stream.classification === "rate-limit" &&
      providerCode === "rate_limit_exceeded" &&
      (providerType === "tokens" || rateLimitKind === "tokens-per-minute")
    );
  }

  rateLimitCompactMessage(stream: {
    providerError: {
      rateLimit?: { retryAfterSeconds?: number };
    };
  }): string {
    const retryAfter = stream.providerError.rateLimit?.retryAfterSeconds;
    const waitText = retryAfter !== undefined && Number.isFinite(retryAfter)
      ? t("be_conversationLoop.rateLimitWaitKnown", { seconds: Math.ceil(retryAfter) })
      : t("be_conversationLoop.rateLimitWaitUnknown");
    return t("be_conversationLoop.rateLimitCompactMessage", { waitText });
  }

  beginSessionTransition(reason: string): SessionTransitionLease {
    if (this.activeSessionTransition !== null) {
      throw new Error("conversation-loop:session-transition-in-progress");
    }
    const lease = Object.freeze({
      sessionId: this.sessionId,
      sessionEpoch: this.sessionEpoch,
      reason,
    });
    this.activeSessionTransition = lease;
    return lease;
  }

  assertSessionTransitionLease(lease: SessionTransitionLease): void {
    if (this.activeSessionTransition !== lease) {
      throw new Error("conversation-loop:invalid-session-transition-lease");
    }
    if (this.sessionId !== lease.sessionId || this.sessionEpoch !== lease.sessionEpoch) {
      throw new Error("conversation-loop:session-generation-changed");
    }
  }

  async runSessionTransition<T>(
    reason: string,
    operation: (lease: SessionTransitionLease) => Promise<T> | T,
  ): Promise<T> {
    const lease = this.beginSessionTransition(reason);
    try {
      return await operation(lease);
    } finally {
      if (this.activeSessionTransition === lease) this.activeSessionTransition = null;
      for (const listener of [...this.sessionTransitionSettledListeners]) listener();
    }
  }

  isSessionTransitioning(): boolean {
    return this.activeSessionTransition !== null;
  }

  onSessionTransitionSettled(listener: () => void): () => void {
    this.sessionTransitionSettledListeners.add(listener);
    return () => this.sessionTransitionSettledListeners.delete(listener);
  }

  newConversation(
    kind: SessionKind = "main",
    project?: SessionProjectContext,
    lease?: SessionTransitionLease,
  ): Promise<void> {
    const targetProject = project ?? (kind === "main" ? this.deps.getDefaultProject?.() : undefined);
    if (lease !== undefined) return newConversation(this, kind, targetProject, lease);
    return this.runSessionTransition(
      "new-conversation",
      (ownedLease) => newConversation(this, kind, targetProject, ownedLease),
    );
  }

  initializeConversation(kind: SessionKind = "main", project?: SessionProjectContext): void {
    initializeConversation(this, kind, project ?? (kind === "main" ? this.deps.getDefaultProject?.() : undefined));
  }

  revokeWorkspaceRoot(
    root: string,
    options?: WorkspaceRootRevocationOptions,
  ): WorkspaceRootRevocationResult {
    return revokeWorkspaceRoot(this, root, options);
  }

  addSessionAdditionalDirectory(path: string): void {
    if (!this.sessionAdditionalDirectories.includes(path)) {
      this.sessionAdditionalDirectories.push(path);
      // Every session-list mutation must notify permission views in other windows.
      this.deps.broadcastPermissionConfigChanged?.();
    }
  }

  addTurnAdditionalDirectory(path: string): void {
    if (!this.turnAdditionalDirectories.includes(path)) {
      this.turnAdditionalDirectories.push(path);
    }
  }

  getTurnAdditionalDirectories(): readonly string[] {
    return [
      // Grants surviving new chats belong in baseAllowedDirectories, not reassigned session directories.
      ...baseAllowedDirectories(),
      ...(this.deps.getAdditionalDirectories?.() ?? this.deps.additionalDirectories ?? []),
      ...this.sessionAdditionalDirectories,
      ...this.turnAdditionalDirectories,
    ];
  }

  getHistory(): ConversationHistory {
    return this.history;
  }

  /** Clear runtime session activations when discarding a loop without a session reset. */
  cleanupSession(lease?: SessionTransitionLease): Promise<void> {
    const cleanup = async (ownedLease: SessionTransitionLease): Promise<void> => {
      this.assertSessionTransitionLease(ownedLease);
      disposeSessionFileReads(ownedLease.sessionId);
      const report = await endShellSession(ownedLease.sessionId);
      this.assertSessionTransitionLease(ownedLease);
      if (report?.state === "cleanup-unproven") {
        throw new Error("workload-broker:session-cleanup-unproven");
      }
      this.deps.closeRationaleSession?.(ownedLease.sessionId);
      this.deps.pluginRuntime?.clearSessionActivated?.(ownedLease.sessionId);
      updateApprovalSurface({ kind: "release", sessionId: ownedLease.sessionId });
    };
    if (lease !== undefined) return cleanup(lease);
    return this.runSessionTransition("session-cleanup", cleanup);
  }

  readToolResultForChunk(toolUseId: string): ReadableToolResult | null {
    const match = this.history
      .getMessages()
      .find((m): m is Extract<GenericMessage, { role: "tool_result" }> =>
        m.role === "tool_result" && m.toolUseId === toolUseId,
      );
    if (!match) return null;
    if (match.meta?.outputArtifactUnavailable) return { ...match, content: "", artifactReadUnavailable: true };
    if (match.meta?.outputArtifact !== undefined) {
      const outputArtifact = normalizeToolOutputArtifactInfo(match.meta.outputArtifact);
      const content = outputArtifact
        ? this.deps.memoryManager.loadToolOutputArtifact(this.sessionId, toolUseId, outputArtifact)
        : null;
      return { ...match, content: content ?? "", ...(outputArtifact ? { outputArtifact } : {}), artifactReadUnavailable: content === null };
    }
    if (isToolResultStubContent(match.content)) {
      const artifact = match.meta?.artifactUnavailable
        ? null
        : this.deps.memoryManager.loadToolResultArtifact(this.sessionId, toolUseId);
      if (!artifact) return match;
      const { serializedStub: _serializedStub, ...restMeta } = match.meta ?? {};
      return {
        toolUseId: artifact.toolUseId,
        toolName: artifact.toolName ?? match.toolName,
        content: artifact.content,
        isError: match.isError,
        meta: { ...restMeta, truncated: artifact.truncated },
      };
    }
    return {
      toolUseId: match.toolUseId,
      toolName: match.toolName,
      content: match.content,
      isError: match.isError,
      meta: match.meta,
    };
  }

  getSessionId(): string {
    return this.sessionId;
  }

  /** Changes even when a user leaves and later returns to the same session id. */
  getSessionEpoch(): number {
    return this.sessionEpoch;
  }

  getSessionKind(): SessionKind {
    return this.sessionKind;
  }

  getSessionProjectRoot(): string | null {
    return this.sessionProjectRoot;
  }

  getSessionExecutionCwd(): string {
    return this.sessionProjectRoot
      ?? this.deps.getDefaultProject?.().projectRoot
      ?? process.cwd();
  }

  getSessionProjectName(): string | null {
    return this.sessionProjectName;
  }

  /** Ambient project bindings omit persisted project metadata but retain execution directory access. */
  getSessionProjectIsDefault(): boolean {
    return this.sessionProjectIsDefault;
  }

  getSessionProjectContext(): SessionProjectContext {
    return {
      ...(this.sessionProjectRoot ? { projectRoot: this.sessionProjectRoot } : {}),
      ...(this.sessionProjectName ? { projectName: this.sessionProjectName } : {}),
    };
  }

  getSessionMemoryProjectContext(): SessionProjectContext & { includeUnscoped?: boolean } {
    return {
      ...this.getSessionProjectContext(),
      ...(this.sessionProjectIsDefault ? { includeUnscoped: true } : {}),
    };
  }

  /** Rebind tracing after direct sessionId changes so trace files name the addressable session. */
  rebindTracer(): void {
    this.tracer = createTracer(this.sessionId);
  }

  getSessionRoutineTitle(): string | null {
    return this.sessionRoutineTitle;
  }

  public enterViewMode(compactNum: number): { messageIndexAtCreation: number } | null {
    const checkpoints = this.deps.memoryManager.loadSessionMetadata(this.sessionId)?.checkpoints ?? [];
    const target = checkpoints.find((c) => c.compactNum === compactNum);
    if (!target) return null;
    return { messageIndexAtCreation: target.messageCountAtTrigger };
  }

  public exitViewMode(): void {
  }

  public async branchFromCheckpoint(compactNum: number): Promise<{
    newSessionId: string;
    lastMessageRole: GenericMessage["role"] | null;
    shouldAutoContinue: boolean;
  }> {
    return branchFromCheckpoint(this, compactNum);
  }

  getSessionRoutineId(): string | null {
    return this.sessionRoutineId;
  }

  getTraceFilePath(): string | undefined {
    return this.tracer.filePath;
  }

  setTracer(tracer: ConversationTracer): void {
    this.tracer = tracer;
  }

  getCumulativeUsage(): TokenUsage {
    return { ...this.cumulativeUsage };
  }

  isAutoCompactEnabled(): boolean {
    return this.deps.settingsService.get("chat").autoCompact ?? true;
  }

  /** Lifecycle notifications are observe-only: ignore denials and unexpected errors.
   * Pass session and trust origin without widening the hook environment. */
  async fireLifecycleEvent(
    event: LifecycleHookEvent,
    payload: import("../hooks/script-hook-types.js").LifecycleEventPayload = {},
    sessionIdOverride?: string,
  ): Promise<void> {
    return fireLifecycleEvent(this.deps, this.sessionId, event, payload, sessionIdOverride);
  }

  /** UserPromptSubmit is blocking and fails closed on denial or unexpected throws.
   * Missing managers or matching hooks allow; the manager DLP-redacts input before dispatch. */
  async fireUserPromptSubmit(
    payload: import("../hooks/script-hook-types.js").UserPromptSubmitPayload,
    sessionIdOverride?: string,
  ): Promise<{ decision: "allow" | "deny"; reason: string }> {
    return fireUserPromptSubmit(this.deps, this.sessionId, payload, sessionIdOverride);
  }

  /** Non-secret session metadata for the SessionStart lifecycle payload. */
  sessionMetaForLifecycle(): Record<string, unknown> {
    return {
      sessionKind: this.sessionKind,
      ...(this.sessionRoutineId ? { routineId: this.sessionRoutineId } : {}),
      ...(this.sessionRoutineTitle ? { routineTitle: this.sessionRoutineTitle } : {}),
      ...(this.sessionProjectRoot ? { projectRoot: this.sessionProjectRoot } : {}),
      ...(this.sessionProjectName ? { projectName: this.sessionProjectName } : {}),
    };
  }

  listSessions(limit?: number): Array<{ id: string; modifiedAt: Date; title: string }> {
    return this.deps.memoryManager.listSessions(limit).map((session) => ({
      id: session.id,
      modifiedAt: session.modifiedAt,
      title: session.title,
    }));
  }

  loadSession(sessionId: string, lease?: SessionTransitionLease): Promise<boolean> {
    if (lease !== undefined) return loadSession(this, sessionId, lease);
    return this.runSessionTransition(
      "load-session",
      (ownedLease) => loadSession(this, sessionId, ownedLease),
    );
  }

  async startRoutineConversation(routineId: string, routineTitle: string, routineFiredAt?: string): Promise<string> {
    return this.runSessionTransition(
      "start-routine-conversation",
      (lease) => startRoutineConversation(this, routineId, routineTitle, routineFiredAt, lease),
    );
  }

  resetAndResume(sessionId: string, lease?: SessionTransitionLease): Promise<{
    ok: boolean;
    compacted: boolean;
    compactedAt: string | null;
    removedMessageCount: number;
  }> {
    if (lease !== undefined) return resetAndResume(this, sessionId, lease);
    return this.runSessionTransition(
      "reset-and-resume",
      (ownedLease) => resetAndResume(this, sessionId, ownedLease),
    );
  }

  async manualCompact(callbacks?: ManualCompactOptions): Promise<{
    compacted: boolean;
    compactedAt: string | null;
    summary: string;
    removedMessageCount: number;
  }> {
    return manualCompact(this, callbacks);
  }

  async runTurn(
    input: string,
    callbacks?: TurnCallbacks,
    abortSignal?: AbortSignal,
    options?: RunTurnOptions,
  ): Promise<TurnResult> {
    if (this.activeSessionTransition !== null) {
      throw new Error("conversation-loop:session-transition-in-progress");
    }
    return turnExtensionPolicyContext.run(
      resolveTurnExtensionPolicy(options?.remoteControllerAuthority, this.deps.headless === true, {
        ownerUnattended: options?.unattendedAuthority !== undefined,
        approvalSurface: this.deps.approvalSurface,
        overlayTriggerOrigin: options?.originSource,
        ...(options?.approvalReasonPrefix ? { floor: {
          code: "other-principal", reason: options.approvalReasonPrefix,
        } } : {}),
        abortSignal,
      }),
      () => runTurn(this, input, callbacks, abortSignal, options),
    );
  }

  rebuildToolSchemas(scope: ToolScope): ToolSchema[] {
    return rebuildToolSchemas(this.deps.toolRegistry, scope);
  }

  buildToolExposureMetrics(
    scope: ToolScope,
    toolSchemas: ToolSchema[],
    projection: RequestInputProjection | null,
    promotedToolNames: readonly string[] = [],
  ): ToolExposureMetrics {
    return buildToolExposureMetrics(this.deps.toolRegistry, scope, toolSchemas, projection, promotedToolNames);
  }

  buildProviderRequestDiagnostics(
    params: Parameters<typeof buildProviderRequestDiagnostics>[1],
  ): ProviderRequestDiagnostics {
    return buildProviderRequestDiagnostics(this.sessionId, params);
  }

  nextCarryForwardToolNames(
    scope: ToolScope,
    toolCalls: Array<{ name: string }>,
  ): Set<string> {
    return nextCarryForwardToolNames(this.deps, scope, toolCalls);
  }

  async applyBoundaryToSession(
    result: import("./structured-compact.js").CompactWithBoundaryResult,
    trigger: "auto-compact" | "manual",
    estimatedBefore: number,
    callbacks: TurnCallbacks | undefined,

    prevMessageCount: number,
    // Preserve verbatim pre-compact messages for checkpoint branching.
    messagesBefore: import("./llm/types.js").GenericMessage[],
    projectionContext: RequestProjectionContext,
  ): Promise<void> {
    return applyBoundaryToSession(this, result, trigger, estimatedBefore, callbacks, prevMessageCount, messagesBefore, projectionContext);
  }

  async runPreflightGuard(
    projectionContext: RequestProjectionContext,
    abortSignal?: AbortSignal,
    callbacks?: TurnCallbacks,
    options?: PreflightGuardOptions,
  ): Promise<boolean> {
    return runPreflightGuard(this, projectionContext, abortSignal, callbacks, options);
  }

  resolveToolScope(input: string): ToolScope {
    return resolveToolScope(input, this.deps, {
      lastTurnScope: this.lastTurnScope,
      lastTurnToolNames: this.lastTurnToolNames,
      sessionActivatedPluginIds: this.sessionActivatedPluginIds,
    });
  }

  shouldDeferToolSchemas(activePluginIds: Set<string>): boolean {
    return shouldDeferToolSchemas(this.deps, activePluginIds);
  }

  filterAllowedPluginIds(pluginIds: string[]): string[] {
    return filterAllowedPluginIds(this.deps, pluginIds);
  }

  async handleCommand(
    command: string,
    args: string,
    inputOrigin: ChatInputOrigin,
    callbacks?: TurnCallbacks,
  ): Promise<TurnResult> {
    return handleCommand(this, command, args, inputOrigin, callbacks);
  }

  async handlePermissionCommand(
    args: string,
    inputOrigin: ChatInputOrigin,
    callbacks?: TurnCallbacks,
  ): Promise<string> {
    return handlePermissionCommand(this, args, inputOrigin, callbacks);
  }

  // Compaction stays in-session; forks require explicit user action.
}
