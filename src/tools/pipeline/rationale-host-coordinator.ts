import { hasRationaleUserQuote } from "../../shared/rationale-user-quote.js";
import {
  isHostApprovalRejectedDecision,
  isHostApprovalTimeoutDecision,
  type ApprovalDecision,
  type ApprovalGate,
} from "../../permissions/approval-gate.js";
import { NO_APPROVER_MESSAGE } from "../../permissions/decision-pipeline.js";
import type {
  RationaleScopeReviewer,
} from "../../permissions/reviewer/rationale-scope-reviewer.js";
import type { SandboxCapability } from "../../permissions/sandbox-capability.js";
import { canonicalJsonEqual, canonicalStringify } from "../../shared/canonical-json.js";
import { runWithAbortableDeadline } from "../../shared/abortable-deadline.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import type { ToolCategory, ToolSource } from "../types.js";
import {
  RATIONALE_UNKNOWN_SCOPE_SENTINEL,
  MAX_RATIONALE_USER_CONTEXT_BYTES,
  RationaleHumanApprovalDeniedError,
  cloneRationaleCanonicalJson,
  createActionIdentity,
  createRationaleRequiredControl,
  verifyRationaleExecutionControl,
  isRationaleHumanApprovalActive,
  beginRationaleHumanApprovalWait,
  approveRationaleHumanWait,
  consumeRationaleHumanWait,
  retireRationaleHumanWait,
  type RationaleHumanApprovalWaitLease,
  type ActionIdentity,
  type HostAnchorRoundCas,
  type HostRationaleEligibilityContext,
  type RationaleEligibilityProvenance,
  type RationaleRequiredControl,
  type RationaleResponse,
  type RequestAnchor,
} from "./rationale-control.js";
import type {
  RationaleControlCandidate,
  RationaleHostRuntime,
  RationaleRuntimeMaterialization,
} from "./rationale-orchestrator.js";
import {
  createRationaleExecutorControlOutcome,
  createReviewerScopeReevaluation,
  evaluateRationaleOnlyBatch,
  isReviewerAutoApproveEligible,
  validateRationaleOnlyBatchDecision,
  validateReviewerScopeReevaluation,
  type RationaleGenerationOutcome,
  type RationaleOnlyBatchDecision,
  type RationaleRoundCall,
  type ReviewerScopeReevaluation,
} from "./rationale-pr1-contract.js";
import {
  createRationaleUiAuditProjection,
  createSealedRationaleResumeRequest as createContractSealedRationaleResumeRequest,
  type RationaleUiAuditProjection,
  type SealedRationaleResumeRequest,
} from "./rationale-resume-contract.js";
import {
  type HostConsumedAllowOnceReceipt,
  type HostInvocationStartCas,
  type InvocationAuditRecord,
  type RationaleGenerationProviderFailureCause,
  type RationaleTicketStateRecord,
} from "./rationale-ticket-lifecycle.js";
import {
  createRationaleTicketCasExpectation,
  type HostRationaleTicketSnapshot,
  type InProcessRationaleTicketStore,
} from "./rationale-ticket-store.js";
import type {
  RationaleResumeHostRuntime,
  RationaleResumeIdentityProbe,
} from "./rationale-resume-runner.js";
import { sha256Hex } from "../../lib/hex-digest-equal.js";
import {
  issueRationaleApprovalPolicyTransition,
  matchesRationaleApprovedDirectoryTransition,
  validateRationaleApprovalPolicyTransition,
  type RationalePolicySnapshot,
  type RationaleApprovalPolicyTransition,
} from "./rationale-policy-epoch.js";

export interface ConservativeRationaleActionSummary {
  readonly requestedEffects: readonly string[];
  readonly affectedResources: readonly string[];
  readonly requiredAuthority: string;
}

const CATEGORY_SUMMARIES = Object.freeze({
  read: Object.freeze({
    requestedEffects: Object.freeze(["read-data"]),
    requiredAuthority: "read-data",
  }),
  write: Object.freeze({
    requestedEffects: Object.freeze(["mutate-data", "delete-or-overwrite-data"]),
    requiredAuthority: "workspace-write",
  }),
  shell: Object.freeze({
    requestedEffects: Object.freeze(["execute-command", "mutate-host-state"]),
    requiredAuthority: "shell-execution",
  }),
  network: Object.freeze({
    requestedEffects: Object.freeze(["network-egress", "transmit-data"]),
    requiredAuthority: "network-egress",
  }),
  meta: Object.freeze({
    requestedEffects: Object.freeze(["change-host-or-agent-state"]),
    requiredAuthority: "host-orchestration",
  }),
}) satisfies Readonly<Record<ToolCategory, {
  readonly requestedEffects: readonly string[];
  readonly requiredAuthority: string;
}>>;

const PROVIDER_FAILURES: readonly RationaleGenerationProviderFailureCause[] =
  Object.freeze([
    "generation-unavailable",
    "generation-error",
    "generation-timeout",
  ]);

function compactResource(value: string): string {
  const normalized = value.trim();
  if (normalized.length <= 160) return normalized;
  const suffix = sha256Hex(normalized).slice(0, 16);
  return normalized.slice(0, 142) + "#" + suffix;
}

/**
 * Effects and authority come from the host-owned category, never from
 * model-authored rationale text or tool arguments.
 */
export function deriveConservativeRationaleActionSummary(input: {
  readonly category: ToolCategory;
  readonly source: ToolSource;
  readonly toolName: string;
  readonly canonicalTargets: readonly string[];
}): ConservativeRationaleActionSummary {
  const category = CATEGORY_SUMMARIES[input.category];
  const resources: string[] = [];
  const seen = new Set<string>();
  const candidates = input.canonicalTargets.length > 0
    ? input.canonicalTargets
    : ["tool:" + input.source + ":" + input.toolName];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !candidate.trim()) continue;
    const resource = compactResource(candidate);
    if (!seen.has(resource)) {
      seen.add(resource);
      resources.push(resource);
    }
    if (resources.length === 8) break;
  }
  if (resources.length === 0) resources.push(RATIONALE_UNKNOWN_SCOPE_SENTINEL);
  return Object.freeze({
    requestedEffects: category.requestedEffects,
    affectedResources: Object.freeze(resources),
    requiredAuthority: category.requiredAuthority,
  });
}

type RationaleApprovalGate = Pick<ApprovalGate, "cancelPendingRequest">;

