import type { ConversationLoop } from "../conversation-loop.js";
import { selectedCompactionModel } from "../../shared/compaction-model.js";
import type { GenericMessage, MessageMeta } from "../llm/types.js";
import type {
  CompactTriggerSource,
  PreflightGuardOptions,
  RequestProjectionContext,
  TurnCallbacks,
} from "./types.js";
import { compactWithBoundary, DEFAULT_PRESERVE_RECENT_TURNS, renderBoundaryAsPreamble, type CompactRecapReviewer } from "../structured-compact.js";
import { CompressionStatus } from "../../shared/compact-status.js";
import {
  estimateMessagesTokens,
  getModelPreflightThreshold,
  getModelPreflightThresholdSource,
  getModelUsableContext,
  type PreflightThresholdSource,
} from "../auto-compact.js";
import { t } from "../../i18n/index.js";
import { createLogger } from "../../lib/logger.js";
import { FALLBACK_CONTEXT_WINDOW } from "../../shared/model-host-policy.js";
import {
  getPreflightThreshold,
  getUsableContext,
  llmRouteCatalogAddress,
  resolveContextWindowForRoute,
  resolveModelContextWindow,
  type ContextWindowSource,
  type ResolvedOutputTokenLimit,
  type RouteContextWindow,
  type RouteModelCapabilities,
  type LlmRouteProviderPreset,
  type LlmRouteSettings,
} from "../../shared/context-budget.js";
import { refreshRouteModelList } from "../llm/model-list.js";
import type { ReasoningPlan } from "../llm/reasoning-plan.js";
import type { SubscriptionChatRuntimeSelection } from "../../shared/subscription-runtime.js";

const log = createLogger("ave");

// Runtimes without trustworthy capacity use an independent budget, never inactive API-key settings.
const SUBSCRIPTION_FALLBACK_CONTEXT_WINDOW = 64_000;
const SUBSCRIPTION_FALLBACK_PREFLIGHT = getPreflightThreshold(
  SUBSCRIPTION_FALLBACK_CONTEXT_WINDOW,
);
const SUBSCRIPTION_FALLBACK_USABLE_CONTEXT = getUsableContext(
  SUBSCRIPTION_FALLBACK_CONTEXT_WINDOW,
);

interface RuntimeContextBudget
  extends RouteModelCapabilities,
    Pick<RouteContextWindow, "catalogEntry" | "inputLimit" | "inputLimitSource" | "baseUrl" | "catalogModel" | "reportedPricing"> {
  readonly model: string;
  readonly preflight: number;
  readonly usableContext: number;
  readonly identity: string;
  readonly thresholdSource: PreflightThresholdSource | "subscription-fallback" | "reported-context-window";
  // Capacity source is diagnostic; fallback means the budget rests on a conservative estimate.
  readonly contextWindowSource: ContextWindowSource | "subscription-fallback";
  readonly contextWindow?: number;
  // API output controls record requested, model ceiling, and effective limit; subscriptions own theirs.
  readonly output?: ResolvedOutputTokenLimit;
}

// Warn once per route; repeated preflight evaluations must not flood long-turn logs.
const fallbackContextWindowWarned = new Set<string>();

function warnFallbackContextWindowOnce(identity: string, model: string): void {
  if (fallbackContextWindowWarned.has(identity)) return;
  fallbackContextWindowWarned.add(identity);
  log.warn(
    `context budget: no context window known for model '${model}' — using the ${FALLBACK_CONTEXT_WINDOW}-token fallback. `
    + `Declare the endpoint's real capacity as llm.vendors.<vendor>.contextWindow, or sync the provider's model list so it can report one.`,
  );
}

const unresolvedCatalogModelWarned = new Set<string>();

// Warn once for unknown declared entries so settings typos do not silently select lower knowledge.
function warnUnresolvedCatalogModelOnce(identity: string, catalogModel: string): void {
  const key = `${identity}\u0000${catalogModel}`;
  if (unresolvedCatalogModelWarned.has(key)) return;
  unresolvedCatalogModelWarned.add(key);
  log.warn(
    `context budget: llm.vendors.<vendor>.catalogModel '${catalogModel}' for '${identity}' names no model catalog entry — `
    + "the window comes from the next source. Name an entry as <provider>/<id> from the catalog.",
  );
}

const unstatedReasoningWarned = new Set<string>();

