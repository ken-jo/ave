/** Display data grants no permission; main binds this exact object to the one-shot approval request with an HMAC. */
import { isRecord, hasExactKeys } from "./is-record.js";
import type { RiskLevel } from "./permission-review-status.js";

export const RATIONALE_APPROVAL_DISPLAY_VERSION = 1 as const;
export const RATIONALE_APPROVAL_DISPLAY_KIND =
  "rationale-approval-display" as const;

type RationaleApprovalDisplayStatus = "ready" | "failed";
type RationaleApprovalDisplayScopeAlignment =
  | "aligned"
  | "unclear"
  | "outside"
  | "unknown";

export interface RationaleApprovalDisplay {
  readonly contractVersion: typeof RATIONALE_APPROVAL_DISPLAY_VERSION;
  readonly display: typeof RATIONALE_APPROVAL_DISPLAY_KIND;
  readonly toolName: string;
  readonly canonicalTargets: readonly string[];
  readonly requestedEffects: readonly string[];
  readonly affectedResources: readonly string[];
  readonly requiredAuthority: string;
  readonly effectiveVerdict: Readonly<{
    level: RiskLevel;
    reason: string;
  }>;
  readonly scopeAlignment: RationaleApprovalDisplayScopeAlignment;
  readonly scopeReasons: readonly string[];
  readonly rationaleStatus: RationaleApprovalDisplayStatus;
  readonly suggestion: string | null;
  readonly modalFallbackRequired: boolean;
}

export interface RationaleApprovalDisplayInput {
  readonly toolName: string;
  readonly canonicalTargets: readonly string[];
  readonly requestedEffects: readonly string[];
  readonly affectedResources: readonly string[];
  readonly requiredAuthority: string;
  readonly effectiveVerdict: Readonly<{
    level: RiskLevel;
    reason: string;
  }>;
  readonly scopeAlignment: RationaleApprovalDisplayScopeAlignment;
  readonly scopeReasons: readonly string[];
  readonly rationaleStatus: RationaleApprovalDisplayStatus;
  readonly suggestion: string | null;
  readonly modalFallbackRequired: boolean;
}

const RISK_LEVELS = new Set<RiskLevel>([
  "low",
  "medium",
  "high",
]);
const SCOPE_ALIGNMENTS = new Set<RationaleApprovalDisplayScopeAlignment>([
  "aligned",
  "unclear",
  "outside",
  "unknown",
]);

/** Reject controls, invisible formatting, and line separators that could hide or reorder consent context. */
const UNSAFE_RATIONALE_APPROVAL_DISPLAY_UNICODE =
  /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const HAS_UNSAFE_RATIONALE_APPROVAL_DISPLAY_UNICODE =
  /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/** Normalize host text before sealing; the parser rejects unnormalized renderer input instead of silently accepting it. */
export function normalizeRationaleApprovalDisplayText(value: string): string {
  return value
    .normalize("NFC")
    .replace(UNSAFE_RATIONALE_APPROVAL_DISPLAY_UNICODE, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function hasUnsafeRationaleApprovalDisplayUnicode(value: string): boolean {
  return HAS_UNSAFE_RATIONALE_APPROVAL_DISPLAY_UNICODE.test(value);
}

/** The sealer and parser must share field caps. */
export const RATIONALE_DISPLAY_CAPS = Object.freeze({
  toolName: 256,
  targetItems: 32,
  targetLength: 1_024,
  listItems: 8,
  listLength: 160,
  authorityLength: 160,
  reasonLength: 500,
  suggestionLength: 500,
});

function isDisplayText(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maxLength &&
    !/[<>]/u.test(value) &&
    !hasUnsafeRationaleApprovalDisplayUnicode(value)
  );
}

function isDisplayList(
  value: unknown,
  maxItems: number,
  maxLength: number,
): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= maxItems &&
    value.every((item) => isDisplayText(item, maxLength))
  );
}

