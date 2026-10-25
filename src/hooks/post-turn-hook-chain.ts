

import type { RunModelSettings } from "../shared/run-model-settings.js";
import { detectFromStream, type DetectorResult } from "../engine/checkpoint-detector.js";
import { isLLMVendor, type GenericMessage, type TokenUsage, type TokenUsageByModel } from "../engine/llm/types.js";
import { normalizeAiSdkUsageForCost } from "../engine/llm/pricing.js";
import type { MemoryManager } from "../memory/memory-manager.js";
import type { AuditLogger } from "../audit/audit-logger.js";
import type { IdleSchedulerService } from "../main/idle-scheduler.js";
import type { SettingsService } from "../data/settings-store.js";
import { createLogger } from "../lib/logger.js";
import { EMPTY_ASSISTANT_RESPONSE_TEXT } from "../lib/chat-stream-state.js";
import { activeLlmRouteModel } from "../shared/llm-vendor-defaults.js";
import type { SubscriptionUsageTelemetry } from "../shared/subscription-runtime.js";
import type { ChatInputOrigin } from "../shared/chat-origin.js";
import type {
  AutomaticMemoryCaptureSubmitter,
  MemoryCaptureTaintReason,
} from "../memory/memory-capture-service.js";
const log = createLogger("post-turn");

export interface PostTurnHookContext {
  sessionId: string;
  projectRoot?: string;
  projectName?: string;

  messages: GenericMessage[];
  input: string;
  // Provenance is supplied by runTurn; absence fails closed for capture.
  inputOrigin?: ChatInputOrigin;
  memoryCaptureTaint?: readonly MemoryCaptureTaintReason[];
  output: string;
  toolCalls: Array<{ name: string; isError: boolean }>;
  // Provider input tokens include cache; audit normalizes them to the cost contract before persisting.
  tokenUsage?: TokenUsage;
  usageByModel?: TokenUsageByModel[];
  // Separate non-billable subscription telemetry; never enters price normalization.
  subscriptionUsage?: SubscriptionUsageTelemetry[];
  toolExposure?: {
    loadedToolCount: number;
    loadedToolSourceCounts: { builtin: number; plugin: number; mcp: number };
    deferredCatalogCount: number;
    deferredCatalogSourceCounts: { plugin: number; mcp: number };
    promotedToolNames: string[];
    loadedPluginIds: string[];
    loadedMcpServerIds: string[];
    deferredPluginIds: string[];
    deferredMcpServerIds: string[];
    toolSchemaTokens: number;
    projectedRequestInputTokens: number | null;
    deferralEligibleLoadedCount: number;
    deferredLoadedRatio: number | null;
  };
  route: string;
  // Snapshot the serving model at runTurn entry so live setting changes cannot alter audit attribution; token-bearing skill routes also use provider/model.
  vendorProvider?: string;
  vendorModel?: string;
  modelSettings?: RunModelSettings;
  // A natural completion is required before automatic capture is eligible.
  stopReason?: string;
}

export interface PostTurnHookChainDeps {
  memoryManager?: MemoryManager;
  auditLogger?: AuditLogger;
  idleScheduler?: IdleSchedulerService;
  settingsService?: SettingsService;
  memoryCaptureService?: AutomaticMemoryCaptureSubmitter;
  // Checkpoint callbacks let the caller trigger summary handling.
  onCheckpointSuggested?: (sessionId: string, cleanedOutput: string) => void;
}

export interface PostTurnHookResult {
  detector: DetectorResult;
  // Canonical message array that this hook persisted for transcript replay. It carries the marker-stripped assistant output.
  messagesForPersistence: GenericMessage[];
}

export class PostTurnHookChain {
  constructor(private readonly deps: PostTurnHookChainDeps) {}