// Warn once when enabled thinking lacks declared effort controls or summary support.
export function warnUnstatedReasoningOnce(
  route: { identity: string; vendor: string; model: string },
  plan: Pick<ReasoningPlan, "kind" | "source" | "suppressed"> | undefined,
): void {
  if (plan === undefined || plan.kind !== "none" || plan.source !== "host-fallback" || plan.suppressed !== undefined) return;
  if (unstatedReasoningWarned.has(route.identity)) return;
  unstatedReasoningWarned.add(route.identity);
  log.warn(
    `reasoning: no effort levels known for model '${route.model}' on '${route.identity}' — the request carries no reasoning_effort and no reasoning summary. `
    + `Name the catalog entry the endpoint serves as llm.vendors.${route.vendor}.catalogModel (<provider>/<id>).`,
  );
}

// Probe unknown capacity without blocking preflight; only later budgets use the persisted answer.
function probeRouteModelListInBackground(
  self: ConversationLoop,
  llm: LlmRouteSettings,
  presets: readonly LlmRouteProviderPreset[] | undefined,
): void {
  const address = llmRouteCatalogAddress(llm, presets);
  // Background probing must honor the same declared discovery policy as settings sync.
  const policy = address.credentialScope
    ? presets?.find((preset) => preset.providerId === address.credentialScope)?.modelDiscoveryPolicy
    : undefined;
  void refreshRouteModelList({
    settingsService: self.deps.settingsService,
    fetchOptions: { fetchImpl: self.deps.networkFetch },
    address,
    ...(policy ? { modelDiscoveryPolicy: policy } : {}),
  }).catch((err: unknown) => {
    log.debug(`model list probe failed: ${(err as Error).message}`);
  });
}

function safeReportedContextBudget(
  contextWindow: number | undefined,
): Pick<RuntimeContextBudget, "preflight" | "usableContext"> | undefined {
  if (typeof contextWindow !== "number" || !Number.isSafeInteger(contextWindow) || contextWindow <= 0) return undefined;
  const usableContext = getUsableContext(contextWindow);
  const preflight = getPreflightThreshold(contextWindow);
  // Tiny malformed capacity reports must not disable preflight.
  return usableContext > 0 && preflight > 0 ? { preflight, usableContext } : undefined;
}

// Keep candidate and stale subscription models on one conservative child budget until capacity is verified.
function hasPendingCodexProfileFallback(
  self: ConversationLoop,
  subscriptionRuntime: SubscriptionChatRuntimeSelection,
): boolean {
  if (subscriptionRuntime.provider !== "codex" || subscriptionRuntime.model === undefined) return false;
  const activeChatRuntime = self.deps.settingsService.get("llm").activeChatRuntime;
  return activeChatRuntime?.kind === "subscription"
    && activeChatRuntime.provider === "codex"
    && activeChatRuntime.model !== subscriptionRuntime.model;
}

