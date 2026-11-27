import { maskSensitiveData } from "./dlp.js";
import { hasHiddenCharacters, hasInvisibleOrReorderingChars, hasNonWhitespaceControlChars } from "./display-safe-text.js";

export const MAX_REQUESTED_OUTPUT_ARGS_BYTES = 32 * 1024;

export function formatApprovalArgs(args: unknown): string {
  return JSON.stringify(args, null, 2) ?? "";
}

export function isExactApprovalText(text: string): boolean {
  return !hasHiddenCharacters(text) && new TextEncoder().encode(text).length <= MAX_REQUESTED_OUTPUT_ARGS_BYTES && maskSensitiveData(text).masked === text;
}

export function requestedOutputArgsError(args: unknown, serialized: string): "args-too-large" | "output-args-not-displayable" | undefined {
  if (new TextEncoder().encode(serialized).length > MAX_REQUESTED_OUTPUT_ARGS_BYTES || hasInvisibleOrReorderingChars(serialized)) return "args-too-large";
  let invisible = false;
  JSON.parse(serialized, (key, value: unknown) => {
    if (hasInvisibleOrReorderingChars(key) || hasNonWhitespaceControlChars(key)
      || typeof value === "string" && (hasInvisibleOrReorderingChars(value) || hasNonWhitespaceControlChars(value))) invisible = true;
    return value;
  });
  if (!approvalArgsAreDisplayable(args)) return "output-args-not-displayable";
  return invisible || maskSensitiveData(serialized).masked !== serialized ? "args-too-large" : undefined;
}

export function maskArgsForDisplay(value: unknown, detections: Set<string>): unknown {
  if (typeof value === "string") {
    const { masked, detections: hits } = maskSensitiveData(value);
    for (const h of hits) detections.add(h);
    return masked;
  }
  if (Array.isArray(value)) {
    return value.map((v) => maskArgsForDisplay(v, detections));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = maskArgsForDisplay(v, detections);
    }
    return out;
  }
  return value;
}

/** Whether the ordinary approval card preserves the JSON argument values and keys. */
export function approvalArgsAreDisplayable(args: unknown): boolean {
  return JSON.stringify(maskArgsForDisplay(args, new Set())) === JSON.stringify(args);
}
