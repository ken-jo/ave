import { canonicalJsonEqual } from "../../shared/canonical-json.js";
import type { RiskVerdict } from "../../permissions/reviewer/risk-classifier.js";
import { maxVerdict } from "../../permissions/reviewer/risk-classifier.js";
import { redactHomePathsInText } from "../../audit/dlp-filter.js";
import {
  createRationaleApprovalDisplay,
  normalizeRationaleApprovalDisplayText,
  type RationaleApprovalDisplay,
  RATIONALE_DISPLAY_CAPS,
} from "../../shared/rationale-approval-display.js";
import {
  RATIONALE_CONTROL_CONTRACT_VERSION,
  assertRationaleCanonicalJson,
  normalizeRationaleRiskVerdict,
  parseRationaleResponse,
  sanitizeDisplayText,
  verifyActionIdentity,
  verifyRationaleRequiredControl,
  type ActionIdentity,
  type HostRationaleEligibilityContext,
  type RationaleRequiredControl,
  type RationaleResponse,
  sealRationaleCanonicalJson,
  assertExactOwnKeys,
} from "./rationale-control.js";
import {
  REVIEWER_REEVALUATION_FAILURE_OUTCOMES,
  validateReviewerScopeReevaluation,
  type RationaleGenerationOutcome,
  type ReviewerScopeAlignment,
  type ReviewerReevaluationOutcome,
  type ReviewerScopeReevaluation,
} from "./rationale-pr1-contract.js";
import {
  createInvocationStartedAudit,
  isRationaleOutcomeBinding,
  validateHostInvocationStartLease,
  validateInvocationAuditRecord,
  validateHostConsumedAllowOnceReceipt,
  validateRationaleTicketRecord,
  type HostConsumedAllowOnceReceipt,
  type HostInvocationStartLease,
  type InvocationAuditRecord,
  type RationaleStatus,
  type RationaleTerminalReason,
  type RationaleTicketStateRecord,
} from "./rationale-ticket-lifecycle.js";
import { isRecord } from "../../shared/is-record.js";
import { UUID_PATTERN } from "../../shared/uuid.js";

export interface RationaleUiAuditProjection {
  contractVersion: typeof RATIONALE_CONTROL_CONTRACT_VERSION;
  projection: "rationale-ui-audit";
  ticketId: string; anchorId: string; actionDigest: string; round: 1;
  reasonCode: "foreground-reviewer-threshold";
  toolName: string;
  canonicalTargets: readonly string[];
  requestedEffects: readonly string[];
  affectedResources: readonly string[];
  requiredAuthority: string;
  reviewerOutcome: "fresh" | "cache";
  generationOutcome: RationaleGenerationOutcome;
  reevaluationOutcome: ReviewerReevaluationOutcome | null;
  initialVerdict: RiskVerdict;
  reevaluatedVerdict: RiskVerdict;
  effectiveVerdict: RiskVerdict;
  scopeAlignment: ReviewerScopeAlignment;
  scopeReasons: readonly string[];
  rationaleStatus: RationaleStatus;
  terminalReason: RationaleTerminalReason | null;
  suggestion: string | null;
  modalFallbackRequired: boolean;
  // Mark only fresh, aligned, non-high reviewer terminals as auto-approved; user/modal decisions retain false provenance.
  autoApproved: boolean;
}

const PROJECTION_GENERATION_OUTCOMES: readonly RationaleGenerationOutcome[] = [
  "accepted-rationale",
  "generation-unavailable",
  "generation-error",
  "generation-timeout",
  "missing-rationale-call",
  "ordinary-tool-call-rejected",
  "multiple-calls-rejected",
  "malformed-rationale",
];
const PROJECTION_REEVALUATION_OUTCOMES: readonly ReviewerReevaluationOutcome[] = [
  "fresh",
  ...REVIEWER_REEVALUATION_FAILURE_OUTCOMES,
];
const PROJECTION_SCOPE_ALIGNMENTS: readonly ReviewerScopeAlignment[] = [
  "aligned",
  "unclear",
  "outside",
  "unknown",
];
const PROJECTION_TERMINAL_REASONS: readonly RationaleTerminalReason[] = [
  "allowed-once",
  "user-deny",
  "user-cancel",
  "modal-timeout",
  "caller-abort",
  "session-close",
  "identity-mismatch",
  "stale-replay",
  "expired",
];

