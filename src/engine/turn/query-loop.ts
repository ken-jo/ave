import {
  DEFAULT_SUBSCRIPTION_REASONING_SPEED,
  subscriptionReasoningSpeedEffort,
  subscriptionRuntimeDescriptor,
} from "../../shared/subscription-runtime.js";
import type { ToolOutputCapture } from "../../shared/tool-output-artifact.js";
import { appendRequestOnlyText } from "./request-only-text.js";
import { randomUUID } from "node:crypto";
import type { ConversationLoop as LoopContext } from "../conversation-loop.js";
import type { GuidanceInjectionSource, TurnCallbacks, TurnDecisionEvent, TurnInputRequired, TurnStopReason, ToolScope } from "./types.js";
import type { GenericMessage, LLMProvider, LLMVendor, MessageMeta, TokenUsage, TokenUsageByModel, ToolCallBlock, ToolSchema } from "../llm/types.js";
import type { ChatInputOrigin, RemoteControllerAuthority } from "../../shared/chat-origin.js";
import type { PermissionReviewEvent } from "../../shared/permission-review-status.js";
import type { ToolTrustOrigin } from "../../tools/types.js";
import type { RequestAnchor } from "../../tools/pipeline/rationale-control.js";
import {
  createCancelledSiblingProposalGuard,
  FOREGROUND_RATIONALE_PRODUCTION_ENABLED,
  isForegroundRationaleOrchestrationEnabled,
} from "../../tools/pipeline/rationale-control.js";
import {
  executeRationaleAwareConversationBatch,
  prepareRationaleConversationRuntime,
  RATIONALE_SIBLING_REPLAY_BLOCKED_RESULT,
  RATIONALE_TRIGGER_FAILED_RESULT,
} from "./rationale-conversation-orchestration.js";
import type { ActiveRolePrompt } from "../../data/role-presets.js";
import type {
  ConversationExecuteOptions,
  InterceptedMetaToolHandler,
  ToolCallMeta,
  ToolResult,
  ToolUseBlock,
} from "../../tools/executor.js";
import { TOOL_SEARCH_TOOL_NAME } from "../../tools/registry.js";
import { collectActiveRuntimeRoundStream } from "./stream-collector.js";
import { FallbackProvider } from "../llm/vercel/fallback-chain.js";
import { vendorSupportsLengthContinuation } from "../llm/vendor-capabilities.js";
import { rejectedToolNameFromError, withoutDroppedTools } from "../llm/rejected-tool-schema.js";
import { nextToolTrustOrigin, rationaleProvenanceFor } from "./trust-origin.js";
import { contextBudgetForCurrentRuntime, warnUnstatedReasoningOnce } from "./compaction.js";
import { markStaleToolResults, evictAgedToolResultImages, isContextLengthError } from "../auto-compact.js";
import { stripSuggestedReplies } from "../suggested-replies.js";
import { isHostExitAbort } from "./turn-journal.js";
import { HOST_EXIT_INTERRUPTION } from "../../memory/session-turn-journal.js";
import { GUIDE_JOINED_MAX_CHARS, mergeGuidanceApprovalReasonPrefixes } from "./guidance-limits.js";
import { parseStagedEnvelope } from "../../shared/staged-origins.js";
import { t } from "../../i18n/index.js";
import { createLogger } from "../../lib/logger.js";
import { MAX_TOOL_CALLS_PER_ROUND } from "../../shared/subagent-policy.js";
import { getLlmVendorSettings } from "../../shared/llm-vendor-defaults.js";
import { apiRoundLlmSettings } from "./round-llm-settings.js";
import { planReasoning } from "../llm/reasoning-plan.js";
import { activeModelCatalog } from "../../shared/model-catalog/active.js";
import type { ContextWindowSource } from "../../shared/context-budget.js";
import type { RunModelSettings } from "../../shared/run-model-settings.js";
import { resolveModelPricing, type ModelPricingRoute } from "../../shared/model-pricing.js";
import { resolvePricingOverrides, type PricingOverride } from "../../shared/pricing-overrides.js";
import { isA2AQuestionInputRequiredControl } from "../../tools/agent-send.js";
import {
  isA2AAgentCausalContext,
  mergeA2AAgentCausalContexts,
  type A2AAgentCausalContext,
} from "../a2a-agent-message-envelope.js";
import { createSubscriptionUsageCollector, recordSubscriptionRoundTelemetry } from "./subscription-usage-telemetry.js";
import { errorMessage } from "../../shared/error-message.js";
import { directoryInstructionsForToolResult, liveDirectoryInstructions } from "./directory-instructions.js";
import { toolResultContentReachesWire } from "../wire-serialize.js";
import {
  authorizationRequiredStateOf,
  issueAuthorizationRequiredControl,
  type AuthorizationRequiredControl,
  type AuthorizationRequiredState,
  type UnattendedTurnAuthority,
} from "../../shared/authorization-required.js";

const log = createLogger("ave");
// Parent turns are unbounded without maxRounds; child loops always receive a budget.
const PARENT_UNLIMITED_ROUNDS = Number.MAX_SAFE_INTEGER;
// Stop continuation at its cap, zero progress, or the assigned round budget, whichever comes first.
const MAX_LENGTH_CONTINUATIONS = 3;
// Bound reasoning-only re-prompts per turn and charge them against the ordinary round budget.
const MAX_REASONING_ONLY_NUDGES = 2;
// Cap stop-hook continuations as well as rounds so an always-blocking hook cannot keep a turn alive.
export const MAX_STOP_HOOK_CONTINUATIONS = 8;
// Replay a bounded reasoning tail as assistant text so next-action context and role alternation survive.
const MAX_NUDGE_REASONING_CHARS = 2_000;
// Bound schema drops despite a shrinking tool set so pathological rejections cannot burn the turn.
const MAX_TOOL_SCHEMA_DROPS_PER_TURN = 5;
// A few recoverable tool failures do not justify an early progress notification.
const PROGRESS_NUDGE_TOOL_ERROR_THRESHOLD = 3;
// Bound per-round fan-out before round limits can intervene, including recursive tool-backed spawns.
// Stub older results on wire to bound repeated input; preserve two rounds and raw in-memory text.
const INTRA_TURN_PRESERVE_RECENT_RESULTS = 2 * MAX_TOOL_CALLS_PER_ROUND;
// Delay stubbing overhead until input reaches half the preflight threshold.
const MICRO_COMPACT_FLOOR_FACTOR = 0.5;
// Retry ineffective compaction only after substantial new growth can produce a different boundary.
const ROUND_COMPACT_REARM_GROWTH_FACTOR = 0.25;