export function contextBudgetForCurrentRuntime(self: ConversationLoop): RuntimeContextBudget {
  const subscriptionRuntime = self.provider?.subscriptionRuntime;
  if (subscriptionRuntime) {
    const model = subscriptionRuntime.model ?? "default";
    if (subscriptionRuntime.provider === "codex" && subscriptionRuntime.model) {
      if (hasPendingCodexProfileFallback(self, subscriptionRuntime)) {
        return {
          model,
          preflight: SUBSCRIPTION_FALLBACK_PREFLIGHT,
          usableContext: SUBSCRIPTION_FALLBACK_USABLE_CONTEXT,
          identity: `subscription:codex/${model}`,
          thresholdSource: "subscription-fallback",
          contextWindowSource: "subscription-fallback",
        };
      }
      // Subscription model IDs stay isolated from inactive API-key settings and pricing.
      const catalogWindow = resolveModelContextWindow({ vendor: "openai", model });
      const catalogPreflight = getModelPreflightThreshold("openai", model);
      const catalogUsableContext = getModelUsableContext("openai", model);
      const reported = self.lastReportedSubscriptionContextWindow;
      const reportedBudget = safeReportedContextBudget(
        reported?.provider === "codex" && reported.model === model
          ? reported.contextWindow
          : undefined,
      );
      // Matching runtime reports may lower budgets, never raise them; invalid tiny values retain thresholds.
      const reportedIsTighter = reportedBudget !== undefined && reportedBudget.preflight < catalogPreflight;
      return {
        model,
        preflight: reportedBudget
          ? Math.min(catalogPreflight, reportedBudget.preflight)
          : catalogPreflight,
        usableContext: reportedBudget
          ? Math.min(catalogUsableContext, reportedBudget.usableContext)
          : catalogUsableContext,
        identity: `subscription:codex/${model}`,
        thresholdSource: reportedIsTighter
          ? "reported-context-window"
          : getModelPreflightThresholdSource("openai", model),
        contextWindowSource: reportedIsTighter ? "provider-reported" : catalogWindow.source,
        ...(catalogWindow.catalogEntry !== undefined ? { catalogEntry: catalogWindow.catalogEntry } : {}),
        ...(catalogWindow.inputLimit !== undefined ? { inputLimit: catalogWindow.inputLimit, inputLimitSource: catalogWindow.inputLimitSource } : {}),
      };
    }
    return {
      model,
      preflight: SUBSCRIPTION_FALLBACK_PREFLIGHT,
      usableContext: SUBSCRIPTION_FALLBACK_USABLE_CONTEXT,
      identity: `subscription:${subscriptionRuntime.provider}/${model}`,
      thresholdSource: "subscription-fallback",
      contextWindowSource: "subscription-fallback",
    };
  }

  const llmSettings = self.deps.settingsService.get("llm");
  const provider = llmSettings.provider;
  // Engine preflight and UI fullness use the same route resolution.
  const installedProviderPresets =
    provider === "openai-compatible" && llmSettings.marketplaceProviderPresetId
      ? self.deps.settingsService.get("marketplace").installedProviderPresets
      : undefined;
  const route = resolveContextWindowForRoute(llmSettings, installedProviderPresets, self.deps.modelOverride);
  const model = route.model;
  const identity = `${provider}/${model}`;
  if (route.unresolvedCatalogModel !== undefined) warnUnresolvedCatalogModelOnce(identity, route.unresolvedCatalogModel);
  if (route.source === "fallback") {
    warnFallbackContextWindowOnce(identity, model);
    probeRouteModelListInBackground(self, llmSettings, installedProviderPresets);
  }
  return {
    model,
    ...(route.baseUrl !== undefined ? { baseUrl: route.baseUrl } : {}),
    ...(route.catalogModel !== undefined ? { catalogModel: route.catalogModel } : {}),
    preflight: getModelPreflightThreshold(provider, model, route.contextWindow, route.inputLimit),
    usableContext: getModelUsableContext(provider, model, route.contextWindow, route.inputLimit),
    identity,
    thresholdSource: getModelPreflightThresholdSource(provider, model, route.contextWindow, route.inputLimit),
    ...(route.inputLimit !== undefined ? { inputLimit: route.inputLimit } : {}),
    ...(route.inputLimitSource !== undefined ? { inputLimitSource: route.inputLimitSource } : {}),
    ...(route.inputLimit !== undefined ? { inputLimit: route.inputLimit } : {}),
    ...(route.catalogEntry !== undefined ? { catalogEntry: route.catalogEntry } : {}),
    contextWindowSource: route.source,
    contextWindow: route.contextWindow,
    ...(route.catalogEntry !== undefined ? { catalogEntry: route.catalogEntry } : {}),
    output: route.output,
    ...(route.inputModalities !== undefined ? { inputModalities: route.inputModalities } : {}),
    ...(route.toolCall !== undefined ? { toolCall: route.toolCall } : {}),
    ...(route.reasoning !== undefined ? { reasoning: route.reasoning } : {}),
    ...(route.reportedPricing !== undefined ? { reportedPricing: route.reportedPricing } : {}),
  };
}

const MAX_FORCE_RECOVER_PER_SESSION = 3;

export type ManualCompactOptions = Pick<TurnCallbacks, "onCompactOccurred" | "onCompactStarted"> & {
  focus?: string;
};

/** Keep the shared reviewer queue, but resolve the summarizer on the loop whose history is being compacted. */
function compactionReviewer(self: ConversationLoop): CompactRecapReviewer | undefined {
  const shared = self.deps.memoryReviewer;
  if (!shared) return undefined;
  return {
    review: (task, prompt, options) => shared.review(task, prompt, {
      ...options,
      recapCaller: (text, generation) => self.generateCompactionText(
        text, generation.systemPrompt, generation.signal, generation.maxTokens,
      ),
    }),
  };
}

function compactionInputBudget(self: ConversationLoop, chatPreflight: number): number | undefined {
  const llm = self.deps.settingsService.get("llm");
  const presets = self.deps.settingsService.get("marketplace").installedProviderPresets;
  const model = selectedCompactionModel(llm, presets);
  if (!model) return undefined;
  if (self.provider?.subscriptionRuntime) {
    // Unverified subscription overrides retain a conservative ceiling until the runtime reports their capacity.
    return Math.min(chatPreflight, SUBSCRIPTION_FALLBACK_PREFLIGHT, getModelPreflightThreshold(self.provider.vendor, model));
  }
  const route = resolveContextWindowForRoute(llm, presets, model);
  return Math.min(chatPreflight, getModelPreflightThreshold(llm.provider, model, route.contextWindow, route.inputLimit));
}

