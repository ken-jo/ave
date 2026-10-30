import { canonicalJsonEqual } from "../../shared/canonical-json.js";
import type { ReviewerDispatchOutcome } from "../../permissions/permission-manager.js";
import type { RiskVerdict } from "../../permissions/reviewer/risk-classifier.js";
import { maxVerdict } from "../../permissions/reviewer/risk-classifier.js";
import {
  RATIONALE_CONTROL_CONTRACT_VERSION,
  RATIONALE_RESPONSE_SCHEMA,
  RATIONALE_RESPONSE_TOOL,
  assertRationaleCanonicalJson,
  normalizeRationaleRiskVerdict,
  parseRationaleResponse,
  verifyRationaleRequiredControl,
  verifyRationaleTicketControl,
  type RationaleRequiredControl,
  type RationaleResponse,
  type HostAnchorRoundReservationReceipt,
  type TriggeringBatchDisposition,
  sealRationaleCanonicalJson,
  assertExactOwnKeys,
} from "./rationale-control.js";
import { isRecord } from "../../shared/is-record.js";

// Frozen rationale contracts grant no execution authority.
export type ReviewerReevaluationOutcome = Exclude<ReviewerDispatchOutcome, "cache" | "approval-memory" | "host-determined">;

export type ReviewerReevaluationFailureOutcome = Exclude<
  ReviewerReevaluationOutcome,
  "fresh"
>;

export const REVIEWER_REEVALUATION_FAILURE_OUTCOMES:
readonly ReviewerReevaluationFailureOutcome[] = Object.freeze([
  "unavailable", "error", "timeout", "malformed", "sandbox-state-changed",
]);

// Generation and reviewer outcomes are separate: either can fail before or after accepted generation.
export type RationaleGenerationOutcome =
  | "accepted-rationale"
  | "generation-unavailable"
  | "generation-error"
  | "generation-timeout"
  | "missing-rationale-call"
  | "ordinary-tool-call-rejected"
  | "multiple-calls-rejected"
  | "malformed-rationale";

export type RationaleGenerationFailureCause = Exclude<
  RationaleGenerationOutcome,
  "accepted-rationale"
>;

export const RATIONALE_GENERATION_FAILURE_CAUSES:
readonly RationaleGenerationFailureCause[] = Object.freeze([
  "generation-unavailable", "generation-error", "generation-timeout",
  "missing-rationale-call", "ordinary-tool-call-rejected",
  "multiple-calls-rejected", "malformed-rationale",
]);
const SCOPE_ALIGNMENTS: readonly Exclude<ReviewerScopeAlignment, "unknown">[] = [
  "aligned", "unclear", "outside",
];


function text(value: unknown, label: string, max = 256): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new TypeError(label + " exceeds its bounded text contract");
  }
}

function boundedStrings(value: unknown, label: string): readonly string[] {
  // Canonical validation rejects Array subclasses/accessors before values are read.
  assertRationaleCanonicalJson(value, label);
  if (!Array.isArray(value)) throw new TypeError(label + " must be an array");
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>;
  const length = descriptors.length && "value" in descriptors.length
    ? descriptors.length.value as number : -1;
  if (length < 1 || length > 8) throw new TypeError(label + " exceeds list bounds");
  const result: string[] = [];
  for (let i = 0; i < length; i += 1) {
    const descriptor = descriptors[String(i)];
    const item = descriptor && "value" in descriptor ? descriptor.value : undefined;
    text(item, label + "[" + i + "]", 160);
    result.push(item);
  }
  return sealRationaleCanonicalJson(result, label);
}

export interface RationaleExecutorControlOutcome {
  contractVersion: typeof RATIONALE_CONTROL_CONTRACT_VERSION;
  channel: "executor-control";
  outcome: "rationale-required";
  control: RationaleRequiredControl;
  triggeringBatchDisposition: TriggeringBatchDisposition;
  anchorRoundReservation: HostAnchorRoundReservationReceipt;
  transcriptVisibility: "hidden";
  ordinaryToolResult: null;
  executionAuthorized: false;
}