function sanitizeProjectionDisplayText(value: string, maxLength: number): string {
  // Reject angle brackets and normalize controls before and after redaction so valid projections always convert to display.
  // Forged projections must fail closed before a stranded user_pending ticket can remain.
  const sanitized = sanitizeDisplayText(value, 4_096)
    .replace(/[<>]/gu, " ");
  return normalizeRationaleApprovalDisplayText(
    redactHomePathsInText(sanitized),
  ).slice(0, maxLength);
}

function isBoundedProjectionText(
  value: unknown,
  maxLength: number,
): value is string {
  return typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maxLength;
}

function isSanitizedProjectionText(
  value: unknown,
  maxLength: number,
): value is string {
  return isBoundedProjectionText(value, maxLength) &&
    sanitizeProjectionDisplayText(value, maxLength) === value;
}

function isBoundedProjectionList(
  value: unknown,
  maxItems: number,
  maxLength: number,
): value is readonly string[] {
  return Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= maxItems &&
    value.every((item) => isSanitizedProjectionText(item, maxLength));
}

function normalizedProjectionVerdict(value: unknown, label: string): RiskVerdict {
  const normalized = normalizeRationaleRiskVerdict(value as RiskVerdict, label);
  if (!canonicalJsonEqual(normalized, value)) {
    throw new TypeError(label + " is not canonical");
  }
  return normalized;
}

