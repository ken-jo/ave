/** Reviewer wiring follows the selected model or active chat identity; errors default to denial (docs/architecture/permission-policy-design.md).
 * Only missing provider configuration may degrade to rules; reconfiguration restores model review. */
import {
  createRiskClassifier,
  type LlmCompletionResult,
  type LlmReviewerProvider,
  type RiskClassifier,
  type ReviewerSettings,
} from "../../permissions/reviewer/risk-classifier.js";
import {
  LlmApprovalSentenceSelector,
  UnavailableApprovalSentenceSelector,
  type ApprovalSentenceSelector,
} from "../../permissions/reviewer/approval-sentence-selector.js";
import { VerdictCache } from "../../permissions/reviewer/verdict-cache.js";
import { RecentlyDeniedStore } from "../../permissions/reviewer/recently-denied.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import {
  readPermissionSettings,
  type ReviewerSettingsBlock,
} from "../../permissions/permission-settings-store.js";
import type { LLMProvider, LLMVendor } from "../../engine/llm/types.js";
import type { SubscriptionRuntimeId } from "../../shared/subscription-runtime.js";
import { createLogger } from "../../lib/logger.js";
import {
  LlmRationaleScopeReviewer,
  UnavailableRationaleScopeReviewer,
  type RationaleScopeReviewer,
} from "../../permissions/reviewer/rationale-scope-reviewer.js";
import {
  LlmParentAdjudicator,
  UnavailableParentAdjudicator,
  type ParentAdjudicationTargetResolver,
  type ParentAdjudicator,
} from "../../permissions/parent-adjudicator.js";

const log = createLogger("reviewer-wiring");

/** Collect text and final usage from the streaming provider into one buffered reviewer response. */
export class LlmReviewerProviderAdapter implements LlmReviewerProvider {
  constructor(private readonly provider: LLMProvider) {}

  async complete(params: {
    model: string;
    systemPrompt: string;
    userPrompt: string;
    abortSignal?: AbortSignal;
  }): Promise<LlmCompletionResult> {
    let text = "";
    let tokensIn = 0;
    let tokensOut = 0;
    const stream = this.provider.streamTurn({
      model: params.model,
      systemPrompt: params.systemPrompt,
      messages: [{ role: "user", content: params.userPrompt }],
      abortSignal: params.abortSignal,
    });
    for await (const event of stream) {
      if (params.abortSignal?.aborted) {
        throw new Error("reviewer LLM call aborted");
      }
      switch (event.type) {
        case "text_delta":
          text += event.text;
          break;
        case "message_complete":
          if (event.usage) {
            tokensIn = event.usage.inputTokens;
            tokensOut = event.usage.outputTokens;
          }
          break;
        case "error":
          throw new Error(`reviewer provider error: ${event.error}`);
        default:
          // reasoning_delta / tool_call ignored; reviewer prompt never asks for tools and reasoning text is not used.
          break;
      }
    }
    // Streaming events supply no cost; reviewer telemetry accepts zero for later pricing.
    return { text, tokensIn, tokensOut, costUsd: 0 };
  }
}

/** The reviewer shares the selected chat identity and credentials; provider resolution may fail closed. */
export interface WireReviewerDeps {
  permissionManager: PermissionManager;
  /** The host's outbound transport; both reviewer adapters run on it. */
  networkFetch: typeof fetch;
  /** Defaults to readPermissionSettings; tests may override the reader. */
  readSettings?: () => ReviewerSettingsBlock;
  /** Use the selected reviewer identity, or the active chat model. */
  readActiveLlm: () => ActiveReviewerLlmIdentity;
  /** An unset selection follows chat; an unavailable explicit selection must fail without substituting rules or another model. */
  selectedModel?: { label: string; available: boolean };
  /** A null provider means unconfigured; wiring must fail closed. */
  streamProviderFor?: (vendor: string) => LLMProvider | null;
  /** Test-only cache path override. */
  verdictCachePath?: string;
  /** Optional display-history store; retained across reviewer rewiring. */
  recentlyDenied?: RecentlyDeniedStore;
  onRecentlyDeniedChanged?: (summary: { total: number }) => void;
  /** Resolve the parent session target per ask so newly configured providers work; absent targets escalate to the user. */
  resolveParentSessionAdjudicationTarget?: ParentAdjudicationTargetResolver;
}

/** Runtime mode may degrade from model review to rules; diagnostics consume it, but settings never persist it. */
export type RuntimeReviewerMode =
  | "disabled"
  | "rule"
  | "llm"
  | "strict"
  | "llm-degraded-to-rule"
  | "llm-model-unavailable";