export interface RationaleHostCoordinatorOptions {
  readonly onReviewerChoiceResolved?: (sessionId: string, requestId: string, decision: "allow" | "deny") => void;
  readonly requestAnchor: RequestAnchor | null;
  readonly userRoleTexts?: readonly string[];
  readonly getUserRoleTexts?: () => readonly string[];
  readonly rationaleProvenance: RationaleEligibilityProvenance;
  /** Shared with every coordinator created for this host session. */
  readonly ticketStore: InProcessRationaleTicketStore;
  readonly rationaleScopeReviewer: RationaleScopeReviewer;
  readonly approvalGate: RationaleApprovalGate;
  readonly getRationalePolicyEpoch: () => string;
  readonly getRationalePolicySnapshot?: () => RationalePolicySnapshot;
  readonly getRegistryGeneration: () => string | number;
  readonly getSandboxGeneration: () => string | number;
  /** Shared across every coordinator created for this host session. */
  readonly anchorRoundCas: HostAnchorRoundCas;
  /** Shared persistent/CAS boundary; never reset per coordinator instance. */
  readonly hostInvocationStartCas: HostInvocationStartCas;
  /** Required audit sink. Missing or failing persistence blocks invocation start. */
  readonly onInvocationAudit: (record: InvocationAuditRecord) => Promise<void> | void;
  /** Required synchronous audit sink. Failure blocks modal publication. */
  readonly onProjectionAudit: (
    sessionId: string,
    projection: RationaleUiAuditProjection,
    at: number,
  ) => unknown;
  /** Shared host generation guard; stale coordinators must not open authority. */
  readonly isCurrent?: () => boolean;
  readonly now?: () => number;
}

export type RationaleRoundResult =
  | {
      readonly kind: "batch-decision";
      readonly decision: RationaleOnlyBatchDecision;
    }
  | {
      readonly kind: "generation-failure";
      readonly generationOutcome: RationaleGenerationProviderFailureCause;
    }
  | {
      readonly kind: "interrupted";
    }
  | {
      readonly kind: "calls";
      readonly calls: readonly RationaleRoundCall[];
    }
  | {
      readonly kind: "provider-failure";
      readonly outcome: RationaleGenerationProviderFailureCause;
    };

export interface RationaleRoundResolution {
  readonly status: "ready" | "failed";
  readonly generationOutcome: RationaleGenerationOutcome;
  readonly response: RationaleResponse | null;
  readonly reevaluation: ReviewerScopeReevaluation | null;
  readonly batchDecision: RationaleOnlyBatchDecision | null;
  readonly ticket: HostRationaleTicketSnapshot;
  readonly projection: RationaleUiAuditProjection;
  // True means a one-shot reviewer receipt already exists: skip the modal and createSealedResume.
  readonly autoApproved: boolean;
  readonly modelDenied?: boolean;
}

export type RationaleApprovalResolution =
  | {
      readonly outcome: "allowed-once";
      readonly ticket: RationaleTicketStateRecord;
      readonly projection: RationaleUiAuditProjection;
      readonly receiptId: string;
    }
  | {
      readonly outcome: "denied" | "cancelled" | "timed-out";
      readonly reason?: string;
      readonly ticket: RationaleTicketStateRecord;
      readonly projection: RationaleUiAuditProjection;
    };

export interface RationaleSealedResumeResolution {
  readonly resumeRequest: SealedRationaleResumeRequest;
  readonly hostConsumedAllowOnceReceipt: HostConsumedAllowOnceReceipt;
}

export interface RationaleApprovalPromptInput {
  readonly abortSignal?: AbortSignal;
  readonly now?: number;
}

export interface CreateRationaleSealedResumeInput {
  readonly ticketId: string;
  readonly currentEligibilityContext: HostRationaleEligibilityContext;
  readonly now?: number;
}

interface ApprovalMetadata {
  readonly recordTerminalDenial?: (reason: string) => Promise<void>;
  readonly requestHumanApproval?: (input: { requestId: string; abortSignal?: AbortSignal }) => Promise<ApprovalDecision>;
  readonly sandboxCapability: SandboxCapability;
}

interface TicketContext {
  readonly reviewerRequestId?: string;
  reviewerChoiceResolved: boolean;
  terminalDenialRecording: Promise<void> | null;
  reviewerAuthorized: boolean;
  humanWaitLease: RationaleHumanApprovalWaitLease | null;
  approvedDecision: ApprovalDecision | null;
  policyTransition: RationaleApprovalPolicyTransition | null;
  readonly sessionId: string;
  readonly control: RationaleRequiredControl;
  readonly approval: ApprovalMetadata;
  snapshot: HostRationaleTicketSnapshot;
  response: RationaleResponse | null;
  reevaluation: ReviewerScopeReevaluation | null;
  projection: RationaleUiAuditProjection | null;
  projectionAuditCommitted: boolean;
  terminalTicket: RationaleTicketStateRecord | null;
  receipt: HostConsumedAllowOnceReceipt | null;
  issuedResumeRequest: SealedRationaleResumeRequest | null;
  roundResultStarted: boolean;
  approvalStarted: boolean;
  resumeIssued: boolean;
}

function generationValue(
  provider: () => string | number,
  label: string,
): string {
  const raw = provider();
  const value = typeof raw === "number"
    ? (Number.isFinite(raw) ? String(raw) : "")
    : raw;
  if (typeof value !== "string" || !value.trim() || value.length > 256) {
    throw new TypeError(label + " must be a bounded generation value");
  }
  return value;
}

// The host coordinator seals control and resume artifacts; the original invocation owns human approval delivery.
export class RationaleHostCoordinator implements RationaleHostRuntime, RationaleResumeHostRuntime {
  readonly requestAnchor: RequestAnchor | null;
  readonly rationaleProvenance: RationaleEligibilityProvenance;