export function validateRationaleUiAuditProjection(
  value: unknown,
): value is RationaleUiAuditProjection {
  try {
    assertRationaleCanonicalJson(value, "RationaleUiAuditProjection");
    if (!isRecord(value)) return false;
    assertExactOwnKeys(value, [
      "contractVersion", "projection", "ticketId", "anchorId", "actionDigest",
      "round", "reasonCode", "toolName", "canonicalTargets", "requestedEffects",
      "affectedResources", "requiredAuthority", "reviewerOutcome",
      "generationOutcome", "reevaluationOutcome", "initialVerdict",
      "reevaluatedVerdict", "effectiveVerdict", "scopeAlignment", "scopeReasons",
      "rationaleStatus", "terminalReason", "suggestion", "modalFallbackRequired",
      "autoApproved",
    ], "RationaleUiAuditProjection");
    if (
      value.contractVersion !== RATIONALE_CONTROL_CONTRACT_VERSION ||
      value.projection !== "rationale-ui-audit" ||
      typeof value.ticketId !== "string" ||
      !UUID_PATTERN.test(value.ticketId) ||
      typeof value.anchorId !== "string" ||
      !UUID_PATTERN.test(value.anchorId) ||
      typeof value.actionDigest !== "string" ||
      !/^[0-9a-f]{64}$/u.test(value.actionDigest) ||
      value.round !== 1 ||
      value.reasonCode !== "foreground-reviewer-threshold" ||
      !isSanitizedProjectionText(value.toolName, RATIONALE_DISPLAY_CAPS.toolName) ||
      !isBoundedProjectionList(value.canonicalTargets, RATIONALE_DISPLAY_CAPS.targetItems, RATIONALE_DISPLAY_CAPS.targetLength) ||
      !isBoundedProjectionList(value.requestedEffects, RATIONALE_DISPLAY_CAPS.listItems, RATIONALE_DISPLAY_CAPS.listLength) ||
      !isBoundedProjectionList(value.affectedResources, RATIONALE_DISPLAY_CAPS.listItems, RATIONALE_DISPLAY_CAPS.listLength) ||
      !isSanitizedProjectionText(value.requiredAuthority, RATIONALE_DISPLAY_CAPS.authorityLength) ||
      (value.reviewerOutcome !== "fresh" && value.reviewerOutcome !== "cache") ||
      !PROJECTION_GENERATION_OUTCOMES.includes(
        value.generationOutcome as RationaleGenerationOutcome,
      ) ||
      (value.reevaluationOutcome !== null &&
        !PROJECTION_REEVALUATION_OUTCOMES.includes(
          value.reevaluationOutcome as ReviewerReevaluationOutcome,
        )) ||
      !PROJECTION_SCOPE_ALIGNMENTS.includes(
        value.scopeAlignment as ReviewerScopeAlignment,
      ) ||
      !isBoundedProjectionList(value.scopeReasons, RATIONALE_DISPLAY_CAPS.listItems, RATIONALE_DISPLAY_CAPS.listLength) ||
      (value.rationaleStatus !== "ready" && value.rationaleStatus !== "failed") ||
      (value.terminalReason !== null &&
        !PROJECTION_TERMINAL_REASONS.includes(
          value.terminalReason as RationaleTerminalReason,
        )) ||
      typeof value.modalFallbackRequired !== "boolean" ||
      typeof value.autoApproved !== "boolean"
    ) {
      return false;
    }

    const initial = normalizedProjectionVerdict(value.initialVerdict, "initialVerdict");
    const reevaluated = normalizedProjectionVerdict(
      value.reevaluatedVerdict,
      "reevaluatedVerdict",
    );
    const effective = normalizedProjectionVerdict(
      value.effectiveVerdict,
      "effectiveVerdict",
    );
    if (
      !isSanitizedProjectionText(initial.reason, RATIONALE_DISPLAY_CAPS.reasonLength) ||
      !isSanitizedProjectionText(reevaluated.reason, RATIONALE_DISPLAY_CAPS.reasonLength) ||
      !isSanitizedProjectionText(effective.reason, RATIONALE_DISPLAY_CAPS.reasonLength)
    ) {
      return false;
    }
    if (!canonicalJsonEqual(effective, maxVerdict(initial, reevaluated))) return false;

    if (value.rationaleStatus === "ready") {
      const readyOk = value.generationOutcome === "accepted-rationale" &&
        value.reevaluationOutcome === "fresh" &&
        value.scopeAlignment !== "unknown" &&
        value.modalFallbackRequired === false &&
        isSanitizedProjectionText(value.suggestion, RATIONALE_DISPLAY_CAPS.suggestionLength);
      if (!readyOk) return false;
      // autoApproved requires aligned, non-high review and the one-shot allowed_once terminal; otherwise it must be false.
      if (value.autoApproved) {
        return value.scopeAlignment === "aligned" &&
          value.terminalReason === "allowed-once" &&
          reevaluated.level !== "high";
      }
      return true;
    }

    const acceptedThenReviewerFailed =
      value.generationOutcome === "accepted-rationale" &&
      value.reevaluationOutcome !== null &&
      value.reevaluationOutcome !== "fresh";
    const generationFailed =
      value.generationOutcome !== "accepted-rationale" &&
      value.reevaluationOutcome === null;
    return (acceptedThenReviewerFailed || generationFailed) &&
      value.scopeAlignment === "unknown" &&
      value.modalFallbackRequired === true &&
      value.suggestion === null &&
      value.autoApproved === false &&
      canonicalJsonEqual(reevaluated, initial) &&
      canonicalJsonEqual(effective, initial);
  } catch {
    return false;
  }
}

function projectUiText(value: string, maxLength: number, label: string): string {
  const projected = sanitizeProjectionDisplayText(value, maxLength);
  if (!projected) throw new TypeError(label + " has no safe display text");
  return projected;
}

function projectUiList(
  values: readonly string[],
  maxLength: number,
  label: string,
): readonly string[] {
  const projected = values.map((value, index) =>
    projectUiText(value, maxLength, label + "[" + index + "]"));
  return sealRationaleCanonicalJson(projected, label);
}

function projectUiVerdict(value: RiskVerdict, label: string): RiskVerdict {
  const normalized = normalizeRationaleRiskVerdict(value, label);
  return sealRationaleCanonicalJson({
    level: normalized.level,
    reason: projectUiText(normalized.reason, 500, label + ".reason"),
  }, label);
}