export function createRationaleExecutorControlOutcome(
  control: RationaleRequiredControl, now = Date.now(),
): RationaleExecutorControlOutcome {
  if (!verifyRationaleRequiredControl(control, { now })) {
    throw new Error("invalid or expired rationale control");
  }
  return sealRationaleCanonicalJson({ contractVersion: RATIONALE_CONTROL_CONTRACT_VERSION,
    channel: "executor-control", outcome: "rationale-required", control,
    triggeringBatchDisposition: sealRationaleCanonicalJson(
      control.triggeringBatchDisposition, "triggeringBatchDisposition",
    ),
    anchorRoundReservation: sealRationaleCanonicalJson(
      control.anchorRoundReservation, "anchorRoundReservation",
    ),
    transcriptVisibility: "hidden", ordinaryToolResult: null,
    executionAuthorized: false }, "RationaleExecutorControlOutcome");
}

export interface RationaleOnlyRoundContract {
  contractVersion: typeof RATIONALE_CONTROL_CONTRACT_VERSION;
  ticketId: string; actionDigest: string; round: 1; anchorRoundBudget: 1;
  schemas: readonly [typeof RATIONALE_RESPONSE_SCHEMA];
  requiredToolName: typeof RATIONALE_RESPONSE_TOOL;
  ordinaryToolSchemas: "forbidden";
  rationaleOnlyBatchSiblingPolicy: "cancel-unexecuted";
  triggeringBatchDisposition: "completed-before-rationale-only-round";
  transcriptPolicy: "ephemeral-rationale-only";
  executionAuthority: "none";
}

export function createRationaleOnlyRoundContract(
  control: RationaleRequiredControl, now = Date.now(),
): RationaleOnlyRoundContract {
  if (!verifyRationaleRequiredControl(control, { now })) {
    throw new Error("invalid or expired rationale control");
  }
  return sealRationaleCanonicalJson({ contractVersion: RATIONALE_CONTROL_CONTRACT_VERSION,
    ticketId: control.ticketId, actionDigest: control.action.actionDigest, round: 1,
    anchorRoundBudget: control.anchor.rationaleRoundBudget,
    schemas: [RATIONALE_RESPONSE_SCHEMA], requiredToolName: RATIONALE_RESPONSE_TOOL,
    ordinaryToolSchemas: "forbidden", rationaleOnlyBatchSiblingPolicy: "cancel-unexecuted",
    triggeringBatchDisposition: "completed-before-rationale-only-round",
    transcriptPolicy: "ephemeral-rationale-only", executionAuthority: "none",
  }, "RationaleOnlyRoundContract") as RationaleOnlyRoundContract;
}

export interface RationaleRoundCall { id: string; name: string; input: unknown; }

export interface RationaleOnlyBatchDecision {
  contractVersion: typeof RATIONALE_CONTROL_CONTRACT_VERSION;
  batchKind: "rationale-only-followup";
  ticketId: string; actionDigest: string; accepted: boolean;
  response: RationaleResponse | null;
  rejectedCallIds: readonly string[];
  cancelledRationaleOnlySiblingCallIds: readonly string[];
  generationOutcome: Extract<RationaleGenerationOutcome,
    "accepted-rationale" | "missing-rationale-call" | "ordinary-tool-call-rejected" |
    "multiple-calls-rejected" | "malformed-rationale">;
  reason: "accepted-rationale" | "missing-rationale-call" |
    "ordinary-tool-call-rejected" | "multiple-calls-rejected" | "malformed-rationale";
  ticketCreationAllowed: boolean; sideEffectsAllowed: false;
}

const BATCH_GENERATION_FAILURES: readonly RationaleGenerationFailureCause[] = [
  "missing-rationale-call", "ordinary-tool-call-rejected",
  "multiple-calls-rejected", "malformed-rationale",
];

function batchResult(
  control: RationaleRequiredControl,
  value: Omit<RationaleOnlyBatchDecision,
    "contractVersion" | "batchKind" | "ticketId" | "actionDigest">,
): RationaleOnlyBatchDecision {
  return sealRationaleCanonicalJson({ contractVersion: RATIONALE_CONTROL_CONTRACT_VERSION,
    batchKind: "rationale-only-followup",
    ticketId: control.ticketId, actionDigest: control.action.actionDigest, ...value },
    "RationaleOnlyBatchDecision");
}

