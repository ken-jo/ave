import { maskSensitiveData } from "../../audit/dlp-filter.js";
import type { UserOwnedSurface } from "../../shared/permissions-events.js";
import { USER_OWNED_SURFACE_REVIEW_PROMPT } from "../../shared/permission-reviewer-framework.js";
import type { LlmReviewerProvider } from "./risk-classifier.js";

export interface UserOwnedSurfaceReviewInput {
  surface: UserOwnedSurface;
  toolName: string;
  userRequest: string;
  currentTaskStep?: string;
  target: Readonly<Record<string, unknown>>;
  action: Readonly<Record<string, unknown>>;
}

export interface UserOwnedSurfaceReviewResult { consistent: boolean; reason: string }

export class UserOwnedSurfaceReviewError extends Error {
  constructor() { super("Logical review returned invalid output"); this.name = "UserOwnedSurfaceReviewError"; }
}

/** Logical scope review has no general risk composition, heuristics or cache. */
export async function reviewUserOwnedSurface(provider: LlmReviewerProvider, model: string, input: UserOwnedSurfaceReviewInput, abortSignal?: AbortSignal): Promise<UserOwnedSurfaceReviewResult> {
  if (!input.userRequest.trim()) return { consistent: false, reason: "The user request is missing." };
  if (!input.currentTaskStep?.trim()) return { consistent: false, reason: "The current task step is missing." };
  const raw = JSON.stringify(input);
  if (raw.length > 8192) return { consistent: false, reason: "The action context is too large to establish consistency." };
  const redacted = maskSensitiveData(raw).masked.replaceAll("<", "\\u003c");
  const result = await provider.complete({ model, systemPrompt: USER_OWNED_SURFACE_REVIEW_PROMPT, userPrompt: `<UNTRUSTED_CONTEXT>\n${redacted}\n</UNTRUSTED_CONTEXT>`, abortSignal });
  let value: unknown;
  try { value = JSON.parse(result.text); } catch { throw new UserOwnedSurfaceReviewError(); }
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 2 ||
      typeof (value as UserOwnedSurfaceReviewResult).consistent !== "boolean" || typeof (value as UserOwnedSurfaceReviewResult).reason !== "string" ||
      !(value as UserOwnedSurfaceReviewResult).reason.trim() || (value as UserOwnedSurfaceReviewResult).reason.length > 200) throw new UserOwnedSurfaceReviewError();
  return { consistent: (value as UserOwnedSurfaceReviewResult).consistent, reason: maskSensitiveData((value as UserOwnedSurfaceReviewResult).reason).masked };
}