export async function manualCompact(self: ConversationLoop, callbacks?: ManualCompactOptions): Promise<{
    compacted: boolean;
    compactedAt: string | null;
    summary: string;
    removedMessageCount: number;
  }> {
    if (!self.provider) {
      return {
        compacted: false,
        compactedAt: null,
        summary: t("be_conversationLoop.manualCompactNoProvider"),
        removedMessageCount: 0,
      };
    }
    if (self.isCompacting) {
      return {
        compacted: false,
        compactedAt: null,
        summary: t("be_conversationLoop.manualCompactAlreadyRunning"),
        removedMessageCount: 0,
      };
    }

    const memoryReviewer = compactionReviewer(self);
    if (!memoryReviewer) {
      log.warn("manualCompact skipped: common Memory Reviewer is unavailable");
      return {
        compacted: false,
        compactedAt: null,
        summary: t("be_conversationLoop.manualCompactFailed", {
          message: "Memory reviewer is unavailable",
        }),
        removedMessageCount: 0,
      };
    }

    const { preflight } = contextBudgetForCurrentRuntime(self);
    const preserveRecentTokens = Math.max(1_000, Math.floor(preflight * 0.4));

    self.isCompacting = true;
    try {
      const messagesBefore = self.history.getMessages();
      const scope = self.resolveToolScope("");
      const toolSchemas = self.rebuildToolSchemas(scope);
      const projectionContext = self.createRequestProjectionContext(scope, null, undefined, toolSchemas);
      const requestProjection = projectionContext.estimateCurrent();

      callbacks?.onCompactStarted?.({
        triggerSource: "manual",
        estimatedBefore: requestProjection.totalTokens,
        preflight,
      });
      await self.fireLifecycleEvent("PreCompact", {
        reason: "manual",
        tokenEstimate: requestProjection.totalTokens,
      });
      const messagesBeforeCount = messagesBefore.length;
      const tokensBefore = requestProjection.totalTokens;
      const result = await compactWithBoundary({
        messages: messagesBefore,
        memoryReviewer,
        preserveRecentTokens,
        preserveRecentTurns: DEFAULT_PRESERVE_RECENT_TURNS,
        compactNum: self.compactNum + 1,
        sessionId: self.sessionId,
        preflightTokens: preflight,
        summaryInputTokens: compactionInputBudget(self, preflight),
        ...(callbacks?.focus !== undefined ? { focus: callbacks.focus } : {}),
      });

      if (result.status === CompressionStatus.NOOP) {
        return {
          compacted: false,
          compactedAt: null,
          summary: t("be_conversationLoop.manualCompactNoop"),
          removedMessageCount: 0,
        };
      }

      await applyBoundaryToSession(self,
        result,
        "manual",
        requestProjection.totalTokens,
        callbacks,
        messagesBefore.length,
        messagesBefore,
        projectionContext,
      );

      await self.fireLifecycleEvent("PostCompact", {
        reason: "manual",
        messagesBefore: messagesBeforeCount,
        messagesAfter: self.history.getMessages().length,
        tokensBefore,
        tokensAfter: self.lastContextInputTokens,
      });

      void Promise.resolve(
        self.deps.memoryManager?.saveSession(self.sessionId, self.history.getMessages()),
      ).catch((err: unknown) => {
        log.warn("manualCompact saveSession failed: %s", (err as Error).message);
      });

      const compactedAt = result.boundary?.createdAt ?? new Date().toISOString();
      const summary = result.status === CompressionStatus.CONTENT_TRUNCATED
        ? t("be_conversationLoop.manualCompactSummaryTruncated", { count: result.removedCount })
        : result.status === CompressionStatus.REDUCED_INSUFFICIENT_FORCED
        ? t("be_conversationLoop.manualCompactSummaryForced", { count: result.removedCount, num: self.compactNum })
        : t("be_conversationLoop.manualCompactSummarySummarized", { count: result.removedCount, num: self.compactNum });
      return {
        compacted: true,
        compactedAt,
        summary,
        removedMessageCount: result.removedCount,
      };
    } catch (err) {
      log.error("manualCompact failed: %s", (err as Error).message);
      // Return a safe failure instead of rejecting IPC; callers show the compact error.
      return {
        compacted: false,
        compactedAt: null,
        summary: t("be_conversationLoop.manualCompactFailed", { message: (err as Error).message }),
        removedMessageCount: 0,
      };
    } finally {
      self.isCompacting = false;
    }
  }