export function evaluateRationaleOnlyBatch(
  control: RationaleRequiredControl, calls: readonly RationaleRoundCall[], now = Date.now(),
): RationaleOnlyBatchDecision {
  if (!verifyRationaleRequiredControl(control, { now })) {
    throw new Error("invalid or expired rationale control");
  }
  assertRationaleCanonicalJson(calls, "RationaleRoundCall[]");
  const normalized = sealRationaleCanonicalJson(calls, "RationaleRoundCall[]");
  const seen = new Set<string>();
  for (const call of normalized) {
    if (!isRecord(call)) throw new TypeError("RationaleRoundCall must be an object");
    assertExactOwnKeys(call, ["id", "name", "input"], "RationaleRoundCall");
    text(call.id, "call.id"); text(call.name, "call.name");
    if (seen.has(call.id)) throw new TypeError("duplicate rationale call id");
    seen.add(call.id);
  }
  if (normalized.length === 1 && normalized[0]!.name === RATIONALE_RESPONSE_TOOL) {
    const response = parseRationaleResponse(normalized[0]!.input, control, now);
    return response
      ? batchResult(control, { accepted: true, response, rejectedCallIds: [],
          cancelledRationaleOnlySiblingCallIds: [],
          generationOutcome: "accepted-rationale", reason: "accepted-rationale",
          ticketCreationAllowed: true, sideEffectsAllowed: false })
      : batchResult(control, { accepted: false, response: null,
          rejectedCallIds: [normalized[0]!.id], cancelledRationaleOnlySiblingCallIds: [],
          generationOutcome: "malformed-rationale", reason: "malformed-rationale",
          ticketCreationAllowed: false,
          sideEffectsAllowed: false });
  }
  const ordinary = normalized.findIndex((call) => call.name !== RATIONALE_RESPONSE_TOOL);
  const rejected = ordinary >= 0 ? ordinary : 0;
  const rejectedCallIds = normalized.length ? [normalized[rejected]!.id] : [];
  const cancelledRationaleOnlySiblingCallIds = normalized
    .filter((_, index) => index !== rejected).map((call) => call.id);
  const generationOutcome = normalized.length === 0 ? "missing-rationale-call"
    : ordinary >= 0 ? "ordinary-tool-call-rejected" : "multiple-calls-rejected";
  return batchResult(control, { accepted: false, response: null, rejectedCallIds,
    cancelledRationaleOnlySiblingCallIds, generationOutcome, reason: generationOutcome,
    ticketCreationAllowed: false, sideEffectsAllowed: false });
}

