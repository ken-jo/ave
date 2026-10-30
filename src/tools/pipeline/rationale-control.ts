// Versioned rationale handoff carries sealed control in memory but grants no execution authority or durable tickets.
import { randomUUID } from "node:crypto";
import type { ChatInputOrigin } from "../../shared/chat-origin.js";
import type { ToolCategory, ToolSource, ToolTrustOrigin } from "../types.js";
import type {
  PermissionCheckResult,
  ReviewerDispatchOutcome,
} from "../../permissions/permission-manager.js";
import type { RiskVerdict } from "../../permissions/reviewer/risk-classifier.js";
import type { ToolSchema } from "../../engine/llm/types.js";
import { maskSensitiveData } from "../../audit/dlp-filter.js";
import { canonicalStringify } from "../../permissions/user-approval-store.js";
import { normalizeRationaleApprovalDisplayText } from "../../shared/rationale-approval-display.js";
import { assertValidToolUseId } from "../../shared/tool-use-id.js";
import { hasExactKeys, isRecord } from "../../shared/is-record.js";
import { UUID_PATTERN } from "../../shared/uuid.js";
import { sha256Hex } from "../../lib/hex-digest-equal.js";

export const RATIONALE_CONTROL_CONTRACT_VERSION = 1 as const;
export const RATIONALE_RESPONSE_TOOL = "permission_rationale";
export const MAX_RATIONALE_USER_CONTEXT_BYTES = 16 * 1024;

export class RationaleHumanApprovalDeniedError extends Error {
  constructor(readonly reason: string) {
    super("Human approval was denied by current policy.");
    this.name = "RationaleHumanApprovalDeniedError";
  }
}

export const RATIONALE_ACTIVATION_PREREQUISITES = [
  "persistent-ticket-store",
  "host-anchor-round-cas",
  "server-enforced-allowed-choices",
  "one-shot-resolution-cas",
  "rationale-only-provider-round",
  "same-batch-sibling-cancellation",
  "reviewer-reevaluation-cache-isolation",
  "current-action-identity-revalidation",
  "ordered-security-suffix-resume",
  "invocation-lifecycle-audit",
  "host-invocation-start-cas",
  "bounded-modal-ui",
] as const;

export type RationaleActivationPrerequisite =
  typeof RATIONALE_ACTIVATION_PREREQUISITES[number];

// Versioned production prerequisites require matching source ledger and scenario-board updates.
export const RATIONALE_GUARDED_ACTIVATION_EVIDENCE = Object.freeze({
  "persistent-ticket-store": true,
  "host-anchor-round-cas": true,
  "server-enforced-allowed-choices": true,
  "one-shot-resolution-cas": true,
  "rationale-only-provider-round": true,
  "same-batch-sibling-cancellation": true,
  "reviewer-reevaluation-cache-isolation": true,
  "current-action-identity-revalidation": true,
  "ordered-security-suffix-resume": true,
  "invocation-lifecycle-audit": true,
  "host-invocation-start-cas": true,
  "bounded-modal-ui": true,
} satisfies Readonly<Record<RationaleActivationPrerequisite, true>>);

// Missing or false prerequisites fail closed; the optional ledger supports missing-attestation tests.
export function isRationaleGuardedActivationReady(
  evidence: Readonly<
    Partial<Record<RationaleActivationPrerequisite, boolean>>
  > = RATIONALE_GUARDED_ACTIVATION_EVIDENCE,
): boolean {
  return RATIONALE_ACTIVATION_PREREQUISITES.every(
    (prerequisite) => evidence[prerequisite] === true,
  );
}

// Production activation requires all attestations plus a boot-published host coordinator.
export const FOREGROUND_RATIONALE_PRODUCTION_ENABLED =
  isRationaleGuardedActivationReady();

export interface ForegroundRationaleActivationContext {
  readonly productionEnabled: boolean;
  readonly nodeEnv: string | undefined;
  /** True only when boot published an executable host coordinator factory. */
  readonly hostCoordinatorAvailable: boolean;
  readonly enableDormantRationaleForTesting: boolean | undefined;
}

// One predicate gates ordering and injection; test activation requires NODE_ENV=test and failed publication keeps the batch path.
export function isForegroundRationaleOrchestrationEnabled(
  context: Readonly<ForegroundRationaleActivationContext>,
): boolean {
  if (!context.hostCoordinatorAvailable) return false;
  if (context.nodeEnv === "test") {
    return context.enableDormantRationaleForTesting === true;
  }
  return context.productionEnabled === true &&
    isRationaleGuardedActivationReady();
}

export const RATIONALE_UNKNOWN_SCOPE_SENTINEL = "[unknown]" as const;
export interface RequestAnchor {
  contractVersion: typeof RATIONALE_CONTROL_CONTRACT_VERSION;
  anchorId: string;
  sessionId: string;
  turnId: string;
  inputMessageId: string;
  inputOrigin: "user-keyboard";
  sanitizedIntent: string;
  rationaleRoundBudget: 1;
  intentDigest: string;
  createdAt: number;
  expiresAt: number;
}
type RationaleTaint =
  | "none"
  | "file-content"
  | "app-emitted"
  | "plugin-emitted"
  | "mcp-prompt-emitted"
  | "plugin-prompt-emitted"
  | "agent-message"
  | "queue-auto"
  | "surface-user"
  | "tailnet-surface"
  | "platform-bridge";

export interface RationaleEligibilityProvenance {
  startedFromUserKeyboard: boolean;
  taint: RationaleTaint;
}

// Bind unexecuted sibling proposals to keyboard anchor, tool, and canonical input, excluding provider tool-use ID.
export interface CancelledSiblingProposalGuard {
  contractVersion: typeof RATIONALE_CONTROL_CONTRACT_VERSION;
  anchorId: string;
  proposalDigest: string;
}

export interface HostRationaleEligibilityContext {
  headless: boolean;
  forceModal: boolean;
  approvalReasonPrefix: string | null;
}

type DeepReadonly<T> =
  T extends (...args: never[]) => unknown
    ? T
    : T extends readonly (infer U)[]
      ? readonly DeepReadonly<U>[]
      : T extends object
        ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
        : T;


export interface ActionIdentity {
  contractVersion: typeof RATIONALE_CONTROL_CONTRACT_VERSION;
  anchorId: string;
  actionDigest: string;
  invocationTrustOrigin: ToolTrustOrigin;
  rationaleProvenance: RationaleEligibilityProvenance;
  toolName: string;
  toolVersion: string;
  source: ToolSource;
  category: ToolCategory;
  pluginId?: string;
  mcpServerId?: string;
  workerId?: string;
  finalInputDigest: string;
  approvalCacheKey?: string;
  canonicalTargets: readonly string[];
  requestedEffects: readonly string[];
  affectedResources: readonly string[];
  requiredAuthority: string;
  policyEpoch: string;
  registryGeneration: string;
  sandboxGeneration: string;
  sandboxExecutionPlan: DeepReadonly<Record<string, unknown>>;
}

export interface TriggeringBatchDisposition {
  contractVersion: typeof RATIONALE_CONTROL_CONTRACT_VERSION;
  kind: "triggering-provider-batch-disposition";
  batchId: string;
  originalToolUseIds: readonly string[];
  triggeringToolUseId: string;
  completedToolUseIds: readonly string[];
  cancelledUnexecutedToolUseIds: readonly string[];
  unexecutedSiblingPolicy: "cancel-all";
  followupRationaleBatchPolicy: "separate-rationale-only-batch";
  batchDigest: string;
}