export async function applyBoundaryToSession(
  self: ConversationLoop,
    result: import("../structured-compact.js").CompactWithBoundaryResult,
    trigger: "auto-compact" | "manual",
    estimatedBefore: number,
    callbacks: TurnCallbacks | undefined,

    prevMessageCount: number,
    messagesBefore: import("../llm/types.js").GenericMessage[],
    projectionContext: RequestProjectionContext,
  ): Promise<void> {
    if (result.boundary === null) {
      self.compactNum += 1;
      let truncated = contentTruncatedHistoryWithContextCarrier({
        messages: result.newHistory,
        compactNum: self.compactNum,
        trigger,
        removedCount: result.removedCount,
        estimatedAfter: result.estimatedAfter,
        freedTokens: Math.max(0, estimatedBefore - result.estimatedAfter),
        ...(result.truncatedDir !== undefined ? { truncatedDir: result.truncatedDir } : {}),
      });
      self.history.clear();
      self.history.restore(truncated.history);
      const contextTokensAfter = projectionContext.estimateCurrent().totalTokens;
      const freedTokens = Math.max(0, estimatedBefore - contextTokensAfter);
      truncated = contentTruncatedHistoryWithContextCarrier({
        messages: result.newHistory,
        compactNum: self.compactNum,
        trigger,
        removedCount: result.removedCount,
        freedTokens,
        estimatedAfter: contextTokensAfter,
        ...(result.truncatedDir !== undefined ? { truncatedDir: result.truncatedDir } : {}),
      });
      try {
        await self.deps.memoryManager.saveCheckpointSnapshot(
          self.sessionId,
          self.compactNum,
          messagesBefore,
        );
        const { usableContext: usable } = contextBudgetForCurrentRuntime(self);
        const ctxUsageAtTrigger = usable > 0 ? Math.min(1.0, estimatedBefore / usable) : 0;
        const checkpointEntry: import("../../memory/memory-manager.js").Checkpoint = {
          id: crypto.randomUUID(),
          triggeredAt: truncated.createdAt,
          trigger,
          ctxUsageAtTrigger,
          summary: t("be_conversationLoop.contentTruncatedSummary", { count: result.removedCount }),
          messageCountAtTrigger: prevMessageCount,
          compactNum: self.compactNum,
        };
        const existingMeta = self.deps.memoryManager.loadSessionMetadata(self.sessionId) ?? {};
        const updatedMeta = self.deps.memoryManager.appendCheckpoint(existingMeta, checkpointEntry);
        await self.deps.memoryManager.saveSessionMetadata(self.sessionId, updatedMeta);
      } catch (storageErr) {
        log.warn(`applyBoundaryToSession: content-truncated checkpoint persist failed — ${(storageErr as Error).message}`);
      }
      self.history.clear();
      self.history.restore(truncated.history);
      self.cumulativeUsage = {
        ...self.cumulativeUsage,
        inputTokens: truncated.contextTokensAfter,
      };
      self.lastContextInputTokens = truncated.contextTokensAfter;
      self.lastContextInputProjectionTokens = truncated.contextTokensAfter;
      callbacks?.onCompactOccurred?.({
        removedMessages: result.removedCount,
        freedTokens,
        trigger,
        compactNum: self.compactNum,
        summary: t("be_conversationLoop.contentTruncatedSummary", { count: result.removedCount }),
        estimatedAfter: truncated.contextTokensAfter,
        compactStatus: result.status,
        ...(result.truncatedDir !== undefined ? { truncatedDir: result.truncatedDir } : {}),
      });
      return;
    }

    self.compactNum = result.boundary.compactNum;

    // Snapshot failure is non-fatal to compaction; branching reports the missing snapshot when used.
    try {
      await self.deps.memoryManager.saveCheckpointSnapshot(
        self.sessionId,
        self.compactNum,
        messagesBefore,
      );
    } catch (snapshotErr) {
      log.warn(`applyBoundaryToSession: saveCheckpointSnapshot failed — ${(snapshotErr as Error).message}`);
    }

    const preamble = renderBoundaryAsPreamble(result.boundary);
    let compactedHistory = compactedHistoryWithContextCarrier(result.newHistory, result.estimatedAfter);
    self.history.clear();
    self.history.restore(compactedHistory);
    const contextTokensAfter = projectionContext.estimateCurrent().totalTokens;
    compactedHistory = compactedHistoryWithContextCarrier(result.newHistory, contextTokensAfter);
    self.history.clear();
    self.history.restore(compactedHistory);
    self.cumulativeUsage = {
      inputTokens: contextTokensAfter,
      outputTokens: self.cumulativeUsage.outputTokens,
      ...(self.cumulativeUsage.cacheReadTokens !== undefined && { cacheReadTokens: 0 }),
      ...(self.cumulativeUsage.cacheWriteTokens !== undefined && { cacheWriteTokens: 0 }),
    };
    self.lastContextInputTokens = contextTokensAfter;
    self.lastContextInputProjectionTokens = contextTokensAfter;

    // Checkpoint usage divides by usable context after reservations.
    try {
      const { usableContext: usable } = contextBudgetForCurrentRuntime(self);
      const ctxUsageAtTrigger = usable > 0 ? Math.min(1.0, estimatedBefore / usable) : 0;
      const checkpointEntry: import("../../memory/memory-manager.js").Checkpoint = {
        id: crypto.randomUUID(),
        triggeredAt: result.boundary.createdAt,
        trigger,
        ctxUsageAtTrigger,
        summary: preamble,
        messageCountAtTrigger: prevMessageCount,
        compactNum: self.compactNum,
      };
      const existingMeta = self.deps.memoryManager.loadSessionMetadata(self.sessionId) ?? {};
      const updatedMeta = self.deps.memoryManager.appendCheckpoint(existingMeta, checkpointEntry);
      await self.deps.memoryManager.saveSessionMetadata(self.sessionId, {
        ...updatedMeta,
        summaryPreamble: preamble,
      });
    } catch (storageErr) {
      log.warn(`applyBoundaryToSession: checkpoint persist failed — ${(storageErr as Error).message}`);
    }

    callbacks?.onCompactOccurred?.({
      removedMessages: result.removedCount,
      freedTokens: Math.max(0, estimatedBefore - contextTokensAfter),
      estimatedAfter: contextTokensAfter,
      trigger,
      summary: preamble,
      compactNum: self.compactNum,
      compactStatus: result.status,
      ...(result.truncatedDir !== undefined ? { truncatedDir: result.truncatedDir } : {}),
    });
  }