export function createRationaleUiAuditProjection(input: {
  control: RationaleRequiredControl;
  response: RationaleResponse | null;
  reevaluation: ReviewerScopeReevaluation | null;
  ticket: RationaleTicketStateRecord;
  now?: number;
  /** Reviewer auto-approve provenance; defaults to false (user/modal path). */
  autoApproved?: boolean;
}): RationaleUiAuditProjection {
  const now = input.now ?? Date.now();
  if (!verifyRationaleRequiredControl(input.control, { now }) ||
      (input.reevaluation !== null &&
        !validateReviewerScopeReevaluation(input.reevaluation, input.control, now))) {
    throw new Error("invalid rationale UI/audit binding");
  }
  validateRationaleTicketRecord(input.ticket);
  const autoApproved = input.autoApproved ?? false;
  if (autoApproved && (
    input.ticket.rationaleStatus !== "ready" ||
    input.ticket.state !== "allowed_once" ||
    input.ticket.terminalReason !== "allowed-once" ||
    input.reevaluation === null ||
    input.reevaluation.outcome !== "fresh" ||
    input.reevaluation.scopeAlignment !== "aligned" ||
    input.reevaluation.reevaluatedVerdict.level === "high"
  )) {
    throw new Error(
      "auto-approved projection requires an aligned non-high reviewer allow-once terminal",
    );
  }
  const generationOutcome = input.ticket.generationOutcome;
  if (input.ticket.ticketId !== input.control.ticketId ||
      input.ticket.actionDigest !== input.control.action.actionDigest ||
      generationOutcome === null ||
      input.ticket.reevaluationOutcome !== (input.reevaluation?.outcome ?? null) ||
      !isRationaleOutcomeBinding(
        input.ticket.rationaleStatus, generationOutcome, input.ticket.reevaluationOutcome,
      )) {
    throw new Error("ticket/action projection mismatch");
  }

  let suggestion: string | null = null;
  let reevaluatedVerdict = sealRationaleCanonicalJson(input.control.initialVerdict, "reevaluatedVerdict");
  let effectiveVerdict = sealRationaleCanonicalJson(input.control.initialVerdict, "effectiveVerdict");
  let scopeAlignment: ReviewerScopeAlignment = "unknown";
  let scopeReasons: readonly string[] = ["rationale-generation-" + generationOutcome];
  let modalFallbackRequired = true;

  if (input.ticket.rationaleStatus === "ready") {
    if (input.reevaluation === null || input.reevaluation.outcome !== "fresh" ||
        input.reevaluation.modalFallbackRequired !== false) {
      throw new Error("ready rationale requires fresh reviewer reevaluation");
    }
    const parsed = parseRationaleResponse(input.response, input.control, now);
    if (!parsed || !canonicalJsonEqual(parsed, input.response)) {
      throw new Error("ready projection requires sealed rationale response");
    }
    suggestion = projectUiText(parsed.suggestion, 500, "suggestion");
    reevaluatedVerdict = input.reevaluation.reevaluatedVerdict;
    effectiveVerdict = input.reevaluation.effectiveVerdict;
    scopeAlignment = input.reevaluation.scopeAlignment;
    scopeReasons = input.reevaluation.scopeReasons;
    modalFallbackRequired = false;
  } else if (input.ticket.rationaleStatus === "failed") {
    if (input.response !== null) {
      throw new Error("failed rationale requires null response and modal fallback");
    }
    if (generationOutcome === "accepted-rationale") {
      if (input.reevaluation === null ||
          !REVIEWER_REEVALUATION_FAILURE_OUTCOMES.includes(
            input.reevaluation.outcome as never,
          ) || input.reevaluation.modalFallbackRequired !== true) {
        throw new Error("failed reevaluation requires reviewer failure and modal fallback");
      }
      reevaluatedVerdict = input.reevaluation.reevaluatedVerdict;
      effectiveVerdict = input.reevaluation.effectiveVerdict;
      scopeAlignment = input.reevaluation.scopeAlignment;
      scopeReasons = input.reevaluation.scopeReasons;
    } else if (input.reevaluation !== null) {
      throw new Error("generation failure must not contain reviewer reevaluation");
    }
  } else {
    throw new Error("UI/audit projection requires ready or failed rationale status");
  }
  const initialVerdict = projectUiVerdict(input.control.initialVerdict, "initialVerdict");
  reevaluatedVerdict = projectUiVerdict(reevaluatedVerdict, "reevaluatedVerdict");
  effectiveVerdict = projectUiVerdict(effectiveVerdict, "effectiveVerdict");
  return sealRationaleCanonicalJson({ contractVersion: RATIONALE_CONTROL_CONTRACT_VERSION,
    projection: "rationale-ui-audit", ticketId: input.control.ticketId,
    anchorId: input.control.anchor.anchorId,
    actionDigest: input.control.action.actionDigest, round: 1,
    reasonCode: input.control.reasonCode,
    toolName: projectUiText(input.control.action.toolName, 256, "toolName"),
    canonicalTargets: projectUiList(
      input.control.action.canonicalTargets,
      1_024,
      "canonicalTargets",
    ),
    requestedEffects: projectUiList(
      input.control.action.requestedEffects,
      160,
      "requestedEffects",
    ),
    affectedResources: projectUiList(
      input.control.action.affectedResources,
      160,
      "affectedResources",
    ),
    requiredAuthority: projectUiText(
      input.control.action.requiredAuthority,
      160,
      "requiredAuthority",
    ),
    reviewerOutcome: input.control.reviewerOutcome, generationOutcome,
    reevaluationOutcome: input.reevaluation?.outcome ?? null,
    initialVerdict, reevaluatedVerdict, effectiveVerdict,
    scopeAlignment,
    scopeReasons: projectUiList(scopeReasons, 160, "scopeReasons"),
    rationaleStatus: input.ticket.rationaleStatus, terminalReason: input.ticket.terminalReason,
    suggestion, modalFallbackRequired, autoApproved,
  }, "RationaleUiAuditProjection");
}