export function createTriggeringBatchDisposition(input: {
  batchId: string;
  originalToolUseIds: readonly string[];
  triggeringToolUseId: string;
  completedToolUseIds: readonly string[];
}): TriggeringBatchDisposition {
  assertBoundedText(input.batchId, "batchId", 256);
  assertValidToolUseId(input.triggeringToolUseId, "triggering tool use ID");
  const originalToolUseIds = cloneBoundedStringList(
    input.originalToolUseIds, "originalToolUseIds", 64, 256,
  );
  const completedToolUseIds = cloneBoundedStringList(
    input.completedToolUseIds, "completedToolUseIds", 63, 256, true,
  );
  for (const toolUseId of originalToolUseIds) {
    assertValidToolUseId(toolUseId, "original tool use ID");
  }
  for (const toolUseId of completedToolUseIds) {
    assertValidToolUseId(toolUseId, "completed tool use ID");
  }
  const originalSet = new Set(originalToolUseIds);
  const completedSet = new Set(completedToolUseIds);
  if (originalSet.size !== originalToolUseIds.length ||
      completedSet.size !== completedToolUseIds.length ||
      !originalSet.has(input.triggeringToolUseId) ||
      completedSet.has(input.triggeringToolUseId) ||
      completedToolUseIds.some((id) => !originalSet.has(id)) ||
      canonicalStringify(originalToolUseIds.filter((id) => completedSet.has(id))) !==
        canonicalStringify(completedToolUseIds)) {
    throw new TypeError("triggering batch partition is invalid");
  }
  const cancelledUnexecutedToolUseIds = originalToolUseIds.filter(
    (id) => id !== input.triggeringToolUseId && !completedSet.has(id),
  );
  const snapshot = {
    contractVersion: RATIONALE_CONTROL_CONTRACT_VERSION,
    kind: "triggering-provider-batch-disposition" as const,
    batchId: input.batchId,
    originalToolUseIds,
    triggeringToolUseId: input.triggeringToolUseId,
    completedToolUseIds,
    cancelledUnexecutedToolUseIds,
    unexecutedSiblingPolicy: "cancel-all" as const,
    followupRationaleBatchPolicy: "separate-rationale-only-batch" as const,
  };
  return deepFreeze({ ...snapshot, batchDigest: digest(snapshot) });
}

export function validateTriggeringBatchDisposition(
  value: TriggeringBatchDisposition,
): boolean {
  try {
    assertCanonicalJson(value, "TriggeringBatchDisposition");
    assertExactOwnKeys(value, ["contractVersion", "kind", "batchId",
      "originalToolUseIds", "triggeringToolUseId", "completedToolUseIds",
      "cancelledUnexecutedToolUseIds", "unexecutedSiblingPolicy",
      "followupRationaleBatchPolicy", "batchDigest"], "TriggeringBatchDisposition");
    assertBoundedText(value.batchId, "batchId", 256);
    assertValidToolUseId(value.triggeringToolUseId, "triggering tool use ID");
    const expected = createTriggeringBatchDisposition({
      batchId: value.batchId,
      originalToolUseIds: value.originalToolUseIds,
      triggeringToolUseId: value.triggeringToolUseId,
      completedToolUseIds: value.completedToolUseIds,
    });
    return canonicalStringify(expected) === canonicalStringify(value) &&
      /^[0-9a-f]{64}$/.test(value.batchDigest);
  } catch {
    return false;
  }
}

// Reservations must come from trusted atomic CAS; shape validation cannot prove authenticity.
// Host-assigned ticketId and nonce keep identical retries on the same control identity.
export interface HostAnchorRoundReservationReceipt {
  contractVersion: typeof RATIONALE_CONTROL_CONTRACT_VERSION;
  kind: "host-anchor-round-cas-reservation";
  reservationId: string;
  anchorId: string;
  anchorDigest: string;
  actionDigest: string;
  batchDigest: string;
  round: 1;
  expectedAnchorVersion: 0;
  committedAnchorVersion: 1;
  ticketId: string;
  nonce: string;
  reservedAt: number;
}

export interface HostAnchorRoundCas {
  tryReserve(input: {
    anchor: RequestAnchor;
    action: ActionIdentity;
    triggeringBatchDisposition: TriggeringBatchDisposition;
    round: 1;
    now?: number;
  }): HostAnchorRoundReservationReceipt | null;
  isCurrentReservation(receipt: HostAnchorRoundReservationReceipt): boolean;
}

function validateHostAnchorRoundReservationReceipt(
  receipt: HostAnchorRoundReservationReceipt,
  anchor: RequestAnchor,
  action: ActionIdentity,
  batch: TriggeringBatchDisposition,
  now = Date.now(),
  humanWait = false,
): boolean {
  try {
    assertCanonicalJson(receipt, "HostAnchorRoundReservationReceipt");
    assertExactOwnKeys(receipt, ["contractVersion", "kind", "reservationId",
      "anchorId", "anchorDigest", "actionDigest", "batchDigest", "round",
      "expectedAnchorVersion", "committedAnchorVersion", "ticketId", "nonce",
      "reservedAt"], "HostAnchorRoundReservationReceipt");
    if (!isValidRequestAnchor(anchor, now, humanWait) || !verifyActionIdentity(action) ||
        !validateTriggeringBatchDisposition(batch) || action.anchorId !== anchor.anchorId) {
      return false;
    }
    return receipt.contractVersion === RATIONALE_CONTROL_CONTRACT_VERSION &&
      receipt.kind === "host-anchor-round-cas-reservation" &&
      UUID_PATTERN.test(receipt.reservationId) && UUID_PATTERN.test(receipt.ticketId) &&
      UUID_PATTERN.test(receipt.nonce) && receipt.anchorId === anchor.anchorId &&
      receipt.anchorDigest === digest(anchor) &&
      receipt.actionDigest === action.actionDigest &&
      receipt.batchDigest === batch.batchDigest && receipt.round === 1 &&
      receipt.expectedAnchorVersion === 0 && receipt.committedAnchorVersion === 1 &&
      Number.isFinite(receipt.reservedAt) && receipt.reservedAt >= anchor.createdAt &&
      receipt.reservedAt < anchor.expiresAt && receipt.reservedAt <= now;
  } catch {
    return false;
  }
}

export class InMemoryHostAnchorRoundCasStore implements HostAnchorRoundCas {
  readonly #reservations = new Map<string, HostAnchorRoundReservationReceipt>();
  readonly #receiptsById = new Map<string, HostAnchorRoundReservationReceipt>();
  readonly #reservationSessions = new Map<string, string>();
  readonly #reservationExpiries = new Map<string, number>();

  tryReserve(input: {
    anchor: RequestAnchor;
    action: ActionIdentity;
    triggeringBatchDisposition: TriggeringBatchDisposition;
    round: 1;
    now?: number;
  }): HostAnchorRoundReservationReceipt | null {
    const now = input.now ?? Date.now();
    if (!Number.isFinite(now) || input.round !== 1 ||
        !isValidRequestAnchor(input.anchor, now) ||
        !verifyActionIdentity(input.action) ||
        !validateTriggeringBatchDisposition(input.triggeringBatchDisposition) ||
        input.action.anchorId !== input.anchor.anchorId) {
      throw new TypeError("invalid anchor-round CAS reservation input");
    }
    this.#pruneExpired(now);
    const requestKey = digest([input.anchor.anchorId, input.triggeringBatchDisposition.triggeringToolUseId]);
    const current = this.#reservations.get(requestKey);
    if (current) {
      return current.anchorDigest === digest(input.anchor) &&
        current.actionDigest === input.action.actionDigest &&
        current.batchDigest === input.triggeringBatchDisposition.batchDigest
        ? current : null;
    }
    const receipt = deepFreeze({
      contractVersion: RATIONALE_CONTROL_CONTRACT_VERSION,
      kind: "host-anchor-round-cas-reservation" as const,
      reservationId: randomUUID(), anchorId: input.anchor.anchorId,
      anchorDigest: digest(input.anchor), actionDigest: input.action.actionDigest,
      batchDigest: input.triggeringBatchDisposition.batchDigest, round: 1 as const,
      expectedAnchorVersion: 0 as const, committedAnchorVersion: 1 as const,
      ticketId: randomUUID(), nonce: randomUUID(), reservedAt: now,
    });
    this.#reservations.set(requestKey, receipt);
    this.#receiptsById.set(receipt.reservationId, receipt);
    this.#reservationSessions.set(requestKey, input.anchor.sessionId);
    this.#reservationExpiries.set(requestKey, input.anchor.expiresAt);
    return receipt;
  }