export interface WireReviewerResult {
  classifier: RiskClassifier;
  rationaleScopeReviewer: RationaleScopeReviewer;
  /** Resolve approval sentences only onto pending scopes, using the reviewer identity; modes without a provider propose nothing. */
  approvalSentenceSelector: ApprovalSentenceSelector;
  /** Provider-backed parent adjudication shares reviewer identity; without a provider it escalates to the user. */
  parentAdjudicator: ParentAdjudicator;
  /** Parent-session adjudication follows chat independently of reviewer mode; missing targets escalate per ask. */
  parentSessionAdjudicator: ParentAdjudicator;
  cache: VerdictCache;
  recentlyDenied: RecentlyDeniedStore;
  /** Settings after normalization. */
  appliedSettings: ReviewerSettingsBlock;
  /** Runtime provider and model after following the active identity. */
  effectiveSettings: EffectiveReviewerSettings;
  /** May differ from persisted mode when model review degrades to rules. */
  runtimeMode: RuntimeReviewerMode;
}

export interface ActiveReviewerLlmIdentity {
  /** Transport identity partitions the verdict cache. */
  provider: LLMVendor | `subscription:${SubscriptionRuntimeId}`;
  marketplaceProviderPresetId?: string;
  model: string;
  baseUrl?: string;
  vertexProject?: string;
  vertexLocation?: string;
}

type EffectiveReviewerSettings = ReviewerSettingsBlock & {
  provider: string;
  model: string;
  marketplaceProviderPresetId?: string;
  baseUrl?: string;
  vertexProject?: string;
  vertexLocation?: string;
};

/** Rewiring replaces the classifier while reusing lock-protected backing files and renderer notifications; live rerun closures remain attached to their history store. */
export function wireReviewerAgent(deps: WireReviewerDeps): WireReviewerResult {
  const settings = (deps.readSettings ?? defaultReadSettings)();
  const effectiveSettings = resolveEffectiveSettings(settings, deps);
  const cache = new VerdictCache(deps.verdictCachePath);
  const recentlyDenied = deps.recentlyDenied ?? deps.permissionManager.getRecentlyDenied()
    ?? new RecentlyDeniedStore(undefined, deps.onRecentlyDeniedChanged);

  let classifier: RiskClassifier;
  let rationaleScopeReviewer: RationaleScopeReviewer =
    new UnavailableRationaleScopeReviewer();
  let approvalSentenceSelector: ApprovalSentenceSelector =
    new UnavailableApprovalSentenceSelector();
  let parentAdjudicator: ParentAdjudicator = new UnavailableParentAdjudicator();
  // Disabled review supplies unassessed LOW verdicts, so it cannot authorize parent-session adjudication below a risk ceiling.
  const parentSessionAdjudicator: ParentAdjudicator =
    deps.resolveParentSessionAdjudicationTarget === undefined ||
    settings.mode === "disabled"
      ? new UnavailableParentAdjudicator()
      : new LlmParentAdjudicator(deps.resolveParentSessionAdjudicationTarget);
  // Only model-to-rule degradation differs from persisted mode.
  let runtimeMode: RuntimeReviewerMode = settings.mode;
  let degradedToRule = false;
  let unavailableReason: string | undefined;
  if (settings.mode === "disabled" || settings.mode === "strict" || settings.mode === "rule") {
    classifier = createRiskClassifier({ mode: settings.mode });
    log.info("boot: reviewer wired (mode=%s)", settings.mode);
  } else {
    // Catch only missing external provider configuration; rules remain stricter than disabled review and reconfiguration restores model review.
    // Keep classifier construction and telemetry outside the catch so internal contract violations abort boot.
    let adapter: LlmReviewerProvider | undefined;
    const selectedModelUnavailable = (): void => {
      runtimeMode = "llm-model-unavailable";
      unavailableReason = `Selected permission reviewer model ${deps.selectedModel?.label} is unavailable`;
      log.warn({ model: deps.selectedModel?.label }, "boot: selected permission reviewer model is unavailable");
    };
    if (deps.selectedModel?.available === false) {
      selectedModelUnavailable();
    } else try {
      if (!effectiveSettings.model.trim()) {
        throw new ReviewerProviderUnconfiguredError("Permission reviewer model not configured.");
      }
      adapter = resolveReviewerAdapter(effectiveSettings.provider, deps);
    } catch (err) {
      // Only ReviewerProviderUnconfiguredError may degrade; missing wiring dependencies must abort boot.
      if (!(err instanceof ReviewerProviderUnconfiguredError)) throw err;
      if (deps.selectedModel) {
        // An explicit model choice must work or fail clearly; never substitute another classifier.
        selectedModelUnavailable();
      } else {
        degradedToRule = true;
        runtimeMode = "llm-degraded-to-rule";
        log.warn(
          { provider: effectiveSettings.provider, error: (err as Error).message },
          "boot: reviewer mode=llm requested but provider could not be wired — " +
            "degrading to rule classifier. Reviewer auto-heals to llm once an LLM " +
            "provider/API key is configured (login or Intelligence settings re-fires wiring).",
        );
      }
    }
    if (adapter) {
      const reviewerSettings: ReviewerSettings = {
        mode: "llm",
        provider: adapter,
        model: effectiveSettings.model,
        fallbackOnError: settings.fallbackOnError,
      };
      classifier = createRiskClassifier(reviewerSettings);
      rationaleScopeReviewer = new LlmRationaleScopeReviewer(
        adapter,
        effectiveSettings.model,
      );
      approvalSentenceSelector = new LlmApprovalSentenceSelector(
        adapter,
        effectiveSettings.model,
      );
      parentAdjudicator = new LlmParentAdjudicator(
        adapter,
        effectiveSettings.model,
      );
      log.info(
        "boot: reviewer wired (mode=llm provider=%s model=%s fallback=%s)",
        effectiveSettings.provider,
        effectiveSettings.model,
        settings.fallbackOnError,
      );
    } else {
      classifier = createRiskClassifier({ mode: "rule" });
    }
  }

  deps.permissionManager.setReviewer({
    classifier,
    cache,
    recentlyDenied,
    degradedToRule,
    ...(runtimeMode === "llm" ? { model: `${effectiveSettings.provider}/${effectiveSettings.model}` } : {}),
    ...(unavailableReason !== undefined ? { unavailableReason } : {}),
    cacheScope: {
      // Partition by runtime mode so healed model review cannot reuse verdicts produced by degraded rules.
      mode: runtimeMode,
      provider: effectiveSettings.provider,
      model: effectiveSettings.model,
      fallbackOnError: settings.fallbackOnError,
      // Auto-approval changes must invalidate verdicts produced under different policy.
      interactiveAutoApprove: settings.interactive.autoApprove,
      // Endpoint or project changes must invalidate verdicts from another upstream deployment.
      providerBaseUrl: effectiveSettings.baseUrl ?? null,
      marketplaceProviderPresetId: effectiveSettings.marketplaceProviderPresetId ?? null,
      vertexProject: effectiveSettings.vertexProject ?? null,
      vertexLocation: effectiveSettings.vertexLocation ?? null,
    },
  });
  // Apply foreground auto-approval policy to the manager during rewiring.
  deps.permissionManager.setInteractiveAutoApprove(settings.interactive.autoApprove);

  // Strict mode returns before reviewer routing; allow mode bypasses review and makes interactive.autoApprove ineffective.
  // Warn when allow mode makes the configured threshold misleading.
  if (deps.permissionManager.getMode() === "allow") {
    log.warn(
      "exec mode=allow — reviewer (and reviewer.interactive.autoApprove) is " +
      "bypassed for all non-hard-blocked tools. `interactive.autoApprove` " +
      "setting has no effect under allow mode.",
    );
  }
  return {
    classifier,
    rationaleScopeReviewer,
    approvalSentenceSelector,
    parentAdjudicator,
    parentSessionAdjudicator,
    cache,
    recentlyDenied,
    appliedSettings: settings,
    effectiveSettings,
    runtimeMode,
  };
}