  readonly #onReviewerChoiceResolved: RationaleHostCoordinatorOptions["onReviewerChoiceResolved"];
  readonly #getUserRoleTexts: () => readonly string[];
  readonly #ticketStore: InProcessRationaleTicketStore;
  readonly #rationaleScopeReviewer: RationaleScopeReviewer;
  readonly #approvalGate: RationaleApprovalGate;
  readonly #getRationalePolicySnapshot: RationaleHostCoordinatorOptions["getRationalePolicySnapshot"];
  readonly #getRationalePolicyEpoch: () => string;
  readonly #getRegistryGeneration: () => string | number;
  readonly #getSandboxGeneration: () => string | number;
  readonly #anchorRoundCas: HostAnchorRoundCas;
  readonly hostInvocationStartCas: HostInvocationStartCas;
  readonly #onInvocationAudit: (
    record: InvocationAuditRecord,
  ) => Promise<void> | void;
  readonly #onProjectionAudit: (
    sessionId: string,
    projection: RationaleUiAuditProjection,
    at: number,
  ) => unknown;
  readonly #now: () => number;
  readonly #isCurrent: () => boolean;
  readonly #contexts = new Map<string, TicketContext>();
  readonly #retiringContexts = new Map<string, TicketContext>();

  constructor(options: RationaleHostCoordinatorOptions) {
    if (typeof options.onProjectionAudit !== "function") {
      throw new TypeError("rationale host coordinator requires projection audit");
    }
    this.requestAnchor = options.requestAnchor;
    this.#onReviewerChoiceResolved = options.onReviewerChoiceResolved;
    const userRoleTexts = Object.freeze([...(options.userRoleTexts ?? [])]);
    this.#getUserRoleTexts = options.getUserRoleTexts ?? (() => userRoleTexts);
    this.rationaleProvenance = Object.freeze({ ...options.rationaleProvenance });
    this.#ticketStore = options.ticketStore;
    this.#rationaleScopeReviewer = options.rationaleScopeReviewer;
    this.#approvalGate = options.approvalGate;
    this.#getRationalePolicyEpoch = options.getRationalePolicyEpoch;
    this.#getRationalePolicySnapshot = options.getRationalePolicySnapshot;
    this.#getRegistryGeneration = options.getRegistryGeneration;
    this.#getSandboxGeneration = options.getSandboxGeneration;
    this.#anchorRoundCas = options.anchorRoundCas;
    this.hostInvocationStartCas = options.hostInvocationStartCas;
    this.#onInvocationAudit = options.onInvocationAudit;
    this.#onProjectionAudit = options.onProjectionAudit;
    this.#now = options.now ?? Date.now;
    this.#isCurrent = options.isCurrent ?? (() => true);
  }

  materializeActionIdentity(candidate: RationaleControlCandidate): ActionIdentity {
    const canonicalTargets = candidate.canonicalTargets.length > 0
      ? [...candidate.canonicalTargets]
      : [RATIONALE_UNKNOWN_SCOPE_SENTINEL];
    const summary = deriveConservativeRationaleActionSummary({
      category: candidate.category,
      source: candidate.source,
      toolName: candidate.toolName,
      canonicalTargets,
    });
    return createActionIdentity({
      anchorId: candidate.requestAnchor.anchorId,
      invocationTrustOrigin: candidate.invocationTrustOrigin,
      rationaleProvenance: candidate.rationaleProvenance,
      toolName: candidate.toolName,
      toolVersion: candidate.toolVersion,
      source: candidate.source,
      category: candidate.category,
      ...(candidate.pluginId === undefined ? {} : { pluginId: candidate.pluginId }),
      ...(candidate.mcpServerId === undefined
        ? {}
        : { mcpServerId: candidate.mcpServerId }),
      ...(candidate.workerId === undefined ? {} : { workerId: candidate.workerId }),
      finalInput: candidate.finalInput,
      ...(candidate.approvalCacheKey === undefined
        ? {}
        : { approvalCacheKey: candidate.approvalCacheKey }),
      canonicalTargets,
      requestedEffects: summary.requestedEffects,
      affectedResources: summary.affectedResources,
      requiredAuthority: summary.requiredAuthority,
      policyEpoch: generationValue(
        this.#getRationalePolicyEpoch,
        "rationale policy epoch",
      ),
      registryGeneration: generationValue(
        this.#getRegistryGeneration,
        "tool registry generation",
      ),
      sandboxGeneration: generationValue(
        this.#getSandboxGeneration,
        "sandbox generation",
      ),
      sandboxExecutionPlan: candidate.sandboxExecutionPlan,
    });
  }

  recomputeSealedActionIdentity(
    control: RationaleRequiredControl,
    now = this.#now(),
  ): ActionIdentity {
    if (!verifyRationaleExecutionControl(control, { now })) {
      throw new Error("cannot recompute identity for invalid rationale control");
    }
    const sealed = control.action;
    const currentPolicyEpoch = generationValue(this.#getRationalePolicyEpoch, "rationale policy epoch");
    const context = this.#contexts.get(control.ticketId);
    const approvedTransition = context?.approvedDecision && context.policyTransition &&
      validateRationaleApprovalPolicyTransition(context.policyTransition, {
        decision: context.approvedDecision, actionDigest: sealed.actionDigest,
        requestId: control.ticketId, beforeEpoch: sealed.policyEpoch, currentEpoch: currentPolicyEpoch,
      });
    const summary = deriveConservativeRationaleActionSummary({
      category: sealed.category,
      source: sealed.source,
      toolName: sealed.toolName,
      canonicalTargets: sealed.canonicalTargets,
    });
    return createActionIdentity({
      anchorId: sealed.anchorId,
      invocationTrustOrigin: sealed.invocationTrustOrigin,
      rationaleProvenance: sealed.rationaleProvenance,
      toolName: sealed.toolName,
      toolVersion: sealed.toolVersion,
      source: sealed.source,
      category: sealed.category,
      ...(sealed.pluginId === undefined ? {} : { pluginId: sealed.pluginId }),
      ...(sealed.mcpServerId === undefined
        ? {}
        : { mcpServerId: sealed.mcpServerId }),
      ...(sealed.workerId === undefined ? {} : { workerId: sealed.workerId }),
      finalInput: control.sealedAction.finalInput as Record<string, unknown>,
      ...(sealed.approvalCacheKey === undefined
        ? {}
        : { approvalCacheKey: sealed.approvalCacheKey }),
      canonicalTargets: sealed.canonicalTargets,
      requestedEffects: summary.requestedEffects,
      affectedResources: summary.affectedResources,
      requiredAuthority: summary.requiredAuthority,
      policyEpoch: approvedTransition ? sealed.policyEpoch : currentPolicyEpoch,
      registryGeneration: generationValue(
        this.#getRegistryGeneration,
        "tool registry generation",
      ),
      sandboxGeneration: generationValue(
        this.#getSandboxGeneration,
        "sandbox generation",
      ),
      sandboxExecutionPlan: sealed.sandboxExecutionPlan,
    });
  }

  readonly hasHumanApproval = (request: SealedRationaleResumeRequest): boolean => {
    if (!this.#isCoordinatorCurrent()) return false;
    const context = this.#contexts.get(request.ticketId);
    return context !== undefined && context.humanWaitLease !== null && context.receipt !== null &&
      isRationaleHumanApprovalActive(context.control, this.#now()) &&
      context.issuedResumeRequest !== null && canonicalJsonEqual(context.issuedResumeRequest, request) &&
      this.#ticketStore.isAuthenticConsumedAllowOnceReceipt(context.receipt, this.#now());
  };

  readonly hasReviewerReevaluationApproval = (request: SealedRationaleResumeRequest): boolean => {
    if (!this.#isCoordinatorCurrent()) return false;
    const context = this.#contexts.get(request.ticketId);
    return context !== undefined && context.reviewerAuthorized && context.receipt !== null &&
      context.reevaluation !== null && isReviewerAutoApproveEligible(context.reevaluation) &&
      context.issuedResumeRequest !== null && canonicalJsonEqual(context.issuedResumeRequest, request) &&
      this.#ticketStore.isAuthenticConsumedAllowOnceReceipt(context.receipt, this.#now());
  };

  readonly hasApprovedPolicyTransition = (request: SealedRationaleResumeRequest): boolean => {
    if (!this.#isCoordinatorCurrent()) return false;
    const context = this.#contexts.get(request.ticketId);
    if (!context || !context.resumeIssued || !context.issuedResumeRequest ||
        !canonicalJsonEqual(context.issuedResumeRequest, request) ||
        !context.approvedDecision || !context.policyTransition) return false;
    return validateRationaleApprovalPolicyTransition(context.policyTransition, {
      decision: context.approvedDecision, actionDigest: request.actionDigest,
      requestId: request.ticketId, beforeEpoch: context.control.action.policyEpoch,
      currentEpoch: generationValue(this.#getRationalePolicyEpoch, "rationale policy epoch"),
    });
  };

  readonly matchesApprovedExecutionScope = (request: SealedRationaleResumeRequest, currentPlan: Readonly<Record<string, unknown>>): boolean => {
    if (!this.hasApprovedPolicyTransition(request)) return false;
    const context = this.#contexts.get(request.ticketId);
    if (!context?.policyTransition) return false;
    const sealedPlan = context.control.action.sandboxExecutionPlan;
    const beforeDirectories = sealedPlan.allowedDirectories;
    const currentDirectories = currentPlan.allowedDirectories;
    if (!Array.isArray(beforeDirectories) || !beforeDirectories.every((path) => typeof path === "string") ||
        !Array.isArray(currentDirectories) || !currentDirectories.every((path) => typeof path === "string")) return false;
    return canonicalJsonEqual(sealedPlan, { ...currentPlan, allowedDirectories: beforeDirectories }) &&
      matchesRationaleApprovedDirectoryTransition(context.policyTransition, { beforeDirectories, currentDirectories });
  };

  readonly revokeUnstartedResume = (request: SealedRationaleResumeRequest): void => {
    const context = this.#contexts.get(request.ticketId);
    if (!context) return;
    if (!context.issuedResumeRequest || !canonicalJsonEqual(context.issuedResumeRequest, request)) {
      throw new Error("Unstarted resume does not match its host request");
    }
    this.abort(request.ticketId, this.#now());
  };

  readonly consumeHumanApprovalWait = (request: SealedRationaleResumeRequest): void => {
    const context = this.#contexts.get(request.ticketId);
    if (!context || !context.issuedResumeRequest || !canonicalJsonEqual(context.issuedResumeRequest, request)) {
      throw new Error("Human approval execution request is not current");
    }
    if (context.humanWaitLease) consumeRationaleHumanWait(context.control, context.humanWaitLease, this.#now());
  };

  readonly resolveCurrentActionIdentity = (
    probe: RationaleResumeIdentityProbe,
  ): ActionIdentity | null => {
    if (!this.#isCoordinatorCurrent()) return null;
    const context = this.#contexts.get(probe.request.ticketId);
    if (
      !context ||
      !context.resumeIssued ||
      context.issuedResumeRequest === null ||
      !canonicalJsonEqual(context.issuedResumeRequest, probe.request) ||
      !canonicalJsonEqual(context.control, probe.request.control)
    ) {
      return null;
    }
    try {
      return this.recomputeSealedActionIdentity(probe.request.control, this.#now());
    } catch {
      return null;
    }
  };

  readonly loadHostConsumedAllowOnceReceipt = (
    request: SealedRationaleResumeRequest,
  ): HostConsumedAllowOnceReceipt | null => {
    if (!this.#isCoordinatorCurrent()) return null;
    const context = this.#contexts.get(request.ticketId);
    if (
      !context ||
      context.receipt === null ||
      context.issuedResumeRequest === null ||
      !canonicalJsonEqual(context.issuedResumeRequest, request)
    ) {
      return null;
    }
    return this.#ticketStore.isAuthenticConsumedAllowOnceReceipt(
      context.receipt,
      this.#now(),
    )
      ? context.receipt
      : null;
  };

  readonly isAuthenticConsumedAllowOnceReceipt = (
    receipt: HostConsumedAllowOnceReceipt,
    now: number,
  ): boolean => this.#isCoordinatorCurrent() &&
    this.#ticketStore.isAuthenticConsumedAllowOnceReceipt(receipt, now);

  readonly onInvocationAudit = async (
    record: InvocationAuditRecord,
  ): Promise<void> => {
    await this.#onInvocationAudit(record);
    const context = this.#contexts.get(record.ticketId);
    if (context?.humanWaitLease && (record.state === "completed" || record.state === "failed" || record.state === "unknown-after-crash")) {
      this.#deleteContext(record.ticketId);
    }
  };
  readonly materializeRationaleControl = (
    candidate: RationaleControlCandidate,
  ): RationaleRuntimeMaterialization | null => {
    if (!this.#isCoordinatorCurrent()) return null;
    if (
      this.requestAnchor === null ||
      !Number.isFinite(candidate.now) ||
      !canonicalJsonEqual(candidate.requestAnchor, this.requestAnchor) ||
      !canonicalJsonEqual(candidate.rationaleProvenance, this.rationaleProvenance)
    ) {
      return null;
    }
    const action = this.materializeActionIdentity(candidate);
    const anchorRoundReservation = this.#anchorRoundCas.tryReserve({
      anchor: candidate.requestAnchor,
      action,
      triggeringBatchDisposition: candidate.triggeringBatchDisposition,
      round: 1,
      now: candidate.now,
    });
    if (!anchorRoundReservation || this.#contexts.has(anchorRoundReservation.ticketId)) {
      return null;
    }
    // Shared tickets prevent another coordinator from reopening the same request's resubmission round.
    const existingTicket = this.#ticketStore.get({
      sessionId: candidate.requestAnchor.sessionId,
      ticketId: anchorRoundReservation.ticketId,
      now: candidate.now,
    });
    if (existingTicket) return null;
    const control = createRationaleRequiredControl({
      anchor: candidate.requestAnchor,
      action,
      triggeringBatchDisposition: candidate.triggeringBatchDisposition,
      anchorRoundReservation,
      hostAnchorRoundCas: this.#anchorRoundCas,
      sealedAction: {
        toolUseId: candidate.toolUseId,
        toolName: candidate.toolName,
        originalInput: candidate.originalInput,
        finalInput: candidate.finalInput,
      },
      eligibilityContext: candidate.eligibilityContext,
      permission: candidate.permission,
      now: candidate.now,
    });
    const executorControl = createRationaleExecutorControlOutcome(
      control,
      candidate.now,
    );
    const created = this.#ticketStore.create({
      sessionId: control.anchor.sessionId,
      control,
      now: candidate.now,
    });
    if (!created) return null;
    const requested = this.#ticketStore.requestRationale(
      createRationaleTicketCasExpectation(created),
      candidate.now,
    );
    if (!requested) return null;
    this.#contexts.set(control.ticketId, {
      sessionId: control.anchor.sessionId,
      reviewerRequestId: candidate.permission.reviewer.requestId,
      reviewerChoiceResolved: false,
      terminalDenialRecording: null,
      reviewerAuthorized: false,
      humanWaitLease: null,
      approvedDecision: null,
      policyTransition: null,
      control,
      approval: {
        requestHumanApproval: candidate.requestHumanApproval,
        recordTerminalDenial: candidate.recordTerminalDenial,
        sandboxCapability: candidate.sandboxCapability,
      },
      snapshot: requested,
      response: null,
      reevaluation: null,
      projection: null,
      projectionAuditCommitted: false,
      terminalTicket: null,
      receipt: null,
      issuedResumeRequest: null,
      roundResultStarted: false,
      approvalStarted: false,
      resumeIssued: false,
    });
    return {
      action,
      control,
      ticket: created.ticket,
      executorControl,
    };
  };

  async handleRationaleRoundResult(input: {
    readonly ticketId: string;
    readonly result: RationaleRoundResult;
    readonly abortSignal?: AbortSignal;
    readonly now?: number;
  }): Promise<RationaleRoundResolution | null> {
    const startedAt = input.now ?? this.#now();
    if (!this.#isCoordinatorCurrent()) {
      this.#deleteContext(input.ticketId);
      return null;
    }
    const context = this.#contexts.get(input.ticketId);
    if (!context || context.roundResultStarted || !Number.isFinite(startedAt)) {
      return null;
    }
    const active = this.#ticketStore.get({
      sessionId: context.sessionId,
      ticketId: input.ticketId,
      now: startedAt,
    });
    if (!active || active.ticket.state !== "rationale_requested") {
      this.#deleteContext(input.ticketId);
      return null;
    }
    context.snapshot = active;
    context.roundResultStarted = true;
    if (input.abortSignal?.aborted) {
      this.abort(input.ticketId, startedAt);
      return null;
    }

    if (input.result.kind === "interrupted") {
      this.abort(input.ticketId, startedAt);
      return null;
    }

    let batchDecision: RationaleOnlyBatchDecision | null = null;
    let generationOutcome: RationaleGenerationOutcome;
    let generatedResponse: RationaleResponse | null = null;
    if (input.result.kind === "batch-decision") {
      try {
        const sealedDecision = cloneRationaleCanonicalJson(
          input.result.decision,
          "RationaleOnlyBatchDecision",
        ) as RationaleOnlyBatchDecision;
        if (!validateRationaleOnlyBatchDecision(
          sealedDecision,
          context.control,
          startedAt,
        )) {
          throw new TypeError("invalid rationale-only batch decision");
        }
        batchDecision = sealedDecision;
        generationOutcome = sealedDecision.generationOutcome;
        generatedResponse = sealedDecision.response;
      } catch {
        generationOutcome = "malformed-rationale";
      }
    } else if (input.result.kind === "calls") {
      try {
        batchDecision = evaluateRationaleOnlyBatch(
          context.control,
          input.result.calls,
          startedAt,
        );
        generationOutcome = batchDecision.generationOutcome;
        generatedResponse = batchDecision.response;
      } catch {
        generationOutcome = "malformed-rationale";
      }
    } else {
      const providerOutcome = input.result.kind === "generation-failure"
        ? input.result.generationOutcome
        : input.result.outcome;
      generationOutcome = PROVIDER_FAILURES.includes(providerOutcome)
        ? providerOutcome
        : "generation-error";
    }
    let reevaluation: ReviewerScopeReevaluation | null = null;
    const reviewUserRoleTexts = Object.freeze([...this.#getUserRoleTexts()]);
    let verifiedUserMessage: string | undefined;
    if (generatedResponse?.choice === "resubmit") {
      for (let index = reviewUserRoleTexts.length - 1; index >= 0; index -= 1) {
        const message = reviewUserRoleTexts[index]!;
        if (!hasRationaleUserQuote(message, generatedResponse.userQuote)) continue;
        // Keep the full most recent matching turn; truncation could remove a negation or condition.
        if (Buffer.byteLength(message, "utf8") <= MAX_RATIONALE_USER_CONTEXT_BYTES) verifiedUserMessage = message;
        break;
      }
    }
    const hasVerifiedUserContext = verifiedUserMessage !== undefined &&
      Buffer.byteLength(canonicalStringify(reviewUserRoleTexts), "utf8") <= MAX_RATIONALE_USER_CONTEXT_BYTES;
    if (generationOutcome === "accepted-rationale" && generatedResponse !== null && hasVerifiedUserContext) {
      let reviewerResult: ReviewerScopeReevaluation;
      const reviewerOutcome = await runWithAbortableDeadline(
        (abortSignal) => this.#rationaleScopeReviewer.reevaluate({
          control: context.control,
          response: generatedResponse,
          verifiedUserQuote: generatedResponse.choice === "resubmit" ? generatedResponse.userQuote : "",
          verifiedUserMessage,
          verifiedUserMessages: reviewUserRoleTexts,
          hostSafetyFacts: {
            targetPaths: context.control.action.canonicalTargets,
            sandbox: context.approval.sandboxCapability,
            sandboxExecutionPlan: context.control.action.sandboxExecutionPlan,
            checkpointAvailable: context.control.action.sandboxExecutionPlan.checkpointAvailable === true,
            reversibility: "not-proven",
            changeScope: context.control.action.requestedEffects,
          },
          abortSignal,
          now: startedAt,
        }),
        {
          deadlineMs: TOOL_TIMEOUT_POLICY.rationaleScopeReviewMs,
          ...(input.abortSignal === undefined
            ? {}
            : { callerAbortSignal: input.abortSignal }),
        },
      );
      if (!reviewerOutcome.ok) {
        if (reviewerOutcome.reason === "caller-abort") {
          this.abort(input.ticketId, input.now ?? this.#now());
          return null;
        }
        reviewerResult = createReviewerScopeReevaluation({
          control: context.control,
          outcome: reviewerOutcome.reason === "deadline" ? "timeout" : "error",
          now: startedAt,
        });
      } else {
        reviewerResult = reviewerOutcome.value;
      }
      if (!validateReviewerScopeReevaluation(
        reviewerResult,
        context.control,
        startedAt,
      )) {
        reviewerResult = createReviewerScopeReevaluation({
          control: context.control,
          outcome: "malformed",
          now: startedAt,
        });
      }
      reevaluation = reviewerResult;
    } else if (generationOutcome === "accepted-rationale") {
      reevaluation = createReviewerScopeReevaluation({ control: context.control, outcome: "unavailable", now: startedAt });
    }

    const settledAt = input.now ?? this.#now();
    if (!this.#isCoordinatorCurrent()) {
      this.#deleteContext(input.ticketId);
      return null;
    }
    if (
      this.#contexts.get(input.ticketId) !== context ||
      input.abortSignal?.aborted
    ) {
      this.abort(input.ticketId, settledAt);
      return null;
    }
    if (!canonicalJsonEqual(reviewUserRoleTexts, this.#getUserRoleTexts())) {
      reevaluation = createReviewerScopeReevaluation({ control: context.control, outcome: "unavailable", now: startedAt });
    }
    const ready = generationOutcome === "accepted-rationale" &&
      reevaluation?.outcome === "fresh";
    const outcomes = {
      generationOutcome,
      reevaluationOutcome: reevaluation?.outcome ?? null,
    };
    const resolved = ready
      ? this.#ticketStore.markRationaleReady(
          createRationaleTicketCasExpectation(context.snapshot),
          outcomes,
          settledAt,
        )
      : this.#ticketStore.markRationaleFailed(
          createRationaleTicketCasExpectation(context.snapshot),
          outcomes,
          settledAt,
        );
    if (!resolved) {
      this.#deleteContext(input.ticketId);
      return null;
    }

    // Only fresh low/medium re-evaluation may mint a reviewer one-shot receipt; every other case requires the modal.
    if (ready && reevaluation !== null &&
        isReviewerAutoApproveEligible(reevaluation)) {
      const receipt = this.#ticketStore.consumeReviewerAuthorizedOnce(
        createRationaleTicketCasExpectation(resolved),
        settledAt,
      );
      if (
        !receipt ||
        !this.#ticketStore.isAuthenticConsumedAllowOnceReceipt(receipt, settledAt)
      ) {
        this.#deleteContext(input.ticketId);
        return null;
      }
      const autoResponse = generatedResponse;
      const autoProjection = createRationaleUiAuditProjection({
        control: context.control,
        response: autoResponse,
        reevaluation,
        ticket: receipt.ticket,
        now: settledAt,
        autoApproved: true,
      });
      // Projection audit failure must block receipt publication and prevent sealing a resume.
      this.#commitProjectionAudit(context.sessionId, autoProjection, settledAt);
      context.snapshot = resolved;
      context.response = autoResponse;
      context.reevaluation = reevaluation;
      context.receipt = receipt;
      context.reviewerAuthorized = true;
      context.terminalTicket = receipt.ticket;
      context.projection = autoProjection;
      context.projectionAuditCommitted = true;
      this.#resolveReviewerChoice(context, "allow");
      return {
        status: "ready",
        generationOutcome,
        response: autoResponse,
        reevaluation,
        batchDecision,
        ticket: resolved,
        projection: autoProjection,
        autoApproved: true,
      };
    }

    this.#resolveReviewerChoice(context, "deny");
    const pending = this.#ticketStore.promptUser(
      createRationaleTicketCasExpectation(resolved),
      settledAt,
    );
    if (!pending) {
      this.#deleteContext(input.ticketId);
      return null;
    }
    const response = ready ? generatedResponse : null;
    const projection = createRationaleUiAuditProjection({
      control: context.control,
      response,
      reevaluation,
      ticket: pending.ticket,
      now: settledAt,
    });
    context.snapshot = pending;
    context.response = response;
    context.reevaluation = reevaluation;
    this.#commitProjectionAudit(context.sessionId, projection, settledAt);
    context.projection = projection;
    context.projectionAuditCommitted = true;
    if (generatedResponse?.choice === "accept") {
      const denied = this.#ticketStore.acceptDenial(createRationaleTicketCasExpectation(pending), settledAt);
      if (!denied) return null;
      context.snapshot = denied;
      context.terminalTicket = denied.ticket;
      await this.#recordTerminalDenial(context, context.control.eligibilityContext.headless ? NO_APPROVER_MESSAGE : "The model accepted the reviewer denial; the action was not executed.");
      const terminalProjection = createRationaleUiAuditProjection({
        control: context.control, response, reevaluation, ticket: denied.ticket, now: settledAt,
      });
      this.#commitProjectionAudit(context.sessionId, terminalProjection, settledAt);
      context.projection = terminalProjection;
    }
    return {
      status: ready ? "ready" : "failed",
      generationOutcome,
      response,
      reevaluation,
      batchDecision,
      ticket: context.snapshot,
      projection: context.projection,
      autoApproved: false,
      ...(generatedResponse?.choice === "accept" ? { modelDenied: true } : {}),
    };
  }

  async promptForApproval(
    ticketId: string,
    input: RationaleApprovalPromptInput = {},
  ): Promise<RationaleApprovalResolution | null> {
    const requestedAt = input.now ?? this.#now();
    if (!this.#isCoordinatorCurrent()) {
      this.#deleteContext(ticketId);
      return null;
    }
    const context = this.#contexts.get(ticketId);
    if (
      !context ||
      context.approvalStarted ||
      context.snapshot.ticket.state !== "user_pending" ||
      context.projection === null ||
      !context.projectionAuditCommitted ||
      !Number.isFinite(requestedAt)
    ) {
      return null;
    }
    if (input.abortSignal?.aborted) {
      this.abort(ticketId, requestedAt);
      return null;
    }

    context.approvalStarted = true;
    if (context.control.eligibilityContext.headless) {
      const denied = this.#ticketStore.denyWithoutApprover(createRationaleTicketCasExpectation(context.snapshot), requestedAt);
      if (!denied) return null;
      context.snapshot = denied;
      context.terminalTicket = denied.ticket;
      await this.#recordTerminalDenial(context, NO_APPROVER_MESSAGE);
      return { outcome: "denied", reason: NO_APPROVER_MESSAGE, ticket: denied.ticket, projection: context.projection };
    }
    const requestHumanApproval = context.approval.requestHumanApproval;
    if (typeof requestHumanApproval !== "function") {
      this.abort(ticketId, requestedAt);
      throw new Error("Human approval callback is unavailable");
    }
    const beforePolicy = this.#getRationalePolicySnapshot?.();
    if (beforePolicy && beforePolicy.epoch !== context.control.action.policyEpoch) {
      const rejected = this.#ticketStore.transition({ expectation: createRationaleTicketCasExpectation(context.snapshot), event: "identity-mismatch", now: requestedAt });
      if (!rejected) { this.abort(ticketId, requestedAt); throw new Error("Changed policy request could not be retired"); }
      const projection = createRationaleUiAuditProjection({ control: context.control, response: context.response,
        reevaluation: context.reevaluation, ticket: rejected.ticket, now: requestedAt });
      this.#commitProjectionAudit(context.sessionId, projection, requestedAt);
      await this.#recordTerminalDenial(context, "Permission policy changed before approval; the action was not executed.");
      this.#deleteContext(ticketId);
      return { outcome: "denied", reason: "Permission policy changed before approval; the action was not executed.", ticket: rejected.ticket, projection };
    }
    context.humanWaitLease = beginRationaleHumanApprovalWait(context.control, requestedAt);
    type ApprovalAbortOutcome = {
      readonly kind: "aborted";
      readonly failure: { readonly error: unknown } | null;
    };
    const abortState: { current: ApprovalAbortOutcome | null } = {
      current: null,
    };
    let settleAbort: ((outcome: ApprovalAbortOutcome) => void) | null = null;
    const abortWait = new Promise<ApprovalAbortOutcome>((resolve) => {
      settleAbort = resolve;
    });
    const abortPending = (): void => {
      if (abortState.current !== null) return;
      let failure: ApprovalAbortOutcome["failure"] = null;
      try {
        this.abort(ticketId, Math.max(requestedAt, this.#now()));
      } catch (error) {
        failure = { error };
      }
      const outcome: ApprovalAbortOutcome = {
        kind: "aborted",
        failure,
      };
      abortState.current = outcome;
      settleAbort?.(outcome);
    };
    input.abortSignal?.addEventListener("abort", abortPending, { once: true });
    if (input.abortSignal?.aborted) abortPending();
    const subscribedAbort = abortState.current;
    if (subscribedAbort !== null) {
      input.abortSignal?.removeEventListener("abort", abortPending);
      if (subscribedAbort.failure !== null) throw subscribedAbort.failure.error;
      return null;
    }
    if (this.#contexts.get(ticketId) !== context) {
      input.abortSignal?.removeEventListener("abort", abortPending);
      return null;
    }

    let approvalResult: Promise<ApprovalDecision>;
    try {
      approvalResult = Promise.resolve(requestHumanApproval({ requestId: ticketId, ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}) }));
    } catch (error) {
      // Preserve synchronous failures as rejections so the shared typed-denial and cleanup boundary handles both forms.
      approvalResult = Promise.reject(error);
    }
    const approvalWait = approvalResult.then((decision) => ({ kind: "decision" as const, decision }));
    let waitOutcome: Awaited<typeof approvalWait> | ApprovalAbortOutcome;
    try {
      waitOutcome = await Promise.race([approvalWait, abortWait]);
    } catch (error) {
      if (input.abortSignal?.aborted || abortState.current !== null) {
        if (abortState.current?.failure) throw abortState.current.failure.error;
        return null;
      }
      if (!(error instanceof RationaleHumanApprovalDeniedError)) throw error;
      const denied = this.#ticketStore.denyByPolicy(createRationaleTicketCasExpectation(context.snapshot), input.now ?? this.#now());
      if (!denied) return null;
      context.snapshot = denied;
      context.terminalTicket = denied.ticket;
      const projection = createRationaleUiAuditProjection({ control: context.control,
        response: context.response, reevaluation: context.reevaluation, ticket: denied.ticket,
        now: input.now ?? this.#now() });
      this.#commitProjectionAudit(context.sessionId, projection, input.now ?? this.#now());
      context.projection = projection;
      await this.#recordTerminalDenial(context, context.control.eligibilityContext.headless ? NO_APPROVER_MESSAGE : error.reason);
      this.#deleteContext(ticketId);
      return { outcome: "denied", reason: error.reason, ticket: denied.ticket, projection };
    } finally {
      input.abortSignal?.removeEventListener("abort", abortPending);
    }
    const observedAbort = abortState.current;
    if (observedAbort !== null) {
      if (observedAbort.failure !== null) throw observedAbort.failure.error;
      return null;
    }
    if (waitOutcome.kind === "aborted") {
      if (waitOutcome.failure !== null) throw waitOutcome.failure.error;
      return null;
    }
    const decision: ApprovalDecision | null = waitOutcome.decision;
    const decidedAt = input.now ?? this.#now();
    if (
      !this.#isCoordinatorCurrent() ||
      this.#contexts.get(ticketId) !== context
    ) {
      this.#deleteContext(ticketId);
      return null;
    }
    const expectation = createRationaleTicketCasExpectation(context.snapshot);

    if (
      decision?.requestId === ticketId &&
      (decision.choice === "allow-once" || decision.choice === "allow-session" || decision.choice === "allow-always") &&
      !isHostApprovalRejectedDecision(decision)
    ) {
      const afterPolicy = this.#getRationalePolicySnapshot?.();
      if (beforePolicy && afterPolicy && beforePolicy.epoch !== afterPolicy.epoch) {
        const transition = issueRationaleApprovalPolicyTransition({
          before: beforePolicy, after: afterPolicy, decision,
          actionDigest: context.control.action.actionDigest, requestId: ticketId,
          approvalGate: this.#approvalGate,
        });
        if (!transition) return null;
        context.policyTransition = transition;
        context.approvedDecision = decision;
      }
      if (context.humanWaitLease === null) throw new Error("Human approval wait lease is unavailable");
      approveRationaleHumanWait(context.control, context.humanWaitLease, decidedAt);
      const receipt = this.#ticketStore.consumeAllowOnce(expectation, decidedAt);
      if (
        !receipt ||
        !this.#ticketStore.isAuthenticConsumedAllowOnceReceipt(receipt, decidedAt)
      ) {
        this.#deleteContext(ticketId);
        return null;
      }
      const projection = createRationaleUiAuditProjection({
        control: context.control,
        response: context.response,
        reevaluation: context.reevaluation,
        ticket: receipt.ticket,
        now: decidedAt,
      });
      this.#commitProjectionAudit(context.sessionId, projection, decidedAt);
      context.receipt = receipt;
      context.terminalTicket = receipt.ticket;
      context.projection = projection;
      return {
        outcome: "allowed-once",
        ticket: receipt.ticket,
        projection,
        receiptId: receipt.receiptId,
      };
    }

    const requestedDeny = decision?.requestId === ticketId &&
      (decision.choice === "deny-once" || decision.choice === "deny-always");
    const timedOut = isHostApprovalTimeoutDecision(decision);
    const hostRejected = isHostApprovalRejectedDecision(decision);
    const denied = !timedOut && !hostRejected && requestedDeny;
    const terminal = timedOut
      ? this.#ticketStore.modalTimeout(expectation, decidedAt)
      : denied
        ? this.#ticketStore.deny(expectation, decidedAt)
        : this.#ticketStore.cancel(expectation, decidedAt);
    if (!terminal) return null;
    const projection = createRationaleUiAuditProjection({
      control: context.control,
      response: context.response,
      reevaluation: context.reevaluation,
      ticket: terminal.ticket,
      now: decidedAt,
    });
    this.#commitProjectionAudit(context.sessionId, projection, decidedAt);
    if (denied || timedOut) await this.#recordTerminalDenial(context,
      context.control.eligibilityContext.headless || (timedOut && decision?.rememberPattern === NO_APPROVER_MESSAGE)
        ? NO_APPROVER_MESSAGE : timedOut ? "Permission approval timed out; the action was not executed." : "The user denied this permission request.");
    this.#deleteContext(ticketId);
    return {
      outcome: timedOut ? "timed-out" : denied ? "denied" : "cancelled",
      ...(timedOut && decision?.rememberPattern === NO_APPROVER_MESSAGE ? { reason: NO_APPROVER_MESSAGE } : {}),
      ticket: terminal.ticket,
      projection,
    };
  }
  async createSealedResume(
    input: CreateRationaleSealedResumeInput,
  ): Promise<RationaleSealedResumeResolution | null> {
    const startedAt = input.now ?? this.#now();
    if (!this.#isCoordinatorCurrent()) {
      this.#deleteContext(input.ticketId);
      return null;
    }
    const context = this.#contexts.get(input.ticketId);
    if (
      !context ||
      context.resumeIssued ||
      context.receipt === null ||
      context.terminalTicket === null ||
      !Number.isFinite(startedAt) ||
      !this.#ticketStore.isAuthenticConsumedAllowOnceReceipt(
        context.receipt,
        startedAt,
      )
    ) {
      return null;
    }
    context.resumeIssued = true;
    try {
      const settledAt = input.now ?? this.#now();
      const currentActionIdentity = this.recomputeSealedActionIdentity(
        context.control,
        settledAt,
      );
      if (
        this.#contexts.get(input.ticketId) !== context ||
        !this.#ticketStore.isAuthenticConsumedAllowOnceReceipt(
          context.receipt,
          settledAt,
        )
      ) {
        this.#deleteContext(input.ticketId);
        return null;
      }
      const status = context.terminalTicket.rationaleStatus;
      if (status !== "ready" && status !== "failed") {
        this.#deleteContext(input.ticketId);
        return null;
      }
      const resumeRequest = createContractSealedRationaleResumeRequest({
        control: context.control,
        response: context.response,
        rationaleStatus: status,
        reevaluation: context.reevaluation,
        ticket: context.terminalTicket,
        currentActionIdentity,
        currentEligibilityContext: input.currentEligibilityContext,
        hostConsumedAllowOnceReceipt: context.receipt,
        now: settledAt,
      });
      context.issuedResumeRequest = resumeRequest;
      return {
        resumeRequest,
        hostConsumedAllowOnceReceipt: context.receipt,
      };
    } catch {
      this.#deleteContext(input.ticketId);
      return null;
    }
  }
  #recordTerminalDenial(context: TicketContext, reason: string): Promise<void> {
    if (context.terminalDenialRecording === null) {
      try {
        context.terminalDenialRecording = Promise.resolve(context.approval.recordTerminalDenial?.(reason));
      } catch (error) {
        context.terminalDenialRecording = Promise.reject(error);
      }
    }
    return context.terminalDenialRecording;
  }

  #resolveReviewerChoice(context: TicketContext, decision: "allow" | "deny"): void {
    if (context.reviewerChoiceResolved) return;
    if (context.reviewerRequestId !== undefined) {
      this.#onReviewerChoiceResolved?.(context.sessionId, context.reviewerRequestId, decision);
    }
    context.reviewerChoiceResolved = true;
  }

  abort(ticketId: string, now = this.#now()): RationaleTicketStateRecord | null {
    let context = this.#contexts.get(ticketId);
    if (context) {
      this.#deleteContext(ticketId);
      this.#retiringContexts.set(ticketId, context);
    } else {
      context = this.#retiringContexts.get(ticketId);
    }
    if (!context) return null;
    const errors: unknown[] = [];
    try {
      this.#approvalGate.cancelPendingRequest(ticketId, context.sessionId, "caller-abort");
    } catch (error) {
      errors.push(error);
    }
    let result: RationaleTicketStateRecord | null =
      context.receipt?.ticket ?? context.terminalTicket;
    let ticketRetired = context.receipt !== null;
    if (!ticketRetired) {
      try {
        if (!this.#ticketStore.activeTicketIds(context.sessionId, now).includes(ticketId)) {
          ticketRetired = true;
        } else {
          const terminal = this.#ticketStore.abort(
            createRationaleTicketCasExpectation(context.snapshot),
            now,
          );
          if (terminal) {
            context.terminalTicket = terminal.ticket;
            result = terminal.ticket;
            ticketRetired = true;
          } else if (!this.#ticketStore.activeTicketIds(context.sessionId, now).includes(ticketId)) {
            ticketRetired = true;
          } else {
            errors.push(new Error("rationale abort CAS did not retire the active ticket"));
          }
        }
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "rationale coordinator abort failed");
    }
    if (ticketRetired) this.#retiringContexts.delete(ticketId);
    return result;
  }

  closeSession(
    sessionId: string,
    now = this.#now(),
  ): readonly HostRationaleTicketSnapshot[] {
    const retiring: Array<readonly [string, TicketContext]> = [];
    for (const [ticketId, context] of this.#contexts) {
      if (context.sessionId === sessionId) {
        this.#deleteContext(ticketId);
        this.#retiringContexts.set(ticketId, context);
        retiring.push([ticketId, context]);
      }
    }
    for (const [ticketId, context] of this.#retiringContexts) {
      if (
        context.sessionId === sessionId &&
        !retiring.some(([retiringId]) => retiringId === ticketId)
      ) {
        retiring.push([ticketId, context]);
      }
    }
    const errors: unknown[] = [];
    const cancelledAtGate = new Set<string>();
    for (const [ticketId] of retiring) {
      try {
        this.#approvalGate.cancelPendingRequest(ticketId, sessionId, "session-close");
        cancelledAtGate.add(ticketId);
      } catch (error) {
        errors.push(error);
      }
    }
    let closed: readonly HostRationaleTicketSnapshot[] = [];
    let storeClosed = false;
    try {
      closed = this.#ticketStore.closeSession(sessionId, now);
      storeClosed = true;
    } catch (error) {
      errors.push(error);
    }
    if (storeClosed) {
      for (const [ticketId, context] of retiring) {
        if (cancelledAtGate.has(ticketId) &&
            this.#retiringContexts.get(ticketId) === context) {
          this.#retiringContexts.delete(ticketId);
        }
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "rationale coordinator session close failed");
    }
    return closed;
  }

  #deleteContext(ticketId: string): boolean {
    const context = this.#contexts.get(ticketId);
    if (context?.humanWaitLease) retireRationaleHumanWait(context.control, context.humanWaitLease);
    if (context?.receipt) {
      this.#ticketStore.releaseConsumedReceipt(context.receipt);
      context.receipt = null;
    }
    return this.#contexts.delete(ticketId);
  }

  #isCoordinatorCurrent(): boolean {
    try {
      return this.#isCurrent();
    } catch {
      return false;
    }
  }

  #commitProjectionAudit(
    sessionId: string,
    projection: RationaleUiAuditProjection,
    at: number,
  ): void {
    const result = this.#onProjectionAudit(sessionId, projection, at);
    if (
      result !== null &&
      (typeof result === "object" || typeof result === "function") &&
      typeof (result as { then?: unknown }).then === "function"
    ) {
      throw new TypeError("rationale projection audit must complete synchronously");
    }
  }
}