  isCurrentReservation(receipt: HostAnchorRoundReservationReceipt): boolean {
    try {
      assertCanonicalJson(receipt, "HostAnchorRoundReservationReceipt");
      assertExactOwnKeys(receipt, ["contractVersion", "kind", "reservationId",
        "anchorId", "anchorDigest", "actionDigest", "batchDigest", "round",
        "expectedAnchorVersion", "committedAnchorVersion", "ticketId", "nonce",
        "reservedAt"], "HostAnchorRoundReservationReceipt");
      const current = this.#receiptsById.get(receipt.reservationId);
      return current !== undefined &&
        canonicalStringify(current) === canonicalStringify(receipt);
    } catch {
      return false;
    }
  }

  closeSession(sessionId: string): number {
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new TypeError("invalid anchor-round CAS session id");
    }
    let removed = 0;
    for (const [anchorId, currentSessionId] of this.#reservationSessions) {
      if (currentSessionId !== sessionId) continue;
      this.#deleteReservation(anchorId);
      removed += 1;
    }
    return removed;
  }

  clear(): void {
    this.#reservations.clear();
    this.#receiptsById.clear();
    this.#reservationSessions.clear();
    this.#reservationExpiries.clear();
  }

  #pruneExpired(now: number): void {
    for (const [anchorId, expiresAt] of this.#reservationExpiries) {
      if (expiresAt <= now) this.#deleteReservation(anchorId);
    }
  }

  #deleteReservation(anchorId: string): void {
    const receipt = this.#reservations.get(anchorId);
    if (receipt) this.#receiptsById.delete(receipt.reservationId);
    this.#reservations.delete(anchorId);
    this.#reservationSessions.delete(anchorId);
    this.#reservationExpiries.delete(anchorId);
  }
}

// Reusable action identity excludes toolUseId; invocationDigest binds it and execution still requires host-consumed CAS.
export interface SealedRationaleAction {
  toolUseId: string;
  toolName: string;
  originalInput: DeepReadonly<Record<string, unknown>>;
  finalInput: DeepReadonly<Record<string, unknown>>;
}

export interface RationaleRequiredControl {
  kind: "rationale-required";
  contractVersion: typeof RATIONALE_CONTROL_CONTRACT_VERSION;
  state: "rationale_requested";
  ticketId: string;
  nonce: string;
  invocationDigest: string;
  round: 1;
  anchor: RequestAnchor;
  action: ActionIdentity;
  triggeringBatchDisposition: TriggeringBatchDisposition;
  anchorRoundReservation: HostAnchorRoundReservationReceipt;
  sealedAction: SealedRationaleAction;
  eligibilityContext: HostRationaleEligibilityContext;
  reviewerOutcome: Extract<ReviewerDispatchOutcome, "fresh" | "cache">;
  initialVerdict: RiskVerdict;
  reasonCode: "foreground-reviewer-threshold";
}
export interface RationaleHumanApprovalWaitLease { readonly kind: "human-approval-wait" }
interface HumanApprovalWaitState {
  readonly lease: RationaleHumanApprovalWaitLease;
  readonly controlDigest: string;
  readonly sessionId: string;
  readonly startedAt: number;
  phase: "pending" | "approved" | "consumed";
}
const humanApprovalWaits = new Map<string, HumanApprovalWaitState>();

function humanApprovalWaitFor(control: RationaleRequiredControl, now: number): HumanApprovalWaitState | undefined {
  try {
    assertCanonicalJson(control, "RationaleRequiredControl");
    const wait = humanApprovalWaits.get(control.ticketId);
    return wait && Number.isFinite(now) && now >= wait.startedAt &&
      wait.sessionId === control.anchor.sessionId && wait.controlDigest === digest(control) ? wait : undefined;
  } catch {
    return undefined;
  }
}

export function beginRationaleHumanApprovalWait(control: RationaleRequiredControl, now = Date.now()): RationaleHumanApprovalWaitLease {
  if (!verifyRationaleRequiredControl(control, { now }) || humanApprovalWaits.has(control.ticketId)) {
    throw new Error("Human approval wait requires a fresh unpublished request");
  }
  const lease: RationaleHumanApprovalWaitLease = Object.freeze({ kind: "human-approval-wait" });
  humanApprovalWaits.set(control.ticketId, { lease, controlDigest: digest(control), sessionId: control.anchor.sessionId, startedAt: now, phase: "pending" });
  return lease;
}

export function approveRationaleHumanWait(control: RationaleRequiredControl, lease: RationaleHumanApprovalWaitLease, now = Date.now()): void {
  const wait = humanApprovalWaitFor(control, now);
  if (!wait || wait.lease !== lease || wait.phase !== "pending") throw new Error("Human approval wait is not current");
  wait.phase = "approved";
}

export function consumeRationaleHumanWait(control: RationaleRequiredControl, lease: RationaleHumanApprovalWaitLease, now = Date.now()): void {
  const wait = humanApprovalWaitFor(control, now);
  if (!wait || wait.lease !== lease || wait.phase !== "approved") throw new Error("Human approval wait was not approved");
  wait.phase = "consumed";
}

export function retireRationaleHumanWait(control: RationaleRequiredControl, lease: RationaleHumanApprovalWaitLease): void {
  if (humanApprovalWaits.get(control.ticketId)?.lease === lease) humanApprovalWaits.delete(control.ticketId);
}

export function retireRationaleHumanWaitsForSession(sessionId: string): void {
  for (const [ticketId, wait] of humanApprovalWaits) {
    if (wait.sessionId === sessionId) humanApprovalWaits.delete(ticketId);
  }
}

export function isRationaleHumanApprovalActive(control: RationaleRequiredControl, now = Date.now()): boolean {
  return humanApprovalWaitFor(control, now)?.phase === "approved";
}

export function verifyRationaleTicketControl(control: RationaleRequiredControl, options: { now?: number; currentEligibilityContext?: HostRationaleEligibilityContext } = {}): boolean {
  return verifyRationaleControl(control, options, humanApprovalWaitFor(control, options.now ?? Date.now()));
}

export function verifyRationaleExecutionControl(control: RationaleRequiredControl, options: { now?: number; currentEligibilityContext?: HostRationaleEligibilityContext } = {}): boolean {
  const wait = humanApprovalWaitFor(control, options.now ?? Date.now());
  if (wait && wait.phase !== "approved") return false;
  return verifyRationaleControl(control, options, wait);
}

export interface RationaleProviderEnvelope {
  contractVersion: typeof RATIONALE_CONTROL_CONTRACT_VERSION;
  anchorId: string;
  ticketId: string;
  actionDigest: string;
  round: 1;
  sanitizedIntent: string;
  toolName: string;
  source: ToolSource;
  category: ToolCategory;
  canonicalTargets: readonly string[];
  requestedEffects: readonly string[];
  affectedResources: readonly string[];
  requiredAuthority: string;
  reviewerOutcome: "fresh" | "cache";
  initialVerdict: RiskVerdict;
}


export type RationaleResponse = {
  contractVersion: typeof RATIONALE_CONTROL_CONTRACT_VERSION;
  anchorId: string;
  ticketId: string;
  actionDigest: string;
  round: 1;
} & (
  | { choice: "accept" | "ask_user" }
  | { choice: "resubmit"; rationale: string; userQuote: string }
);

