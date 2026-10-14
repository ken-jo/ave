/**
 * Boot-time provider construction for `permissions.judge.provider`.
 *
 * Returns null for `off`. For a configured provider whose dependency is not
 * wired (no LLM reviewer for `builtin-llm`) it returns null as well and the
 * engine treats every call as `unavailable` — ask / deny, never allow — rather
 * than silently switching provider.
 */
import type { ReviewerInteractiveAutoApprove } from "../permission-settings-store.js";
import type { PermissionJudge } from "./judge-contract.js";
import { BuiltinLlmJudge, type TracingRiskClassifier } from "./builtin-llm-judge.js";
import { ExternalJudge, type JudgeFetch } from "./external-judge.js";
import type { JudgeSettings } from "./judge-settings.js";

export interface CreateJudgeDeps {
  /** The LLM reviewer, when the reviewer runs in `llm` mode. */
  llmClassifier: TracingRiskClassifier | null;
  autoApprove: () => ReviewerInteractiveAutoApprove;
  fetch: JudgeFetch;
}

export function createPermissionJudge(settings: JudgeSettings, deps: CreateJudgeDeps): PermissionJudge | null {
  switch (settings.provider) {
    case "off":
      return null;
    case "builtin-llm":
      return deps.llmClassifier ? new BuiltinLlmJudge(deps.llmClassifier, deps.autoApprove) : null;
    case "external":
      if (!settings.external) {
        throw new Error("permissions.judge provider 'external' reached construction without a validated endpoint");
      }
      return new ExternalJudge(settings.external, deps.fetch);
    default: {
      const unknown: never = settings.provider;
      throw new Error(`unknown judge provider: ${String(unknown)}`);
    }
  }
}
