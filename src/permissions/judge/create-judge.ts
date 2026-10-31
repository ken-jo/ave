// Keep unavailable stages as null so the chain escalates and ultimately asks/denies; never silently substitute another model or provider.
import { BuiltinLlmJudge, type TracingRiskClassifier } from "./builtin-llm-judge.js";
import type { JudgeChainStage } from "./judge-engine.js";
import { ExternalJudge, type JudgeFetch } from "./external-judge.js";
import { formatJudgeModel, type JudgeModelRef, type JudgeSettings, type JudgeStageSettings } from "./judge-settings.js";

export interface CreateJudgeDeps {
  // The reviewer's LLM classifier (current reviewer model), when the reviewer runs in `llm` mode.
  reviewerClassifier: TracingRiskClassifier | null;
  // The model the reviewer classifier resolved to (the active chat model); recorded in the audit.
  reviewerModel: JudgeModelRef | string | null;
  // A classifier on a user-selected model, built through the same provider wiring as the chat model picker. Null when that provider is not configured.
  classifierForModel: (model: JudgeModelRef) => TracingRiskClassifier | null;
  // Non-secret transport identity for a selected model's verdict cache.
  cacheScopeForModel?: (model: JudgeModelRef) => Record<string, unknown>;
  fetch: JudgeFetch;
}

function createStage(stage: JudgeStageSettings, deps: CreateJudgeDeps): JudgeChainStage {
  switch (stage.provider) {
    case "builtin-llm": {
      const classifier = stage.model ? deps.classifierForModel(stage.model) : deps.reviewerClassifier;
      const model = stage.model ?? deps.reviewerModel;
      return {
        settings: stage,
        judge: classifier ? new BuiltinLlmJudge(
          classifier,
          typeof model === "string" ? model : model ? formatJudgeModel(model) : undefined,
          stage.model ? deps.cacheScopeForModel?.(stage.model) : undefined,
        ) : null,
      };
    }
    case "external":
      if (!stage.external) {
        throw new Error(`permissions.judge stage '${stage.id}' reached construction without a validated endpoint`);
      }
      return { settings: stage, judge: new ExternalJudge(stage.external, deps.fetch, stage.id) };
    default: {
      const unknown: never = stage.provider;
      throw new Error(`unknown judge provider: ${String(unknown)}`);
    }
  }
}

export function createJudgeChain(settings: JudgeSettings, deps: CreateJudgeDeps): JudgeChainStage[] {
  return settings.chain.map((stage) => createStage(stage, deps));
}