export async function queryLoop(
  self: LoopContext,
    initialSystemPrompt: string,
    scope: ToolScope,
    callbacks: TurnCallbacks | undefined,
    abortSignal: AbortSignal | undefined,
    overlayTriggerOrigin: string | null,
    bounds: {
      maxRounds?: number;
      sessionIdOverride?: string;
      spawnDepth?: number;
      approvalReasonPrefix?: string;
      remoteControllerAuthority?: import("../../shared/chat-origin.js").RemoteControllerAuthority;
      unattendedAuthority?: UnattendedTurnAuthority;
      a2aCausalContext?: A2AAgentCausalContext;
      inputOrigin: ChatInputOrigin;
      toolTrustOrigin: ToolTrustOrigin;
      requestAnchor?: RequestAnchor;
      permissionUserIntent?: string;
      rolePrompt?: ActiveRolePrompt;
      onMemoryCaptureTaint?: (reason: "staged-guidance") => void;
      memoryQuery?: string;
      onStopHook?: (state: { toolCount: number; stopHookActive: boolean }) => Promise<string | undefined>;
    },
  ): Promise<{
    text: string;
    toolCalls: Array<{ name: string; input: Record<string, unknown>; result: string }>;
    usage?: TokenUsage;
    stopReason?: TurnStopReason;
    inputRequired?: TurnInputRequired;
    authorizationRequired?: AuthorizationRequiredState;
    usageByModel: TokenUsageByModel[];
    subscriptionUsage: ReturnType<typeof createSubscriptionUsageCollector>["values"];
    vendorProvider?: LLMVendor;
    vendorModel?: string;
    modelSettings?: RunModelSettings;
    finalToolSchemas: ToolSchema[];
    promotedToolNames: string[];
  }> {
    const llmSettings = self.deps.settingsService.get("llm");
    const activeBlock = getLlmVendorSettings(
      llmSettings.vendors,
      llmSettings.provider,
    );
    const subscriptionRuntime = self.provider?.subscriptionRuntime;
    // Subscription usage requires an explicit telemetry contract, never an inferred API-key billing identity.
    const subscriptionUsageIsOpaque = subscriptionRuntime !== undefined;
    const runtimeContextBudget = contextBudgetForCurrentRuntime(self);
    const model = runtimeContextBudget.model;
    // Subscription reasoning never inherits inactive API-key settings.
    // API thinking budgets share the route-resolved effective output limit.
    const effectiveOutput = runtimeContextBudget.output;
    if (!subscriptionRuntime && effectiveOutput === undefined) {
      throw new Error("API route resolved without an output limit");
    }
    const apiRound = subscriptionRuntime || effectiveOutput === undefined
      ? undefined
      : apiRoundLlmSettings(activeBlock, effectiveOutput, llmSettings.streamSmoothing, runtimeContextBudget);
    // A subscription runtime on Ave's own request path takes the user's speed; the others own their reasoning.
    const subscriptionSpeed = subscriptionRuntime
      && subscriptionRuntimeDescriptor(subscriptionRuntime.provider).offersReasoningSpeed === true
      ? llmSettings.subscriptionReasoningSpeed ?? DEFAULT_SUBSCRIPTION_REASONING_SPEED
      : undefined;
    const roundLlmSettings = apiRound ?? (subscriptionSpeed === undefined
      ? { streamSmoothing: llmSettings.streamSmoothing, enableThinking: false }
      : {
          streamSmoothing: llmSettings.streamSmoothing,
          enableThinking: true,
          reasoningEffort: subscriptionReasoningSpeedEffort(subscriptionSpeed),
        });
    // Subscription max-token responses remain partial until native assistant-prefill support is verified.
    const supportsLengthContinuation = subscriptionRuntime === undefined
      && vendorSupportsLengthContinuation(llmSettings.provider);
    let systemPrompt = initialSystemPrompt;
    let activeApprovalReasonPrefix = bounds.approvalReasonPrefix;
    let servingVendorProvider: LLMVendor | undefined = subscriptionUsageIsOpaque
      ? undefined
      : llmSettings.provider;
    let servingVendorModel: string | undefined = subscriptionUsageIsOpaque
      ? undefined
      : model;
    const usageByModel: TokenUsageByModel[] = [];
    const turnPricingOverrides = resolvePricingOverrides(llmSettings.pricingOverrides);
    const subscriptionUsage = createSubscriptionUsageCollector();
    // Decision reporting is observational; listener errors must not change execution.
    const decide = (event: TurnDecisionEvent): void => {
      try {
        callbacks?.onDecision?.(event);
      } catch {
      }
    };
    // Rejected tool schemas stay excluded only for this turn.
    const droppedToolSchemaNames = new Set<string>();
    // Host-only same-anchor digests prevent replay of siblings canceled by a rationale batch.
    const cancelledSiblingProposalDigests = new Set<string>();
    let cancelledSiblingProposalGuardIncomplete = false;
    // Scope rebuilds must retain activations, excluded rejected tools, and resolved tool-capability denials.
    const toolsWithheld = runtimeContextBudget.toolCall?.supported === false ? runtimeContextBudget.toolCall : undefined;
    const rebuildTurnToolSchemas = (): ToolSchema[] => toolsWithheld
      ? []
      : withoutDroppedTools(self.rebuildToolSchemas(scope), droppedToolSchemaNames);
    let toolSchemas: ToolSchema[] = rebuildTurnToolSchemas();
    const primaryPricingRoute = subscriptionRuntime
      ? undefined
      : {
          ...(runtimeContextBudget.baseUrl !== undefined ? { baseUrl: runtimeContextBudget.baseUrl } : {}),
          ...(runtimeContextBudget.reportedPricing !== undefined ? { reported: runtimeContextBudget.reportedPricing } : {}),
        };
    // Capacity is turn-stable; record reasoning at each request because retries may change its shape.
    const modelSettingsBase: RunModelSettings | undefined = apiRound === undefined || effectiveOutput === undefined
      ? undefined
      : {
          modelCatalogSha256: activeModelCatalog().sha256,
          contextWindow: {
            tokens: runtimeContextBudget.contextWindow ?? 0,
            source: runtimeContextBudget.contextWindowSource as ContextWindowSource,
            ...(runtimeContextBudget.catalogEntry !== undefined ? { catalogEntry: runtimeContextBudget.catalogEntry } : {}),
            ...(runtimeContextBudget.inputLimit !== undefined && runtimeContextBudget.inputLimitSource !== undefined
              ? { inputLimit: { tokens: runtimeContextBudget.inputLimit, source: runtimeContextBudget.inputLimitSource } }
              : {}),
          },
          output: effectiveOutput,
          ...(toolsWithheld
            ? { tools: { sent: false as const, source: toolsWithheld.source, catalogEntry: toolsWithheld.catalogEntry } }
            : {}),
          pricing: resolveModelPricing(llmSettings.provider, model, turnPricingOverrides, primaryPricingRoute),
        };
    let turnModelSettings: RunModelSettings | undefined;
    const withServingIdentity = (
      result: {
        text: string;
        toolCalls: Array<{ name: string; input: Record<string, unknown>; result: string }>;
        usage?: TokenUsage;
        stopReason?: TurnStopReason;
        inputRequired?: TurnInputRequired;
        authorizationRequired?: AuthorizationRequiredState;
      },
    ) => ({
      ...result,
      usageByModel: [...usageByModel],
      subscriptionUsage: subscriptionUsage.values,
      ...(servingVendorProvider !== undefined && servingVendorModel !== undefined
        ? {
            vendorProvider: servingVendorProvider,
            vendorModel: servingVendorModel,
          }
        : {}),
      // Fallbacks resolve their own facts even when labels match; retain only last primary request facts.
      ...(turnModelSettings !== undefined
        && servingVendorProvider === llmSettings.provider && servingVendorModel === model
        ? { modelSettings: turnModelSettings }
        : {}),
      finalToolSchemas: [...toolSchemas],
      promotedToolNames: [...new Set(promotedToolNamesForTurn)],
    });
    const turnProvider = self.provider instanceof FallbackProvider
      ? self.provider.withCallbacks({
        onFallback: callbacks?.onFallback,
        onStatus: (status) => {
          if (status.phase === "fallback") turnModelSettings = undefined;
          if (
            !subscriptionUsageIsOpaque &&
            (status.phase === "attempt" || status.phase === "retry") &&
            status.provider &&
            status.model
          ) {
            servingVendorProvider = status.provider;
            servingVendorModel = status.model;
          }
          callbacks?.onLlmStatus?.(status);
        },
      })
      : self.provider!;
    const allToolCalls: Array<{ name: string; input: Record<string, unknown>; result: string }> = [];
    const toolMetaByUseId = new Map<string, ToolCallMeta>();
    // Persist the last live review verdict on its tool result so reload shows the same decision.
    const permissionReviewByUseId = new Map<string, PermissionReviewEvent>();
    let turnUsage: TokenUsage | undefined;
    const recordProviderUsage = (
      usage: TokenUsage,
      updateContextCalibration: boolean,
    ): void => {
      if (subscriptionUsageIsOpaque) {
        return;
      }
      const cacheRead = usage.cacheReadTokens ?? 0;
      const cacheWrite = usage.cacheWriteTokens ?? 0;
      const adjustedInput = Math.max(
        0,
        usage.inputTokens - cacheRead - cacheWrite,
      );

      if (updateContextCalibration) {
        self.lastRoundProviderInputTokens = usage.inputTokens;
        self.lastContextInputTokens = usage.inputTokens;
        self.lastContextInputProjectionTokens =
          self.lastRoundInputProjection?.totalTokens ?? 0;
      }

      turnUsage = {
        inputTokens: (turnUsage?.inputTokens ?? 0) + usage.inputTokens,
        outputTokens: (turnUsage?.outputTokens ?? 0) + usage.outputTokens,
        cacheReadTokens: (turnUsage?.cacheReadTokens ?? 0) + cacheRead,
        cacheWriteTokens: (turnUsage?.cacheWriteTokens ?? 0) + cacheWrite,
      };
      appendUsageForServingModel(
        usageByModel,
        servingVendorProvider,
        servingVendorModel,
        {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadTokens: cacheRead,
          cacheWriteTokens: cacheWrite,
          ...(usage.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
        },
        turnPricingOverrides,
        primaryPricingRoute ? { vendor: llmSettings.provider, model, ...primaryPricingRoute } : undefined,
      );
      self.cumulativeUsage.inputTokens += adjustedInput;
      self.cumulativeUsage.outputTokens += usage.outputTokens;
      self.cumulativeUsage.cacheReadTokens =
        (self.cumulativeUsage.cacheReadTokens ?? 0) + cacheRead;
      self.cumulativeUsage.cacheWriteTokens =
        (self.cumulativeUsage.cacheWriteTokens ?? 0) + cacheWrite;
    };
    let pluginExpansions = 0;
    let toolSearches = 0;
    const promotedToolNamesForTurn: string[] = [];
    let roundIndex = 0;
    let toolTrustOrigin = bounds.toolTrustOrigin;
    // Staged origin only tightens; non-user guidance forces remaining write, shell, and network calls to ask.
    let stagedOrigin = overlayTriggerOrigin;
    // Activation writes, reads, and clears must use the same overridden session ID as sessionContext.
    const effectiveSessionId = bounds.sessionIdOverride ?? self.sessionId;
    let activeA2ACausalContext =
      isA2AAgentCausalContext(bounds.a2aCausalContext)
      && bounds.a2aCausalContext.recipientChildSessionId === effectiveSessionId
        ? bounds.a2aCausalContext
        : undefined;
    if (activeA2ACausalContext) toolTrustOrigin = "agent-message";

    let assistantRoundsRun = 0;
    // Count progress outside history because compaction must not make a long turn appear short.
    const turnStartedAtMs = Date.now();
    let toolErrorsRun = 0;
    let toolErrorsAtLastProgressNudge = 0;
    // Continuations and schema retries hold roundIndex; record the last notification to avoid duplicate sends.
    let roundIndexAtLastProgressNudge = -1;
    const progressNudgeRounds =
      self.deps.settingsService.get("chat").progressNudgeRounds;
    // Re-arm only after sufficient growth following an ineffective in-turn compaction.
    let roundCompactArmedAbove = 0;
    const roundCompactRearmGrowth = Math.max(
      1_000,
      Math.floor(runtimeContextBudget.preflight * ROUND_COMPACT_REARM_GROWTH_FACTOR),
    );
    // Accumulate raw continuation text and reasoning; append and notify once for the final merged answer.
    let continuationsRun = 0;
    let continuationCarryText = "";
    let continuationCarryThought = "";
    let continuationPrefillText: string | undefined = undefined;
    // Arm one next-round re-prompt; assembly replays reasoning from the committed row.
    let reasoningNudgesRun = 0;
    let reasoningNudgePending = false;
    let stopHookContinuationsRun = 0;
    // Honor the exact caller-assigned round budget, including values above the default.
    const requestedMaxRounds = bounds?.maxRounds;
    const effectiveMaxRounds =
      typeof requestedMaxRounds === "number" && Number.isFinite(requestedMaxRounds) && requestedMaxRounds > 0
        ? Math.floor(requestedMaxRounds)
        : PARENT_UNLIMITED_ROUNDS;

    type PendingGuidanceDelivery = {
      entries: Array<(typeof self.guidanceQueue)[number]>;
      joined: string;
      historyMessage: ReturnType<typeof self.history.append> | null;
      round: number;
      subAgentSource: GuidanceInjectionSource | undefined;
    };
    let pendingGuidanceDelivery: PendingGuidanceDelivery | null = null;
    const ownedOutputCaptures: ToolOutputCapture[] = [];

    const rollbackPendingGuidance = (): void => {
      const delivery = pendingGuidanceDelivery;
      if (!delivery) return;
      pendingGuidanceDelivery = null;
      const injectionId = delivery.historyMessage?.meta?.hostInjectionId;
      if (injectionId !== undefined) {
        // Remove by durable row ID; compaction can replace object identity and cause duplicate redelivery.
        self.history.removeByHostInjectionId(injectionId);
      }
      // Requeue drained entries; outer cleanup clears the controller before delivering drop dispositions.
      self.guidanceQueue = [...delivery.entries, ...self.guidanceQueue];
    };

    const commitPendingGuidance = async (): Promise<void> => {
      const delivery = pendingGuidanceDelivery;
      if (!delivery) return;
      pendingGuidanceDelivery = null;
      await Promise.allSettled(
        delivery.entries.map((entry) =>
          Promise.resolve().then(() => entry.onInjected?.())),
      );
      // A committed delivery without its appended row violates the injection invariant.
      const committedRow = delivery.historyMessage;
      if (committedRow === null) {
        throw new Error("[guidance] committed a guidance batch that never reached history");
      }
      try {
        callbacks?.onGuidanceInjected?.(delivery.joined, {
          messageId: committedRow.meta.messageId,
          ...(delivery.subAgentSource ? { source: delivery.subAgentSource } : {}),
        });
      } catch {
        // Renderer notification failure must not invalidate a committed round.
      }
      self.tracer.step("GUIDANCE_INJECTED", {
        round: delivery.round,
        len: delivery.joined.length,
      });
    };
    const loopRoundBound = effectiveMaxRounds;
    try {
    for (let round = 0; round < loopRoundBound; round++) {
      // Track whether guidance already ran preflight so the same round cannot compact twice.
      let preflightRanThisRound = false;
      if (assistantRoundsRun >= effectiveMaxRounds) {
        log.warn(
          `queryLoop: EARLY-EXIT(round-cap) — assistantRoundsRun=${assistantRoundsRun} effectiveMaxRounds=${effectiveMaxRounds} totalToolCalls=${allToolCalls.length}`,
        );
        decide({
          kind: "early_exit",
          branch: "round-cap",
          data: {
            assistantRoundsRun,
            effectiveMaxRounds,
            toolCalls: allToolCalls.length,
          },
        });
        callbacks?.onError?.(
          t("be_conversationLoop.roundCapError", { max: effectiveMaxRounds }),
        );
        // Round-cap is resumable budget exhaustion, not natural completion.
        const finalized = await finalizeAfterRoundCap({
          provider: turnProvider, model, systemPrompt,
          messages: self.history.getMessages(),
          ...(apiRound?.modelCapabilities !== undefined ? { modelCapabilities: apiRound.modelCapabilities } : {}),
          ...(abortSignal ? { abortSignal } : {}),
        });
        turnUsage = mergeFinalizeUsage(turnUsage, finalized);
        return withServingIdentity({
          text: resolveRoundCapText(
            finalized,
            self.history.getMessages(),
            t("be_conversationLoop.roundCapError", { max: effectiveMaxRounds }),
          ),
          toolCalls: allToolCalls,
          usage: turnUsage,
          stopReason: "round-cap",
        });
      }
      // Drain guidance only after round zero and outside continuation chains.
      // Guidance after assistant prefill would violate its final-assistant-message contract.
      if (
        round > 0
        && pendingGuidanceDelivery === null
        && self.guidanceQueue.length > 0
        && continuationPrefillText === undefined
      ) {
        // Inspect the whole queue before truncation so staged provenance cannot be dropped.
        // Once non-user guidance enters, its stricter origin applies to the rest of the turn.
        const stagedGuidance = self.guidanceQueue
          .map((entry) => parseStagedEnvelope(entry.text))
          .find((parsed) => parsed !== null);
        if (stagedGuidance) {
          bounds.onMemoryCaptureTaint?.("staged-guidance");
          stagedOrigin = stagedGuidance.source;
          toolTrustOrigin = stagedGuidance.kind.inputOrigin;
        }
        const { kept, dropped, joined } = truncateGuidanceBatch(self.guidanceQueue);
        activeApprovalReasonPrefix = mergeGuidanceApprovalReasonPrefixes(
          activeApprovalReasonPrefix,
          kept.map((entry) => entry.approvalReasonPrefix),
        );
        self.guidanceQueue = [];
        const queuedCausalContexts = kept
          .map((entry) => entry.a2aCausalContext)
          .filter((context): context is A2AAgentCausalContext => context !== undefined);
        if (queuedCausalContexts.length > 0) {
          const mergedCausalContext = mergeA2AAgentCausalContexts(
            effectiveSessionId,
            [
              ...(activeA2ACausalContext ? [activeA2ACausalContext] : []),
              ...queuedCausalContexts,
            ],
          );
          if (mergedCausalContext) {
            activeA2ACausalContext = mergedCausalContext;
            toolTrustOrigin = "agent-message";
          }
        }

        if (dropped.length > 0) {
          await Promise.allSettled(
            dropped.map((entry) =>
              Promise.resolve().then(() => entry.onDropped?.("joined-limit"))),
          );
        }
        const injectedContent = t("be_conversationLoop.guidanceInjectionHeader", { joined });
        const subAgentSource = subAgentSourceForBatch(kept);
        const delivery: PendingGuidanceDelivery = {
          entries: kept,
          joined,
          historyMessage: null,
          round,
          subAgentSource,
        };
        pendingGuidanceDelivery = delivery;
        // Compact before appending guidance so the newly injected instruction cannot be summarized away.
        if (self.provider && !self.deps.disableSessionPersistence) {
          preflightRanThisRound = true;
          const compacted = await self.runPreflightGuard(
            {
              systemPrompt,
              toolSchemas,
              estimateCurrent: () => self.estimateCurrentRequestProjection({
                turnContext: self.buildTurnContext(bounds.memoryQuery ?? "", stagedOrigin),
                systemPrompt: self.buildSystemPromptForScope(
                  scope,
                  bounds.rolePrompt,
                  bounds.sessionIdOverride ?? self.sessionId,
                ),
                toolSchemas,
              }),
            },
            abortSignal,
            callbacks,
          );
          if (compacted) {
            systemPrompt = self.buildSystemPromptForScope(
              scope,
              bounds.rolePrompt,
              bounds.sessionIdOverride ?? self.sessionId,
            );
          }
        }
        const historyMessage = self.history.append({
          role: "user",
          content: injectedContent,
          // Stamp all injected batches host-owned; mixed child/user content must not become parent-authored evidence.
          meta: {
            hostInjectionId: randomUUID(),
            // Persist bare display text separately from the prompt envelope so reload and composer restore agree.
            displayText: joined,
            ...(subAgentHistoryMeta(subAgentSource).meta ?? {}),
          },
        });
        delivery.historyMessage = historyMessage;
      }

      // Progress notifications are request-only and count assistant rounds, not retry or continuation iterations.
      // Record a notification only when the model is actually handed it.
      const progressNudgeBranch: "cadence" | "tool-errors" | null =
        progressNudgeRounds === 0
          ? null
          : roundIndex > 0
            && roundIndex % progressNudgeRounds === 0
            && roundIndex !== roundIndexAtLastProgressNudge
            ? "cadence"
            : toolErrorsRun - toolErrorsAtLastProgressNudge >= PROGRESS_NUDGE_TOOL_ERROR_THRESHOLD
              ? "tool-errors"
              : null;

      const repaired = self.history.repairToolPairInvariant();
      if (repaired.removedMessages > 0 || repaired.removedToolCalls > 0) {
        log.warn(
          `queryLoop: repaired invalid tool history before provider call (removedMessages=${repaired.removedMessages}, removedToolCalls=${repaired.removedToolCalls})`,
        );
      }

      // Spend host instructions once outside assembly; preflight may rebuild the request after compaction.
      // Merge user instructions into one request-only row to preserve role alternation.
      let nudgeTextForRound: string | undefined;
      if (continuationPrefillText === undefined && reasoningNudgePending) {
        reasoningNudgePending = false;
        reasoningNudgesRun += 1;
        nudgeTextForRound = t("be_conversationLoop.reasoningOnlyContinuePrompt");
      }
      let progressNudgeText: string | undefined;
      if (continuationPrefillText === undefined && progressNudgeBranch !== null) {
        const elapsedSeconds = Math.round((Date.now() - turnStartedAtMs) / 1000);
        progressNudgeText = t("be_conversationLoop.progressNudge", {
          round: roundIndex,
          elapsedSeconds,
          toolCalls: allToolCalls.length,
          toolErrors: toolErrorsRun,
        });
        decide({
          kind: "progress.nudge",
          branch: progressNudgeBranch,
          data: {
            round: roundIndex,
            elapsedSeconds,
            toolCalls: allToolCalls.length,
            toolErrors: toolErrorsRun,
          },
        });
        toolErrorsAtLastProgressNudge = toolErrorsRun;
        roundIndexAtLastProgressNudge = roundIndex;
      }
      // Build once so measured and sent assemblies share identical text and current staged origin.
      let roundTurnContext: string | undefined;
      const turnContextForRound = (): string =>
        (roundTurnContext ??= self.buildTurnContext(bounds.memoryQuery ?? "", stagedOrigin));
      // Assembly is pure over history so compaction can rebuild without consuming state.
      const assembleRoundMessages = (
        base: GenericMessage[],
      ): GenericMessage[] => {
        // Continuations end with wire-only assistant prefill and carry no extra user context.
        // Open reasoning stays open so the model can finish it without a second generated think block.
        if (continuationPrefillText !== undefined) {
          return [
            ...base,
            { role: "assistant" as const, content: continuationPrefillText },
          ];
        }
        const rows: GenericMessage[] = [...base];
        // Replay bounded reasoning as wire assistant text; otherwise empty-row filtering loses it and breaks alternation.
        for (let i = rows.length - 1; i >= 0; i--) {
          const row = rows[i]!;
          if (row.role !== "assistant") continue;
          const thought = row.thought ?? "";
          if (
            row.content.trim().length === 0 &&
            (row.toolCalls?.length ?? 0) === 0 &&
            thought.trim().length > 0
          ) {
            rows[i] = {
              role: "assistant",
              content: thought.slice(-MAX_NUDGE_REASONING_CHARS),
            };
          }
          break;
        }
        const appendedUserText: string[] = [];
        // Attach turn context only inside user input or guidance, never tool-result rows.
        if (rows[rows.length - 1]?.role === "user") appendedUserText.push(turnContextForRound());
        if (nudgeTextForRound !== undefined) appendedUserText.push(nudgeTextForRound);
        if (progressNudgeText !== undefined) appendedUserText.push(progressNudgeText);
        return appendRequestOnlyText(rows, appendedUserText);
      };
      const projectRound = (
        messages: GenericMessage[],
        requestSystemPrompt = systemPrompt,
      ) => self.projectProviderRequestInput({
        systemPrompt: requestSystemPrompt, messages, toolSchemas,
        continuationPrefill: continuationPrefillText !== undefined,
        enableThinking: roundLlmSettings.enableThinking,
        thinkingBudgetTokens: subscriptionRuntime ? undefined : activeBlock.thinkingBudgetTokens,
      });
      let messagesForRound = assembleRoundMessages(self.history.getMessages());
      self.lastRoundInputProjection = projectRound(messagesForRound);

      // Measure each outgoing request so tool-loop growth can trigger the same preflight compaction.
      if (
        assistantRoundsRun > 0 &&
        // Do not compact mid-continuation: its unpersisted prefill depends on the preceding history.
        continuationPrefillText === undefined &&
        // Guidance already evaluated this history; do not spend a second compaction in the same round.
        !preflightRanThisRound &&
        self.provider &&
        !self.deps.disableSessionPersistence &&
        runtimeContextBudget.preflight > 0
      ) {
        const projected = self.lastRoundInputProjection.totalTokens;
        if (projected >= runtimeContextBudget.preflight) {
          if (projected < roundCompactArmedAbove) {
            decide({
              kind: "compact.auto",
              branch: "rearm-hold",
              data: { threshold: runtimeContextBudget.preflight, projected, armedAbove: roundCompactArmedAbove },
            });
          } else {
            const compacted = await self.runPreflightGuard(
              {
                systemPrompt,
                toolSchemas,
                // Both preflight measurements must include request-only instructions, replay, and updated summary context.
                estimateCurrent: () => projectRound(
                  assembleRoundMessages(self.history.getMessages()),
                  self.buildSystemPromptForScope(
                    scope,
                    bounds.rolePrompt,
                    bounds.sessionIdOverride ?? self.sessionId,
                  ),
                ),
              },
              abortSignal,
              callbacks,
              // Protect recent tool rounds, not the entire active user turn.
              { intraTurn: true },
            );
            decide({
              kind: "compact.auto",
              branch: compacted ? "fired" : "skipped",
              data: { threshold: runtimeContextBudget.preflight, projected },
            });
            if (compacted) {
              systemPrompt = self.buildSystemPromptForScope(
                scope,
                bounds.rolePrompt,
                bounds.sessionIdOverride ?? self.sessionId,
              );
              // Repair pairs again after compaction can cut between a call and its result.
              const repairedAfterCompact = self.history.repairToolPairInvariant();
              if (repairedAfterCompact.removedMessages > 0 || repairedAfterCompact.removedToolCalls > 0) {
                log.warn(
                  `queryLoop: repaired invalid tool history after round-loop compaction (removedMessages=${repairedAfterCompact.removedMessages}, removedToolCalls=${repairedAfterCompact.removedToolCalls})`,
                );
              }
              messagesForRound = assembleRoundMessages(self.history.getMessages());
              self.lastRoundInputProjection = projectRound(messagesForRound);
              // Re-arm from the achieved post-compaction projection, never zero while still over threshold.
              roundCompactArmedAbove =
                self.lastRoundInputProjection.totalTokens + roundCompactRearmGrowth;
            } else {
              // No-op compaction needs real request growth before another model call is justified.
              roundCompactArmedAbove = projected + roundCompactRearmGrowth;
            }
          }
        }
      }
      if (subscriptionRuntime) self.lastRoundProviderInputTokens = 0;
      const toolExposure = self.buildToolExposureMetrics(
        scope,
        toolSchemas,
        self.lastRoundInputProjection,
        promotedToolNamesForTurn,
      );
      const requestDiagnostics = self.buildProviderRequestDiagnostics({
        round,
        assistantRoundIndex: roundIndex,
        inputOrigin: bounds.inputOrigin,
        runtimeIdentity: runtimeContextBudget.identity,
        model,
        preflightThresholdTokens: runtimeContextBudget.preflight,
        systemPrompt,
        messages: messagesForRound,
        toolSchemas,
        activePluginIds: [...scope.activePluginIds],
        projection: self.lastRoundInputProjection,
        toolExposure,
      });
      self.tracer.step("LLM_STREAM", {
        round,
        assistantRoundIndex: roundIndex,
        model,
        toolCount: toolSchemas.length,
        ...toolExposure,
        request: requestDiagnostics,
      });
      let requestModelSettings: RunModelSettings | undefined;
      if (modelSettingsBase !== undefined && apiRound !== undefined) {
        const reasoning = planReasoning({
          vendor: llmSettings.provider,
          model,
          enableThinking: apiRound.enableThinking,
          budgetTokens: apiRound.thinkingBudgetTokens ?? 10_000,
          requestedEffort: apiRound.reasoningEffort,
          baseUrl: runtimeContextBudget.baseUrl,
          catalogModel: apiRound.catalogModel,
          ...(apiRound.modelCapabilities?.reasoning !== undefined ? { reasoning: apiRound.modelCapabilities.reasoning } : {}),
          request: { hasTools: toolSchemas.length > 0 },
        });
        warnUnstatedReasoningOnce({ identity: runtimeContextBudget.identity, vendor: llmSettings.provider, model }, reasoning);
        requestModelSettings = { ...modelSettingsBase, ...(reasoning ? { reasoning } : {}) };
      }
      // Snapshot partial text under its eventual row ID, including captured continuation carry.
      const roundJournal = self.activeTurnJournal;
      // Flush completed rows before the next provider request so process death cannot lose completed rounds.
      if (roundJournal) await roundJournal.settled();
      const carryTextAtStreamStart = continuationCarryText;
      const carryThoughtAtStreamStart = continuationCarryThought;
      let streamedText = "";
      let streamedThought = "";
      const renderPartial = () => ({
        content: stripSuggestedReplies(carryTextAtStreamStart + streamedText),
        thought: carryThoughtAtStreamStart + streamedThought,
      });
      const stream = await collectActiveRuntimeRoundStream(
        {
          provider: turnProvider,
          model,
          systemPrompt,
          messages: messagesForRound,
          toolSchemas,
          llmSettings: roundLlmSettings,
          abortSignal,
          continuationPrefill: continuationPrefillText !== undefined,
          promptCacheKey: effectiveSessionId,
          onReasoningDelta: roundJournal
            ? (text: string) => {
                streamedThought += text;
                roundJournal.notePartial(renderPartial);
                callbacks?.onReasoningDelta?.(text);
              }
            : callbacks?.onReasoningDelta,
          onTextDelta: roundJournal
            ? (text: string) => {
                streamedText += text;
                roundJournal.notePartial(renderPartial);
                callbacks?.onTextDelta?.(text);
              }
            : callbacks?.onTextDelta,
          onRequestStarted: () => { turnModelSettings = requestModelSettings; },
          ...(apiRound === undefined ? {} : {
            onRequestControls: (controls: NonNullable<RunModelSettings["requestControls"]>) => {
              if (turnModelSettings === undefined) return;
              const reasoning = turnModelSettings.reasoning;
              turnModelSettings = {
                ...turnModelSettings,
                requestControls: { ...controls },
                ...(reasoning?.kind === "anthropic-numeric" && controls.thinkingBudgetTokens !== undefined
                  ? { reasoning: { ...reasoning, budgetTokens: controls.thinkingBudgetTokens } }
                  : {}),
              };
            },
          }),
        },
        self.deps.settingsService.get("llm").activeChatRuntime,
        () => self.abortCurrentTurn(new Error("active chat runtime changed")),
      );
      // Consume prefill once; the continuation branch re-arms it only if the chain extends.
      continuationPrefillText = undefined;

      // End on context drift instead of mutating active tool history in a mid-loop retry.
      if (stream.kind === "context_error") {
        log.warn(
          `queryLoop: EARLY-EXIT(context_error after token preflight) — round=${roundIndex} err="${(stream.errorMessage ?? "").slice(0, 100)}" (estimator drift suspected)`,
        );
        decide({
          kind: "early_exit",
          branch: "context_error",
          reason: "estimator-drift",
          data: { round: roundIndex },
        });
        // context_error is already classified as capacity overflow; TPM failures take the stream-error path.
        const userMsg =
          t("be_conversationLoop.contextErrorUserMessage");
        callbacks?.onError?.(userMsg, "context-error");
        // Host error notices need systemNotice metadata so they cannot impersonate assistant replies.
        self.history.append({
          role: "assistant",
          content: userMsg,
          meta: { systemNotice: "context-error" },
        });
        // The displayed recovery promise requires forced compaction on the next send.
        self.contextErrorPending = true;
        return withServingIdentity({ text: userMsg, toolCalls: allToolCalls, usage: turnUsage, stopReason: "context-error" });
      }

      if (stream.kind === "stream_error") {
        const streamErrorMeta = {
          round,
          assistantRoundIndex: roundIndex,
          classification: stream.classification,
          providerError: stream.providerError,
          request: requestDiagnostics,
        };
        log.warn(
          {
            sessionId: self.sessionId,
            ...streamErrorMeta,
          },
          `queryLoop: EARLY-EXIT(stream-error) — round=${roundIndex} userMessage="${stream.userMessage.slice(0, 100)}"`,
        );
        self.tracer.step("LLM_STREAM_ERROR", streamErrorMeta);

        // Drop only the rejected tool still present in schemas; each retry shrinks the finite set.
        const rejectedTool = rejectedToolNameFromError(
          stream.providerError,
          toolSchemas.map((s) => s.name),
        );
        if (
          rejectedTool &&
          !droppedToolSchemaNames.has(rejectedTool) &&
          droppedToolSchemaNames.size >= MAX_TOOL_SCHEMA_DROPS_PER_TURN
        ) {
          decide({
            kind: "tool_schema.drop",
            branch: "ceiling",
            data: {
              dropped: droppedToolSchemaNames.size,
              cap: MAX_TOOL_SCHEMA_DROPS_PER_TURN,
            },
          });
        }
        if (
          rejectedTool &&
          !droppedToolSchemaNames.has(rejectedTool) &&
          droppedToolSchemaNames.size < MAX_TOOL_SCHEMA_DROPS_PER_TURN
        ) {
          droppedToolSchemaNames.add(rejectedTool);
          toolSchemas = toolSchemas.filter((s) => s.name !== rejectedTool);
          log.warn(
            {
              sessionId: self.sessionId,
              toolName: rejectedTool,
              providerCode: stream.providerError?.providerCode,
              remainingTools: toolSchemas.length,
            },
            `queryLoop: provider rejected tool inputSchema — dropping '${rejectedTool}' and retrying round (provider-as-oracle)`,
          );
          self.tracer.step("TOOL_SCHEMA_REJECTED", {
            round,
            assistantRoundIndex: roundIndex,
            toolName: rejectedTool,
            providerError: stream.providerError,
          });
          decide({
            kind: "tool_schema.drop",
            branch: "dropped",
            reason: rejectedTool,
            data: {
              dropped: droppedToolSchemaNames.size,
              remainingTools: toolSchemas.length,
            },
          });
          // Schema retry does not consume an assistant round; total iterations remain budget-bounded.
          continue;
        }

        if (
          self.shouldAutoCompactForRateLimit(stream) &&
          !self.rateLimitRecoveryAttempted &&
          self.provider &&
          !self.deps.disableSessionPersistence
        ) {
          self.rateLimitRecoveryAttempted = true;
          const compacted = await self.runPreflightGuard(
            {
              systemPrompt,
              toolSchemas,
              estimateCurrent: () => self.estimateCurrentRequestProjection({
                turnContext: self.buildTurnContext(bounds.memoryQuery ?? "", stagedOrigin),
                systemPrompt,
                toolSchemas,
              }),
            },
            abortSignal,
            callbacks,
            // Mid-turn recovery must preserve tool rounds so it can reduce the active turn.
            { forceReason: "rate-limit", intraTurn: true },
          );
          if (compacted) {
            const recoveredMessage = self.rateLimitCompactMessage(stream);
            callbacks?.onTextDelta?.(recoveredMessage);
            self.history.append({
              role: "assistant",
              content: recoveredMessage,
            });
            return withServingIdentity({
              text: recoveredMessage,
              toolCalls: allToolCalls,
              usage: turnUsage,
              stopReason: "stream-error",
            });
          }
        }
        callbacks?.onError?.(stream.userMessage, "stream-error", stream.classification);
        self.history.append({
          role: "assistant",
          content: stream.userMessage,
          meta: { systemNotice: "stream-error" },
        });
        // Force context recovery only for actual capacity failures; other errors must not discard working history.
        if (isContextLengthError(stream.userMessage)) {
          self.contextErrorPending = true;
        }
        decide({
          kind: "early_exit",
          branch: "stream-error",
          ...(stream.classification ? { reason: stream.classification } : {}),
          data: { round: roundIndex },
        });
        return withServingIdentity({ text: stream.userMessage, toolCalls: allToolCalls, usage: turnUsage, stopReason: "stream-error" });
      }

      if (stream.kind === "interrupted") {
        log.info(
          `queryLoop: EARLY-EXIT(interrupted) — round=${roundIndex} priorTextLen=${(stream.text ?? "").length}`,
        );
        decide({
          kind: "early_exit",
          branch: "interrupted",
          data: { round: roundIndex, priorTextChars: (stream.text ?? "").length },
        });
        // Strip suggestion markup before persistence; interruption is metadata, never synthetic model prose.
        // Prepend continuation carry so interrupted chains retain their full partial answer.
        const savedText = stripSuggestedReplies(continuationCarryText + (stream.text ?? ""));
        self.history.append({
          role: "assistant",
          content: savedText,
          meta: {
            interrupted: true,
            ...(isHostExitAbort(abortSignal?.reason) ? { interruptedBy: HOST_EXIT_INTERRUPTION } : {}),
            // Reuse the snapshot row ID to prevent recovery from displaying both copies.
            ...(roundJournal ? { messageId: roundJournal.currentRoundRowId() } : {}),
          },
        });
        return withServingIdentity({ text: savedText, toolCalls: allToolCalls, usage: turnUsage, stopReason: "interrupted" });
      }

      // Aggregate every round; normalized input includes cache, so cumulative fresh input subtracts it.
      // Keep cache reads and writes separate for their distinct prices.
      if (stream.usage) recordProviderUsage(stream.usage, true);

      const { text: streamText, thought: thoughtContent, thinkingBlocks: roundThinkingBlocks, toolCalls: pendingToolCalls, stopReason } = stream;
      recordSubscriptionRoundTelemetry(
        self, subscriptionUsage, subscriptionRuntime, stream, stopReason === "end_turn",
      );
      // Keep raw continuation carry to preserve inter-chunk whitespace and exact prefill.
      // Strip suggestions once from the merged answer before history, callbacks, and return values.
      const mergedRawText = continuationCarryText + streamText;
      const mergedThought = continuationCarryThought + thoughtContent;
      const mergedText = stripSuggestedReplies(mergedRawText);

      // Length truncation without tools may continue; defer commit and callbacks until one merged answer ends.
      const madeProgress = streamText.length > 0 || thoughtContent.length > 0;
      const willContinue =
        stopReason === "max_tokens" &&
        pendingToolCalls.length === 0 &&
        supportsLengthContinuation &&
        continuationsRun < MAX_LENGTH_CONTINUATIONS &&
        assistantRoundsRun + 1 < effectiveMaxRounds &&
        madeProgress;

      if (stopReason === "max_tokens" && pendingToolCalls.length === 0) {
        decide({
          kind: "length.continuation",
          branch: willContinue ? "continue" : "stop",
          ...(willContinue
            ? {}
            : {
              reason: !supportsLengthContinuation
                ? "unsupported-runtime"
                : continuationsRun >= MAX_LENGTH_CONTINUATIONS
                  ? "cap"
                  : assistantRoundsRun + 1 >= effectiveMaxRounds
                    ? "round-budget"
                    : "no-progress",
            }),
          data: {
            continuationsRun,
            cap: MAX_LENGTH_CONTINUATIONS,
            carryTextChars: mergedRawText.length,
          },
        });
      }

      if (willContinue) {
        continuationCarryText = mergedRawText;
        continuationCarryThought = mergedThought;
        // Continue answer text verbatim; reasoning-only truncation reopens its unfinished think block.
        continuationPrefillText =
          mergedRawText.length > 0 ? mergedRawText : `<think>\n${mergedThought}`;
        continuationsRun += 1;
        assistantRoundsRun += 1;
        self.tracer.step("LENGTH_CONTINUATION", {
          round: roundIndex,
          continuationsRun,
          carryTextLen: continuationCarryText.length,
          reopenedThink: mergedRawText.length === 0,
        });
        // Continuations share roundIndex and an open UI card; firing completion here would drop later deltas.
        continue;
      }

      // Cap before persistence so every stored call receives a matching executed result.
      let pendingToolCallsCapped = pendingToolCalls;
      const wasCapped = pendingToolCalls.length > MAX_TOOL_CALLS_PER_ROUND;
      if (wasCapped) {
        log.warn(
          `conversation-loop: round ${roundIndex} emitted ${pendingToolCalls.length} tool_use blocks, capping to ${MAX_TOOL_CALLS_PER_ROUND}`,
        );
        pendingToolCallsCapped = pendingToolCalls.slice(0, MAX_TOOL_CALLS_PER_ROUND);
      }

      // Persist registry-owned tool provenance so reloaded action panels retain plugin and MCP attribution.
      const persistedToolCalls: ToolCallBlock[] = pendingToolCallsCapped.map((toolCall) => {
        const tool = self.deps.toolRegistry.findByName(toolCall.name);
        if (!tool) return toolCall;
        return {
          ...toolCall,
          source: tool.source,
          category: tool.category,
          ...(tool.pluginId ? { pluginId: tool.pluginId } : {}),
          ...(tool.mcpServerId ? { mcpServerId: tool.mcpServerId } : {}),
        };
      });

      // Pending tool chains must replay signed thinking blocks with unchanged signatures.
      const preserveThinkingBlocks = stopReason === "tool_use" && pendingToolCallsCapped.length > 0;
      const committedAssistantRow = self.history.append({
        role: "assistant",
        // A committed row supersedes its partial snapshot by sharing the same ID.
        ...(roundJournal ? { meta: { messageId: roundJournal.currentRoundRowId() } } : {}),
        content: wasCapped ? `${mergedText}\n\n[capped at ${MAX_TOOL_CALLS_PER_ROUND} of ${pendingToolCalls.length} tool_use blocks]` : mergedText,
        ...(mergedThought && { thought: mergedThought }),
        ...(preserveThinkingBlocks && roundThinkingBlocks.length > 0 && { thinkingBlocks: roundThinkingBlocks }),
        // Persist only executed calls; live UI may still report the full intended count.
        ...(persistedToolCalls.length > 0 && { toolCalls: persistedToolCalls }),
      });
      continuationCarryText = "";
      continuationCarryThought = "";
      // Flush calls before tool execution so recovery can show interrupted work with unknown results.
      if (roundJournal && persistedToolCalls.length > 0) await roundJournal.settled();

      if (thoughtContent.length > 0) {
        self.tracer.step("REASONING_ACCUMULATE", { round: roundIndex, thoughtLen: thoughtContent.length });
      }
      callbacks?.onAssistantRound?.({
        roundIndex,
        text: mergedText,
        thought: mergedThought,
        stopReason,
        // Reannounce the row ID so multi-round cards name the row containing their displayed answer.
        messageId: committedAssistantRow.meta.messageId,
        // Live telemetry retains the full intended fan-out even though stored calls are capped.
        hasToolCalls: pendingToolCalls.length > 0,
      });
      self.tracer.step("ROUND_COMMIT", {
        round: roundIndex,
        stopReason,
        textLen: mergedText.length,
        toolCallCount: pendingToolCalls.length,
      });
      await commitPendingGuidance();
      roundIndex += 1;
      // Both tool-call and terminal assistant commits count against the round budget.
      assistantRoundsRun += 1;

      if (pendingToolCalls.length === 0 || stopReason === "end_turn") {
        // Queued guidance takes effect before ending the turn; the cap still reports undelivered entries.
        if (self.guidanceQueue.length > 0 && assistantRoundsRun < effectiveMaxRounds) {
          self.tracer.step("GUIDANCE_INJECTED", {
            round: roundIndex,
            note: "extending turn — guide queued at end-turn boundary",
          });
          continue;
        }
        // Re-prompt bounded reasoning-only completion; truly empty rounds still terminate normally.
        const reasoningOnlyEnd =
          stopReason === "end_turn" &&
          pendingToolCalls.length === 0 &&
          mergedText.trim().length === 0 &&
          mergedThought.trim().length > 0;
        if (reasoningOnlyEnd) {
          const willNudge =
            reasoningNudgesRun < MAX_REASONING_ONLY_NUDGES &&
            assistantRoundsRun < effectiveMaxRounds;
          decide({
            kind: "reasoning_only.continuation",
            branch: willNudge ? "continue" : "stop",
            ...(willNudge
              ? {}
              : {
                reason: reasoningNudgesRun >= MAX_REASONING_ONLY_NUDGES
                  ? "cap"
                  : "round-budget",
              }),
            data: {
              nudgesRun: reasoningNudgesRun,
              cap: MAX_REASONING_ONLY_NUDGES,
              thoughtChars: mergedThought.length,
            },
          });
          if (willNudge) {
            reasoningNudgePending = true;
            self.tracer.step("REASONING_ONLY_CONTINUATION", {
              round: roundIndex,
              nudgesRun: reasoningNudgesRun,
              thoughtLen: mergedThought.length,
            });
            continue;
          }
        }
        // Deliberate stop-hook feedback continues as host-owned guidance, retaining its framing in later rounds.
        if (stopReason === "end_turn" && bounds.onStopHook && !abortSignal?.aborted) {
          const feedback = await bounds.onStopHook({
            toolCount: allToolCalls.length,
            stopHookActive: stopHookContinuationsRun > 0,
          });
          if (feedback !== undefined && !abortSignal?.aborted) {
            if (stopHookContinuationsRun >= MAX_STOP_HOOK_CONTINUATIONS) {
              log.warn(`queryLoop: stop hook continuation cap (${MAX_STOP_HOOK_CONTINUATIONS}) reached; ending the turn`);
              callbacks?.onError?.(t("be_conversationLoop.stopHookContinuationCap", { max: MAX_STOP_HOOK_CONTINUATIONS }));
            } else if (assistantRoundsRun < effectiveMaxRounds) {
              stopHookContinuationsRun += 1;
              self.history.append({
                role: "user",
                content: t("be_conversationLoop.stopHookFeedback", { reason: feedback }),
                meta: { hostInjectionId: randomUUID(), displayText: feedback },
              });
              continue;
            }
          }
        }
        // Warn on no-tool termination without end_turn so silent truncation remains diagnosable.
        if (stopReason !== "end_turn" && pendingToolCalls.length === 0) {
          log.warn(
            `queryLoop: EARLY-EXIT(suspect-truncation) — stopReason="${stopReason}" pendingTools=0 textLen=${mergedText.length} round=${roundIndex}`,
          );
          callbacks?.onError?.(
            t("be_conversationLoop.suspectTruncationError", { reason: stopReason ?? "unknown reason", round: roundIndex }),
          );
        }
        return withServingIdentity({ text: mergedText, toolCalls: allToolCalls, usage: turnUsage, stopReason });
      }

      // Malformed argument calls receive per-call errors without reaching execution.
      // Persisted results preserve replay pairing even though intercepted errors have no live tool card.
      for (const tc of pendingToolCallsCapped) {
        if (!tc.invalidInput) continue;
        const content = t("be_conversationLoop.toolCallInvalidArguments", {
          excerpt: tc.invalidInput.raw,
        });
        self.history.append({
          role: "tool_result",
          toolUseId: tc.id,
          toolName: tc.name,
          content,
          isError: true,
        });
        allToolCalls.push({ name: tc.name, input: {}, result: content });
        decide({
          kind: "tool_call.invalid_arguments",
          branch: tc.invalidInput.reason,
          data: { round: roundIndex, rawChars: tc.invalidInput.rawChars, tool: tc.name },
        });
      }

      const toolUses: ToolUseBlock[] = pendingToolCallsCapped
        .filter((tc) => !tc.invalidInput)
        .map((tc) => ({
          id: tc.id, name: tc.name, input: tc.input,
        }));

      const availableRationaleCoordinatorFactory =
        typeof self.deps.rationaleCoordinatorFactory === "function"
          ? self.deps.rationaleCoordinatorFactory
          : undefined;
      const currentRationaleProvenance = rationaleProvenanceFor(
        bounds.requestAnchor !== undefined,
        toolTrustOrigin,
      );
      const rationaleActivationRequested = isForegroundRationaleOrchestrationEnabled({
        productionEnabled: FOREGROUND_RATIONALE_PRODUCTION_ENABLED,
        nodeEnv: process.env.NODE_ENV,
        hostCoordinatorAvailable: availableRationaleCoordinatorFactory !== undefined,
        enableDormantRationaleForTesting:
          self.deps.enableDormantRationaleForTesting,
      });
      // Materialize the runtime before reordering meta tools; unavailable factories retain legacy ordering.
      const preparedRationaleRuntime = rationaleActivationRequested
        ? await prepareRationaleConversationRuntime({
            coordinatorFactory: availableRationaleCoordinatorFactory,
            requestAnchor: bounds.requestAnchor ?? null,
            rationaleProvenance: currentRationaleProvenance,
            sessionId: effectiveSessionId,
          })
        : null;
      const rationaleOrchestrationEnabled = preparedRationaleRuntime !== null;
      const firstNonMetaIndex = rationaleOrchestrationEnabled
        ? toolUses.findIndex(
            (toolUse) =>
              toolUse.name !== REQUEST_PLUGIN_TOOL &&
              toolUse.name !== TOOL_SEARCH_TOOL,
          )
        : -1;
      const eagerMetaToolUses = firstNonMetaIndex >= 0
        ? toolUses.slice(0, firstNonMetaIndex)
        : toolUses;
      const deferredOrderedToolUses = firstNonMetaIndex >= 0
        ? toolUses.slice(firstNonMetaIndex)
        : [];

      const interceptedMetaGate = await gateCrossAgentInterceptedMetaTools(
        self,
        eagerMetaToolUses,
        activeApprovalReasonPrefix,
        toolTrustOrigin,
        effectiveSessionId,
        bounds.remoteControllerAuthority,
      );
      const interceptedAuthorizationRequired = interceptedMetaGate.denied
        .map((denied) => authorizationRequiredStateOf(denied.authorizationRequired))
        .find((state): state is AuthorizationRequiredState => state !== undefined);
      for (const denied of interceptedMetaGate.denied) {
        self.history.append({
          role: "tool_result",
          toolUseId: denied.toolUseId,
          toolName: denied.toolName,
          content: denied.content,
          isError: true,
        });
        allToolCalls.push({
          name: denied.toolName,
          input: toolUses.find((toolUse) => toolUse.id === denied.toolUseId)?.input ?? {},
          result: denied.content,
        });
      }

      const sessionActivatedBefore = new Set(self.sessionActivatedPluginIds);
      const pluginExpansionsBefore = pluginExpansions;
      const requestedPluginExpansions = interceptedMetaGate.approved
        .filter((toolUse) => toolUse.name === REQUEST_PLUGIN_TOOL).length;
      const pluginOutcome = handleRequestPlugin(interceptedMetaGate.approved, {
        turnExpansions: pluginExpansions,
        sessionExpansions: self.sessionPluginExpansions,
        activePluginIds: scope.activePluginIds,
        availablePluginIds: self.filterAllowedPluginIds(
          (self.deps.pluginRuntime?.listPluginIds() ?? [])
            // Only allowlisted sessions may activate disabled plugins for themselves; main chat cannot.
            .filter((pluginId) =>
              self.deps.pluginRuntime?.isPluginEnabled?.(pluginId) !== false ||
              self.deps.allowedPluginIds?.has(pluginId) === true),
        ),
        sessionActivatedPluginIds: self.sessionActivatedPluginIds,
        isPluginEnabled: (pluginId) =>
          self.deps.pluginRuntime?.isPluginEnabled?.(pluginId) !== false,
      });
      pluginExpansions = pluginOutcome.nextTurnExpansions;
      self.sessionPluginExpansions = pluginOutcome.nextSessionExpansions;
      if (requestedPluginExpansions > 0) {
        const activatedPlugins = pluginOutcome.activatedPluginIds.length;
        decide({
          kind: "plugin.expansion",
          branch: activatedPlugins > 0
            ? "expanded"
            : pluginExpansionsBefore >= MAX_PLUGIN_EXPANSION
              ? "ceiling"
              : "rejected",
          data: {
            requested: requestedPluginExpansions,
            activated: activatedPlugins,
            turnExpansions: pluginExpansions,
            cap: MAX_PLUGIN_EXPANSION,
          },
        });
      }

      // Audit each new session-only activation because enabled state is never persisted.
      for (const activated of self.sessionActivatedPluginIds) {
        if (!sessionActivatedBefore.has(activated)) {
          // Publish session activation before dispatching remaining tools so delegate checks see it.
          // Use the same effective session ID as async context; never persist enabled state.
          self.deps.pluginRuntime?.setSessionActivated?.(effectiveSessionId, activated);
          self.auditLogger.log({
            timestamp: new Date().toISOString(),
            sessionId: effectiveSessionId,
            type: "info",
            input: `session_activated_disabled_plugin pluginId=${activated} (non-persistent; registry stays enabled:false)`,
          });
        }
      }

      const rebuiltAfterPlugin = pluginOutcome.activatedPluginIds.length > 0;
      if (rebuiltAfterPlugin) {
        scope.deferral = self.shouldDeferToolSchemas(scope.activePluginIds);
        toolSchemas = rebuildTurnToolSchemas();
      }
      const catalogCountAfterPlugin = self.deps.toolRegistry.getToolCatalogForScope(scope).length;
      for (const rr of pluginOutcome.results) {
        // Eager activation exposes the full suite immediately; only deferred mode needs search guidance.
        const finalContent = !rr.is_error && rebuiltAfterPlugin
          ? scope.deferral
            ? t("be_conversationLoop.pluginToolsDeferred", { content: rr.content, catalogCount: catalogCountAfterPlugin, loadedCount: toolSchemas.length })
            : t("be_conversationLoop.pluginToolsEager", { content: rr.content, loadedCount: toolSchemas.length })
          : rr.content;
        self.history.append({
          role: "tool_result",
          toolUseId: rr.tool_use_id,
          toolName: REQUEST_PLUGIN_TOOL,
          content: finalContent,
          ...(rr.is_error && { isError: true }),
        });
      }
      for (const activated of pluginOutcome.activatedPluginIds) {
        allToolCalls.push({
          name: REQUEST_PLUGIN_TOOL,
          input: { pluginId: activated },
          result: `activated:${activated}`,
        });
      }

      // Search promotion rebuilds schemas and synthesizes paired results before remaining execution.
      let toolUsesForExecutor: ToolUseBlock[];
      let searchPromotedThisRound = false;
      const prevToolCountForSearch = toolSchemas.length;
      const toolSearchesBefore = toolSearches;
      const sessionToolSearchesBefore = self.sessionToolSearches;
      const requestedToolSearches = pluginOutcome.remaining
        .filter((toolUse) => toolUse.name === TOOL_SEARCH_TOOL).length;
      const searchOutcome = handleToolSearch(pluginOutcome.remaining, {
        turnSearches: toolSearches,
        sessionSearches: self.sessionToolSearches,
        activeToolNames: scope.activeToolNames,
        loadedToolNames: new Set(toolSchemas.map((tool) => tool.name)),
        loadedTools: toolSchemas.map((tool) => ({
          name: tool.name,
          description: tool.description,
        })),
        catalog: self.deps.toolRegistry.getToolCatalogForScope(scope),
      });
      toolSearches = searchOutcome.nextTurnSearches;
      self.sessionToolSearches = searchOutcome.nextSessionSearches;
      toolUsesForExecutor = [...searchOutcome.remaining, ...deferredOrderedToolUses];
      searchPromotedThisRound = searchOutcome.promotedToolNames.length > 0;
      promotedToolNamesForTurn.push(...searchOutcome.promotedToolNames);

      const rebuiltAfterSearch = searchOutcome.promotedToolNames.length > 0;
      if (rebuiltAfterSearch) {
        toolSchemas = rebuildTurnToolSchemas();
      }
      const addedBySearch = Math.max(0, toolSchemas.length - prevToolCountForSearch);
      if (requestedToolSearches > 0) {
        decide({
          kind: "tool_search",
          branch: searchOutcome.promotedToolNames.length > 0
            ? "promoted"
            : toolSearchesBefore >= MAX_TOOL_SEARCH_PER_TURN ||
              sessionToolSearchesBefore >= MAX_TOOL_SEARCH_PER_SESSION
              ? "cap"
              : "none",
          data: {
            requested: requestedToolSearches,
            promoted: searchOutcome.promotedToolNames.length,
            addedSchemas: addedBySearch,
            turnSearches: toolSearches,
            cap: MAX_TOOL_SEARCH_PER_TURN,
          },
        });
      }
      for (const rr of searchOutcome.results) {
        const finalContent = !rr.is_error && rebuiltAfterSearch
          ? t("be_conversationLoop.searchToolLoaded", { content: rr.content, loadedCount: toolSchemas.length, added: addedBySearch })
          : rr.content;
        self.history.append({
          role: "tool_result",
          toolUseId: rr.tool_use_id,
          toolName: TOOL_SEARCH_TOOL,
          content: finalContent,
          ...(rr.is_error && { isError: true }),
        });
      }
      for (const promoted of searchOutcome.promotedToolNames) {
        allToolCalls.push({
          name: TOOL_SEARCH_TOOL,
          input: { promoted },
          result: `loaded:${promoted}`,
        });
      }

      // Successful meta-only promotion refunds its assistant-round budget.
      if (toolUsesForExecutor.length === 0) {
        if (interceptedAuthorizationRequired) {
          decide({
            kind: "early_exit",
            branch: "authorization-required",
            reason: interceptedAuthorizationRequired.reason,
          });
          return withServingIdentity({
            text: mergedText,
            toolCalls: allToolCalls,
            usage: turnUsage,
            stopReason: "authorization-required",
            authorizationRequired: interceptedAuthorizationRequired,
          });
        }
        const promotedSomething =
          pluginOutcome.activatedPluginIds.length > 0 || searchPromotedThisRound;
        if (promotedSomething) round--;
        continue;
      }

      self.tracer.step("TOOL_EXECUTE", {
        round: roundIndex,
        toolNames: toolUsesForExecutor.map((tu) => tu.name),
      });
      const appendedToolResultIds = new Set<string>();
      const attachedDirectoryInstructions = liveDirectoryInstructions(self.history.getMessages());
      const appendToolResult = (tr: ToolResult): void => {
        if (appendedToolResultIds.has(tr.tool_use_id)) return;
        const resultMeta = toolResultMeta(
          tr,
          toolMetaByUseId.get(tr.tool_use_id),
          permissionReviewByUseId.get(tr.tool_use_id),
        );
        const toolUse = toolUsesForExecutor.find((tu) => tu.id === tr.tool_use_id);
        const directoryInstructions = directoryInstructionsForToolResult({
          projectRoot: self.getSessionProjectContext().projectRoot,
          source: toolMetaByUseId.get(tr.tool_use_id)?.source,
          toolInput: toolUse?.input,
          isError: tr.is_error === true,
          toolResultContent: tr.content,
          stubbedOnWire: !toolResultContentReachesWire(resultMeta),
          attached: attachedDirectoryInstructions,
          gitIgnoreVerdicts: self.gitIgnoreVerdicts,
        });
        const meta = directoryInstructions
          ? { ...resultMeta, directoryInstructions: directoryInstructions.attached }
          : resultMeta;
        self.history.appendToolResult({
          role: "tool_result",
          toolUseId: tr.tool_use_id,
          toolName: toolUse?.name,
          content: directoryInstructions ? `${tr.content}\n\n${directoryInstructions.text}` : tr.content,
          ...(tr.is_error && { isError: true }),
          ...("image" in tr && tr.image ? { image: tr.image } : {}),
          ...(meta ? { meta } : {}),
        });
        appendedToolResultIds.add(tr.tool_use_id);
      };
      const executeOptions = {
          onToolResult: async (result) => {
            appendToolResult(result);
            await self.activeTurnJournal?.settled();
          },
          callbacks: {
            onToolStart: (name, input, meta) => {
              toolMetaByUseId.set(meta.toolUseId, meta);
              callbacks?.onToolStart?.(name, input, meta);
            },
            onPermissionReview: (event) => {
              permissionReviewByUseId.set(event.toolUseId, event);
              callbacks?.onPermissionReview?.(event);
            },
            ...(callbacks?.onToolOutput
              ? { onToolOutput: callbacks.onToolOutput }
              : {}),
            onToolEnd: (name, result, isError, meta, uiPayload, durationMs) => {
              toolMetaByUseId.set(meta.toolUseId, meta);
              callbacks?.onToolEnd?.(name, result, isError, meta, uiPayload, durationMs);
            },
          },
          // Attribute child tool audits to the effective child session, not its parent.
          sessionId: bounds?.sessionIdOverride ?? self.sessionId,
          // Staged origins bypass cached allow-always decisions and require confirmation for effects.
          overlayTriggerOrigin: stagedOrigin ?? null,
          // Carry spawn depth so execution refuses recursive agent_spawn calls.
          spawnDepth: bounds?.spawnDepth,
          memoryIncludeUnscoped: self.getSessionMemoryProjectContext?.()?.includeUnscoped === true,
          supportsA2AParentDelivery: self.deps.supportsA2AParentDelivery === true,
          approvalReasonPrefix: activeApprovalReasonPrefix,
          // Pass the turn abort signal so blocking tools honor user stop.
          a2aCausalContext: activeA2ACausalContext,
          abortSignal,
          toolResultChunkReader: (toolUseId) => self.readToolResultForChunk(toolUseId),
          toolOutputCaptureFactory: (toolUseId) => {
            const capture = self.deps.memoryManager.startToolOutputCapture(bounds?.sessionIdOverride ?? self.sessionId, toolUseId);
            ownedOutputCaptures.push(capture);
            return capture;
          },
          executionCwd: self.getSessionExecutionCwd(),
          permissionContext: {
            // One-turn unattended authority selects routine approval policy without changing tool or egress scope.
            ...(bounds.unattendedAuthority !== undefined
              ? { headless: true, ownerUnattended: true }
              : { headless: self.deps.headless }),
            approvalSurface: self.deps.approvalSurface,
            allowedPluginIds: new Set(scope.activePluginIds),
            projectDirectories: self.deps.getAdditionalDirectories?.() ?? self.deps.additionalDirectories ?? [],
            additionalDirectories: self.getTurnAdditionalDirectories(),
            getAdditionalDirectories: () => self.getTurnAdditionalDirectories(),
            trustOrigin: toolTrustOrigin,
            ...(bounds.remoteControllerAuthority
              ? { remoteControllerAuthority: bounds.remoteControllerAuthority }
              : {}),
            ...(bounds.requestAnchor
              ? {
                  requestAnchor: bounds.requestAnchor,
                  rationaleProvenance: rationaleProvenanceFor(true, toolTrustOrigin),
                }
              : {}),
            ...(bounds.permissionUserIntent ? { userIntent: bounds.permissionUserIntent } : {}),
            onTurnDirectoryGrant: (path) => self.addTurnAdditionalDirectory(path),
            onSessionDirectoryGrant: (path) => self.addSessionAdditionalDirectory(path),
          },
      } satisfies ConversationExecuteOptions;
      const orderedMetaToolHandler: InterceptedMetaToolHandler | undefined =
        rationaleOrchestrationEnabled
          ? async (toolUse) => {
              const gated = await gateCrossAgentInterceptedMetaTools(
                self,
                [toolUse],
                activeApprovalReasonPrefix,
                toolTrustOrigin,
                effectiveSessionId,
                bounds.remoteControllerAuthority,
              );
              const denied = gated.denied[0];
              if (denied) {
                return {
                  tool_use_id: toolUse.id,
                  content: denied.content,
                  is_error: true,
                  ...(denied.authorizationRequired
                    ? { authorizationRequired: denied.authorizationRequired }
                    : {}),
                  durationMs: 0,
                };
              }
              if (gated.approved.length !== 1) return null;

              if (toolUse.name === REQUEST_PLUGIN_TOOL) {
                const sessionActivatedBefore = new Set(self.sessionActivatedPluginIds);
                const outcome = handleRequestPlugin([toolUse], {
                  turnExpansions: pluginExpansions,
                  sessionExpansions: self.sessionPluginExpansions,
                  activePluginIds: scope.activePluginIds,
                  availablePluginIds: self.filterAllowedPluginIds(
                    (self.deps.pluginRuntime?.listPluginIds() ?? [])
                      .filter((pluginId) =>
                        self.deps.pluginRuntime?.isPluginEnabled?.(pluginId) !== false ||
                        self.deps.allowedPluginIds?.has(pluginId) === true),
                  ),
                  sessionActivatedPluginIds: self.sessionActivatedPluginIds,
                  isPluginEnabled: (pluginId) =>
                    self.deps.pluginRuntime?.isPluginEnabled?.(pluginId) !== false,
                });
                pluginExpansions = outcome.nextTurnExpansions;
                self.sessionPluginExpansions = outcome.nextSessionExpansions;

                for (const activated of self.sessionActivatedPluginIds) {
                  if (!sessionActivatedBefore.has(activated)) {
                    self.deps.pluginRuntime?.setSessionActivated?.(
                      effectiveSessionId,
                      activated,
                    );
                    self.auditLogger.log({
                      timestamp: new Date().toISOString(),
                      sessionId: effectiveSessionId,
                      type: "info",
                      input: `session_activated_disabled_plugin pluginId=${activated} (non-persistent; registry stays enabled:false)`,
                    });
                  }
                }

                const rebuilt = outcome.activatedPluginIds.length > 0;
                if (rebuilt) {
                  scope.deferral = self.shouldDeferToolSchemas(scope.activePluginIds);
                  toolSchemas = rebuildTurnToolSchemas();
                }
                const result = outcome.results[0];
                if (!result) return null;
                const catalogCount =
                  self.deps.toolRegistry.getToolCatalogForScope(scope).length;
                const content = !result.is_error && rebuilt
                  ? scope.deferral
                    ? t("be_conversationLoop.pluginToolsDeferred", {
                        content: result.content,
                        catalogCount,
                        loadedCount: toolSchemas.length,
                      })
                    : t("be_conversationLoop.pluginToolsEager", {
                        content: result.content,
                        loadedCount: toolSchemas.length,
                      })
                  : result.content;
                return {
                  tool_use_id: toolUse.id,
                  content,
                  is_error: result.is_error,
                  durationMs: 0,
                };
              }

              if (toolUse.name === TOOL_SEARCH_TOOL) {
                const previousToolCount = toolSchemas.length;
                const outcome = handleToolSearch([toolUse], {
                  turnSearches: toolSearches,
                  sessionSearches: self.sessionToolSearches,
                  activeToolNames: scope.activeToolNames,
                  loadedToolNames: new Set(toolSchemas.map((tool) => tool.name)),
                  loadedTools: toolSchemas.map((tool) => ({
                    name: tool.name,
                    description: tool.description,
                  })),
                  catalog: self.deps.toolRegistry.getToolCatalogForScope(scope),
                });
                toolSearches = outcome.nextTurnSearches;
                self.sessionToolSearches = outcome.nextSessionSearches;
                promotedToolNamesForTurn.push(...outcome.promotedToolNames);
                const rebuilt = outcome.promotedToolNames.length > 0;
                if (rebuilt) toolSchemas = rebuildTurnToolSchemas();
                const result = outcome.results[0];
                if (!result) return null;
                const addedToolCount = Math.max(
                  0,
                  toolSchemas.length - previousToolCount,
                );
                return {
                  tool_use_id: toolUse.id,
                  content: !result.is_error && rebuilt
                    ? t("be_conversationLoop.searchToolLoaded", {
                        content: result.content,
                        loadedCount: toolSchemas.length,
                        added: addedToolCount,
                      })
                    : result.content,
                  is_error: result.is_error,
                  durationMs: 0,
                };
              }

              return null;
            }
          : undefined;
      const replayBlockedResultsById = new Map<string, ToolResult>();
      const executableToolUses = toolUsesForExecutor.filter((toolUse) => {
        if (
          bounds.requestAnchor === undefined ||
          (cancelledSiblingProposalDigests.size === 0 && !cancelledSiblingProposalGuardIncomplete)
        ) {
          return true;
        }
        try {
          const guard = createCancelledSiblingProposalGuard({
            anchorId: bounds.requestAnchor.anchorId,
            toolName: toolUse.name,
            originalInput: toolUse.input,
          });
          if (!cancelledSiblingProposalGuardIncomplete && !cancelledSiblingProposalDigests.has(guard.proposalDigest)) {
            return true;
          }
        } catch {
          // Once replay guards exist, non-canonical proposals cannot prove they differ from canceled siblings.
        }
        log.warn(
          { sessionId: effectiveSessionId, toolName: toolUse.name },
          "rationale cancelled sibling replay blocked",
        );
        replayBlockedResultsById.set(toolUse.id, {
          tool_use_id: toolUse.id,
          content: RATIONALE_SIBLING_REPLAY_BLOCKED_RESULT,
          is_error: true,
          durationMs: 0,
        });
        return false;
      });
      // Report batch shape only; actual parallel overlap belongs to executor segmentation and spans.
      if (toolUsesForExecutor.length > 0) {
        decide({
          kind: "tool_batch",
          branch: executableToolUses.length > 1 ? "batched" : "single",
          data: {
            size: toolUsesForExecutor.length,
            executable: executableToolUses.length,
            replayBlocked: replayBlockedResultsById.size,
          },
        });
      }
      const rationaleBatch = executableToolUses.length === 0
        ? {
            results: [],
            rationaleUsage: null,
            rationaleAttempted: false,
            cancelledSiblingProposalGuards: [],
            cancelledSiblingProposalGuardIncomplete: false,
          }
        : await executeRationaleAwareConversationBatch({
            executor: self.toolExecutor,
            toolUses: executableToolUses,
            executeOptions,
            provider: turnProvider,
            model,
            llmSettings: roundLlmSettings,
            ...(abortSignal ? { abortSignal } : {}),
            requestAnchor: bounds.requestAnchor ?? null,
            rationaleProvenance: currentRationaleProvenance,
            sessionId: effectiveSessionId,
            rationaleRuntime: preparedRationaleRuntime,
            ...(orderedMetaToolHandler
              ? { interceptedMetaToolHandler: orderedMetaToolHandler }
              : {}),
          });
      for (const guard of rationaleBatch.cancelledSiblingProposalGuards) {
        if (guard.anchorId === bounds.requestAnchor?.anchorId) {
          cancelledSiblingProposalDigests.add(guard.proposalDigest);
        }
      }
      cancelledSiblingProposalGuardIncomplete ||=
        rationaleBatch.cancelledSiblingProposalGuardIncomplete;
      const executedResultsById = new Map(
        rationaleBatch.results.map((result) => [result.tool_use_id, result] as const),
      );
      const toolResults = toolUsesForExecutor.map((toolUse): ToolResult =>
        replayBlockedResultsById.get(toolUse.id) ??
        executedResultsById.get(toolUse.id) ?? {
          tool_use_id: toolUse.id,
          content: RATIONALE_TRIGGER_FAILED_RESULT,
          is_error: true,
          durationMs: 0,
        },
      );
      if (rationaleBatch.rationaleUsage) {
        recordProviderUsage(rationaleBatch.rationaleUsage, false);
      }
      toolTrustOrigin = nextToolTrustOrigin(toolTrustOrigin, toolUsesForExecutor, toolResults);

      for (let i = 0; i < toolUsesForExecutor.length; i++) {
        allToolCalls.push({
          name: toolUsesForExecutor[i].name,
          input: toolUsesForExecutor[i].input,
          result: toolResults[i]?.content ?? "(missing)",
        });
      }

      toolErrorsRun += toolResults.filter((tr) => tr.is_error === true).length;

      // Synthetic terminal results have no invocation callback; completed calls are already stored.
      for (const result of toolResults) appendToolResult(result);
      if (abortSignal?.aborted) {
        log.info(
          `queryLoop: EARLY-EXIT(tool-abort) — round=${roundIndex} toolResults=${toolResults.length}`,
        );
        // Tool-abort rows carry empty prose and interruption metadata, never a synthetic assistant answer.
        const savedText = "";
        self.history.append({
          role: "assistant",
          content: savedText,
          meta: {
            interrupted: true,
            ...(isHostExitAbort(abortSignal?.reason) ? { interruptedBy: HOST_EXIT_INTERRUPTION } : {}),
          },
        });
        return withServingIdentity({
          text: savedText,
          toolCalls: allToolCalls,
          usage: turnUsage,
          stopReason: "interrupted",
        });
      }
      const authorizationRequired = interceptedAuthorizationRequired
        ?? toolResults
          .map((toolResult) => authorizationRequiredStateOf(toolResult.authorizationRequired))
          .find((state): state is AuthorizationRequiredState => state !== undefined);
      if (authorizationRequired) {
        decide({
          kind: "early_exit",
          branch: "authorization-required",
          reason: authorizationRequired.reason,
        });
        return withServingIdentity({
          text: mergedText,
          toolCalls: allToolCalls,
          usage: turnUsage,
          stopReason: "authorization-required",
          authorizationRequired,
        });
      }
      const inputRequiredControls = toolResults.flatMap((toolResult) => {
        const toolUse = toolUsesForExecutor.find((candidate) =>
          candidate.id === toolResult.tool_use_id);
        const meta = toolMetaByUseId.get(toolResult.tool_use_id);
        return !toolResult.is_error
          && toolUse?.name === "agent_send"
          && meta?.source === "builtin"
          && isA2AQuestionInputRequiredControl(toolResult.rawResult)
          ? [toolResult.rawResult]
          : [];
      });
      if (inputRequiredControls.length === 1) {
        const control = inputRequiredControls[0]!;
        return withServingIdentity({
          text: mergedText,
          toolCalls: allToolCalls,
          usage: turnUsage,
          stopReason: "input-required",
          inputRequired: { reason: "question", prompt: control.prompt },
        });
      }
      if (inputRequiredControls.length > 1) {
        log.error("queryLoop: multiple a2a-input-required controls in one round");
        return withServingIdentity({
          text: mergedText,
          toolCalls: allToolCalls,
          usage: turnUsage,
          stopReason: "stream-error",
        });
      }

      // Evict aged images regardless of token pressure; the protect window guarantees they were sent once.
      {
        const { messages: afterEvict, result: ie } = evictAgedToolResultImages(
          self.history.getMessages(),
          INTRA_TURN_PRESERVE_RECENT_RESULTS,
        );
        if (ie.evicted) {
          self.history.clear();
          self.history.restore(afterEvict);
          if (process.env.NODE_ENV !== "production") {
            log.info(
              `image-evict (intra-turn): dropped ${ie.evictedCount} aged image(s), ~${ie.freedChars} base64 chars`,
            );
          }
        }
      }

      // Gate text stubbing on the current runtime budget, never inactive API-key context settings.
      const microCompactFloor = Math.floor(
        runtimeContextBudget.preflight * MICRO_COMPACT_FLOOR_FACTOR,
      );
      const microCompactProjected = self.lastRoundInputProjection?.totalTokens ?? 0;
      if (microCompactFloor > 0 && microCompactProjected < microCompactFloor) {
        decide({
          kind: "compact.micro",
          branch: "floor-hold",
          data: { floor: microCompactFloor, projected: microCompactProjected },
        });
      }
      if (microCompactFloor > 0 && microCompactProjected >= microCompactFloor) {
        const { messages: afterMark, result: mr } = markStaleToolResults(
          self.history.getMessages(),
          { preserveRecentToolResults: INTRA_TURN_PRESERVE_RECENT_RESULTS },
        );
        decide({
          kind: "compact.micro",
          branch: mr.marked ? "fired" : "nothing-stale",
          data: {
            floor: microCompactFloor,
            projected: microCompactProjected,
            marked: mr.markedCount,
            freedChars: mr.freedCharsOnSerialize,
          },
        });
        if (mr.marked) {
          self.history.clear();
          self.history.restore(afterMark);
          if (process.env.NODE_ENV !== "production") {
            log.info(
              `mark-stale (intra-turn): marked ${mr.markedCount} tool_results, ~${mr.freedCharsOnSerialize} chars saved on serialize`,
            );
          }
        }
      }
    }

    // Exhausted outer iterations are resumable round-cap termination, including meta-tool refund churn.
    decide({
      kind: "early_exit",
      branch: "round-cap",
      reason: "loop-bound",
      data: {
        assistantRoundsRun,
        effectiveMaxRounds,
        toolCalls: allToolCalls.length,
      },
    });
    return withServingIdentity({ text: t("be_conversationLoop.toolRoundLimitExceeded"), toolCalls: allToolCalls, usage: turnUsage, stopReason: "round-cap" });
    } finally {
      rollbackPendingGuidance();
      const referenced = new Set(self.history.getMessages().map((message) => message.meta?.outputArtifact?.captureId));
      for (const capture of ownedOutputCaptures) {
        if (!referenced.has(capture.captureId)) capture.abandon?.();
      }
    }
  }

// Derive live and persisted guidance provenance together so reload renders the same attribution.

/** Bound batches by dropping oldest text visibly; notify every dropped producer entry. */
function truncateGuidanceBatch<T extends { text: string }>(
  queue: readonly T[],
): { kept: T[]; dropped: T[]; joined: string } {
  const kept = [...queue];
  const dropped: T[] = [];
  let joined = kept.map((entry) => entry.text).join("\n\n");
  let truncatedCount = 0;
  while (joined.length > GUIDE_JOINED_MAX_CHARS && kept.length > 1) {
    const removed = kept.shift();
    if (removed) dropped.push(removed);
    truncatedCount += 1;
    joined = kept.map((entry) => entry.text).join("\n\n");
  }
  return {
    kept,
    dropped,
    joined: truncatedCount > 0
      ? t("be_conversationLoop.guidanceTruncationMarker", { count: truncatedCount, joined })
      : joined,
  };
}

/** Attribute to children only when every entry is a child report; mixed user guides keep user framing. */
function subAgentSourceForBatch(
  entries: readonly { subAgentTitle?: string }[],
): GuidanceInjectionSource | undefined {
  if (entries.length === 0) return undefined;
  const titles = [...new Set(entries.map((entry) => entry.subAgentTitle))];
  if (titles.includes(undefined)) return undefined;
  return {
    kind: "sub-agent",
    // Mixed-child batches stay unnamed so no child receives credit for another report.
    ...(titles.length === 1 ? { title: titles[0]! } : {}),
  };
}

function subAgentHistoryMeta(
  source: GuidanceInjectionSource | undefined,
): { meta: MessageMeta } | Record<string, never> {
  if (!source) return {};
  return {
    meta: {
      subAgentReport: source.title === undefined ? {} : { title: source.title },
    },
  };
}

// Persist tool display fields and permission verdict together for transcript reconstruction.
function toolResultMeta(
  result: ToolResult,
  callMeta: ToolCallMeta | undefined,
  review: PermissionReviewEvent | undefined,
): MessageMeta | undefined {
  const toolDisplay = "durationMs" in result
    ? {
        durationMs: result.durationMs,
        ...(callMeta?.source ? { source: callMeta.source } : {}),
        ...(callMeta?.category ? { category: callMeta.category } : {}),
        ...(callMeta?.pluginId ? { pluginId: callMeta.pluginId } : {}),
        ...(callMeta?.mcpServerId ? { mcpServerId: callMeta.mcpServerId } : {}),
        ...(callMeta?.cancelled ? { cancelled: true } : {}),
        ...("uiPayload" in result && result.uiPayload ? { uiPayload: result.uiPayload } : {}),
      }
    : undefined;
  const permissionReview = review
    ? {
        status: review.status,
        ...(review.verdictLevel ? { verdictLevel: review.verdictLevel } : {}),
        ...(review.reason ? { reason: review.reason } : {}),
      }
    : undefined;
  if (!toolDisplay && !permissionReview && !result.outputArtifact) return undefined;
  return {
    ...(toolDisplay ? { toolDisplay } : {}),
    ...(result.outputArtifact ? { outputArtifact: result.outputArtifact } : {}),
    ...(permissionReview ? { permissionReview } : {}),
  };
}

// Record API usage only with a verified serving identity.
function appendUsageForServingModel(
  usageByModel: TokenUsageByModel[],
  vendorProvider: LLMVendor | undefined,
  vendorModel: string | undefined,
  usage: TokenUsage,
  pricingOverrides: readonly PricingOverride[],
  primaryRoute?: { vendor: string; model: string } & ModelPricingRoute,
): void {
  if (vendorProvider === undefined || vendorModel === undefined) {
    return;
  }
  usageByModel.push({
    vendorProvider,
    vendorModel,
    pricing: resolveModelPricing(
      vendorProvider,
      vendorModel,
      pricingOverrides,
      primaryRoute?.vendor === vendorProvider && primaryRoute.model === vendorModel ? primaryRoute : undefined,
    ),
    tokenUsage: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      ...(usage.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
      ...(usage.cacheWriteTokens !== undefined ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
      ...(usage.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
    },
  });
}

// At round exhaustion, make one output-bounded, tool-free handoff call; it cannot extend the work.

const FINALIZE_OUTPUT_TOKEN_LIMIT = 1024;

export interface RoundCapFinalizeParams {
  provider: LLMProvider;
  model: string;
  systemPrompt: string;
  messages: GenericMessage[];
  modelCapabilities?: import("../llm/types.js").StreamTurnParams["modelCapabilities"];
  abortSignal?: AbortSignal;
}

export interface RoundCapFinalizeResult {
  text: string;
  usage?: TokenUsage;
}

/** Failed, aborted, or empty finalization returns null so existing partial text remains available. */
export async function finalizeAfterRoundCap(
  params: RoundCapFinalizeParams,
): Promise<RoundCapFinalizeResult | null> {
  if (params.abortSignal?.aborted) return null;

  const messages: GenericMessage[] = [
    ...params.messages,
    { role: "user", content: t("be_conversationLoop.roundCapFinalizePrompt") },
  ];

  let text = "";
  let usage: TokenUsage | undefined;
  try {
    for await (const event of params.provider.streamTurn({
      model: params.model,
      systemPrompt: params.systemPrompt,
      messages,
      ...(params.modelCapabilities !== undefined ? { modelCapabilities: params.modelCapabilities } : {}),
      // No tools: finalization reports work without extending it.
      outputTokenLimit: FINALIZE_OUTPUT_TOKEN_LIMIT,
      ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
    })) {
      if (event.type === "text_delta") text += event.text;
      else if (event.type === "message_complete") usage = event.usage;
      else if (event.type === "error") {
        log.warn({ error: event.error }, "round-cap finalize: provider error");
        return null;
      }
    }
  } catch (err) {
    log.warn(
      { err: errorMessage(err) },
      "round-cap finalize: call failed",
    );
    return null;
  }

  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  return usage ? { text: trimmed, usage } : { text: trimmed };
}

/** Prefer the final handoff, then real partial text, then a notice only when no answer exists. */
export function resolveRoundCapText(
  finalized: RoundCapFinalizeResult | null,
  messages: readonly GenericMessage[],
  roundCapNotice: string,
): string {
  if (finalized?.text) return finalized.text;
  const lastAssistant = messages
    .filter((m) => m.role === "assistant")
    .slice(-1)[0]?.content ?? "";
  return lastAssistant.length > 0 ? lastAssistant : roundCapNotice;
}

export function mergeFinalizeUsage(
  turnUsage: TokenUsage | undefined,
  finalized: RoundCapFinalizeResult | null,
): TokenUsage | undefined {
  const extra = finalized?.usage;
  if (!extra) return turnUsage;
  return {
    inputTokens: (turnUsage?.inputTokens ?? 0) + extra.inputTokens,
    outputTokens: (turnUsage?.outputTokens ?? 0) + extra.outputTokens,
    cacheReadTokens: (turnUsage?.cacheReadTokens ?? 0) + (extra.cacheReadTokens ?? 0),
    cacheWriteTokens: (turnUsage?.cacheWriteTokens ?? 0) + (extra.cacheWriteTokens ?? 0),
  };
}

const REQUEST_PLUGIN_TOOL = "request_plugin";

const MAX_PLUGIN_EXPANSION = 2;

const MAX_SESSION_PLUGIN_EXPANSION = 6;

interface PluginExpansionState {
  turnExpansions: number;

  sessionExpansions: number;

  activePluginIds: Set<string>;

  availablePluginIds: string[];
  // Record allowlisted disabled-plugin activation for this session only; never persist enabled state.
  sessionActivatedPluginIds?: Set<string>;
  isPluginEnabled?: (pluginId: string) => boolean;
}

interface PluginExpansionOutcome {
  results: Array<{ tool_use_id: string; content: string; is_error: boolean }>;

  remaining: ToolUseBlock[];

  activatedPluginIds: string[];

  nextTurnExpansions: number;

  nextSessionExpansions: number;
}

function handleRequestPlugin(
  toolUses: ToolUseBlock[],
  state: PluginExpansionState,
): PluginExpansionOutcome {
  const results: PluginExpansionOutcome["results"] = [];
  const remaining: ToolUseBlock[] = [];
  const activatedPluginIds: string[] = [];
  let turnExpansions = state.turnExpansions;
  let sessionExpansions = state.sessionExpansions;

  for (const tu of toolUses) {
    if (tu.name !== REQUEST_PLUGIN_TOOL) {
      remaining.push(tu);
      continue;
    }
    const pluginId = (tu.input as { pluginId?: unknown })?.pluginId;
    const availableIds = state.availablePluginIds;
    if (typeof pluginId !== "string" || pluginId.length === 0) {
      results.push({
        tool_use_id: tu.id,
        content: t("be_pluginExpansion.missingPluginId", { available: availableIds.join(", ") || t("be_pluginExpansion.noneAvailable") }),
        is_error: true,
      });
    } else if (!availableIds.includes(pluginId)) {
      results.push({
        tool_use_id: tu.id,
        content: t("be_pluginExpansion.unknownPluginId", { pluginId, available: availableIds.join(", ") || t("be_pluginExpansion.noneAvailable") }),
        is_error: true,
      });
    } else if (turnExpansions >= MAX_PLUGIN_EXPANSION) {
      results.push({
        tool_use_id: tu.id,
        content: t("be_pluginExpansion.turnLimitExceeded", { max: String(MAX_PLUGIN_EXPANSION), pluginId }),
        is_error: true,
      });
    } else if (sessionExpansions >= MAX_SESSION_PLUGIN_EXPANSION) {
      log.warn(
        `request_plugin session cap reached (${MAX_SESSION_PLUGIN_EXPANSION}). ` +
        `Rejecting '${pluginId}'.`,
      );
      results.push({
        tool_use_id: tu.id,
        content: t("be_pluginExpansion.sessionLimitExceeded", { max: String(MAX_SESSION_PLUGIN_EXPANSION), pluginId }),
        is_error: true,
      });
    } else {
      state.activePluginIds.add(pluginId);
      // Preserve activated scope for this session without changing registry enabled state.
      if (state.isPluginEnabled?.(pluginId) === false) {
        state.sessionActivatedPluginIds?.add(pluginId);
      }
      turnExpansions += 1;
      sessionExpansions += 1;
      activatedPluginIds.push(pluginId);
      results.push({
        tool_use_id: tu.id,
        // 호출자가 schema 재빌드 후 추가 도구 수와 activation 메시지를 보강한다.
        content: t("be_pluginExpansion.activated", { pluginId }),
        is_error: false,
      });
    }
  }

  return {
    results,
    remaining,
    activatedPluginIds,
    nextTurnExpansions: turnExpansions,
    nextSessionExpansions: sessionExpansions,
  };
}

// Promote catalog tools without execution; synthesize paired results and let the caller rebuild schemas.

export const TOOL_SEARCH_TOOL = TOOL_SEARCH_TOOL_NAME;

export const MAX_TOOL_SEARCH_PER_TURN = 4;

export const MAX_TOOL_SEARCH_PER_SESSION = 20;

export const MAX_TOOL_SEARCH_PROMOTIONS_PER_SEARCH = 5;

export const MIN_CATALOG_MATCH_TOKEN_LENGTH = 2;

interface ToolSearchCatalogEntry {
  name: string;
  description: string;
}

export interface ToolSearchState {
  turnSearches: number;

  sessionSearches: number;

  activeToolNames: Set<string>;

  loadedToolNames?: Set<string>;

  loadedTools?: ToolSearchCatalogEntry[];

  catalog: ToolSearchCatalogEntry[];
}

interface ToolSearchOutcome {
  results: Array<{ tool_use_id: string; content: string; is_error: boolean }>;

  remaining: ToolUseBlock[];

  promotedToolNames: string[];

  nextTurnSearches: number;

  nextSessionSearches: number;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function tokenizeQuery(query: string): string[] {
  const normalized = query.toLowerCase().trim();
  if (normalized.length === 0) return [];
  return uniqueStrings([
    normalized,
    ...normalized.split(/[\s,.;:()[\]{}"'`/\\|]+/),
    ...normalized.split(/[\s,.;:()[\]{}"'`/\\|_-]+/),
  ].map((token) => token.trim()).filter((token) => token.length >= MIN_CATALOG_MATCH_TOKEN_LENGTH));
}

function tokenizeName(name: string): string[] {
  return name.toLowerCase().split(/[_\-\s.]+/).filter((token) => token.length > 0);
}

function entrySearchText(entry: ToolSearchCatalogEntry): string {
  return `${entry.name} ${entry.description}`.toLowerCase();
}

// Damp common tokens with catalog-normalized IDF in [0.2, 1] while retaining a positive match floor.
function computeIdfWeights(
  catalog: ToolSearchCatalogEntry[],
  queryTokens: string[],
): Map<string, number> {
  const weights = new Map<string, number>();
  const total = catalog.length;
  if (total === 0) return weights;
  const texts = catalog.map(entrySearchText);
  const denom = Math.log(1 + total) || 1;
  for (const token of queryTokens) {
    if (weights.has(token)) continue;
    let documentFrequency = 0;
    for (const text of texts) {
      if (text.includes(token)) documentFrequency += 1;
    }
    const idf = documentFrequency > 0 ? Math.log(1 + total / documentFrequency) : Math.log(1 + total);
    weights.set(token, Math.min(1, Math.max(0.2, idf / denom)));
  }
  return weights;
}

function scoreCatalogEntry(
  query: string,
  tokens: string[],
  entry: ToolSearchCatalogEntry,
  idfWeights?: Map<string, number>,
): number {
  const name = entry.name.toLowerCase();
  const description = entry.description.toLowerCase();
  const nameTokens = tokenizeName(entry.name);
  // Exact name matches stay unweighted but must meet the minimum query length.
  let score = name === query && query.length >= MIN_CATALOG_MATCH_TOKEN_LENGTH ? 1_000 : 0;

  for (const token of tokens) {
    // Reject short tokens here even if a caller bypasses tokenizer filtering.
    if (token.length < MIN_CATALOG_MATCH_TOKEN_LENGTH) continue;
    let tokenScore = 0;
    if (name === token) {
      tokenScore = 700;
    } else if (name.startsWith(token)) {
      tokenScore = 350;
    } else if (nameTokens.includes(token)) {
      tokenScore = 300;
    } else if (name.includes(token)) {
      tokenScore = 120;
    }

    if (description.includes(token)) {
      tokenScore += 30;
    }

    // Missing weights default to one; common catalog tokens contribute less.
    score += tokenScore * (idfWeights?.get(token) ?? 1);
  }

  return score;
}

/** @internal Tests may exercise scorer guards independently of tokenizer filtering. */
export { scoreCatalogEntry as _scoreCatalogEntryForTest };
/** @internal Pure IDF test seam; import only from __tests__. */
export { computeIdfWeights as _computeIdfWeightsForTest };

function matchCatalog(
  query: string,
  catalog: ToolSearchCatalogEntry[],
): ToolSearchCatalogEntry[] {
  const normalizedQuery = query.toLowerCase().trim();
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) return [];
  const idfWeights = computeIdfWeights(catalog, tokens);
  return catalog
    .map((entry) => ({ entry, score: scoreCatalogEntry(normalizedQuery, tokens, entry, idfWeights) }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name))
    .slice(0, MAX_TOOL_SEARCH_PROMOTIONS_PER_SEARCH)
    .map((candidate) => candidate.entry);
}

export function handleToolSearch(
  toolUses: ToolUseBlock[],
  state: ToolSearchState,
): ToolSearchOutcome {
  const results: ToolSearchOutcome["results"] = [];
  const remaining: ToolUseBlock[] = [];
  const promotedToolNames: string[] = [];
  let turnSearches = state.turnSearches;
  let sessionSearches = state.sessionSearches;

  for (const tu of toolUses) {
    if (tu.name !== TOOL_SEARCH_TOOL) {
      remaining.push(tu);
      continue;
    }
    const query = (tu.input as { query?: unknown })?.query;
    if (typeof query !== "string" || query.trim().length === 0) {
      results.push({
        tool_use_id: tu.id,
        content: t("be_toolSearch.queryRequired"),
        is_error: true,
      });
    } else if (tokenizeQuery(query).length === 0) {
      results.push({
        tool_use_id: tu.id,
        content: t("be_toolSearch.queryTokenTooShort", { minLen: String(MIN_CATALOG_MATCH_TOKEN_LENGTH) }),
        is_error: true,
      });
    } else if (turnSearches >= MAX_TOOL_SEARCH_PER_TURN) {
      results.push({
        tool_use_id: tu.id,
        content: t("be_toolSearch.turnLimitExceeded", { max: String(MAX_TOOL_SEARCH_PER_TURN), query }),
        is_error: true,
      });
    } else if (sessionSearches >= MAX_TOOL_SEARCH_PER_SESSION) {
      log.warn(
        `tool_search session cap reached (${MAX_TOOL_SEARCH_PER_SESSION}). ` +
        `Rejecting query '${query}'.`,
      );
      results.push({
        tool_use_id: tu.id,
        content: t("be_toolSearch.sessionLimitExceeded", { max: String(MAX_TOOL_SEARCH_PER_SESSION), query }),
        is_error: true,
      });
    } else {
      const normalizedQuery = query.trim().toLowerCase();
      const loadedCatalog = state.loadedTools ?? [...(state.loadedToolNames ?? state.activeToolNames)]
        .map((name) => ({ name, description: "" }));
      const exactLoaded = loadedCatalog.find(
        (tool) => tool.name.toLowerCase() === normalizedQuery,
      );
      if (exactLoaded) {
        results.push({
          tool_use_id: tu.id,
          content: t("be_toolSearch.alreadyLoaded", { name: exactLoaded.name }),
          is_error: false,
        });
      } else {
        const matches = matchCatalog(query, state.catalog).filter(
          (m) => !state.activeToolNames.has(m.name),
        );
        if (matches.length === 0) {
          const loadedMatches = matchCatalog(query, loadedCatalog);
          if (loadedMatches.length > 0) {
            results.push({
              tool_use_id: tu.id,
              content: t("be_toolSearch.alreadyLoadedMultiple", { names: loadedMatches.map((m) => m.name).join(", ") }),
              is_error: false,
            });
          } else {
            results.push({
              tool_use_id: tu.id,
              content: t("be_toolSearch.noMatchFound", {
                query,
                catalog: state.catalog.map((c) => c.name).join(", ") || t("be_toolSearch.catalogEmpty"),
              }),
              is_error: true,
            });
          }
        } else {
          for (const m of matches) {
            state.activeToolNames.add(m.name);
            promotedToolNames.push(m.name);
          }
          turnSearches += 1;
          sessionSearches += 1;
          results.push({
            tool_use_id: tu.id,
            content: t("be_toolSearch.toolsPromoted", { count: String(matches.length), names: matches.map((m) => m.name).join(", ") }),
            is_error: false,
          });
        }
      }
    }
  }

  return {
    results,
    remaining,
    promotedToolNames,
    nextTurnSearches: turnSearches,
    nextSessionSearches: sessionSearches,
  };
}

// Intercepted scope-mutating meta tools bypass execution and need approval for non-local-user origins.

interface InterceptedMetaGateResult {
  approved: ToolUseBlock[];
  denied: Array<{
    toolUseId: string;
    toolName: string;
    content: string;
    authorizationRequired?: AuthorizationRequiredControl;
  }>;
}

function isApprovalChoiceAllowed(choice: string): boolean {
  return choice === "allow-once" || choice === "allow-session" || choice === "allow-always";
}

export async function gateCrossAgentInterceptedMetaTools(
  self: LoopContext,
  toolUses: ToolUseBlock[],
  approvalReasonPrefix: string | undefined,
  trustOrigin: ToolTrustOrigin,
  sessionId: string,
  remoteControllerAuthority?: RemoteControllerAuthority,
): Promise<InterceptedMetaGateResult> {
  if (!approvalReasonPrefix && !remoteControllerAuthority) {
    return { approved: toolUses, denied: [] };
  }

  const approved: ToolUseBlock[] = [];
  const denied: InterceptedMetaGateResult["denied"] = [];
  for (const toolUse of toolUses) {
    if (toolUse.name !== REQUEST_PLUGIN_TOOL && toolUse.name !== TOOL_SEARCH_TOOL) {
      approved.push(toolUse);
      continue;
    }

    // Remote controllers cannot create cross-turn capabilities without an actor-scoped continuation protocol.
    if (remoteControllerAuthority !== undefined) {
      denied.push({
        toolUseId: toolUse.id,
        toolName: toolUse.name,
        content: `remote-controller-meta-disabled: ${toolUse.name}`,
      });
      continue;
    }

    if (
      self.deps.headless !== true
      && self.deps.approvalSurface === "unavailable"
      && self.currentAbortController?.signal.aborted !== true
    ) {
      const content =
        "Authorization required: this cross-agent meta operation requires local approval, "
        + "but this host has no approval surface. The turn has stopped and will not retry automatically.";
      self.auditLogger.log({
        timestamp: new Date().toISOString(),
        sessionId,
        type: "error",
        input: `cross-agent-meta-authorization-required:${toolUse.name}`,
      });
      denied.push({
        toolUseId: toolUse.id,
        toolName: toolUse.name,
        content,
        authorizationRequired: issueAuthorizationRequiredControl({
          kind: "tool",
          toolName: toolUse.name,
          source: "builtin",
          category: "meta",
          reason: "approval-surface-unavailable",
        }),
      });
      continue;
    }

    const gate = self.deps.approvalGate;
    let allowed = false;
    if (!gate) {
      self.auditLogger.log({
        timestamp: new Date().toISOString(),
        sessionId,
        type: "error",
        input: `cross-agent-meta-approval-unavailable:${toolUse.name}`,
      });
    } else {
      try {
        const decision = await gate.requestAndWait({
          id: randomUUID(),
          category: "tool",
          kind: "tool",
          toolName: toolUse.name,
          toolCategory: "meta",
          sessionId,
          args: toolUse.input,
          reason: `${approvalReasonPrefix} cross-agent message requested ${toolUse.name}`,
          source: "builtin",
          createdAt: Date.now(),
          isReadOnly: false,
          mode: "ask_all",
          trustOrigin,
          // Use the active turn controller so user stop cancels this pending approval too.
          ...(self.currentAbortController === null
            ? {}
            : { abortSignal: self.currentAbortController.signal }),
        });
        allowed = isApprovalChoiceAllowed(decision.choice);
      } catch {
        self.auditLogger.log({
          timestamp: new Date().toISOString(),
          sessionId,
          type: "error",
          input: `cross-agent-meta-approval-failed:${toolUse.name}`,
        });
      }
    }

    if (allowed) {
      approved.push(toolUse);
    } else {
      denied.push({
        toolUseId: toolUse.id,
        toolName: toolUse.name,
        content: `cross-agent-approval-denied: ${toolUse.name}`,
      });
    }
  }

  return { approved, denied };
}