export const RATIONALE_RESPONSE_SCHEMA: ToolSchema = {
  name: RATIONALE_RESPONSE_TOOL,
  description: "Choose accept, resubmit once with a verbatim user quote, or ask_user for the sealed denied action. This grants no permission.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      contractVersion: { type: "integer", const: RATIONALE_CONTROL_CONTRACT_VERSION },
      anchorId: { type: "string" }, ticketId: { type: "string" }, actionDigest: { type: "string" },
      round: { type: "integer", const: 1 },
      choice: { type: "string", enum: ["accept", "resubmit", "ask_user"] },
      rationale: { type: "string", minLength: 1, maxLength: 500 },
      userQuote: { type: "string", minLength: 1, maxLength: 2000 },
    },
    required: ["contractVersion", "anchorId", "ticketId", "actionDigest", "round", "choice"],
  },
};

function digest(value: unknown): string {
  return sha256Hex(canonicalStringify(value));
}

export function createCancelledSiblingProposalGuard(input: {
  readonly anchorId: string;
  readonly toolName: string;
  readonly originalInput: Readonly<Record<string, unknown>>;
}): CancelledSiblingProposalGuard {
  assertBoundedText(input.anchorId, "anchorId", 256);
  assertBoundedText(input.toolName, "toolName", 256);
  if (
    input.originalInput === null ||
    typeof input.originalInput !== "object" ||
    Array.isArray(input.originalInput)
  ) {
    throw new TypeError("cancelled sibling input must be a plain record");
  }
  const originalInput = cloneCanonicalJson(
    input.originalInput,
    "cancelledSibling.originalInput",
    CANCELLED_SIBLING_GUARD_LIMITS,
  );
  return deepFreeze({
    contractVersion: RATIONALE_CONTROL_CONTRACT_VERSION,
    anchorId: input.anchorId,
    proposalDigest: digest({
      anchorId: input.anchorId,
      toolName: input.toolName,
      originalInput,
    }),
  }) as CancelledSiblingProposalGuard;
}

export function sanitizeDisplayText(value: string, maxLength: number): string {
  const withoutMarkup = value
    .replace(/<[^>]*>/g, " ")
    .trim();
  // Apply renderer Unicode policy again after masking so display cannot regain invisible controls.
  const masked = maskSensitiveData(
    normalizeRationaleApprovalDisplayText(withoutMarkup),
  ).masked;
  return normalizeRationaleApprovalDisplayText(masked).slice(0, maxLength);
}

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value as DeepReadonly<T>;
}


interface CanonicalJsonLimits {
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxBytes: number;
}

const MAX_CANONICAL_DEPTH = 12;
const MAX_CANONICAL_NODES = 1_024;
const MAX_CANONICAL_BYTES = 64 * 1_024;
const DEFAULT_CANONICAL_JSON_LIMITS: CanonicalJsonLimits = Object.freeze({
  maxDepth: MAX_CANONICAL_DEPTH,
  maxNodes: MAX_CANONICAL_NODES,
  maxBytes: MAX_CANONICAL_BYTES,
});
const CANCELLED_SIBLING_GUARD_LIMITS: CanonicalJsonLimits = Object.freeze({
  maxDepth: 32, maxNodes: 16_384, maxBytes: 1024 * 1024,
});

function assertCanonicalJson(
  value: unknown,
  label: string,
  limits: CanonicalJsonLimits = DEFAULT_CANONICAL_JSON_LIMITS,
): void {
  const seen = new WeakSet<object>();
  let nodes = 0;

  const visit = (current: unknown, depth: number, path: string): void => {
    nodes += 1;
    if (nodes > limits.maxNodes) {
      throw new TypeError(label + " exceeds canonical JSON node limit");
    }
    if (depth > limits.maxDepth) {
      throw new TypeError(label + " exceeds canonical JSON depth limit");
    }
    if (
      current === null ||
      typeof current === "string" ||
      typeof current === "boolean"
    ) {
      return;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current) || Object.is(current, -0)) {
        throw new TypeError(path + " must be a finite canonical JSON number");
      }
      return;
    }
    if (typeof current !== "object") {
      throw new TypeError(path + " is not canonical JSON");
    }
    if (seen.has(current)) {
      throw new TypeError(path + " contains a cycle or shared object reference");
    }
    seen.add(current);

    if (Array.isArray(current)) {
      const descriptors = Object.getOwnPropertyDescriptors(current) as Record<
        string, PropertyDescriptor
      >;
      const lengthDescriptor = descriptors.length;
      if (
        !lengthDescriptor ||
        !("value" in lengthDescriptor) ||
        typeof lengthDescriptor.value !== "number" ||
        !Number.isSafeInteger(lengthDescriptor.value) ||
        (lengthDescriptor.value as number) < 0
      ) {
        throw new TypeError(path + " has an invalid array length descriptor");
      }
      const length = lengthDescriptor.value as number;
      const expectedKeys = new Set<string>(["length"]);
      for (let index = 0; index < length; index += 1) {
        expectedKeys.add(String(index));
      }
      const ownKeys = Reflect.ownKeys(current);
      if (
        ownKeys.some((key) => typeof key === "symbol") ||
        ownKeys.some((key) => typeof key === "string" && !expectedKeys.has(key)) ||
        ownKeys.length !== expectedKeys.size
      ) {
        throw new TypeError(path + " must be a dense JSON array without extra properties");
      }
      if (Object.getPrototypeOf(current) !== Array.prototype) {
        throw new TypeError(path + " must use the intrinsic Array prototype");
      }
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor?.enumerable || !("value" in descriptor)) {
          throw new TypeError(path + "[" + index + "] must be an enumerable data property");
        }
        visit(descriptor.value, depth + 1, path + "[" + index + "]");
      }
      return;
    }

    const prototype = Object.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(path + " must use a plain object prototype");
    }
    if (Reflect.ownKeys(current).some((key) => typeof key === "symbol")) {
      throw new TypeError(path + " must not contain symbol keys");
    }
    const descriptors = Object.getOwnPropertyDescriptors(current);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!descriptor.enumerable || !("value" in descriptor)) {
        throw new TypeError(path + "." + key + " must be an enumerable data property");
      }
      visit(descriptor.value, depth + 1, path + "." + key);
    }
  };

  visit(value, 0, label);
  if (Buffer.byteLength(canonicalStringify(value), "utf8") > limits.maxBytes) {
    throw new TypeError(label + " exceeds canonical JSON byte limit");
  }
}

function cloneCanonicalJson<T>(
  value: T,
  label: string,
  limits = DEFAULT_CANONICAL_JSON_LIMITS,
): DeepReadonly<T> {
  assertCanonicalJson(value, label, limits);
  const cloned = structuredClone(value);
  assertCanonicalJson(cloned, label, limits);
  return deepFreeze(cloned);
}

function cloneBoundedStringList(
  value: readonly string[],
  label: string,
  maxItems: number,
  maxLength: number,
  allowEmpty = false,
): readonly string[] {
  if (!Array.isArray(value)) {
    throw new TypeError(label + " exceeds its bounded string-list contract");
  }
  // Validate descriptors and prototypes before inherited iterators can trigger attacker-controlled accessors.
  assertCanonicalJson(value, label);
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>;
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor || !("value" in lengthDescriptor)) {
    throw new TypeError(label + " has an invalid length descriptor");
  }
  const length = lengthDescriptor.value as number;
  if (length < (allowEmpty ? 0 : 1) || length > maxItems) {
    throw new TypeError(label + " exceeds its bounded string-list contract");
  }
  const values: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    const item = descriptor && "value" in descriptor ? descriptor.value : undefined;
    if (typeof item !== "string" || item.trim().length === 0 || item.length > maxLength) {
      throw new TypeError(label + " exceeds its bounded string-list contract");
    }
    values.push(item);
  }
  if (values.includes(RATIONALE_UNKNOWN_SCOPE_SENTINEL) &&
      !(values.length === 1 && values[0] === RATIONALE_UNKNOWN_SCOPE_SENTINEL)) {
    throw new TypeError(label + " unknown sentinel must be the sole value");
  }
  return cloneCanonicalJson(value, label) as readonly string[];
}