// Renderer payloads contain bounded explanatory facts only; keep replay-sensitive ticket, anchor, and action bindings host-side.
// Rebuild through the strict display parser so invalid projections cannot widen the modal surface.
export function createRationaleApprovalDisplayFromProjection(
  projection: RationaleUiAuditProjection,
): RationaleApprovalDisplay {
  if (!validateRationaleUiAuditProjection(projection)) {
    throw new TypeError("invalid rationale UI/audit projection");
  }
  // Keep renderer status narrowed explicitly; audit types also permit pre-terminal states.
  const rationaleStatus = projection.rationaleStatus;
  if (rationaleStatus !== "ready" && rationaleStatus !== "failed") {
    throw new TypeError("projection has no renderer-safe rationale status");
  }
  return createRationaleApprovalDisplay({
    toolName: projection.toolName,
    canonicalTargets: projection.canonicalTargets,
    requestedEffects: projection.requestedEffects,
    affectedResources: projection.affectedResources,
    requiredAuthority: projection.requiredAuthority,
    effectiveVerdict: {
      level: projection.effectiveVerdict.level,
      reason: projection.effectiveVerdict.reason,
    },
    scopeAlignment: projection.scopeAlignment,
    scopeReasons: projection.scopeReasons,
    rationaleStatus,
    suggestion: projection.suggestion,
    modalFallbackRequired: projection.modalFallbackRequired,
  });
}

export const RATIONALE_SECURITY_SUFFIX_VERSION = 4 as const;

export const RATIONALE_SECURITY_SUFFIX = Object.freeze([
  "resume-cas-validate",
  "script-pre-tool-use",
  "current-invocation-scope-revalidate",
  "current-policy-mode-revalidate",
  "current-permission-revalidate",
  "current-sandbox-capability-revalidate",
  "permission-request-hook",
  "permission-ask-audit",
  "approval-allow-once-cas-consume",
  "rate-limit",
  "permission-audit-writable-fail-closed",
  "host-invocation-start-cas",
  "tool-start-emit-boundary",
  "during-execute-effect-gate-context",
  "tool-execute",
  "effect-shadow-reconciliation",
  "post-tool-use-hooks",
  "post-failure-lifecycle",
  "post-exec-dlp-display-audit",
  "final-permission-audit",
  "invocation-audit-terminal",
  "tool-end-emit",
] as const);

type RationaleSecuritySuffixStep = (typeof RATIONALE_SECURITY_SUFFIX)[number];

export interface SealedRationaleResumeRequest {
  contractVersion: typeof RATIONALE_CONTROL_CONTRACT_VERSION;
  kind: "sealed-rationale-resume";
  ticketId: string; actionDigest: string; invocationDigest: string;
  authorizationReceiptId: string;
  control: RationaleRequiredControl;
  response: RationaleResponse | null;
  rationaleStatus: Extract<RationaleStatus, "ready" | "failed">;
  generationOutcome: RationaleGenerationOutcome;
  reevaluation: ReviewerScopeReevaluation | null;
  ticket: RationaleTicketStateRecord;
  currentActionIdentity: ActionIdentity;
  currentEligibilityContext: HostRationaleEligibilityContext;
  securitySuffixVersion: typeof RATIONALE_SECURITY_SUFFIX_VERSION;
  securitySuffix: readonly RationaleSecuritySuffixStep[];
  executionEntryPoint: "tool-executor-security-suffix";
  directToolExecute: "forbidden";
}