export function validateRationaleOnlyBatchDecision(
  value: unknown, control: RationaleRequiredControl, now = Date.now(),
): value is RationaleOnlyBatchDecision {
  try {
    if (!verifyRationaleRequiredControl(control, { now })) return false;
    assertRationaleCanonicalJson(value, "RationaleOnlyBatchDecision");
    if (!isRecord(value)) return false;
    assertExactOwnKeys(value, ["contractVersion", "batchKind", "ticketId", "actionDigest", "accepted",
      "response", "rejectedCallIds", "cancelledRationaleOnlySiblingCallIds",
      "generationOutcome", "reason", "ticketCreationAllowed", "sideEffectsAllowed"],
    "RationaleOnlyBatchDecision");
    if (value.contractVersion !== RATIONALE_CONTROL_CONTRACT_VERSION ||
        value.batchKind !== "rationale-only-followup" ||
        value.ticketId !== control.ticketId ||
        value.actionDigest !== control.action.actionDigest ||
        value.sideEffectsAllowed !== false ||
        !Array.isArray(value.rejectedCallIds) ||
        !Array.isArray(value.cancelledRationaleOnlySiblingCallIds)) return false;
    const ids = [
      ...value.rejectedCallIds,
      ...value.cancelledRationaleOnlySiblingCallIds,
    ];
    const seen = new Set<string>();
    for (const id of ids) {
      text(id, "rationale batch call id");
      if (seen.has(id)) return false;
      seen.add(id);
    }
    if (value.accepted === true) {
      const parsed = parseRationaleResponse(value.response, control, now);
      return value.generationOutcome === "accepted-rationale" &&
        value.reason === "accepted-rationale" &&
        value.ticketCreationAllowed === true &&
        value.rejectedCallIds.length === 0 &&
        value.cancelledRationaleOnlySiblingCallIds.length === 0 &&
        parsed !== null && canonicalJsonEqual(parsed, value.response);
    }
    if (value.accepted !== false ||
        value.ticketCreationAllowed !== false ||
        value.response !== null ||
        value.generationOutcome !== value.reason ||
        !BATCH_GENERATION_FAILURES.includes(
          value.generationOutcome as RationaleGenerationFailureCause,
        )) return false;
    if (value.generationOutcome === "missing-rationale-call") {
      return value.rejectedCallIds.length === 0 &&
        value.cancelledRationaleOnlySiblingCallIds.length === 0;
    }
    if (value.generationOutcome === "malformed-rationale") {
      return value.rejectedCallIds.length === 1 &&
        value.cancelledRationaleOnlySiblingCallIds.length === 0;
    }
    if (value.generationOutcome === "ordinary-tool-call-rejected") {
      return value.rejectedCallIds.length === 1;
    }
    return value.generationOutcome === "multiple-calls-rejected" &&
      value.rejectedCallIds.length === 1 &&
      value.cancelledRationaleOnlySiblingCallIds.length >= 1;
  } catch {
    return false;
  }
}

export type ReviewerScopeAlignment = "aligned" | "unclear" | "outside" | "unknown";

export interface ReviewerScopeReevaluation {
  contractVersion: typeof RATIONALE_CONTROL_CONTRACT_VERSION;
  ticketId: string; anchorId: string; actionDigest: string; round: 1;
  ticketNamespace: string;
  cachePolicy: "bypass-base-cache";
  baseCacheWrite: "forbidden";
  outcome: ReviewerReevaluationOutcome;
  scopeAlignment: ReviewerScopeAlignment;
  scopeReasons: readonly string[];
  reevaluatedVerdict: RiskVerdict;
  effectiveVerdict: RiskVerdict;
  modalFallbackRequired: boolean;
}

// Fresh low/medium re-evaluation allows the action; high and review failures require a card.
// Never gate on effectiveVerdict: max(initial, reevaluated) retains the initial high verdict.
export function isReviewerAutoApproveEligible(r: ReviewerScopeReevaluation): boolean {
  return r.outcome === "fresh" && r.reevaluatedVerdict.level !== "high";
}

export function createReviewerScopeReevaluation(input: {
  control: RationaleRequiredControl;
  outcome: ReviewerReevaluationOutcome;
  scopeAlignment?: Exclude<ReviewerScopeAlignment, "unknown">;
  scopeReasons?: readonly string[];
  reevaluatedVerdict?: RiskVerdict;
  now?: number;
}): ReviewerScopeReevaluation {
  const now = input.now ?? Date.now();
  if (!verifyRationaleRequiredControl(input.control, { now })) {
    throw new Error("invalid or expired rationale control");
  }
  const initial = normalizeRationaleRiskVerdict(input.control.initialVerdict, "initialVerdict");
  const failed = REVIEWER_REEVALUATION_FAILURE_OUTCOMES.includes(input.outcome as never);
  if (input.outcome !== "fresh" && !failed) {
    throw new TypeError("cache and approval-memory are forbidden for ticket reevaluation");
  }
  if (input.outcome === "fresh") {
    if (!SCOPE_ALIGNMENTS.includes(input.scopeAlignment as never) ||
        !input.scopeReasons || !input.reevaluatedVerdict) {
      throw new TypeError("fresh reevaluation requires reviewer-owned scope and verdict");
    }
  } else if (input.scopeAlignment !== undefined || input.scopeReasons !== undefined ||
      input.reevaluatedVerdict !== undefined) {
    throw new TypeError("failed reevaluation must use sealed modal fallback");
  }
  const scopeAlignment = input.outcome === "fresh" ? input.scopeAlignment! : "unknown";
  const scopeReasons = input.outcome === "fresh"
    ? boundedStrings(input.scopeReasons, "scopeReasons")
    : sealRationaleCanonicalJson(["reviewer-" + input.outcome], "scopeReasons");
  const reevaluatedVerdict = input.outcome === "fresh"
    ? normalizeRationaleRiskVerdict(input.reevaluatedVerdict!, "reevaluatedVerdict")
    : initial;
  const effectiveVerdict = normalizeRationaleRiskVerdict(
    maxVerdict(initial, reevaluatedVerdict), "effectiveVerdict",
  );
  return sealRationaleCanonicalJson({ contractVersion: RATIONALE_CONTROL_CONTRACT_VERSION,
    ticketId: input.control.ticketId, anchorId: input.control.anchor.anchorId,
    actionDigest: input.control.action.actionDigest, round: 1,
    ticketNamespace: "rationale-ticket/" + input.control.ticketId,
    cachePolicy: "bypass-base-cache", baseCacheWrite: "forbidden", outcome: input.outcome,
    scopeAlignment, scopeReasons, reevaluatedVerdict, effectiveVerdict,
    modalFallbackRequired: input.outcome !== "fresh",
  }, "ReviewerScopeReevaluation");
}