  async run(ctx: PostTurnHookContext): Promise<PostTurnHookResult> {
    let messagesForPersistence = ctx.messages;

    // Stub old results only during compaction; post-turn rewriting changes the next request's prefix and defeats cache reuse.

    // Strip markers before persistence so replay, callers and renderers receive the same output.
    let detector: DetectorResult = { cleanedText: ctx.output, newTitle: null, checkpointSuggested: false };
    try {
      detector = detectFromStream(ctx.output);
      if (detector.checkpointSuggested) {
        log.info(`detect-checkpoint: [checkpoint] marker stripped for session ${ctx.sessionId}`);
        try {
          this.deps.onCheckpointSuggested?.(ctx.sessionId, detector.cleanedText);
        } catch (cbErr) {
          log.warn("onCheckpointSuggested callback failed: %s", cbErr);
        }
      }
    } catch (err) {
      log.warn("detect-checkpoint failed: %s", err);
    }
    const outputForHooks = detector.cleanedText;
    const outputForPersistence =
      outputForHooks.trim().length > 0
        ? outputForHooks
        : ctx.output.trim().length > 0
          ? EMPTY_ASSISTANT_RESPONSE_TEXT
          : outputForHooks;

    try {
      const baseMessages = ctx.messages;
      messagesForPersistence =
        outputForPersistence !== ctx.output
          ? replaceLastAssistantOutput(baseMessages, ctx.output, outputForPersistence)
          : baseMessages;
      // saveSession owns JSONL stubbing and file-backed tool results; preserve the engine's in-memory verbatim messages.
      await this.deps.memoryManager?.saveSession(ctx.sessionId, messagesForPersistence);
    } catch (err) {
      log.warn("saveSession failed: %s", err);
    }

    // Automatic capture is queued only after the durable session projection. It never consumes the assistant response: a separate model reviews the bounded user-authored input later, and the host remains the writer.
    try {
      if (ctx.inputOrigin) {
        this.deps.memoryCaptureService?.enqueueAutomatic({
          sessionId: ctx.sessionId,
          input: ctx.input,
          inputOrigin: ctx.inputOrigin,
          ...(ctx.projectRoot ? { projectRoot: ctx.projectRoot } : {}),
          ...(ctx.projectName ? { projectName: ctx.projectName } : {}),
          ...(ctx.stopReason ? { stopReason: ctx.stopReason } : {}),
          ...(ctx.memoryCaptureTaint ? { taintReasons: ctx.memoryCaptureTaint } : {}),
        });
        if (!this.deps.idleScheduler) this.deps.memoryCaptureService?.scheduleFallbackDrain();
      }
    } catch (err) {
      log.warn("automatic memory capture enqueue failed: %s", err);
    }

    try {
      if (this.deps.memoryManager && detector.newTitle) {
        const sessionMeta = this.deps.memoryManager.loadSessionMetadata(ctx.sessionId) ?? {};
        await this.deps.memoryManager.saveSessionMetadata(ctx.sessionId, {
          ...sessionMeta,
          title: detector.newTitle,
        });
        log.info(`update-title: session ${ctx.sessionId} title set to "${detector.newTitle}"`);
      }
    } catch (err) {
      log.warn("update-title failed: %s", err);
    }

    // Audit token-bearing routes as provider/model; use the captured model rather than live settings.
    try {
      const llmSettings = this.deps.settingsService?.get("llm");
      const provider = ctx.vendorProvider ?? llmSettings?.provider;
      const model =
        ctx.vendorModel ??
        (llmSettings ? activeLlmRouteModel(llmSettings) : undefined);
      const auditTokenUsage = provider && isLLMVendor(provider)
        ? normalizeAiSdkUsageForCost(ctx.tokenUsage, provider)
        : ctx.tokenUsage;
      const auditUsageByModel = ctx.usageByModel?.map((segment) => ({
        ...segment,
        tokenUsage: normalizeAiSdkUsageForCost(segment.tokenUsage, segment.vendorProvider),
      }));
      const auditRoute =
        ctx.tokenUsage && provider && model
          ? `${provider}/${model}`
          : ctx.route;
      this.deps.auditLogger?.logTurn({
        sessionId: ctx.sessionId,
        input: ctx.input,
        output: outputForHooks,
        toolCalls: ctx.toolCalls,
        tokenUsage: auditTokenUsage,
        usageByModel: auditUsageByModel,
        subscriptionUsage: ctx.subscriptionUsage,
        toolExposure: ctx.toolExposure,
        route: auditRoute,
        ...(ctx.modelSettings ? { modelSettings: ctx.modelSettings } : {}),
      });
    } catch (err) {
      log.warn("audit failed: %s", err);
    }

    try {
      this.deps.idleScheduler?.signalConversation();
    } catch (err) {
      log.warn("idle poke failed: %s", err);
    }

    return { detector, messagesForPersistence };
  }
}

function replaceLastAssistantOutput(
  messages: GenericMessage[],
  rawOutput: string,
  cleanedOutput: string,
): GenericMessage[] {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== "assistant") continue;
    const next = [...messages];
    next[i] = {
      ...message,
      content: message.content === rawOutput ? cleanedOutput : message.content.replace(rawOutput, cleanedOutput),
    };
    return next;
  }
  return messages;
}