export function createSealedRationaleResumeRequest(input: {
  control: RationaleRequiredControl;
  response: unknown | null;
  rationaleStatus: "ready" | "failed";
  reevaluation: ReviewerScopeReevaluation | null;
  ticket: RationaleTicketStateRecord;
  currentActionIdentity: ActionIdentity;
  currentEligibilityContext: HostRationaleEligibilityContext;
  hostConsumedAllowOnceReceipt: HostConsumedAllowOnceReceipt;
  now?: number;
}): SealedRationaleResumeRequest {
  const now = input.now ?? Date.now();
  if (input.rationaleStatus !== "ready" && input.rationaleStatus !== "failed") {
    throw new TypeError("invalid runtime rationaleStatus");
  }
  if (!verifyRationaleRequiredControl(input.control, {
    now, currentEligibilityContext: input.currentEligibilityContext,
  })) throw new Error("invalid, expired, or stale rationale control");
  if (!verifyActionIdentity(input.currentActionIdentity) ||
      !canonicalJsonEqual(input.currentActionIdentity, input.control.action)) {
    throw new Error("current ActionIdentity does not match sealed action");
  }
  if (input.reevaluation !== null &&
      !validateReviewerScopeReevaluation(input.reevaluation, input.control, now)) {
    throw new Error("reviewer reevaluation binding mismatch");
  }
  validateRationaleTicketRecord(input.ticket);
  validateHostConsumedAllowOnceReceipt(
    input.hostConsumedAllowOnceReceipt, input.control, input.ticket, now,
  );
  const generationOutcome = input.ticket.generationOutcome;
  if (input.ticket.ticketId !== input.control.ticketId ||
      input.ticket.actionDigest !== input.control.action.actionDigest ||
      input.ticket.state !== "allowed_once" || input.ticket.terminalReason !== "allowed-once" ||
      input.ticket.rationaleStatus !== input.rationaleStatus ||
      generationOutcome === null ||
      input.ticket.reevaluationOutcome !== (input.reevaluation?.outcome ?? null) ||
      !isRationaleOutcomeBinding(
        input.rationaleStatus, generationOutcome, input.ticket.reevaluationOutcome,
      )) {
    throw new Error("allow-once ticket binding mismatch");
  }
  let response: RationaleResponse | null;
  if (input.rationaleStatus === "ready") {
    if (generationOutcome !== "accepted-rationale" ||
        input.reevaluation === null || input.reevaluation.outcome !== "fresh" ||
        input.reevaluation.modalFallbackRequired !== false) {
      throw new Error("ready rationale requires fresh reviewer reevaluation");
    }
    response = parseRationaleResponse(input.response, input.control, now);
    if (!response) throw new Error("invalid rationale response");
  } else {
    if (input.response !== null) {
      throw new Error("failed rationale requires null response");
    }
    if (generationOutcome === "accepted-rationale") {
      if (input.reevaluation === null ||
          !REVIEWER_REEVALUATION_FAILURE_OUTCOMES.includes(
            input.reevaluation.outcome as never,
          ) || input.reevaluation.modalFallbackRequired !== true) {
        throw new Error("failed reevaluation requires reviewer failure");
      }
    } else if (input.reevaluation !== null) {
      throw new Error("generation failure must not contain reviewer reevaluation");
    }
    response = null;
  }
  return sealRationaleCanonicalJson({ contractVersion: RATIONALE_CONTROL_CONTRACT_VERSION,
    kind: "sealed-rationale-resume", ticketId: input.control.ticketId,
    actionDigest: input.control.action.actionDigest,
    invocationDigest: input.control.invocationDigest,
    authorizationReceiptId: input.hostConsumedAllowOnceReceipt.receiptId,
    control: sealRationaleCanonicalJson(input.control, "control"), response,
    rationaleStatus: input.rationaleStatus, generationOutcome,
    reevaluation: input.reevaluation,
    ticket: input.ticket, currentActionIdentity: sealRationaleCanonicalJson(input.currentActionIdentity, "currentActionIdentity"),
    currentEligibilityContext: sealRationaleCanonicalJson(input.currentEligibilityContext, "currentEligibilityContext"),
    securitySuffixVersion: RATIONALE_SECURITY_SUFFIX_VERSION,
    securitySuffix: RATIONALE_SECURITY_SUFFIX,
    executionEntryPoint: "tool-executor-security-suffix", directToolExecute: "forbidden",
  }, "SealedRationaleResumeRequest");
}

