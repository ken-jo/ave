import type { HookTrustRow } from "../hooks/hook-trust-commands.js";

export interface HookTrustReviewRequest {
  sourceId: string;
  fileName: string;
  expectedSha256: string;
  action: "accept" | "disable" | "trust-project";
}

export type HookTrustListResult =
  | { ok: true; active: HookTrustRow[]; disabled: HookTrustRow[]; totalDisabled: number }
  | { ok: false; error: string };

export type HookTrustReviewResult = { ok: true } | { ok: false; error: string };