function assertBoundedText(value: string, label: string, maxLength: number): void {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
    throw new TypeError(label + " exceeds its bounded text contract");
  }
}



function normalizeAndSealRiskVerdict(
  value: RiskVerdict,
  label: string,
): RiskVerdict {
  assertCanonicalJson(value, label);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(label + " must be a RiskVerdict object");
  }
  assertExactOwnKeys(value, ["level", "reason"], label);
  if (
    !["low", "medium", "high"].includes(value.level) ||
    typeof value.reason !== "string"
  ) {
    throw new TypeError(label + " has an invalid RiskVerdict value");
  }
  const reason = value.reason
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .trim();
  if (!reason || reason.length > 1_000) {
    throw new TypeError(label + ".reason exceeds its bounded text contract");
  }
  return deepFreeze({ level: value.level, reason }) as RiskVerdict;
}

const TOOL_TRUST_ORIGINS: readonly string[] = [
  "user-keyboard", "plugin-emitted", "app-emitted", "mcp-prompt-emitted", "plugin-prompt-emitted",
  "llm-tool-arg", "agent-message", "file-content", "queue-auto", "surface-user", "tailnet-surface", "platform-bridge",
];
const RATIONALE_TAINTS: readonly string[] = [
  "none", "file-content", "app-emitted", "plugin-emitted",
  "mcp-prompt-emitted", "plugin-prompt-emitted", "agent-message", "queue-auto", "surface-user", "tailnet-surface", "platform-bridge",
];

export function assertExactOwnKeys(value: object, expected: readonly string[], label: string): void {
  if (!hasExactKeys(value, expected)) {
    throw new TypeError(label + " contains unexpected or missing fields");
  }
}

export function assertRationaleCanonicalJson(value: unknown, label: string): void {
  assertCanonicalJson(value, label);
}

export function cloneRationaleCanonicalJson<T>(
  value: T,
  label: string,
): DeepReadonly<T> {
  return cloneCanonicalJson(value, label);
}

export function sealRationaleCanonicalJson<T>(value: T, label: string): T {
  return cloneCanonicalJson(value, label) as T;
}

export function normalizeRationaleRiskVerdict(
  value: RiskVerdict,
  label: string,
): RiskVerdict {
  return normalizeAndSealRiskVerdict(value, label);
}

function assertRationaleProvenance(value: RationaleEligibilityProvenance): void {
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.startedFromUserKeyboard !== "boolean" ||
    !RATIONALE_TAINTS.includes(value.taint)
  ) {
    throw new TypeError("invalid rationale provenance");
  }
  assertExactOwnKeys(value, ["startedFromUserKeyboard", "taint"], "rationaleProvenance");
}




function isValidRationaleProvenance(
  value: RationaleEligibilityProvenance,
): boolean {
  try {
    assertRationaleProvenance(value);
    return true;
  } catch {
    return false;
  }
}


function assertHostEligibilityContext(
  value: HostRationaleEligibilityContext,
): void {
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.headless !== "boolean" ||
    typeof value.forceModal !== "boolean" ||
    !(
      value.approvalReasonPrefix === null ||
      (
        typeof value.approvalReasonPrefix === "string" &&
        value.approvalReasonPrefix.trim().length > 0 &&
        value.approvalReasonPrefix.length <= 160
      )
    )
  ) {
    throw new TypeError("invalid host rationale eligibility context");
  }
  assertExactOwnKeys(
    value,
    ["headless", "forceModal", "approvalReasonPrefix"],
    "HostRationaleEligibilityContext",
  );
}


function computeRationaleInvocationDigest(input: {
  ticketId: string;
  nonce: string;
  anchor: RequestAnchor;
  // SHA-256 proves consistency, not authenticity; compare against immutable host-CAS digests, never caller-supplied digests.
  actionDigest: string;
  triggeringBatchDisposition: TriggeringBatchDisposition;
  anchorRoundReservation: HostAnchorRoundReservationReceipt;
  sealedAction: SealedRationaleAction;
  eligibilityContext: HostRationaleEligibilityContext;
  reviewerOutcome: "fresh" | "cache";
  initialVerdict: RiskVerdict;
}): string {
  return digest({
    ticketId: input.ticketId,
    nonce: input.nonce,
    anchor: input.anchor,
    actionDigest: input.actionDigest,
    triggeringBatchDisposition: input.triggeringBatchDisposition,
    anchorRoundReservation: input.anchorRoundReservation,
    sealedAction: input.sealedAction,
    eligibilityContext: input.eligibilityContext,
    reviewerOutcome: input.reviewerOutcome,
    initialVerdict: input.initialVerdict,
  });
}

export function isRationaleEligibilityContextCurrent(
  control: RationaleRequiredControl,
  current: HostRationaleEligibilityContext,
  now = Date.now(),
): boolean {
  return verifyRationaleRequiredControl(control, {
    now,
    currentEligibilityContext: current,
  });
}

function assertSourceIdentity(
  source: ToolSource,
  pluginId: string | undefined,
  mcpServerId: string | undefined,
  workerId: string | undefined,
): void {
  if (source === "builtin") {
    if (pluginId !== undefined || mcpServerId !== undefined || workerId !== undefined) {
      throw new TypeError("builtin action must not carry plugin/MCP worker identity");
    }
    return;
  }
  if (source === "plugin") {
    if (pluginId === undefined || mcpServerId !== undefined) {
      throw new TypeError("plugin action requires pluginId and forbids mcpServerId");
    }
    return;
  }
  if (source === "mcp") {
    if (mcpServerId === undefined || pluginId !== undefined || workerId !== undefined) {
      throw new TypeError("MCP action requires mcpServerId and forbids plugin worker identity");
    }
    return;
  }
  throw new TypeError("invalid action source");
}

export function createRequestAnchor(input: {
  sessionId: string;
  turnId: string;
  inputMessageId: string;
  inputOrigin: ChatInputOrigin;
  rawIntent: string;
  now?: number;
  ttlMs?: number;
}): RequestAnchor | null {
  if (input.inputOrigin !== "user-keyboard") return null;
  if (![input.sessionId, input.turnId, input.inputMessageId].every(
    (value) => value.trim().length > 0 && value.length <= 256,
  )) {
    return null;
  }
  const sanitizedIntent = sanitizeDisplayText(input.rawIntent, 500);
  if (!sanitizedIntent || sanitizedIntent.startsWith("/")) return null;
  const now = input.now ?? Date.now();
  const ttlMs = input.ttlMs ?? 10 * 60 * 1000;
  if (!Number.isFinite(now) || !Number.isFinite(ttlMs) || ttlMs <= 0) return null;
  const normalizedIntent = input.rawIntent.normalize("NFC").replace(/\r\n?/g, "\n");
  return deepFreeze({
    contractVersion: RATIONALE_CONTROL_CONTRACT_VERSION,
    anchorId: randomUUID(),
    sessionId: input.sessionId,
    turnId: input.turnId,
    inputMessageId: input.inputMessageId,
    inputOrigin: "user-keyboard",
    sanitizedIntent,
    intentDigest: digest({ inputOrigin: input.inputOrigin, normalizedIntent }),
    createdAt: now,
    expiresAt: now + ttlMs,
    rationaleRoundBudget: 1,
  }) as RequestAnchor;
}


