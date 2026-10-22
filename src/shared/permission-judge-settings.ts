import type { JudgeSettings } from "../permissions/judge/judge-settings.js";
import type { LLMVendor } from "./llm-vendor-defaults.js";

export const MAX_PERMISSION_JUDGE_STAGES = 4;

export type PermissionJudgeSettings = JudgeSettings;

export interface PermissionJudgeSnapshot {
  settings: PermissionJudgeSettings;
  issues: string[];
  modelOptions: Array<{ vendor: LLMVendor; model: string }>;
  /** What an unset reviewer model resolves to right now: the active chat route. */
  chatModel: string | null;
  /** The stored reviewer model is not offered by any connected provider. */
  reviewerModelUnavailable: boolean;
}

type PermissionJudgeErrorCode =
  | "unauthorized-frame"
  | "user-keyboard-required"
  | "invalid-judge-settings"
  | "judge-save-failed"
  | "judge-rewire-failed"
  | "judge-rollback-failed";

export type PermissionJudgeReadResult =
  | ({ ok: true } & PermissionJudgeSnapshot)
  | { ok: false; error: PermissionJudgeErrorCode };
export type PermissionJudgeWriteResult = PermissionJudgeReadResult;

/** Persisted judge wire shape, shared by the host store and settings renderer. */
export function serializePermissionJudgeSettings(settings: PermissionJudgeSettings): Record<string, unknown> {
  return {
    // Explicit null: "unset" is a stored choice (follow the chat model), not an absent field.
    model: settings.model ? `${settings.model.vendor}/${settings.model.model}` : null,
    chain: settings.chain.map((stage) => ({
      provider: stage.provider,
      id: stage.id,
      ...(stage.escalateBelow !== undefined ? { escalateBelow: stage.escalateBelow } : {}),
      ...(stage.model ? { model: `${stage.model.vendor}/${stage.model.model}` } : {}),
      ...(stage.external ? { external: { ...stage.external } } : {}),
    })),
    mode: settings.mode,
    categories: { ...settings.categories },
    timeoutMs: settings.timeoutMs,
    chainDeadlineMs: settings.chainDeadlineMs,
    breaker: { ...settings.breaker },
  };
}
