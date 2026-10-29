import type { AuditLogger } from "../../audit/audit-logger.js";
import type { LLMProvider } from "../../engine/llm/types.js";
import { createJudgeChain } from "../../permissions/judge/create-judge.js";
import type { JudgeFetch } from "../../permissions/judge/external-judge.js";
import type { JudgeEngineDeps } from "../../permissions/judge/judge-engine.js";
import type { JudgeModelRef, JudgeSettings } from "../../permissions/judge/judge-settings.js";
import type { PermissionManager } from "../../permissions/permission-manager.js";
import { LlmRiskClassifier } from "../../permissions/reviewer/risk-classifier.js";
import { traceRiskClassifier } from "../../permissions/judge/builtin-llm-judge.js";
import { isLLMVendor } from "../../shared/llm-vendor-defaults.js";
import { LlmReviewerProviderAdapter, type WireReviewerResult } from "./reviewer-wiring.js";

interface WireJudgeDeps {
  permissionManager: PermissionManager;
  settings: JudgeSettings;
  chainRejected?: boolean;
  settingsUnreadable?: boolean;
  reviewer: WireReviewerResult;
  providerForModel: (model: JudgeModelRef) => LLMProvider | null;
  selectedModelCacheScope?: (model: JudgeModelRef) => Record<string, unknown>;
  networkFetch: JudgeFetch;
  audit: Pick<AuditLogger, "logShadow" | "appendPermissionAuditEntry">;
  resolveRootSessionId: (sessionId: string) => string;
}

/** Attach the configured chain after the existing reviewer and its stores are ready. */
export function wireJudgeAgent(deps: WireJudgeDeps): JudgeEngineDeps {
  const { reviewer } = deps;
  const identity = reviewer.effectiveSettings;
  const settings = deps.settings;
  const chain = createJudgeChain(settings, {
    reviewerClassifier: reviewer.runtimeMode !== "llm-model-unavailable"
      ? traceRiskClassifier(reviewer.classifier)
      : null,
    reviewerModel: identity && isLLMVendor(identity.provider)
      ? { vendor: identity.provider, model: identity.model }
      : identity ? `${identity.provider}/${identity.model}` : null,
    classifierForModel: (model) => {
      const provider = deps.providerForModel(model);
      return provider
        ? new LlmRiskClassifier(
          new LlmReviewerProviderAdapter(provider),
          model.model,
          reviewer.appliedSettings.fallbackOnError,
        )
        : null;
    },
    cacheScopeForModel: deps.selectedModelCacheScope,
    fetch: deps.networkFetch,
  });
  const engine: JudgeEngineDeps = {
    settings,
    chain,
    ...(deps.chainRejected === true ? { chainRejected: true } : {}),
    ...(deps.settingsUnreadable === true ? { settingsUnreadable: true } : {}),
    breaker: deps.permissionManager.getJudgeBreaker(settings.breaker),
    audit: deps.audit,
  };
  deps.permissionManager.setJudge(engine, deps.resolveRootSessionId);
  return engine;
}