export function validateReviewerScopeReevaluation(value: unknown, control: RationaleRequiredControl, now = Date.now()): value is ReviewerScopeReevaluation {
  return validateRationaleReevaluation(value, control, now, false);
}

export function validateReviewerExecutionReevaluation(value: unknown, control: RationaleRequiredControl, now = Date.now()): value is ReviewerScopeReevaluation {
  return validateRationaleReevaluation(value, control, now, true);
}

function validateRationaleReevaluation(
  value: unknown, control: RationaleRequiredControl, now: number, humanWait: boolean,
): value is ReviewerScopeReevaluation {
  try {
    if (!(humanWait ? verifyRationaleTicketControl(control, { now }) : verifyRationaleRequiredControl(control, { now }))) return false;
    assertRationaleCanonicalJson(value, "ReviewerScopeReevaluation");
    if (!isRecord(value)) return false;
    assertExactOwnKeys(value, ["contractVersion", "ticketId", "anchorId", "actionDigest", "round",
      "ticketNamespace", "cachePolicy", "baseCacheWrite", "outcome",
      "scopeAlignment", "scopeReasons", "reevaluatedVerdict", "effectiveVerdict",
      "modalFallbackRequired"], "ReviewerScopeReevaluation");
    if (value.contractVersion !== RATIONALE_CONTROL_CONTRACT_VERSION ||
      value.ticketId !== control.ticketId || value.anchorId !== control.anchor.anchorId ||
      value.actionDigest !== control.action.actionDigest || value.round !== 1 ||
      value.ticketNamespace !== "rationale-ticket/" + control.ticketId ||
      value.cachePolicy !== "bypass-base-cache" || value.baseCacheWrite !== "forbidden") return false;
    const outcome = value.outcome as ReviewerReevaluationOutcome;
    if (outcome !== "fresh" &&
      !REVIEWER_REEVALUATION_FAILURE_OUTCOMES.includes(outcome as never)) return false;
    if (!canonicalJsonEqual(boundedStrings(value.scopeReasons, "scopeReasons"), value.scopeReasons)) return false;
    const reevaluated = normalizeRationaleRiskVerdict(
      value.reevaluatedVerdict as RiskVerdict, "reevaluatedVerdict",
    );
    const effective = normalizeRationaleRiskVerdict(
      value.effectiveVerdict as RiskVerdict, "effectiveVerdict",
    );
    const initial = normalizeRationaleRiskVerdict(control.initialVerdict, "initialVerdict");
    if (!canonicalJsonEqual(effective, maxVerdict(initial, reevaluated))) return false;
    return outcome === "fresh"
      ? SCOPE_ALIGNMENTS.includes(value.scopeAlignment as never) &&
          value.modalFallbackRequired === false
      : value.scopeAlignment === "unknown" && value.modalFallbackRequired === true &&
          canonicalJsonEqual(reevaluated, initial);
  } catch {
    return false;
  }
}