function isValidRequestAnchor(anchor: RequestAnchor, now: number, humanWait = false): boolean {
  try {
    assertCanonicalJson(anchor, "RequestAnchor");
    assertExactOwnKeys(anchor, [
      "contractVersion", "anchorId", "sessionId", "turnId", "inputMessageId",
      "inputOrigin", "sanitizedIntent", "intentDigest", "createdAt", "expiresAt", "rationaleRoundBudget",
    ], "RequestAnchor");
    for (const [label, value, maxLength] of [
      ["anchorId", anchor.anchorId, 256], ["sessionId", anchor.sessionId, 256],
      ["turnId", anchor.turnId, 256], ["inputMessageId", anchor.inputMessageId, 256],
      ["sanitizedIntent", anchor.sanitizedIntent, 500],
    ] as const) {
      assertBoundedText(value, label, maxLength);
    }
    return (
      anchor.contractVersion === RATIONALE_CONTROL_CONTRACT_VERSION &&
      anchor.inputOrigin === "user-keyboard" &&
      !anchor.sanitizedIntent.startsWith("/") &&
      /^[0-9a-f-]{36}$/i.test(anchor.anchorId) &&
      /^[0-9a-f]{64}$/.test(anchor.intentDigest) &&
      Number.isFinite(now) && Number.isFinite(anchor.createdAt) &&
      anchor.rationaleRoundBudget === 1 &&
      Number.isFinite(anchor.expiresAt) && anchor.expiresAt > anchor.createdAt &&
      anchor.createdAt <= now && (anchor.expiresAt > now || humanWait)
    );
  } catch {
    return false;
  }
}


function assertActionIdentitySemantics(action: ActionIdentity): void {
  if (action.contractVersion !== RATIONALE_CONTROL_CONTRACT_VERSION) {
    throw new TypeError("invalid ActionIdentity contract version");
  }
  for (const [label, value, maxLength] of [
    ["anchorId", action.anchorId, 256],
    ["toolName", action.toolName, 256], ["toolVersion", action.toolVersion, 128],
    ["requiredAuthority", action.requiredAuthority, 160], ["policyEpoch", action.policyEpoch, 256],
    ["registryGeneration", action.registryGeneration, 256],
    ["sandboxGeneration", action.sandboxGeneration, 256],
  ] as const) {
    assertBoundedText(value, label, maxLength);
  }
  for (const [label, value] of [
    ["pluginId", action.pluginId], ["mcpServerId", action.mcpServerId],
    ["workerId", action.workerId], ["approvalCacheKey", action.approvalCacheKey],
  ] as const) {
    if (value !== undefined) assertBoundedText(value, label, 512);
  }
  if (
    !TOOL_TRUST_ORIGINS.includes(action.invocationTrustOrigin) ||
    !["read", "write", "shell", "network", "meta"].includes(action.category)
  ) {
    throw new TypeError("invalid action trust origin or category");
  }
  assertRationaleProvenance(action.rationaleProvenance);
  assertSourceIdentity(action.source, action.pluginId, action.mcpServerId, action.workerId);
  cloneBoundedStringList(action.canonicalTargets, "canonicalTargets", 32, 1_024);
  cloneBoundedStringList(action.requestedEffects, "requestedEffects", 8, 160);
  cloneBoundedStringList(action.affectedResources, "affectedResources", 8, 160);
  assertCanonicalJson(action.sandboxExecutionPlan, "sandboxExecutionPlan");
  if (
    !/^[0-9a-f]{64}$/.test(action.finalInputDigest) ||
    !/^[0-9a-f]{64}$/.test(action.actionDigest)
  ) {
    throw new TypeError("invalid ActionIdentity digest");
  }

  const expectedKeys = [
    "contractVersion", "anchorId", "actionDigest",
    "invocationTrustOrigin", "rationaleProvenance", "toolName", "toolVersion",
    "source", "category", "finalInputDigest", "canonicalTargets",
    "requestedEffects", "affectedResources", "requiredAuthority", "policyEpoch",
    "registryGeneration", "sandboxGeneration", "sandboxExecutionPlan",
  ];
  if (action.pluginId !== undefined) expectedKeys.push("pluginId");
  if (action.mcpServerId !== undefined) expectedKeys.push("mcpServerId");
  if (action.workerId !== undefined) expectedKeys.push("workerId");
  if (action.approvalCacheKey !== undefined) expectedKeys.push("approvalCacheKey");
  assertExactOwnKeys(action, expectedKeys, "ActionIdentity");
}

export function createActionIdentity(input: Omit<ActionIdentity, "contractVersion" | "actionDigest" | "finalInputDigest"> & {
  finalInput: Record<string, unknown>;
}): ActionIdentity {
  for (const [label, value, maxLength] of [
    ["anchorId", input.anchorId, 256],
    ["toolName", input.toolName, 256],
    ["toolVersion", input.toolVersion, 128],
    ["requiredAuthority", input.requiredAuthority, 160],
    ["policyEpoch", input.policyEpoch, 256],
    ["registryGeneration", input.registryGeneration, 256],
    ["sandboxGeneration", input.sandboxGeneration, 256],
  ] as const) {
    assertBoundedText(value, label, maxLength);
  }
  for (const [label, value] of [
    ["pluginId", input.pluginId],
    ["mcpServerId", input.mcpServerId],
    ["workerId", input.workerId],
    ["approvalCacheKey", input.approvalCacheKey],
  ] as const) {
    if (value !== undefined) assertBoundedText(value, label, 512);
  }
  assertRationaleProvenance(input.rationaleProvenance);
  if (
    !TOOL_TRUST_ORIGINS.includes(input.invocationTrustOrigin) ||
    !["read", "write", "shell", "network", "meta"].includes(input.category)
  ) {
    throw new TypeError("invalid action trust origin or category");
  }
  assertSourceIdentity(input.source, input.pluginId, input.mcpServerId, input.workerId);

  const sealedFinalInput = cloneCanonicalJson(input.finalInput, "finalInput");
  const finalInputDigest = digest(sealedFinalInput);
  const snapshot = {
    anchorId: input.anchorId,
    invocationTrustOrigin: input.invocationTrustOrigin,
    rationaleProvenance: cloneCanonicalJson(
      input.rationaleProvenance,
      "rationaleProvenance",
    ),
    toolName: input.toolName,
    toolVersion: input.toolVersion,
    source: input.source,
    category: input.category,
    ...(input.pluginId === undefined ? {} : { pluginId: input.pluginId }),
    ...(input.mcpServerId === undefined ? {} : { mcpServerId: input.mcpServerId }),
    ...(input.workerId === undefined ? {} : { workerId: input.workerId }),
    finalInputDigest,
    ...(input.approvalCacheKey === undefined
      ? {}
      : { approvalCacheKey: input.approvalCacheKey }),
    canonicalTargets: cloneBoundedStringList(
      input.canonicalTargets,
      "canonicalTargets",
      32,
      1_024,
    ),
    requestedEffects: cloneBoundedStringList(
      input.requestedEffects,
      "requestedEffects",
      8,
      160,
    ),
    affectedResources: cloneBoundedStringList(
      input.affectedResources,
      "affectedResources",
      8,
      160,
    ),
    requiredAuthority: input.requiredAuthority,
    policyEpoch: input.policyEpoch,
    registryGeneration: input.registryGeneration,
    sandboxGeneration: input.sandboxGeneration,
    sandboxExecutionPlan: cloneCanonicalJson(
      input.sandboxExecutionPlan,
      "sandboxExecutionPlan",
    ),
  };
  const action = deepFreeze({
    contractVersion: RATIONALE_CONTROL_CONTRACT_VERSION,
    ...snapshot,
    actionDigest: digest(snapshot),
  }) as ActionIdentity;
  assertActionIdentitySemantics(action);
  return action;
}

export function verifyActionIdentity(action: ActionIdentity): boolean {
  try {
    assertCanonicalJson(action, "ActionIdentity");
    assertActionIdentitySemantics(action);
    const { contractVersion, actionDigest, ...snapshot } = action;
    assertCanonicalJson(snapshot, "ActionIdentity");
    return (
      contractVersion === RATIONALE_CONTROL_CONTRACT_VERSION &&
      /^[0-9a-f]{64}$/.test(actionDigest) &&
      digest(snapshot) === actionDigest
    );
  } catch {
    return false;
  }
}