/** Invalid display data must never become an approval-capable rationale card. */
export function parseRationaleApprovalDisplay(
  value: unknown,
): RationaleApprovalDisplay | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "contractVersion",
      "display",
      "toolName",
      "canonicalTargets",
      "requestedEffects",
      "affectedResources",
      "requiredAuthority",
      "effectiveVerdict",
      "scopeAlignment",
      "scopeReasons",
      "rationaleStatus",
      "suggestion",
      "modalFallbackRequired",
    ])
  ) {
    return null;
  }

  const verdict = value.effectiveVerdict;
  if (
    value.contractVersion !== RATIONALE_APPROVAL_DISPLAY_VERSION ||
    value.display !== RATIONALE_APPROVAL_DISPLAY_KIND ||
    !isDisplayText(value.toolName, RATIONALE_DISPLAY_CAPS.toolName) ||
    !isDisplayList(value.canonicalTargets, RATIONALE_DISPLAY_CAPS.targetItems, RATIONALE_DISPLAY_CAPS.targetLength) ||
    !isDisplayList(value.requestedEffects, RATIONALE_DISPLAY_CAPS.listItems, RATIONALE_DISPLAY_CAPS.listLength) ||
    !isDisplayList(value.affectedResources, RATIONALE_DISPLAY_CAPS.listItems, RATIONALE_DISPLAY_CAPS.listLength) ||
    !isDisplayText(value.requiredAuthority, RATIONALE_DISPLAY_CAPS.authorityLength) ||
    !isRecord(verdict) ||
    !hasExactKeys(verdict, ["level", "reason"]) ||
    !RISK_LEVELS.has(verdict.level as RiskLevel) ||
    !isDisplayText(verdict.reason, RATIONALE_DISPLAY_CAPS.reasonLength) ||
    !SCOPE_ALIGNMENTS.has(
      value.scopeAlignment as RationaleApprovalDisplayScopeAlignment,
    ) ||
    !isDisplayList(value.scopeReasons, RATIONALE_DISPLAY_CAPS.listItems, RATIONALE_DISPLAY_CAPS.listLength) ||
    (value.rationaleStatus !== "ready" && value.rationaleStatus !== "failed") ||
    typeof value.modalFallbackRequired !== "boolean"
  ) {
    return null;
  }

  if (value.rationaleStatus === "ready") {
    if (
      value.modalFallbackRequired !== false ||
      value.scopeAlignment === "unknown" ||
      !isDisplayText(value.suggestion, RATIONALE_DISPLAY_CAPS.suggestionLength)
    ) {
      return null;
    }
  } else if (
    value.modalFallbackRequired !== true ||
    value.scopeAlignment !== "unknown" ||
    value.suggestion !== null
  ) {
    return null;
  }

  return Object.freeze({
    contractVersion: RATIONALE_APPROVAL_DISPLAY_VERSION,
    display: RATIONALE_APPROVAL_DISPLAY_KIND,
    toolName: value.toolName,
    canonicalTargets: Object.freeze([...value.canonicalTargets]),
    requestedEffects: Object.freeze([...value.requestedEffects]),
    affectedResources: Object.freeze([...value.affectedResources]),
    requiredAuthority: value.requiredAuthority,
    effectiveVerdict: Object.freeze({
      level: verdict.level as RiskLevel,
      reason: verdict.reason as string,
    }),
    scopeAlignment:
      value.scopeAlignment as RationaleApprovalDisplayScopeAlignment,
    scopeReasons: Object.freeze([...value.scopeReasons]),
    rationaleStatus: value.rationaleStatus as RationaleApprovalDisplayStatus,
    suggestion: value.suggestion as string | null,
    modalFallbackRequired: value.modalFallbackRequired,
  });
}

/** Host-only construction helper. Throws rather than widening malformed data. */
export function createRationaleApprovalDisplay(
  input: Readonly<RationaleApprovalDisplayInput>,
): RationaleApprovalDisplay {
  const parsed = parseRationaleApprovalDisplay({
    contractVersion: RATIONALE_APPROVAL_DISPLAY_VERSION,
    display: RATIONALE_APPROVAL_DISPLAY_KIND,
    ...input,
  });
  if (parsed === null) {
    throw new TypeError("invalid rationale approval display");
  }
  return parsed;
}

/** Substitute for a field the DLP mask rendered invalid; always parses. */
const REDACTED_DISPLAY_TEXT = "[redacted]";

function sealText(
  value: string,
  maxLength: number,
  maskText: (value: string) => string,
): string {
  // Normalize before DLP masking and never afterward, so detectors see canonical text and approved mask tokens remain intact.
  const masked = maskText(normalizeRationaleApprovalDisplayText(value));
  // Use a plain boolean here; a type guard would narrow an already-string false branch to never.
  const fits = (candidate: string): boolean => isDisplayText(candidate, maxLength);
  if (fits(masked)) return masked;
  // Only length violations may show a surviving prefix; other invalidity must show total loss.
  if (masked.length > maxLength) {
    const truncated = truncateVisibly(masked, maxLength);
    if (fits(truncated)) return truncated;
  }
  return REDACTED_DISPLAY_TEXT;
}

/** Make every truncation visible and avoid splitting surrogate pairs; silently shortened paths or URLs could misrepresent what is approved. */
function truncateVisibly(value: string, maxLength: number): string {
  let head = value.slice(0, Math.max(0, maxLength - 1));
  const last = head.charCodeAt(head.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1);
  return head.trimEnd() + "…";
}

function sealList(
  values: readonly string[],
  maxItems: number,
  maxLength: number,
  maskText: (value: string) => string,
): readonly string[] {
  // Construction guarantees the list cap; if that weakens, dropped items need a visible marker.
  const sealed = values
    .slice(0, maxItems)
    .map((value) => sealText(value, maxLength, maskText));
  return sealed.length >= 1 ? sealed : [REDACTED_DISPLAY_TEXT];
}

/** Mask and revalidate each free-text field so expanded mask tokens cannot invalidate the card. Preserve host enums, booleans, and statuses verbatim; construction guarantees the result parses. */
export function sealMaskedRationaleApprovalDisplay(
  display: RationaleApprovalDisplay,
  maskText: (value: string) => string,
): RationaleApprovalDisplay {
  const caps = RATIONALE_DISPLAY_CAPS;
  return createRationaleApprovalDisplay({
    toolName: sealText(display.toolName, caps.toolName, maskText),
    canonicalTargets: sealList(display.canonicalTargets, caps.targetItems, caps.targetLength, maskText),
    requestedEffects: sealList(display.requestedEffects, caps.listItems, caps.listLength, maskText),
    affectedResources: sealList(display.affectedResources, caps.listItems, caps.listLength, maskText),
    requiredAuthority: sealText(display.requiredAuthority, caps.authorityLength, maskText),
    effectiveVerdict: {
      level: display.effectiveVerdict.level,
      reason: sealText(display.effectiveVerdict.reason, caps.reasonLength, maskText),
    },
    scopeAlignment: display.scopeAlignment,
    scopeReasons: sealList(display.scopeReasons, caps.listItems, caps.listLength, maskText),
    rationaleStatus: display.rationaleStatus,
    suggestion: display.rationaleStatus === "ready"
      ? sealText(display.suggestion ?? "", caps.suggestionLength, maskText)
      : null,
    modalFallbackRequired: display.modalFallbackRequired,
  });
}