function defaultReadSettings(): ReviewerSettingsBlock {
  return readPermissionSettings().permissions.reviewer;
}

/** Resolve identity in every mode because judge wiring and cache scopes also consume it. */
function resolveEffectiveSettings(
  settings: ReviewerSettingsBlock,
  deps: WireReviewerDeps,
): EffectiveReviewerSettings {
  const active = deps.readActiveLlm();
  return {
    ...settings,
    provider: active.provider,
    ...(active.marketplaceProviderPresetId !== undefined
      ? { marketplaceProviderPresetId: active.marketplaceProviderPresetId }
      : {}),
    model: active.model,
    ...(active.baseUrl !== undefined ? { baseUrl: active.baseUrl } : {}),
    ...(active.vertexProject !== undefined ? { vertexProject: active.vertexProject } : {}),
    ...(active.vertexLocation !== undefined ? { vertexLocation: active.vertexLocation } : {}),
  };
}

/** Only missing external provider configuration permits degradation; internal wiring errors must propagate. */
export class ReviewerProviderUnconfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewerProviderUnconfiguredError";
  }
}

/** Missing provider configuration may degrade; missing streamProviderFor violates the wiring contract and must abort boot. */
function resolveReviewerAdapter(
  provider: string,
  deps: WireReviewerDeps,
): LlmReviewerProvider {
  if (!deps.streamProviderFor) {
    throw new Error(
      `Permission reviewer wiring: settings.reviewer.mode='llm' but no streamProviderFor supplied. ` +
      `Boot caller must provide a provider factory (atomic cutover — no silent fallback).`,
    );
  }
  const upstream = deps.streamProviderFor(provider);
  if (!upstream) {
    throw new ReviewerProviderUnconfiguredError(
      `Permission reviewer wiring: reviewer provider '${provider}' is not configured. ` +
      `Add an API key for ${provider} or change reviewer mode.`,
    );
  }
  return new LlmReviewerProviderAdapter(upstream);
}