export function isRationaleEligible(input: {
  permission: PermissionCheckResult;
  anchor: RequestAnchor | null | undefined;
  invocationTrustOrigin: ToolTrustOrigin;
  rationaleProvenance: RationaleEligibilityProvenance;
  headless?: boolean;
  humanApprovalControl?: RationaleRequiredControl;
  forceModal?: boolean;
  approvalReasonPrefix?: string;
  now?: number;
}): input is typeof input & {
  anchor: RequestAnchor;
  permission: PermissionCheckResult & {
    reviewer: {
      route: "foreground-auto" | "headless";
      verdict: RiskVerdict;
      outcome: "fresh" | "cache";
    };
  };
} {
  const reviewer = input.permission.reviewer;
  const now = input.now ?? Date.now();
  return (
    input.permission.decision === "ask" &&
    input.permission.reasonCode === "reviewer-human-required" &&
    reviewer?.verdict?.level === "high" &&
    (reviewer?.route === "foreground-auto" || reviewer?.route === "headless") &&
    (reviewer.outcome === "fresh" || reviewer.outcome === "cache") &&
    reviewer.verdict !== undefined &&
    input.forceModal !== true &&
    input.permission.forceModal !== true &&
    !input.approvalReasonPrefix &&
    input.anchor !== null &&
    input.anchor !== undefined &&
    (isValidRequestAnchor(input.anchor, now) || (input.humanApprovalControl !== undefined &&
      isRationaleHumanApprovalActive(input.humanApprovalControl, now) &&
      canonicalStringify(input.anchor) === canonicalStringify(input.humanApprovalControl.anchor))) &&
    isValidRationaleProvenance(input.rationaleProvenance) &&
    input.rationaleProvenance.startedFromUserKeyboard === true &&
    input.rationaleProvenance.taint === "none" &&
    // Only model-authored tool arguments satisfy this keyboard-turn boundary; other content provenance fails.
    input.invocationTrustOrigin === "llm-tool-arg"
  );
}

export function createRationaleRequiredControl(input: {
  anchor: RequestAnchor;
  action: ActionIdentity;
  triggeringBatchDisposition: TriggeringBatchDisposition;
  anchorRoundReservation: HostAnchorRoundReservationReceipt;
  hostAnchorRoundCas: HostAnchorRoundCas;
  sealedAction: SealedRationaleAction;
  eligibilityContext: HostRationaleEligibilityContext;
  permission: PermissionCheckResult & {
    reviewer: {
      route: "foreground-auto" | "headless";
      verdict: RiskVerdict;
      outcome: "fresh" | "cache";
    };
  };
  now?: number;
}): RationaleRequiredControl {
  const now = input.now ?? Date.now();
  assertHostEligibilityContext(input.eligibilityContext);
  assertValidToolUseId(input.sealedAction.toolUseId, "sealed action tool use ID");
  assertBoundedText(input.sealedAction.toolName, "sealedAction.toolName", 256);
  if (
    !isValidRequestAnchor(input.anchor, now) ||
    input.anchor.anchorId !== input.action.anchorId ||
    !verifyActionIdentity(input.action) ||
    !validateTriggeringBatchDisposition(input.triggeringBatchDisposition) ||
    input.triggeringBatchDisposition.triggeringToolUseId !== input.sealedAction.toolUseId ||
    !validateHostAnchorRoundReservationReceipt(
      input.anchorRoundReservation,
      input.anchor,
      input.action,
      input.triggeringBatchDisposition,
      now,
    ) ||
    !input.hostAnchorRoundCas.isCurrentReservation(input.anchorRoundReservation) ||
    input.sealedAction.toolName !== input.action.toolName ||
    !isRationaleEligible({
      permission: input.permission,
      anchor: input.anchor,
      invocationTrustOrigin: input.action.invocationTrustOrigin,
      rationaleProvenance: input.action.rationaleProvenance,
      headless: input.eligibilityContext.headless,
      forceModal: input.eligibilityContext.forceModal,
      approvalReasonPrefix: input.eligibilityContext.approvalReasonPrefix ?? undefined,
      now,
    })
  ) {
    throw new Error("rationale control does not match an eligible sealed action");
  }

  const anchor = cloneCanonicalJson(input.anchor, "RequestAnchor") as RequestAnchor;
  const action = cloneCanonicalJson(input.action, "ActionIdentity") as ActionIdentity;
  const triggeringBatchDisposition = cloneCanonicalJson(
    input.triggeringBatchDisposition,
    "TriggeringBatchDisposition",
  ) as TriggeringBatchDisposition;
  const anchorRoundReservation = cloneCanonicalJson(
    input.anchorRoundReservation,
    "HostAnchorRoundReservationReceipt",
  ) as HostAnchorRoundReservationReceipt;
  const sealedAction = deepFreeze({
    toolUseId: input.sealedAction.toolUseId,
    toolName: input.sealedAction.toolName,
    originalInput: cloneCanonicalJson(
      input.sealedAction.originalInput,
      "sealedAction.originalInput",
    ),
    finalInput: cloneCanonicalJson(
      input.sealedAction.finalInput,
      "sealedAction.finalInput",
    ),
  }) as SealedRationaleAction;
  const eligibilityContext = cloneCanonicalJson(
    input.eligibilityContext,
    "HostRationaleEligibilityContext",
  ) as HostRationaleEligibilityContext;
  assertHostEligibilityContext(eligibilityContext);
  const reviewerOutcome = input.permission.reviewer.outcome;
  const initialVerdict = normalizeAndSealRiskVerdict(
    input.permission.reviewer.verdict,
    "initialVerdict",
  );

  if (
    !verifyActionIdentity(action) ||
    !isValidRequestAnchor(anchor, now) ||
    anchor.anchorId !== action.anchorId ||
    sealedAction.toolName !== action.toolName ||
    digest(sealedAction.finalInput) !== action.finalInputDigest
  ) {
    throw new Error("sealed rationale action does not match ActionIdentity");
  }

  const ticketId = anchorRoundReservation.ticketId;
  const nonce = anchorRoundReservation.nonce;
  const invocationDigest = computeRationaleInvocationDigest({
    ticketId,
    nonce,
    anchor,
    actionDigest: action.actionDigest,
    triggeringBatchDisposition,
    anchorRoundReservation,
    sealedAction,
    eligibilityContext,
    reviewerOutcome,
    initialVerdict,
  });
  return deepFreeze({
    kind: "rationale-required",
    contractVersion: RATIONALE_CONTROL_CONTRACT_VERSION,
    state: "rationale_requested",
    ticketId,
    nonce,
    invocationDigest,
    round: 1,
    anchor,
    action,
    triggeringBatchDisposition,
    anchorRoundReservation,
    sealedAction,
    eligibilityContext,
    reviewerOutcome,
    initialVerdict,
    reasonCode: "foreground-reviewer-threshold",
  }) as RationaleRequiredControl;
}

export function verifyRationaleRequiredControl(control: RationaleRequiredControl, options: { now?: number; currentEligibilityContext?: HostRationaleEligibilityContext } = {}): boolean {
  return verifyRationaleControl(control, options);
}