// Trace counts and decisions only, never prompt or message content.
function tracePreflightGuard(
  self: ConversationLoop,
  outcome: "skipped" | "not-reached" | "fired",
  reason: string,
  extra?: Record<string, unknown>,
): void {
  self.tracer.step("PREFLIGHT_GUARD", { outcome, reason, ...extra });
}

export async function runPreflightGuard(
  self: ConversationLoop,
    projectionContext: RequestProjectionContext,
    abortSignal?: AbortSignal,
    callbacks?: TurnCallbacks,
    options?: PreflightGuardOptions,
  ): Promise<boolean> {
    // Pending recovery bypasses compact-off once per cycle, within the per-session recovery budget.
    // Exhaustion blocks repeated API spending until a clean turn re-arms recovery.
    const overRecoveryBudget = self.contextErrorRecoveryCount >= MAX_FORCE_RECOVER_PER_SESSION;
    const forceRecover = self.contextErrorPending && !overRecoveryBudget;
    const forceRateLimit = options?.forceReason === "rate-limit";
    if (self.contextErrorPending && overRecoveryBudget) {
      log.warn(
        `preflight: force-recover BUDGET EXHAUSTED (count=${self.contextErrorRecoveryCount}/${MAX_FORCE_RECOVER_PER_SESSION}) — blocking all compact API calls`,
      );
      // Recovery exhaustion blocks both forced and normal compact calls; threshold fallthrough would bypass the cap.
      self.contextErrorPending = false;
      self.recoveryExhausted = true;
      callbacks?.onRecoveryExhausted?.();
      tracePreflightGuard(self, "skipped", "recovery-budget-exhausted", {
        contextErrorRecoveryCount: self.contextErrorRecoveryCount,
      });
      return false;
    }
    if (self.recoveryExhausted) {
      log.warn("preflight: recoveryExhausted — all compact API calls blocked until normal turn completes");
      tracePreflightGuard(self, "skipped", "recovery-exhausted");
      return false;
    }
    if (!forceRecover && !forceRateLimit && !self.isAutoCompactEnabled()) {
    log.debug("runPreflightGuard: skipped (autoCompact setting OFF)");
      tracePreflightGuard(self, "skipped", "auto-compact-disabled");
      return false;
    }
    if (self.isCompacting) {
      log.info("preflight: SKIPPED — isCompacting lock held (concurrent turn race avoided)");
      tracePreflightGuard(self, "skipped", "concurrent-compaction-lock");
      return false;
    }
    if (!self.provider) {
      tracePreflightGuard(self, "skipped", "no-provider");
      return false;
    }

    const memoryReviewer = compactionReviewer(self);
    if (!memoryReviewer) {
      log.warn("preflight: compact skipped because common Memory Reviewer is unavailable");
      tracePreflightGuard(self, "skipped", "memory-reviewer-unavailable");
      return false;
    }

    const { preflight, identity, thresholdSource, contextWindowSource, inputLimitSource, inputLimit, catalogEntry } = contextBudgetForCurrentRuntime(self);
    if (!forceRecover && !forceRateLimit && preflight <= 0) {
      tracePreflightGuard(self, "skipped", "invalid-preflight-threshold", {
        threshold: preflight, thresholdSource, contextWindowSource, inputLimitSource, inputLimit, catalogEntry, model: identity,
      });
      return false;
    }

    const messagesBefore = self.history.getMessages();
    const requestProjection = projectionContext.estimateCurrent();
    const estimated = requestProjection.totalTokens;
    // Pair local projection with provider-calibrated context fill; cumulative billing is not context pressure.
    const pendingInputDelta = self.lastContextInputProjectionTokens > 0
      ? Math.max(0, estimated - self.lastContextInputProjectionTokens)
      : 0;
    const contextTokensIn = self.lastContextInputTokens > 0
      ? self.lastContextInputTokens + pendingInputDelta
      : estimated;
    if (!forceRecover && !forceRateLimit && estimated < preflight && contextTokensIn < preflight) {
      tracePreflightGuard(self, "not-reached", "below-threshold", {
        threshold: preflight, thresholdSource, contextWindowSource, inputLimitSource, inputLimit, catalogEntry, model: identity, estimated, contextTokensIn,
      });
      return false;
    }
    const triggerSource: Exclude<CompactTriggerSource, "manual"> = forceRecover
      ? "force-recover"
      : forceRateLimit
        ? "rate-limit"
        : estimated >= preflight
          ? "estimate"
          : "context-tokens";
    tracePreflightGuard(self, "fired", triggerSource, {
      threshold: preflight, thresholdSource, contextWindowSource, inputLimitSource, inputLimit, catalogEntry, model: identity, estimated, contextTokensIn,
    });

    self.isCompacting = true;
    // Notify before blocking summary generation so the renderer can show compact progress.
    callbacks?.onCompactStarted?.({
      triggerSource,
      estimatedBefore: estimated,
      preflight,
    });
    try {
      log.info(
        `preflight: TRIGGER — source=${triggerSource} estimated=${estimated} contextTokensIn=${contextTokensIn} preflight=${preflight} (model=${identity}) → LLM compact #${self.compactNum + 1}`,
      );
      // Reduce token preservation under pressure; forced recovery uses zero token preserve but retains the turn floor.
      const preflightPressure = Math.max(estimated, contextTokensIn);
      const usagePct = preflight > 0 ? preflightPressure / preflight : 0;
      const basePreserveRecentTokens = forceRecover || forceRateLimit || usagePct >= 1.0
        ? 0
        : usagePct >= 0.8
          ? Math.max(1_000, Math.floor(preflight * 0.2))
          : Math.max(1_000, Math.floor(preflight * 0.4));
      const latestMessage = messagesBefore.at(-1);
      const currentUserPreserveTokens = latestMessage?.role === "user"
        ? Math.max(1, estimateMessagesTokens([latestMessage]))
        : 0;
      // Preserve the just-entered question verbatim even during forced recovery.
      const preserveRecentTokens = Math.max(basePreserveRecentTokens, currentUserPreserveTokens);
      // PreCompact is observe-only; a hook cannot veto compaction.
      await self.fireLifecycleEvent("PreCompact", {
        reason: "auto-compact",
        tokenEstimate: estimated,
      });
      const messagesBeforeCount = messagesBefore.length;
      const tokensBefore = estimated;
      const compactResult = await compactWithBoundary({
        messages: messagesBefore,
        memoryReviewer,
        preserveRecentTokens,
        preserveRecentTurns: DEFAULT_PRESERVE_RECENT_TURNS,
        // In-turn preservation counts tool rounds; a user-turn floor would prevent all reduction.
        ...(options?.intraTurn ? { preserveUnit: "tool-rounds" as const } : {}),
        compactNum: self.compactNum + 1,
        sessionId: self.sessionId,
        preflightTokens: preflight,
        summaryInputTokens: compactionInputBudget(self, preflight),
        ...(abortSignal !== undefined && { abortSignal }),
      });

      if (compactResult.status === CompressionStatus.NOOP) {
        log.info("preflight: LLM compact returned NOOP (history within preserveRecentTokens) — no mutation");
        self.lastContextInputTokens = contextTokensIn;
        self.lastContextInputProjectionTokens = estimated;
        self.tracer.step("COMPACTION_RESULT", { status: "noop", triggerSource });
        // No applied boundary means no PostCompact notification.
        return false;
      }

      // Boundary application emits the compact event once; a second event duplicates the divider.
      await applyBoundaryToSession(self,
        compactResult,
        "auto-compact",
        estimated,
        callbacks,
        messagesBefore.length,
        messagesBefore,
        projectionContext,
      );

      log.info(
        `preflight: APPLIED — removed=${compactResult.removedCount} estimatedAfter=${compactResult.estimatedAfter} compactNum=${self.compactNum}`,
      );
      self.tracer.step("COMPACTION_RESULT", {
        status: "applied",
        triggerSource,
        removedCount: compactResult.removedCount,
        estimatedAfter: compactResult.estimatedAfter,
        compactNum: self.compactNum,
      });
      // PostCompact observes counts after boundary mutation and cannot veto the result.
      await self.fireLifecycleEvent("PostCompact", {
        reason: "auto-compact",
        messagesBefore: messagesBeforeCount,
        messagesAfter: self.history.getMessages().length,
        tokensBefore,
        tokensAfter: self.lastContextInputTokens,
      });
      return true;
    } catch (err) {
      // Failed compaction leaves history and the chat turn intact; report a nonterminal maintenance notice.
      log.warn(`preflight: LLM compact failed — ${(err as Error).message}. Delegating to context_error safety net.`);
      self.tracer.step("COMPACTION_RESULT", { status: "error", triggerSource, message: (err as Error).message });
      if (!abortSignal?.aborted) callbacks?.onError?.("Automatic compaction failed", undefined, undefined, "compaction");
      return false;
    } finally {
      self.isCompacting = false;
      // Finally clears recovery and charges every attempt, including throws and no-ops, to prevent infinite retry.
      if (forceRecover) {
        self.contextErrorPending = false;
        self.contextErrorRecoveryCount += 1;
      }
    }
  }

