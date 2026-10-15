/**
 * Boot-time construction of the judge chain from `permissions.judge.chain`.
 *
 * A stage whose dependency is not available — no LLM reviewer for a default
 * builtin-llm stage, or a selected model whose provider is not configured —
 * is kept with `judge: null`. The engine treats it as `unavailable`: the stage
 * escalates, and if it is the last stage the call asks / denies, never allows.
 * A stage is never silently swapped for a different provider or model.
 */
import type { ReviewerInteractiveAutoApprove } from "../permission-settings-store.js";
import { BuiltinLlmJudge, type TracingRiskClassifier } from "./builtin-llm-judge.js";
import type { JudgeChainStage } from "./judge-engine.js";
import { ExternalJudge, type JudgeFetch } from "./external-judge.js";
import { formatJudgeModel, type JudgeModelRef, type JudgeSettings, type JudgeStageSettings } from "./judge-settings.js";

export interface CreateJudgeDeps {
  /** The reviewer's LLM classifier (current reviewer model), when the reviewer runs in `llm` mode. */
  reviewerClassifier: TracingRiskClassifier | null;
  /** The model the reviewer classifier resolved to (the active chat model); recorded in the audit. */
  reviewerModel: JudgeModelRef | null;
  /**
   * A classifier on a user-selected model, built through the same provider
   * wiring as the chat model picker. Null when that provider is not configured.
   */
  classifierForModel: (model: JudgeModelRef) => TracingRiskClassifier | null;
  autoApprove: () => ReviewerInteractiveAutoApprove;
  fetch: JudgeFetch;
}

function createStage(stage: JudgeStageSettings, deps: CreateJudgeDeps): JudgeChainStage {
  switch (stage.provider) {
    case "builtin-llm": {
      const classifier = stage.model ? deps.classifierForModel(stage.model) : deps.reviewerClassifier;
      const model = stage.model ?? deps.reviewerModel;
      return {
        settings: stage,
        judge: classifier ? new BuiltinLlmJudge(classifier, deps.autoApprove, model ? formatJudgeModel(model) : undefined) : null,
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