function verifyRationaleControl(
  control: RationaleRequiredControl,
  options: {
    now?: number;
    currentEligibilityContext?: HostRationaleEligibilityContext;
  } = {},
  humanWait?: HumanApprovalWaitState,
): boolean {
  try {
    const now = options.now ?? Date.now();
    if (!Number.isFinite(now)) return false;
    assertCanonicalJson(control, "RationaleRequiredControl");
    assertExactOwnKeys(control, [
      "kind", "contractVersion", "state", "ticketId", "nonce",
      "invocationDigest", "round", "anchor", "action",
      "triggeringBatchDisposition", "anchorRoundReservation", "sealedAction",
      "eligibilityContext", "reviewerOutcome", "initialVerdict", "reasonCode",
    ], "RationaleRequiredControl");
    if (
      control.kind !== "rationale-required" ||
      control.contractVersion !== RATIONALE_CONTROL_CONTRACT_VERSION ||
      control.state !== "rationale_requested" ||
      control.round !== 1 ||
      control.reasonCode !== "foreground-reviewer-threshold"
    ) {
      return false;
    }
    assertBoundedText(control.ticketId, "ticketId", 256);
    assertBoundedText(control.nonce, "nonce", 256);
    if (
      !UUID_PATTERN.test(
        control.ticketId,
      ) ||
      !UUID_PATTERN.test(
        control.nonce,
      ) ||
      !/^[0-9a-f]{64}$/.test(control.invocationDigest)
    ) {
      return false;
    }
    if (
      !isValidRequestAnchor(control.anchor, now, humanWait !== undefined) ||
      !verifyActionIdentity(control.action) ||
      control.anchor.anchorId !== control.action.anchorId ||
      !validateTriggeringBatchDisposition(control.triggeringBatchDisposition) ||
      control.triggeringBatchDisposition.triggeringToolUseId !==
        control.sealedAction.toolUseId ||
      !validateHostAnchorRoundReservationReceipt(
        control.anchorRoundReservation,
        control.anchor,
        control.action,
        control.triggeringBatchDisposition,
        now,
        humanWait !== undefined,
      ) ||
      control.ticketId !== control.anchorRoundReservation.ticketId ||
      control.nonce !== control.anchorRoundReservation.nonce
    ) {
      return false;
    }

    const sealedAction = control.sealedAction;
    if (
      !sealedAction ||
      typeof sealedAction !== "object" ||
      Array.isArray(sealedAction)
    ) {
      return false;
    }
    assertExactOwnKeys(
      sealedAction,
      ["toolUseId", "toolName", "originalInput", "finalInput"],
      "SealedRationaleAction",
    );
    assertValidToolUseId(sealedAction.toolUseId, "sealed action tool use ID");
    assertBoundedText(sealedAction.toolName, "sealedAction.toolName", 256);
    assertCanonicalJson(sealedAction.originalInput, "sealedAction.originalInput");
    assertCanonicalJson(sealedAction.finalInput, "sealedAction.finalInput");
    if (
      !isRecord(sealedAction.originalInput) ||
      !isRecord(sealedAction.finalInput) ||
      sealedAction.toolName !== control.action.toolName ||
      digest(sealedAction.finalInput) !== control.action.finalInputDigest
    ) {
      return false;
    }

    assertHostEligibilityContext(control.eligibilityContext);
    if (
      control.reviewerOutcome !== "fresh" &&
      control.reviewerOutcome !== "cache"
    ) {
      return false;
    }
    const initialVerdict = normalizeAndSealRiskVerdict(
      control.initialVerdict,
      "initialVerdict",
    );
    if (
      canonicalStringify(initialVerdict) !==
      canonicalStringify(control.initialVerdict)
    ) {
      return false;
    }
    const expectedInvocationDigest = computeRationaleInvocationDigest({
      ticketId: control.ticketId,
      nonce: control.nonce,
      anchor: control.anchor,
      actionDigest: control.action.actionDigest,
      triggeringBatchDisposition: control.triggeringBatchDisposition,
      anchorRoundReservation: control.anchorRoundReservation,
      sealedAction,
      eligibilityContext: control.eligibilityContext,
      reviewerOutcome: control.reviewerOutcome,
      initialVerdict,
    });
    if (expectedInvocationDigest !== control.invocationDigest) return false;

    if (options.currentEligibilityContext !== undefined) {
      assertCanonicalJson(
        options.currentEligibilityContext,
        "currentEligibilityContext",
      );
      assertHostEligibilityContext(options.currentEligibilityContext);
      if (
        canonicalStringify(options.currentEligibilityContext) !==
        canonicalStringify(control.eligibilityContext)
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

export function toRationaleProviderEnvelope(
  control: RationaleRequiredControl,
): RationaleProviderEnvelope {
  if (!verifyRationaleRequiredControl(control)) {
    throw new Error("invalid or expired rationale control");
  }
  const projectBounded = (
    values: readonly string[],
    label: string,
    maxItems = 8,
    maxLength = 160,
  ) => {
    if (values.length > maxItems) {
      throw new Error(label + " exceeds the provider contract");
    }
    const projected = values.map((value) => sanitizeDisplayText(value, maxLength));
    if (projected.some((value) => !value)) {
      throw new Error(label + " contains an empty provider projection");
    }
    return projected;
  };
  const reason =
    sanitizeDisplayText(control.initialVerdict.reason, 500) ||
    "Reviewer requested confirmation.";
  return deepFreeze({
    contractVersion: RATIONALE_CONTROL_CONTRACT_VERSION,
    anchorId: control.anchor.anchorId,
    ticketId: control.ticketId,
    actionDigest: control.action.actionDigest,
    canonicalTargets: projectBounded(
      control.action.canonicalTargets,
      "canonicalTargets",
      32,
      1_024,
    ),
    round: 1,
    sanitizedIntent: control.anchor.sanitizedIntent,
    toolName: control.action.toolName,
    source: control.action.source,
    category: control.action.category,
    requestedEffects: projectBounded(
      control.action.requestedEffects,
      "requestedEffects",
    ),
    affectedResources: projectBounded(
      control.action.affectedResources,
      "affectedResources",
    ),
    requiredAuthority: sanitizeDisplayText(control.action.requiredAuthority, 160),
    reviewerOutcome: control.reviewerOutcome,
    initialVerdict: {
      level: control.initialVerdict.level,
      reason,
    },
  }) as RationaleProviderEnvelope;
}


export function parseRationaleResponse(input: unknown, control: RationaleRequiredControl, now = Date.now()): RationaleResponse | null {
  return parseRationaleBoundResponse(input, control, now, false);
}

export function parseRationaleExecutionResponse(input: unknown, control: RationaleRequiredControl, now = Date.now()): RationaleResponse | null {
  return parseRationaleBoundResponse(input, control, now, true);
}

function parseRationaleBoundResponse(
  input: unknown,
  control: RationaleRequiredControl,
  now: number,
  humanWait: boolean,
): RationaleResponse | null {
  if (!(humanWait ? verifyRationaleTicketControl(control, { now }) : verifyRationaleRequiredControl(control, { now }))) return null;
  try {
    assertCanonicalJson(input, "RationaleResponse");
    if (!isRecord(input)) return null;
    const baseKeys = ["contractVersion", "anchorId", "ticketId", "actionDigest", "round", "choice"];
    if (input.choice !== "accept" && input.choice !== "resubmit" && input.choice !== "ask_user") return null;
    assertExactOwnKeys(input, input.choice === "resubmit" ? [...baseKeys, "rationale", "userQuote"] : baseKeys, "RationaleResponse");
    if (input.contractVersion !== RATIONALE_CONTROL_CONTRACT_VERSION ||
        input.anchorId !== control.anchor.anchorId || input.ticketId !== control.ticketId ||
        input.actionDigest !== control.action.actionDigest || input.round !== 1) return null;
    const base = { contractVersion: RATIONALE_CONTROL_CONTRACT_VERSION,
      anchorId: control.anchor.anchorId, ticketId: control.ticketId,
      actionDigest: control.action.actionDigest, round: 1 as const };
    if (input.choice !== "resubmit") return deepFreeze({ ...base, choice: input.choice });
    if (typeof input.rationale !== "string" || !input.rationale.trim() || input.rationale.length > 500 ||
        typeof input.userQuote !== "string" || !input.userQuote.trim() || input.userQuote.length > 2000) return null;
    // Preserve exact quote bytes until verification; display redaction is a separate projection.
    return deepFreeze({ ...base, choice: "resubmit" as const, rationale: input.rationale, userQuote: input.userQuote });
  } catch {
    return null;
  }
}