// Compact and content-truncated histories carry their post-compact context size on checkpoint metadata.
function compactedHistoryWithContextCarrier(
  messages: GenericMessage[],
  contextTokensAfter: number,
): GenericMessage[] {
  let contextCarrierAttached = false;
  return messages.map((message) => {
    const meta = message.meta;
    if (!meta) return message;
    const nextMeta: MessageMeta = { ...meta };
    delete nextMeta.turnSummary;
    if (!contextCarrierAttached && nextMeta.checkpointMeta) {
      nextMeta.checkpointMeta = {
        ...nextMeta.checkpointMeta,
        contextTokensAfter,
      };
      contextCarrierAttached = true;
    }
    return { ...message, meta: nextMeta };
  });
}

function contentTruncatedHistoryWithContextCarrier(params: {
  messages: GenericMessage[];
  compactNum: number;
  trigger: "auto-compact" | "manual";
  removedCount: number;
  freedTokens: number;
  estimatedAfter: number;
  truncatedDir?: string;
}): { history: GenericMessage[]; contextTokensAfter: number; createdAt: string } {
  const createdAt = new Date().toISOString();
  const checkpointContent = `[compact #${params.compactNum}: content truncated]`;
  const checkpoint: GenericMessage = {
    role: "user",
    content: checkpointContent,
    meta: {
      compactBoundary: true,
      compactNum: params.compactNum,
      removedCount: params.removedCount,
      compactedAt: createdAt,
      createdAt: new Date(createdAt).getTime(),
      checkpointMeta: {
        removedMessages: params.removedCount,
        freedTokens: params.freedTokens,
        compactNum: params.compactNum,
        trigger: params.trigger,
        compactStatus: CompressionStatus.CONTENT_TRUNCATED,
        summary: t("be_conversationLoop.contentTruncatedSummary", { count: params.removedCount }),
        ...(params.truncatedDir !== undefined ? { truncatedDir: params.truncatedDir } : {}),
      },
    },
  };
  const contextTokensAfter = params.estimatedAfter + estimateMessagesTokens([checkpoint]);
  return {
    history: compactedHistoryWithContextCarrier([checkpoint, ...params.messages], contextTokensAfter),
    contextTokensAfter,
    createdAt,
  };
}