export function validateSealedRationaleResumeRequest(
  request: unknown,
  currentActionIdentity: ActionIdentity,
  currentEligibilityContext: HostRationaleEligibilityContext,
  hostConsumedAllowOnceReceipt: HostConsumedAllowOnceReceipt,
  now = Date.now(),
): request is SealedRationaleResumeRequest {
  try {
    assertRationaleCanonicalJson(request, "SealedRationaleResumeRequest");
    if (!isRecord(request)) return false;
    assertExactOwnKeys(request, ["contractVersion", "kind", "ticketId", "actionDigest",
      "invocationDigest", "authorizationReceiptId", "control", "response", "rationaleStatus",
      "generationOutcome", "reevaluation", "ticket", "currentActionIdentity",
      "currentEligibilityContext", "securitySuffixVersion", "securitySuffix",
      "executionEntryPoint", "directToolExecute"], "SealedRationaleResumeRequest");
    const control = request.control as RationaleRequiredControl;
    if (!verifyRationaleRequiredControl(control, { now, currentEligibilityContext })) return false;
    const ticket = request.ticket as RationaleTicketStateRecord;
    validateRationaleTicketRecord(ticket);
    validateHostConsumedAllowOnceReceipt(
      hostConsumedAllowOnceReceipt, control, ticket, now,
    );
    const generationOutcome = request.generationOutcome as RationaleGenerationOutcome;
    const reevaluation = request.reevaluation === null
      ? null : request.reevaluation as ReviewerScopeReevaluation;
    const reevaluationOutcome = reevaluation?.outcome ?? null;
    if (request.contractVersion !== RATIONALE_CONTROL_CONTRACT_VERSION ||
      request.kind !== "sealed-rationale-resume" || request.ticketId !== control.ticketId ||
      request.actionDigest !== control.action.actionDigest ||
      request.invocationDigest !== control.invocationDigest ||
      request.authorizationReceiptId !== hostConsumedAllowOnceReceipt.receiptId ||
      ticket.ticketId !== control.ticketId || ticket.actionDigest !== control.action.actionDigest ||
      ticket.state !== "allowed_once" || ticket.terminalReason !== "allowed-once" ||
      ticket.rationaleStatus !== request.rationaleStatus ||
      ticket.generationOutcome !== generationOutcome ||
      ticket.reevaluationOutcome !== reevaluationOutcome ||
      !isRationaleOutcomeBinding(
        request.rationaleStatus as RationaleStatus,
        generationOutcome, reevaluationOutcome,
      ) ||
      request.executionEntryPoint !== "tool-executor-security-suffix" ||
      request.securitySuffixVersion !== RATIONALE_SECURITY_SUFFIX_VERSION ||
      request.directToolExecute !== "forbidden" ||
      !verifyActionIdentity(currentActionIdentity) || !canonicalJsonEqual(currentActionIdentity, control.action) ||
      !canonicalJsonEqual(request.currentActionIdentity, currentActionIdentity) ||
      !canonicalJsonEqual(request.currentEligibilityContext, currentEligibilityContext) ||
      !canonicalJsonEqual(request.securitySuffix, RATIONALE_SECURITY_SUFFIX) ||
      (reevaluation !== null &&
        !validateReviewerScopeReevaluation(reevaluation, control, now))) return false;
    if (request.rationaleStatus === "failed") {
      if (request.response !== null) return false;
      return generationOutcome === "accepted-rationale"
        ? reevaluation !== null && reevaluation.modalFallbackRequired === true &&
            REVIEWER_REEVALUATION_FAILURE_OUTCOMES.includes(reevaluation.outcome as never)
        : reevaluation === null;
    }
    if (request.rationaleStatus !== "ready" ||
        generationOutcome !== "accepted-rationale" ||
        reevaluation === null || reevaluation.outcome !== "fresh" ||
        reevaluation.modalFallbackRequired !== false) return false;
    const response = parseRationaleResponse(request.response, control, now);
    return response !== null && canonicalJsonEqual(response, request.response);
  } catch {
    return false;
  }
}

export interface RationaleExecutionAuthorityEntry {
  contractVersion: typeof RATIONALE_CONTROL_CONTRACT_VERSION;
  kind: "rationale-execution-authority-entry";
  ticketId: string;
  actionDigest: string;
  invocationDigest: string;
  toolUseId: string;
  authorizationReceiptId: string;
  invocationStartLeaseId: string;
  securitySuffixVersion: typeof RATIONALE_SECURITY_SUFFIX_VERSION;
  resumeRequest: SealedRationaleResumeRequest;
  startLease: HostInvocationStartLease;
  startedInvocationAudit: InvocationAuditRecord;
  executionAuthority: "single-host-cas-start-lease";
  directToolExecute: "forbidden";
}

export function createRationaleExecutionAuthorityEntry(input: {
  resumeRequest: SealedRationaleResumeRequest;
  currentActionIdentity: ActionIdentity;
  currentEligibilityContext: HostRationaleEligibilityContext;
  hostConsumedAllowOnceReceipt: HostConsumedAllowOnceReceipt;
  authorizedInvocationAudit: InvocationAuditRecord;
  hostInvocationStartLease: HostInvocationStartLease;
  startedInvocationAudit: InvocationAuditRecord;
  now?: number;
}): RationaleExecutionAuthorityEntry {
  const now = input.now ?? Date.now();
  if (!validateSealedRationaleResumeRequest(
    input.resumeRequest,
    input.currentActionIdentity,
    input.currentEligibilityContext,
    input.hostConsumedAllowOnceReceipt,
    now,
  )) throw new Error("invalid sealed rationale resume authority input");
  validateInvocationAuditRecord(input.authorizedInvocationAudit);
  validateHostInvocationStartLease(
    input.hostInvocationStartLease, input.authorizedInvocationAudit, now,
  );
  validateInvocationAuditRecord(input.startedInvocationAudit);
  const control = input.resumeRequest.control;
  if (input.authorizedInvocationAudit.state !== "authorized" ||
      input.authorizedInvocationAudit.ticketId !== control.ticketId ||
      input.authorizedInvocationAudit.actionDigest !== control.action.actionDigest ||
      input.authorizedInvocationAudit.invocationDigest !== control.invocationDigest ||
      input.authorizedInvocationAudit.toolUseId !== control.sealedAction.toolUseId ||
      input.authorizedInvocationAudit.authorizationReceiptId !==
        input.resumeRequest.authorizationReceiptId) {
    throw new Error("authorized invocation does not match resume request");
  }
  const expectedStartedInvocationAudit = createInvocationStartedAudit({
    authorized: input.authorizedInvocationAudit,
    startLease: input.hostInvocationStartLease,
    now,
  });
  if (!canonicalJsonEqual(expectedStartedInvocationAudit, input.startedInvocationAudit)) {
    throw new Error("started invocation audit does not match committed start");
  }
  return sealRationaleCanonicalJson({
    contractVersion: RATIONALE_CONTROL_CONTRACT_VERSION,
    kind: "rationale-execution-authority-entry",
    ticketId: control.ticketId,
    actionDigest: control.action.actionDigest,
    invocationDigest: control.invocationDigest,
    toolUseId: control.sealedAction.toolUseId,
    authorizationReceiptId: input.resumeRequest.authorizationReceiptId,
    invocationStartLeaseId: input.hostInvocationStartLease.leaseId,
    securitySuffixVersion: RATIONALE_SECURITY_SUFFIX_VERSION,
    resumeRequest: input.resumeRequest,
    startLease: input.hostInvocationStartLease,
    startedInvocationAudit: input.startedInvocationAudit,
    executionAuthority: "single-host-cas-start-lease",
    directToolExecute: "forbidden",
  }, "RationaleExecutionAuthorityEntry");
}
