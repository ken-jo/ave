import { createRationaleApprovalCallback } from "../../../__tests__/support/rationale-approval-callback.js";
import { describe, expect, it, vi } from "vitest";
import { HookRunner } from "../../../hooks/hook-runner.js";
import { captureRationalePolicySnapshot, type RationalePolicySnapshot } from "../rationale-policy-epoch.js";
import { ApprovalGate } from "../../../permissions/approval-gate.js";
import type {
  ApprovalChoice,
  ApprovalDecision,
  ApprovalRequest,
} from "../../../permissions/approval-gate.js";
import { buildPermissionEvaluationContext } from "../../../permissions/evaluation-context.js";
import type { PermissionCheckResult } from "../../../permissions/permission-manager.js";
import { TOOL_TIMEOUT_POLICY } from "../../../shared/tool-timeout-policy.js";
import { LlmRationaleScopeReviewer } from "../../../permissions/reviewer/rationale-scope-reviewer.js";
import type { LlmReviewerProvider } from "../../../permissions/reviewer/risk-classifier.js";
import type {
  RationaleScopeReviewer,
} from "../../../permissions/reviewer/rationale-scope-reviewer.js";
import {
  InMemoryHostAnchorRoundCasStore,
  isRationaleEligible,
  RationaleHumanApprovalDeniedError,
  parseRationaleResponse,
  verifyRationaleRequiredControl,
  verifyRationaleExecutionControl,
  createRequestAnchor,
  createTriggeringBatchDisposition,
  type ActionIdentity,
  type RationaleRequiredControl,
  type RequestAnchor,
} from "../rationale-control.js";
import { rationaleResponseFor } from "./rationale-fixtures.js";
import {
  RationaleHostCoordinator,
  deriveConservativeRationaleActionSummary,
} from "../rationale-host-coordinator.js";
import type { RationaleControlCandidate } from "../rationale-orchestrator.js";
import { createReviewerScopeReevaluation } from "../rationale-pr1-contract.js";
import {
  InMemoryHostInvocationStartCasStore,
  type InvocationAuditRecord,
} from "../rationale-ticket-lifecycle.js";
import type { RationaleUiAuditProjection } from "../rationale-resume-contract.js";
import {
  InProcessRationaleTicketStore,
  type RationaleTicketStoreAuditEvent,
} from "../rationale-ticket-store.js";

const NOW = 1_900_000_000_000;
const rationaleProvenance = {
  startedFromUserKeyboard: true,
  taint: "none",
} as const;
const eligibilityContext = {
  headless: false,
  forceModal: false,
  approvalReasonPrefix: null,
} as const;
const permission = {
  decision: "ask",
  reason: "Automatic review requires human approval.",
  reasonCode: "reviewer-human-required",
  reviewer: {
    requestId: "review-request-1",
    route: "foreground-auto",
    verdict: { level: "high", reason: "bounded destructive action" },
    outcome: "fresh",
  },
} as const satisfies PermissionCheckResult;

interface SetupOptions {
  readonly sessionId?: string;
  readonly platform?: NodeJS.Platform;
  readonly headless?: boolean;
  readonly requestHumanApproval?: RationaleControlCandidate["requestHumanApproval"];
  readonly humanApprovalAvailable?: boolean;
  readonly recordTerminalDenial?: RationaleControlCandidate["recordTerminalDenial"];
  readonly executionCwd?: string;
  readonly now?: () => number;
  readonly policySnapshot?: () => RationalePolicySnapshot;
  readonly ownerUnattended?: boolean;
  readonly userRoleTexts?: readonly string[];
  readonly onReviewerChoiceResolved?: (sessionId: string, requestId: string, decision: "allow" | "deny") => void;
  readonly approvalChoice?: ApprovalChoice;
  readonly reviewer?: RationaleScopeReviewer;
  readonly deferApproval?: boolean;
  readonly approvalGate?: Pick<
    ApprovalGate,
    "requestAndWait" | "cancelPendingRequest"
  >;
  readonly onTicketAudit?: (event: RationaleTicketStoreAuditEvent) => void;
  readonly onProjectionAudit?: (
    sessionId: string,
    projection: RationaleUiAuditProjection,
    at: number,
  ) => unknown;
}

function createAnchor(
  sessionId = "3863264e-4954-486d-8547-d1256eb1af1a",
  suffix = "1",
): RequestAnchor {
  const anchor = createRequestAnchor({
    sessionId,
    turnId: "turn-" + suffix,
    inputMessageId: "message-" + suffix,
    inputOrigin: "user-keyboard",
    rawIntent: "remove the private build output",
    now: NOW,
    ttlMs: 60_000,
  });
  if (!anchor) throw new Error("expected request anchor");
  return anchor;
}

function createCandidate(
  anchor: RequestAnchor,
  platform: NodeJS.Platform,
): RationaleControlCandidate {
  const originalInput = { command: "rm -rf workspace/private-build" };
  const finalInput = { command: "rm -rf workspace/private-build", confirmed: true };
  return {
    now: NOW,
    requestAnchor: anchor,
    rationaleProvenance,
    triggeringBatchDisposition: createTriggeringBatchDisposition({
      batchId: "provider-batch-1",
      originalToolUseIds: ["tool-use-1", "tool-use-cancelled"],
      triggeringToolUseId: "tool-use-1",
      completedToolUseIds: [],
    }),
    toolUseId: "tool-use-1",
    originalInput,
    finalInput,
    toolName: "shell_exec",
    toolVersion: "1",
    source: "builtin",
    category: "shell",
    invocationTrustOrigin: "llm-tool-arg",
    canonicalTargets: ["workspace/private-build"],
    approvalCacheKey: "shell_exec:workspace/private-build",
    sandboxCapability: {
      kind: "asrt",
      confidence: "verified",
      platform,
      reason: "test sandbox",
      confines: { filesystem: true, process: platform !== "win32", network: true },
    },
    sandboxExecutionPlan: {
      cwd: "workspace",
      filesystem: "workspace-only",
      network: "strict-union",
    },
    permission,
    eligibilityContext,
  };
}

const responseFor = (control: RationaleRequiredControl) =>
  rationaleResponseFor(control, "Remove the sealed build target.");

function setup(options: SetupOptions = {}) {
  const anchor = createAnchor(options.sessionId);
  const baseCandidate = createCandidate(anchor, options.platform ?? "linux");
  const candidate = { ...baseCandidate,
    requestHumanApproval: options.requestHumanApproval,
    recordTerminalDenial: options.recordTerminalDenial,
    eligibilityContext: { ...baseCandidate.eligibilityContext, headless: options.headless ?? false } };
  const ticketStore = new InProcessRationaleTicketStore({
    onAudit: options.onTicketAudit ?? (() => {}),
  });
  const anchorRoundCas = new InMemoryHostAnchorRoundCasStore();
  const hostInvocationStartCas = new InMemoryHostInvocationStartCasStore();
  const invocationAudits: InvocationAuditRecord[] = [];
  const projectionAudits: Array<{
    readonly sessionId: string;
    readonly projection: RationaleUiAuditProjection;
    readonly at: number;
  }> = [];
  const approvalRequests: Array<Omit<ApprovalRequest, "requireExplicit">> = [];
  // Modal tests use a high re-evaluation; allow cases supply a low/medium reviewer.
  const reviewer = options.reviewer ?? {
    async reevaluate(input) {
      return createReviewerScopeReevaluation({
        control: input.control,
        outcome: "fresh",
        scopeAlignment: "unclear",
        scopeReasons: ["the sealed target scope could not be fully confirmed"],
        reevaluatedVerdict: {
          level: "high",
          reason: "bounded destructive action remains high",
        },
        now: input.now,
      });
    },
  } satisfies RationaleScopeReviewer;
  const generations = {
    policy: "policy-epoch-1",
    registry: "registry-generation-1",
    sandbox: "sandbox-generation-1",
  };
  const pendingApprovals = new Map<
    string,
    (decision: ApprovalDecision) => void
  >();
  const resolvePendingApproval = (
    requestId: string,
    choice: ApprovalChoice,
  ): boolean => {
    const resolve = pendingApprovals.get(requestId);
    if (!resolve) return false;
    pendingApprovals.delete(requestId);
    resolve({ requestId, choice });
    return true;
  };
  const fallbackApprovalGate = {
    requestAndWait: vi.fn(async (
      request: Omit<ApprovalRequest, "requireExplicit">,
    ) => {
      approvalRequests.push(request);
      if (options.deferApproval) {
        return await new Promise<ApprovalDecision>((resolve) => {
          pendingApprovals.set(request.id, resolve);
        });
      }
      return {
        requestId: request.id,
        choice: options.approvalChoice ?? "allow-once",
      };
    }),
    cancelPendingRequest: vi.fn((requestId: string) =>
      resolvePendingApproval(requestId, "deny-once")
    ),
  };
  const approvalGate = options.approvalGate ?? fallbackApprovalGate;
  const evaluationContext = buildPermissionEvaluationContext({
    policyMode: "auto", headless: options.headless ?? false, source: "builtin", category: "shell", trustOrigin: "llm-tool-arg",
    executionCwd: options.executionCwd ?? "workspace", allowedDirectories: ["workspace"], pathFields: ["command"],
    targetFilePaths: [...candidate.canonicalTargets], sensitivePathsAdjacent: [],
  });
  if (options.humanApprovalAvailable !== false) candidate.requestHumanApproval = options.requestHumanApproval ?? createRationaleApprovalCallback({
    candidate, approvalGate, evaluationContext, ownerUnattended: options.ownerUnattended,
  });
  const coordinator = new RationaleHostCoordinator({
    requestAnchor: anchor,
    userRoleTexts: options.userRoleTexts ?? ["remove the private build output"],
    onReviewerChoiceResolved: options.onReviewerChoiceResolved,
    rationaleProvenance,
    ticketStore,
    rationaleScopeReviewer: reviewer,
    approvalGate,
    getRationalePolicyEpoch: options.policySnapshot ? () => options.policySnapshot!().epoch : () => generations.policy,
    getRationalePolicySnapshot: options.policySnapshot,
    getRegistryGeneration: () => generations.registry,
    getSandboxGeneration: () => generations.sandbox,
    anchorRoundCas,
    hostInvocationStartCas,
    onInvocationAudit: (record) => invocationAudits.push(record),
    onProjectionAudit: (sessionId, projection, at) => {
      const result = options.onProjectionAudit?.(sessionId, projection, at);
      projectionAudits.push({ sessionId, projection, at });
      return result;
    },
    now: options.now ?? (() => NOW),
  });
  return {
    coordinator,
    candidate,
    evaluationContext,
    ticketStore,
    anchorRoundCas,
    hostInvocationStartCas,
    invocationAudits,
    projectionAudits,
    approvalGate,
    approvalRequests,
    pendingApprovals,
    resolvePendingApproval,
    reviewer,
    generations,
  };
}

function materialize(setupValue: ReturnType<typeof setup>) {
  const value = setupValue.coordinator.materializeRationaleControl(
    setupValue.candidate,
  );
  expect(value).not.toBeNull();
  if (!value) throw new Error("expected materialization");
  return value;
}

describe("RationaleHostCoordinator", () => {
  it.each(["linux", "darwin", "win32"] as const)(
    "materializes one conservative host round on %s",
    (platform) => {
      const state = setup({ platform });
      const materialized = materialize(state);

      expect(materialized.action).toMatchObject({
        requestedEffects: ["execute-command", "mutate-host-state"],
        affectedResources: ["workspace/private-build"],
        requiredAuthority: "shell-execution",
        policyEpoch: "policy-epoch-1",
        registryGeneration: "registry-generation-1",
        sandboxGeneration: "sandbox-generation-1",
      });
      expect(materialized.ticket.state).toBe("review_required");
      expect(state.ticketStore.get({
        sessionId: materialized.control.anchor.sessionId,
        ticketId: materialized.control.ticketId,
        now: NOW,
      })?.ticket.state).toBe("rationale_requested");
      expect(state.coordinator.materializeRationaleControl(state.candidate)).toBeNull();
    },
  );

  it("shares the anchor CAS and ticket store across coordinator instances", () => {
    const state = setup();
    const first = materialize(state);
    const second = new RationaleHostCoordinator({
      requestAnchor: state.candidate.requestAnchor,
      userRoleTexts: ["remove the private build output"],
      rationaleProvenance,
      ticketStore: state.ticketStore,
      rationaleScopeReviewer: state.reviewer,
      approvalGate: state.approvalGate,
      getRationalePolicyEpoch: () => state.generations.policy,
      getRegistryGeneration: () => state.generations.registry,
      getSandboxGeneration: () => state.generations.sandbox,
      anchorRoundCas: state.anchorRoundCas,
      hostInvocationStartCas: state.hostInvocationStartCas,
      onInvocationAudit: (record) => state.invocationAudits.push(record),
      onProjectionAudit: (sessionId, projection, at) => {
        state.projectionAudits.push({ sessionId, projection, at });
      },
      now: () => NOW,
    });

    expect(second.materializeRationaleControl(state.candidate)).toBeNull();
    expect(state.ticketStore.get({
      sessionId: first.control.anchor.sessionId,
      ticketId: first.control.ticketId,
      now: NOW,
    })?.ticket.state).toBe("rationale_requested");
  });

  it("uses the same meta authority rule for agent_spawn and every other meta tool", () => {
    const spawn = deriveConservativeRationaleActionSummary({
      category: "meta",
      source: "builtin",
      toolName: "agent_spawn",
      canonicalTargets: [],
    });
    const other = deriveConservativeRationaleActionSummary({
      category: "meta",
      source: "builtin",
      toolName: "host_setting_update",
      canonicalTargets: [],
    });

    expect(spawn.requestedEffects).toEqual(["change-host-or-agent-state"]);
    expect(spawn.requiredAuthority).toBe("host-orchestration");
    expect(other.requestedEffects).toEqual(spawn.requestedEffects);
    expect(other.requiredAuthority).toBe(spawn.requiredAuthority);
  });

  it("requires fresh cache-bypassed reevaluation, one-shot modal, and authentic resume", async () => {
    const state = setup();
    const materialized = materialize(state);
    const round = await runReadyRound(state, materialized);

    expect(round).toMatchObject({
      status: "ready",
      generationOutcome: "accepted-rationale",
      ticket: { ticket: { state: "user_pending", rationaleStatus: "ready" } },
      projection: {
        rationaleStatus: "ready",
        reevaluationOutcome: "fresh",
        modalFallbackRequired: false,
      },
    });
    expect(round?.reevaluation).toMatchObject({
      outcome: "fresh",
      cachePolicy: "bypass-base-cache",
      baseCacheWrite: "forbidden",
    });
    expect(state.projectionAudits).toEqual([
      expect.objectContaining({
        sessionId: materialized.control.anchor.sessionId,
        at: NOW + 1,
        projection: expect.objectContaining({ terminalReason: null }),
      }),
    ]);
    expect(state.approvalGate.requestAndWait).not.toHaveBeenCalled();

    const approval = await state.coordinator.promptForApproval(
      materialized.control.ticketId,
      { now: NOW + 2 },
    );
    expect(approval).toMatchObject({
      outcome: "allowed-once",
      ticket: { state: "allowed_once", terminalReason: "allowed-once" },
    });
    expect(state.approvalGate.requestAndWait).toHaveBeenCalledTimes(1);
    expect(state.projectionAudits.map(({ projection }) => projection.terminalReason)).toEqual([
      null,
      "allowed-once",
    ]);
    expect(state.approvalRequests[0]).toMatchObject({
      id: materialized.control.ticketId,
      kind: "tool",
      sessionId: materialized.control.anchor.sessionId,
    });
    expect(state.approvalRequests[0]?.approvalCacheKey).toBe(materialized.action.approvalCacheKey);
    expect(state.approvalRequests[0]?.allowedChoices).toBeUndefined();
    expect(state.approvalRequests[0]?.args).toEqual(materialized.control.sealedAction.finalInput);
    const modalArgs = state.approvalRequests[0]!.args as Record<string, unknown>;
    expect(modalArgs).toMatchObject({ command: "rm -rf workspace/private-build", confirmed: true });
    // Send only display facts to the renderer; retain replay-sensitive bindings in host and audit projections.
    expect(modalArgs).not.toHaveProperty("ticketId");
    expect(modalArgs).not.toHaveProperty("anchorId");
    expect(modalArgs).not.toHaveProperty("actionDigest");
    expect(state.projectionAudits[0]?.projection).toMatchObject({
      ticketId: materialized.control.ticketId,
      anchorId: materialized.control.anchor.anchorId,
      actionDigest: materialized.action.actionDigest,
    });
    expect(await state.coordinator.promptForApproval(
      materialized.control.ticketId,
      { now: NOW + 2 },
    )).toBeNull();

    const sealed = await state.coordinator.createSealedResume({
      ticketId: materialized.control.ticketId,
      currentEligibilityContext: eligibilityContext,
      now: NOW + 3,
    });
    expect(sealed?.resumeRequest).toMatchObject({
      kind: "sealed-rationale-resume",
      actionDigest: materialized.action.actionDigest,
      executionEntryPoint: "tool-executor-security-suffix",
      directToolExecute: "forbidden",
    });
    expect(state.ticketStore.isAuthenticConsumedAllowOnceReceipt(
      sealed!.hostConsumedAllowOnceReceipt,
      NOW + 3,
    )).toBe(true);
    expect(await state.coordinator.createSealedResume({
      ticketId: materialized.control.ticketId,
      currentEligibilityContext: eligibilityContext,
      now: NOW + 3,
    })).toBeNull();
  });

  it("enforces the scope-review deadline and falls back to the bounded modal", async () => {
    vi.useFakeTimers();
    try {
      let reviewSignal: AbortSignal | undefined;
      const reviewer: RationaleScopeReviewer = {
        async reevaluate(input) {
          reviewSignal = input.abortSignal;
          return await new Promise<never>(() => {});
        },
      };
      const state = setup({ reviewer, approvalChoice: "deny-once" });
      const materialized = materialize(state);
      const pending = runReadyRound(state, materialized);
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(
        TOOL_TIMEOUT_POLICY.rationaleScopeReviewMs + 1,
      );
      const round = await pending;
      expect(round).toMatchObject({
        status: "failed",
        generationOutcome: "accepted-rationale",
        response: null,
        reevaluation: { outcome: "timeout", modalFallbackRequired: true },
        projection: { rationaleStatus: "failed", modalFallbackRequired: true },
      });
      expect(reviewSignal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);

      const approval = await state.coordinator.promptForApproval(
        materialized.control.ticketId,
        { now: NOW + 2 },
      );
      expect(approval).toMatchObject({
        outcome: "denied",
        ticket: { state: "denied", terminalReason: "user-deny" },
      });
      expect(await state.coordinator.createSealedResume({
        ticketId: materialized.control.ticketId,
        currentEligibilityContext: eligibilityContext,
        now: NOW + 3,
      })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts the ticket on in-flight caller cancellation instead of reporting timeout", async () => {
    vi.useFakeTimers();
    try {
      let reviewSignal: AbortSignal | undefined;
      const reviewer: RationaleScopeReviewer = {
        async reevaluate(input) {
          reviewSignal = input.abortSignal;
          return await new Promise<never>(() => {});
        },
      };
      const state = setup({ reviewer });
      const materialized = materialize(state);
      const caller = new AbortController();
      const pending = state.coordinator.handleRationaleRoundResult({
        ticketId: materialized.control.ticketId,
        result: {
          kind: "calls",
          calls: [{
            id: "rationale-call-1",
            name: "permission_rationale",
            input: responseFor(materialized.control),
          }],
        },
        abortSignal: caller.signal,
        now: NOW + 1,
      });
      await vi.advanceTimersByTimeAsync(0);
      caller.abort(new Error("caller cancelled"));

      await expect(pending).resolves.toBeNull();
      expect(reviewSignal?.aborted).toBe(true);
      expect(state.approvalGate.cancelPendingRequest).toHaveBeenCalledWith(
        materialized.control.ticketId,
        materialized.control.anchor.sessionId,
        "caller-abort",
      );
      expect(state.ticketStore.get({
        sessionId: materialized.control.anchor.sessionId,
        ticketId: materialized.control.ticketId,
        now: NOW + 1,
      })).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not infer a host timeout from a reviewer-thrown error name", async () => {
    const reviewer: RationaleScopeReviewer = {
      async reevaluate() {
        const error = new Error("reviewer failed before the host deadline");
        error.name = "TimeoutError";
        throw error;
      },
    };
    const state = setup({ reviewer });
    const materialized = materialize(state);
    const round = await runReadyRound(state, materialized);

    expect(round).toMatchObject({
      status: "failed",
      reevaluation: { outcome: "error", modalFallbackRequired: true },
    });
  });

  it("fails provider errors without reviewer use and records deny without persistent grant", async () => {
    const reviewer = {
      reevaluate: vi.fn(),
    } as unknown as RationaleScopeReviewer;
    const state = setup({ reviewer, approvalChoice: "deny-once" });
    const materialized = materialize(state);
    const round = await state.coordinator.handleRationaleRoundResult({
      ticketId: materialized.control.ticketId,
      result: {
        kind: "provider-failure",
        outcome: "generation-timeout",
      },
      now: NOW + 1,
    });

    expect(round).toMatchObject({
      status: "failed",
      generationOutcome: "generation-timeout",
      response: null,
      reevaluation: null,
      projection: { modalFallbackRequired: true },
    });
    expect(reviewer.reevaluate).not.toHaveBeenCalled();
    const approval = await state.coordinator.promptForApproval(
      materialized.control.ticketId,
      { now: NOW + 2 },
    );
    expect(approval).toMatchObject({
      outcome: "denied",
      ticket: { state: "denied", terminalReason: "user-deny" },
    });
    expect(state.approvalRequests[0]?.approvalCacheKey).toBe(materialized.action.approvalCacheKey);
    expect(state.approvalRequests[0]?.allowedChoices).toBeUndefined();
  });

  it("records an actual host modal timeout separately from a user deny", async () => {
    vi.useFakeTimers();
    try {
      const nativeWebContents = {
        send: vi.fn(),
        isDestroyed: vi.fn(() => false),
      };
      const gate = new ApprovalGate(nativeWebContents as never, undefined, 25);
      const state = setup({ approvalGate: gate, executionCwd: process.cwd() });
      const materialized = materialize(state);
      await state.coordinator.handleRationaleRoundResult({
        ticketId: materialized.control.ticketId,
        result: {
          kind: "provider-failure",
          outcome: "generation-timeout",
        },
        now: NOW + 1,
      });

      const pending = state.coordinator.promptForApproval(
        materialized.control.ticketId,
        { now: NOW + 2 },
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(gate.listPendingRendererRequests(nativeWebContents as never)).toEqual([expect.objectContaining({
        id: materialized.control.ticketId,
        kind: "tool",
      })]);
      expect(gate.listPendingRendererRequests(nativeWebContents as never)[0]?.persistentApprovalCwd).toBe(state.evaluationContext.executionCwd);
      expect(gate.getRequestSnapshot(materialized.control.ticketId)).toMatchObject({ toolName: state.candidate.toolName, approvalCacheKey: state.candidate.approvalCacheKey });
      await vi.advanceTimersByTimeAsync(26);
      await expect(pending).resolves.toMatchObject({
        outcome: "timed-out",
        ticket: {
          state: "cancelled",
          terminalReason: "modal-timeout",
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("burns an allow receipt path when current identity generations changed", async () => {
    const state = setup();
    const materialized = materialize(state);
    await runReadyRound(state, materialized);
    await state.coordinator.promptForApproval(materialized.control.ticketId, { now: NOW + 2 });
    state.generations.registry = "registry-generation-2";

    expect(await state.coordinator.createSealedResume({
      ticketId: materialized.control.ticketId,
      currentEligibilityContext: eligibilityContext,
      now: NOW + 3,
    })).toBeNull();
    state.generations.registry = "registry-generation-1";
    expect(await state.coordinator.createSealedResume({
      ticketId: materialized.control.ticketId,
      currentEligibilityContext: eligibilityContext,
      now: NOW + 3,
    })).toBeNull();
  });

  it("retires active tickets on abort and session close", () => {
    const abortedState = setup();
    const aborted = materialize(abortedState);
    expect(abortedState.coordinator.abort(
      aborted.control.ticketId,
      NOW + 1,
    )).toMatchObject({
      state: "cancelled",
      terminalReason: "caller-abort",
    });
    expect(abortedState.ticketStore.get({
      sessionId: aborted.control.anchor.sessionId,
      ticketId: aborted.control.ticketId,
      now: NOW + 1,
    })).toBeNull();

    const closedState = setup();
    const closed = materialize(closedState);
    expect(closedState.coordinator.closeSession(
      closed.control.anchor.sessionId,
      NOW + 1,
    )).toEqual([
      expect.objectContaining({
        ticket: expect.objectContaining({
          state: "cancelled",
          terminalReason: "session-close",
        }),
      }),
    ]);
    expect(closedState.coordinator.abort(closed.control.ticketId, NOW + 1)).toBeNull();
  });

  it("blocks the modal when the pre-modal projection audit cannot commit", async () => {
    let failProjection = true;
    const state = setup({
      onProjectionAudit: () => {
        if (failProjection) throw new Error("projection audit unavailable");
      },
    });
    const materialized = materialize(state);

    await expect(state.coordinator.handleRationaleRoundResult({
      ticketId: materialized.control.ticketId,
      result: {
        kind: "generation-failure",
        generationOutcome: "generation-error",
      },
      now: NOW + 1,
    })).rejects.toThrow(/projection audit unavailable/);
    expect(await state.coordinator.promptForApproval(
      materialized.control.ticketId,
      { now: NOW + 2 },
    )).toBeNull();
    expect(state.approvalGate.requestAndWait).not.toHaveBeenCalled();

    failProjection = false;
    expect(state.coordinator.abort(
      materialized.control.ticketId,
      NOW + 3,
    )).toMatchObject({
      state: "cancelled",
      terminalReason: "caller-abort",
    });
  });

  it("rejects an asynchronous projection audit sink before modal publication", async () => {
    const state = setup({
      onProjectionAudit: async () => {},
    });
    const materialized = materialize(state);

    await expect(state.coordinator.handleRationaleRoundResult({
      ticketId: materialized.control.ticketId,
      result: {
        kind: "generation-failure",
        generationOutcome: "generation-error",
      },
      now: NOW + 1,
    })).rejects.toThrow(/must complete synchronously/);
    expect(await state.coordinator.promptForApproval(
      materialized.control.ticketId,
      { now: NOW + 2 },
    )).toBeNull();
    expect(state.approvalGate.requestAndWait).not.toHaveBeenCalled();
  });

  it("does not expose an allow receipt when terminal projection audit fails", async () => {
    let projectionAttempt = 0;
    const state = setup({
      onProjectionAudit: () => {
        projectionAttempt += 1;
        if (projectionAttempt === 2) {
          throw new Error("terminal projection audit unavailable");
        }
      },
    });
    const materialized = materialize(state);
    await runReadyRound(state, materialized);

    await expect(state.coordinator.promptForApproval(
      materialized.control.ticketId,
      { now: NOW + 2 },
    )).rejects.toThrow(/terminal projection audit unavailable/);
    expect(state.approvalGate.requestAndWait).toHaveBeenCalledOnce();
    expect(state.projectionAudits).toHaveLength(1);
    expect(await state.coordinator.createSealedResume({
      ticketId: materialized.control.ticketId,
      currentEligibilityContext: eligibilityContext,
      now: NOW + 3,
    })).toBeNull();
  });

  it("quarantines an abort until its required ticket audit can be retried", async () => {
    let failAbortAudit = false;
    const state = setup({
      onTicketAudit: (event) => {
        if (failAbortAudit && event.event === "abort") {
          throw new Error("abort audit unavailable");
        }
      },
    });
    const materialized = materialize(state);
    await state.coordinator.handleRationaleRoundResult({
      ticketId: materialized.control.ticketId,
      result: {
        kind: "generation-failure",
        generationOutcome: "generation-error",
      },
      now: NOW + 1,
    });
    failAbortAudit = true;

    expect(() => state.coordinator.abort(
      materialized.control.ticketId,
      NOW + 2,
    )).toThrow(AggregateError);
    expect(await state.coordinator.promptForApproval(
      materialized.control.ticketId,
      { now: NOW + 2 },
    )).toBeNull();
    expect(state.ticketStore.get({
      sessionId: materialized.control.anchor.sessionId,
      ticketId: materialized.control.ticketId,
      now: NOW + 2,
    })?.ticket.state).toBe("user_pending");

    failAbortAudit = false;
    expect(state.coordinator.abort(
      materialized.control.ticketId,
      NOW + 3,
    )).toMatchObject({
      state: "cancelled",
      terminalReason: "caller-abort",
    });
  });

  it("surfaces abort-listener audit failure through the prompt promise", async () => {
    let failAbortAudit = false;
    const state = setup({
      deferApproval: true,
      onTicketAudit: (event) => {
        if (failAbortAudit && event.event === "abort") {
          throw new Error("listener abort audit unavailable");
        }
      },
    });
    const materialized = materialize(state);
    await state.coordinator.handleRationaleRoundResult({
      ticketId: materialized.control.ticketId,
      result: {
        kind: "generation-failure",
        generationOutcome: "generation-error",
      },
      now: NOW + 1,
    });
    failAbortAudit = true;
    const caller = new AbortController();
    const pending = state.coordinator.promptForApproval(
      materialized.control.ticketId,
      { abortSignal: caller.signal, now: NOW + 2 },
    );
    await vi.waitFor(() => {
      expect(state.approvalGate.requestAndWait).toHaveBeenCalledOnce();
    });

    expect(() => caller.abort(new Error("caller cancelled"))).not.toThrow();
    await expect(pending).rejects.toThrow(AggregateError);
    expect(state.ticketStore.get({
      sessionId: materialized.control.anchor.sessionId,
      ticketId: materialized.control.ticketId,
      now: NOW + 2,
    })?.ticket.state).toBe("user_pending");

    failAbortAudit = false;
    expect(state.coordinator.abort(
      materialized.control.ticketId,
      NOW + 3,
    )).toMatchObject({
      state: "cancelled",
      terminalReason: "caller-abort",
    });
  });

  it("settles an abort when gate cancellation throws and approval never settles", async () => {
    let failCancellation = true;
    const ticketAudits: RationaleTicketStoreAuditEvent[] = [];
    const approvalGate = {
      requestAndWait: vi.fn((_request: Omit<ApprovalRequest, "requireExplicit">) =>
        new Promise<ApprovalDecision>(() => {})),
      cancelPendingRequest: vi.fn(() => {
        if (failCancellation) throw new Error("approval cancellation unavailable");
        return false;
      }),
    } satisfies Pick<ApprovalGate, "requestAndWait" | "cancelPendingRequest">;
    const state = setup({
      approvalGate,
      onTicketAudit: (event) => ticketAudits.push(event),
    });
    const materialized = materialize(state);
    await state.coordinator.handleRationaleRoundResult({
      ticketId: materialized.control.ticketId,
      result: {
        kind: "generation-failure",
        generationOutcome: "generation-error",
      },
      now: NOW + 1,
    });
    const caller = new AbortController();
    const pending = state.coordinator.promptForApproval(
      materialized.control.ticketId,
      { abortSignal: caller.signal, now: NOW + 2 },
    );
    await vi.waitFor(() => {
      expect(approvalGate.requestAndWait).toHaveBeenCalledOnce();
    });

    expect(() => caller.abort()).not.toThrow();
    await expect(pending).rejects.toThrow(AggregateError);
    expect(state.ticketStore.get({
      sessionId: materialized.control.anchor.sessionId,
      ticketId: materialized.control.ticketId,
      now: NOW + 2,
    })).toBeNull();
    expect(ticketAudits.filter((event) => event.event === "abort")).toHaveLength(1);

    failCancellation = false;
    expect(state.coordinator.abort(
      materialized.control.ticketId,
      NOW + 3,
    )).toMatchObject({
      state: "cancelled",
      terminalReason: "caller-abort",
    });
    expect(approvalGate.cancelPendingRequest).toHaveBeenCalledTimes(2);
    expect(ticketAudits.some((event) => event.operation === "replay-rejected"))
      .toBe(false);
  });

  it("quarantines session close contexts until ticket audit recovery", async () => {
    let failCloseAudit = false;
    const state = setup({
      onTicketAudit: (event) => {
        if (failCloseAudit && event.event === "session-close") {
          throw new Error("session close audit unavailable");
        }
      },
    });
    const materialized = materialize(state);
    await state.coordinator.handleRationaleRoundResult({
      ticketId: materialized.control.ticketId,
      result: {
        kind: "generation-failure",
        generationOutcome: "generation-error",
      },
      now: NOW + 1,
    });
    failCloseAudit = true;

    expect(() => state.coordinator.closeSession(
      materialized.control.anchor.sessionId,
      NOW + 2,
    )).toThrow(AggregateError);
    expect(await state.coordinator.promptForApproval(
      materialized.control.ticketId,
      { now: NOW + 2 },
    )).toBeNull();
    expect(state.ticketStore.get({
      sessionId: materialized.control.anchor.sessionId,
      ticketId: materialized.control.ticketId,
      now: NOW + 2,
    })?.ticket.state).toBe("user_pending");

    failCloseAudit = false;
    expect(state.coordinator.closeSession(
      materialized.control.anchor.sessionId,
      NOW + 3,
    )).toEqual([
      expect.objectContaining({
        ticket: expect.objectContaining({
          state: "cancelled",
          terminalReason: "session-close",
        }),
      }),
    ]);
  });

  it("retains session-close context until gate cancellation can be retried", async () => {
    let failCancellation = true;
    let settleApproval: ((decision: ApprovalDecision) => void) | null = null;
    const approvalGate = {
      requestAndWait: vi.fn((_request: Omit<ApprovalRequest, "requireExplicit">) =>
        new Promise<ApprovalDecision>((resolve) => {
          settleApproval = resolve;
        })),
      cancelPendingRequest: vi.fn((requestId: string) => {
        if (failCancellation) throw new Error("session cancellation unavailable");
        settleApproval?.({ requestId, choice: "deny-once" });
        return true;
      }),
    } satisfies Pick<ApprovalGate, "requestAndWait" | "cancelPendingRequest">;
    const state = setup({ approvalGate });
    const materialized = materialize(state);
    await state.coordinator.handleRationaleRoundResult({
      ticketId: materialized.control.ticketId,
      result: {
        kind: "generation-failure",
        generationOutcome: "generation-error",
      },
      now: NOW + 1,
    });
    const pending = state.coordinator.promptForApproval(
      materialized.control.ticketId,
      { now: NOW + 2 },
    );
    await vi.waitFor(() => {
      expect(approvalGate.requestAndWait).toHaveBeenCalledOnce();
    });

    expect(() => state.coordinator.closeSession(
      materialized.control.anchor.sessionId,
      NOW + 2,
    )).toThrow(AggregateError);
    expect(state.ticketStore.get({
      sessionId: materialized.control.anchor.sessionId,
      ticketId: materialized.control.ticketId,
      now: NOW + 2,
    })).toBeNull();

    failCancellation = false;
    expect(state.coordinator.closeSession(
      materialized.control.anchor.sessionId,
      NOW + 3,
    )).toEqual([]);
    await expect(pending).resolves.toBeNull();
    expect(approvalGate.cancelPendingRequest).toHaveBeenCalledTimes(2);
  });

  function reviewerReturning(
    scopeAlignment: "aligned" | "unclear" | "outside",
    level: "low" | "medium" | "high",
  ): RationaleScopeReviewer {
    return {
      async reevaluate(input) {
        return createReviewerScopeReevaluation({
          control: input.control,
          outcome: "fresh",
          scopeAlignment,
          scopeReasons: ["scope re-evaluation reason"],
          reevaluatedVerdict: { level, reason: "reviewer re-evaluated verdict" },
          now: input.now,
        });
      },
    } satisfies RationaleScopeReviewer;
  }

  async function runReadyRound(
    state: ReturnType<typeof setup>,
    materialized: ReturnType<typeof materialize>,
  ) {
    return state.coordinator.handleRationaleRoundResult({
      ticketId: materialized.control.ticketId,
      result: {
        kind: "calls",
        calls: [{
          id: "rationale-call-1",
          name: "permission_rationale",
          input: responseFor(materialized.control),
        }],
      },
      now: NOW + 1,
    });
  }

  it("auto-approves a fresh low/medium reviewer terminal without a modal", async () => {
    const state = setup({ reviewer: reviewerReturning("aligned", "medium") });
    const materialized = materialize(state);
    const round = await runReadyRound(state, materialized);

    expect(round).toMatchObject({
      status: "ready",
      generationOutcome: "accepted-rationale",
      autoApproved: true,
      reevaluation: { outcome: "fresh", scopeAlignment: "aligned" },
      projection: {
        rationaleStatus: "ready",
        reevaluationOutcome: "fresh",
        scopeAlignment: "aligned",
        modalFallbackRequired: false,
        terminalReason: "allowed-once",
        autoApproved: true,
      },
    });
    expect(state.approvalGate.requestAndWait).not.toHaveBeenCalled();
    expect(state.projectionAudits.map(({ projection }) => [
      projection.terminalReason,
      projection.autoApproved,
    ])).toEqual([["allowed-once", true]]);
    expect(state.ticketStore.get({
      sessionId: materialized.control.anchor.sessionId,
      ticketId: materialized.control.ticketId,
      now: NOW + 1,
    })).toBeNull();
    expect(await state.coordinator.promptForApproval(
      materialized.control.ticketId,
      { now: NOW + 2 },
    )).toBeNull();
    expect(state.approvalGate.requestAndWait).not.toHaveBeenCalled();

    // Execution requires a host-minted single-use receipt even after reviewer authorization.
    const sealed = await state.coordinator.createSealedResume({
      ticketId: materialized.control.ticketId,
      currentEligibilityContext: eligibilityContext,
      now: NOW + 3,
    });
    expect(sealed?.resumeRequest).toMatchObject({
      kind: "sealed-rationale-resume",
      actionDigest: materialized.action.actionDigest,
      executionEntryPoint: "tool-executor-security-suffix",
      directToolExecute: "forbidden",
    });
    expect(state.ticketStore.isAuthenticConsumedAllowOnceReceipt(
      sealed!.hostConsumedAllowOnceReceipt,
      NOW + 3,
    )).toBe(true);
    expect(await state.coordinator.createSealedResume({
      ticketId: materialized.control.ticketId,
      currentEligibilityContext: eligibilityContext,
      now: NOW + 3,
    })).toBeNull();
  });

  it.each(["low", "medium"] as const)(
    "auto-approves fresh %s and never opens the gate",
    async (level) => {
      const state = setup({ reviewer: reviewerReturning("aligned", level) });
      const materialized = materialize(state);
      const round = await runReadyRound(state, materialized);
      expect(round?.autoApproved).toBe(true);
      expect(state.approvalGate.requestAndWait).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["aligned", "high"],
    ["outside", "high"],
    ["unclear", "high"],
  ] as const)(
    "routes %s+%s to the user modal instead of auto-approving",
    async (scopeAlignment, level) => {
      const state = setup({ reviewer: reviewerReturning(scopeAlignment, level) });
      const materialized = materialize(state);
      const round = await runReadyRound(state, materialized);

      expect(round).toMatchObject({
        status: "ready",
        autoApproved: false,
        ticket: { ticket: { state: "user_pending" } },
        projection: { autoApproved: false, terminalReason: null },
      });
      expect(state.approvalGate.requestAndWait).not.toHaveBeenCalled();

      const approval = await state.coordinator.promptForApproval(
        materialized.control.ticketId,
        { now: NOW + 2 },
      );
      expect(approval).toMatchObject({
        outcome: "allowed-once",
        ticket: { state: "allowed_once", terminalReason: "allowed-once" },
      });
      expect(state.approvalGate.requestAndWait).toHaveBeenCalledTimes(1);
      // Preserve provenance differences between user allow-once and reviewer auto-approval.
      expect(state.projectionAudits.map(({ projection }) => [
        projection.terminalReason,
        projection.autoApproved,
      ])).toEqual([[null, false], ["allowed-once", false]]);
    },
  );

  it("fails closed and exposes no receipt when the auto-approve audit cannot commit", async () => {
    const state = setup({
      reviewer: reviewerReturning("aligned", "medium"),
      onProjectionAudit: () => {
        throw new Error("auto-approve projection audit unavailable");
      },
    });
    const materialized = materialize(state);

    await expect(runReadyRound(state, materialized))
      .rejects.toThrow(/auto-approve projection audit unavailable/);
    expect(state.approvalGate.requestAndWait).not.toHaveBeenCalled();
    expect(await state.coordinator.createSealedResume({
      ticketId: materialized.control.ticketId,
      currentEligibilityContext: eligibilityContext,
      now: NOW + 3,
    })).toBeNull();
  });
});

describe("reviewer denial model choices", () => {
  const choiceCall = (control: RationaleRequiredControl, choice: "accept" | "ask_user") => {
    const { rationale: _rationale, userQuote: _userQuote, ...binding } = responseFor(control);
    return { id: "choice", name: "permission_rationale", input: { ...binding, choice } };
  };
  const review = (level: "low" | "high"): RationaleScopeReviewer => ({
    async reevaluate(input) {
      return createReviewerScopeReevaluation({ control: input.control, outcome: "fresh",
        scopeAlignment: "aligned", scopeReasons: ["Same host-sealed action"],
        reevaluatedVerdict: { level, reason: "Bounded review" }, now: input.now });
    },
  });

  it("accept denies without a card or another reviewer call", async () => {
    const reviewer = { reevaluate: vi.fn() } satisfies RationaleScopeReviewer;
    const onReviewerChoiceResolved = vi.fn();
    const state = setup({ reviewer, onReviewerChoiceResolved });
    const { control } = materialize(state);
    const resolution = await state.coordinator.handleRationaleRoundResult({ ticketId: control.ticketId,
      result: { kind: "calls", calls: [choiceCall(control, "accept")] }, now: NOW });
    expect(resolution?.modelDenied).toBe(true);
    expect(onReviewerChoiceResolved).toHaveBeenCalledExactlyOnceWith(control.anchor.sessionId, "review-request-1", "deny");
    expect(reviewer.reevaluate).not.toHaveBeenCalled();
    expect(state.approvalRequests).toHaveLength(0);
    expect(resolution?.ticket.ticket).toMatchObject({ state: "denied", terminalReason: "model-accepted-denial" });
    expect(resolution?.projection.terminalReason).toBe("model-accepted-denial");
    expect(state.ticketStore.get({ sessionId: control.anchor.sessionId, ticketId: control.ticketId, now: NOW })).toBeNull();
  });

  it.each(["low", "high"] as const)("verified resubmission with %s uses one reviewer judgment", async (level) => {
    const reviewer = review(level);
    const reevaluate = vi.spyOn(reviewer, "reevaluate");
    const state = setup({ reviewer });
    const { control } = materialize(state);
    const resolution = await state.coordinator.handleRationaleRoundResult({ ticketId: control.ticketId,
      result: { kind: "calls", calls: [{ id: "resubmit", name: "permission_rationale", input: responseFor(control) }] }, now: NOW });
    expect(reevaluate).toHaveBeenCalledTimes(1);
    expect(reevaluate.mock.calls[0]?.[0]).toMatchObject({ verifiedUserQuote: "remove the private build output",
      hostSafetyFacts: { targetPaths: control.action.canonicalTargets, changeScope: control.action.requestedEffects } });
    expect(resolution?.autoApproved).toBe(level === "low");
    if (level === "high") {
      await state.coordinator.promptForApproval(control.ticketId, { now: NOW });
      expect(state.approvalRequests).toHaveLength(1);
    } else expect(state.approvalRequests).toHaveLength(0);
    expect(await state.coordinator.handleRationaleRoundResult({ ticketId: control.ticketId,
      result: { kind: "calls", calls: [{ id: "second", name: "permission_rationale", input: responseFor(control) }] }, now: NOW })).toBeNull();
    expect(reevaluate).toHaveBeenCalledTimes(1);
  });

  it.each(["tool output quote", "model turn quote"])("refuses %s without reviewer authority", async (quote) => {
    const reviewer = { reevaluate: vi.fn() } satisfies RationaleScopeReviewer;
    const state = setup({ reviewer, userRoleTexts: ["Only inspect the workspace."] });
    const { control } = materialize(state);
    const resolution = await state.coordinator.handleRationaleRoundResult({ ticketId: control.ticketId,
      result: { kind: "calls", calls: [{ id: "resubmit", name: "permission_rationale", input: { ...responseFor(control), userQuote: quote } }] }, now: NOW });
    expect(resolution?.autoApproved).toBe(false);
    expect(reviewer.reevaluate).not.toHaveBeenCalled();
    await state.coordinator.promptForApproval(control.ticketId, { now: NOW });
    expect(state.approvalRequests).toHaveLength(1);
  });

  it.each([false, true])("ask_user is a normal card or a headless denial (headless=%s)", async (headless) => {
    const recordTerminalDenial = vi.fn(async (_reason: string) => {});
    const state = setup({ headless, recordTerminalDenial });
    const { control } = materialize(state);
    await state.coordinator.handleRationaleRoundResult({ ticketId: control.ticketId,
      result: { kind: "calls", calls: [choiceCall(control, "ask_user")] }, now: NOW });
    const result = await state.coordinator.promptForApproval(control.ticketId, { now: NOW });
    expect(result?.outcome).toBe(headless ? "denied" : "allowed-once");
    expect(state.approvalRequests).toHaveLength(headless ? 0 : 1);
    if (!headless) {
      expect(state.approvalRequests[0]).toMatchObject({ kind: "tool", args: control.sealedAction.finalInput });
      expect(state.approvalRequests[0]?.allowedChoices).toBeUndefined();
    }
    else expect(result?.ticket.terminalReason).toBe("no-approver");
    if (headless) expect(recordTerminalDenial).toHaveBeenCalledExactlyOnceWith("Nobody can approve this request; do not retry.");
    else expect(recordTerminalDenial).not.toHaveBeenCalled();
  });
});

it("gives each distinct denied request its own round in one user turn", () => {
  const state = setup();
  const first = materialize(state);
  const secondCandidate = {
    ...state.candidate,
    toolUseId: "second-request",
    triggeringBatchDisposition: createTriggeringBatchDisposition({
      batchId: "second-provider-batch",
      originalToolUseIds: ["second-request"],
      triggeringToolUseId: "second-request",
      completedToolUseIds: [],
    }),
  };
  const second = state.coordinator.materializeRationaleControl(secondCandidate);
  expect(second).not.toBeNull();
  expect(second?.control.anchor.anchorId).toBe(first.control.anchor.anchorId);
  expect(second?.control.ticketId).not.toBe(first.control.ticketId);
  expect(state.coordinator.materializeRationaleControl(state.candidate)).toBeNull();
  expect(state.coordinator.materializeRationaleControl(secondCandidate)).toBeNull();
  expect(state.coordinator.materializeRationaleControl({
    ...secondCandidate, finalInput: { command: "a different action" },
  })).toBeNull();
});

it.each([
  ["aligned", "low"], ["outside", "low"], ["unclear", "low"],
  ["aligned", "medium"], ["outside", "medium"], ["unclear", "medium"],
] as const)("uses fresh %s metadata with %s as the re-judged allow result", async (scopeAlignment, level) => {
  const state = setup({ reviewer: { async reevaluate(input) {
    return createReviewerScopeReevaluation({ control: input.control, outcome: "fresh", scopeAlignment,
      scopeReasons: ["Host-sealed action re-judged"], reevaluatedVerdict: { level, reason: "Re-judged action" }, now: input.now });
  } } });
  const { control } = materialize(state);
  const result = await state.coordinator.handleRationaleRoundResult({ ticketId: control.ticketId,
    result: { kind: "calls", calls: [{ id: "resubmit", name: "permission_rationale", input: responseFor(control) }] }, now: NOW });
  expect(result?.autoApproved).toBe(true);
  expect(result?.reevaluation).toMatchObject({ scopeAlignment, reevaluatedVerdict: { level } });
  expect(state.approvalRequests).toHaveLength(0);
});

it("does not count a caller abort before model choice resolves as a reviewer denial", () => {
  const onReviewerChoiceResolved = vi.fn();
  const state = setup({ onReviewerChoiceResolved });
  const { control } = materialize(state);
  state.coordinator.abort(control.ticketId, NOW);
  expect(onReviewerChoiceResolved).not.toHaveBeenCalled();
});

it.each(["allow-once", "allow-session", "allow-always"] as const)("normal rationale fallback accepts %s and issues only one current execution receipt", async (approvalChoice) => {
  const state = setup({ approvalChoice });
  const { control } = materialize(state);
  await state.coordinator.handleRationaleRoundResult({ ticketId: control.ticketId,
    result: { kind: "calls", calls: [{ id: "resubmit", name: "permission_rationale", input: responseFor(control) }] }, now: NOW });
  const decision = await state.coordinator.promptForApproval(control.ticketId, { now: NOW });
  expect(decision?.outcome).toBe("allowed-once");
  expect(state.approvalRequests[0]).toMatchObject({ kind: "tool", args: control.sealedAction.finalInput,
    approvalCacheKey: state.candidate.approvalCacheKey });
  expect(state.approvalRequests[0]?.allowedChoices).toBeUndefined();
  expect(await state.coordinator.promptForApproval(control.ticketId, { now: NOW })).toBeNull();
});


it("preserves an explicit hook or policy denial without relabeling it as user cancellation", async () => {
  const state = setup({ requestHumanApproval: async () => { throw new RationaleHumanApprovalDeniedError("The permission hook blocked this request."); } });
  const { control } = materialize(state);
  await state.coordinator.handleRationaleRoundResult({ ticketId: control.ticketId,
    result: { kind: "calls", calls: [{ id: "resubmit", name: "permission_rationale", input: responseFor(control) }] }, now: NOW });
  const result = await state.coordinator.promptForApproval(control.ticketId, { now: NOW });
  expect(result).toMatchObject({ outcome: "denied", reason: "The permission hook blocked this request.",
    ticket: { state: "denied", terminalReason: "host-denied" } });
  expect(state.approvalRequests).toHaveLength(0);
  expect(await state.coordinator.createSealedResume({ ticketId: control.ticketId, currentEligibilityContext: eligibilityContext, now: NOW })).toBeNull();
});

it("propagates approval callback contract failures without a cancellation result", async () => {
  const failure = new Error("Approval response violated its host contract");
  const state = setup({ requestHumanApproval: async () => { throw failure; } });
  const { control } = materialize(state);
  await state.coordinator.handleRationaleRoundResult({ ticketId: control.ticketId,
    result: { kind: "calls", calls: [{ id: "resubmit", name: "permission_rationale", input: responseFor(control) }] }, now: NOW });
  await expect(state.coordinator.promptForApproval(control.ticketId, { now: NOW })).rejects.toBe(failure);
  expect(state.approvalRequests).toHaveLength(0);
  expect(await state.coordinator.createSealedResume({ ticketId: control.ticketId, currentEligibilityContext: eligibilityContext, now: NOW })).toBeNull();
});


it("preserves the no-retry message when an owner-away rationale card auto-skips", async () => {
  vi.useFakeTimers();
  try {
    const nativeWebContents = { send: vi.fn(), isDestroyed: vi.fn(() => false) };
    const gate = new ApprovalGate(nativeWebContents as never, undefined, 25);
    gate.setOwnerAwayAutoSkipMinutes(1);
    const recordTerminalDenial = vi.fn(async (_reason: string) => {});
    const state = setup({ recordTerminalDenial, approvalGate: gate, executionCwd: process.cwd(), ownerUnattended: true });
    const { control } = materialize(state);
    await state.coordinator.handleRationaleRoundResult({ ticketId: control.ticketId,
      result: { kind: "provider-failure", outcome: "generation-timeout" }, now: NOW });
    const pending = state.coordinator.promptForApproval(control.ticketId, { now: NOW });
    await vi.advanceTimersByTimeAsync(0);
    expect(gate.listPendingRendererRequests(nativeWebContents as never)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_001);
    await expect(pending).resolves.toMatchObject({ outcome: "timed-out",
      reason: "Nobody can approve this request; do not retry.", ticket: { terminalReason: "modal-timeout" } });
    expect(gate.listPendingRendererRequests(nativeWebContents as never)).toHaveLength(0);
    expect(recordTerminalDenial).toHaveBeenCalledExactlyOnceWith("Nobody can approve this request; do not retry.");
    expect(await state.coordinator.createSealedResume({ ticketId: control.ticketId, currentEligibilityContext: eligibilityContext, now: NOW })).toBeNull();
  } finally { vi.useRealTimers(); }
});


it("keeps an already published ordinary card waiting beyond the model-response deadline", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  try {
    const state = setup({ deferApproval: true, ownerUnattended: true, now: () => Date.now() });
    const { control } = materialize(state);
    await state.coordinator.handleRationaleRoundResult({ ticketId: control.ticketId,
      result: { kind: "calls", calls: [{ id: "resubmit", name: "permission_rationale", input: responseFor(control) }] } });
    const pending = state.coordinator.promptForApproval(control.ticketId);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(control.anchor.expiresAt - Date.now() + 1);
    expect(state.approvalRequests).toHaveLength(1);
    expect(verifyRationaleRequiredControl(control)).toBe(false);
    expect(parseRationaleResponse(responseFor(control), control)).toBeNull();
    expect(verifyRationaleExecutionControl(control)).toBe(false);
    expect(state.resolvePendingApproval(control.ticketId, "allow-once")).toBe(true);
    await expect(pending).resolves.toMatchObject({ outcome: "allowed-once" });
    expect(verifyRationaleRequiredControl(control)).toBe(false);
    expect(verifyRationaleExecutionControl(control)).toBe(true);
    expect(await state.coordinator.createSealedResume({ ticketId: control.ticketId, currentEligibilityContext: eligibilityContext })).not.toBeNull();
    state.coordinator.abort(control.ticketId);
    expect(verifyRationaleExecutionControl(control)).toBe(false);
  } finally { vi.useRealTimers(); }
});

it("rejects an expired request that never published a human card", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  try {
    const state = setup({ now: () => Date.now() });
    const { control } = materialize(state);
    await vi.advanceTimersByTimeAsync(control.anchor.expiresAt - Date.now() + 1);
    expect(verifyRationaleRequiredControl(control)).toBe(false);
    expect(verifyRationaleExecutionControl(control)).toBe(false);
    expect(await state.coordinator.handleRationaleRoundResult({ ticketId: control.ticketId,
      result: { kind: "calls", calls: [{ id: "late", name: "permission_rationale", input: responseFor(control) }] } })).toBeNull();
    expect(state.approvalRequests).toHaveLength(0);
  } finally { vi.useRealTimers(); }
});

it("rejects a late human answer after the waiting request was aborted", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  try {
    const state = setup({ deferApproval: true, ownerUnattended: true, now: () => Date.now() });
    const { control } = materialize(state);
    await state.coordinator.handleRationaleRoundResult({ ticketId: control.ticketId,
      result: { kind: "calls", calls: [{ id: "resubmit", name: "permission_rationale", input: responseFor(control) }] } });
    const pending = state.coordinator.promptForApproval(control.ticketId);
    await vi.advanceTimersByTimeAsync(control.anchor.expiresAt - Date.now() + 1);
    state.coordinator.abort(control.ticketId);
    await expect(pending).resolves.toBeNull();
    expect(state.resolvePendingApproval(control.ticketId, "allow-once")).toBe(false);
    expect(verifyRationaleExecutionControl(control)).toBe(false);
    expect(await state.coordinator.createSealedResume({ ticketId: control.ticketId, currentEligibilityContext: eligibilityContext })).toBeNull();
  } finally { vi.useRealTimers(); }
});

it.each(["abort", "prestart-terminal"] as const)("revokes an approved human receipt on %s before execution", async (boundary) => {
  const state = setup();
  const { control } = materialize(state);
  await state.coordinator.handleRationaleRoundResult({ ticketId: control.ticketId,
    result: { kind: "calls", calls: [{ id: "resubmit", name: "permission_rationale", input: responseFor(control) }] }, now: NOW });
  await state.coordinator.promptForApproval(control.ticketId, { now: NOW });
  const sealed = await state.coordinator.createSealedResume({ ticketId: control.ticketId, currentEligibilityContext: eligibilityContext, now: NOW });
  expect(sealed).not.toBeNull();
  const receipt = sealed!.hostConsumedAllowOnceReceipt;
  expect(state.ticketStore.isAuthenticConsumedAllowOnceReceipt(receipt, NOW)).toBe(true);
  if (boundary === "abort") state.coordinator.abort(control.ticketId, NOW);
  else state.coordinator.revokeUnstartedResume(sealed!.resumeRequest);
  expect(state.ticketStore.isAuthenticConsumedAllowOnceReceipt(receipt, NOW)).toBe(false);
  expect(state.coordinator.loadHostConsumedAllowOnceReceipt(sealed!.resumeRequest)).toBeNull();
  expect(await state.coordinator.resolveCurrentActionIdentity({ request: sealed!.resumeRequest } as never)).toBeNull();
});


it("retires a changed policy before opening a stale ordinary card", async () => {
  const hooks = new HookRunner();
  const state = setup({ policySnapshot: () => captureRationalePolicySnapshot({ hookRunner: hooks, additionalDirectories: [] }) });
  const { control } = materialize(state);
  await state.coordinator.handleRationaleRoundResult({ ticketId: control.ticketId,
    result: { kind: "calls", calls: [{ id: "resubmit", name: "permission_rationale", input: responseFor(control) }] }, now: NOW });
  hooks.registerPreHook("new-policy-boundary", () => ({ action: "allow" }));
  const result = await state.coordinator.promptForApproval(control.ticketId, { now: NOW });
  expect(result).toMatchObject({ outcome: "denied", reason: "Permission policy changed before approval; the action was not executed.",
    ticket: { state: "rejected", terminalReason: "identity-mismatch" } });
  expect(state.approvalRequests).toHaveLength(0);
  expect(state.ticketStore.get({ sessionId: control.anchor.sessionId, ticketId: control.ticketId, now: NOW })).toBeNull();
  expect(await state.coordinator.createSealedResume({ ticketId: control.ticketId, currentEligibilityContext: eligibilityContext, now: NOW })).toBeNull();
});

it("propagates a sealed action contract violation before any approval card", () => {
  const state = setup();
  expect(() => state.coordinator.materializeRationaleControl({ ...state.candidate,
    finalInput: { unsupported: () => "not JSON" } })).toThrow();
  expect(state.approvalRequests).toHaveLength(0);
  expect(state.ticketStore.activeTicketIds(state.candidate.requestAnchor.sessionId, NOW)).toHaveLength(0);
});


it("throws an invalid trusted session contract instead of falling through to a human card", () => {
  const state = setup({ sessionId: "invalid-host-session" });
  expect(isRationaleEligible({ permission: state.candidate.permission,
    anchor: state.candidate.requestAnchor, invocationTrustOrigin: state.candidate.invocationTrustOrigin,
    rationaleProvenance, now: NOW })).toBe(true);
  expect(() => state.coordinator.materializeRationaleControl(state.candidate)).toThrow("invalid rationale ticket session id");
  expect(state.approvalGate.requestAndWait).not.toHaveBeenCalled();
  expect(state.approvalRequests).toHaveLength(0);
  expect(state.invocationAudits).toHaveLength(0);
});


it("sends the full native negative user context to re-review without granting on the matching substring", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  try {
  const complete = vi.fn<LlmReviewerProvider["complete"]>(async () => ({
    text: JSON.stringify({ level: "high", reason: "The user forbids this deletion.",
      scopeAlignment: "outside", scopeReasons: ["The full user turn says not to delete X."] }),
    tokensIn: 1, tokensOut: 1, costUsd: 0,
  }));
  const message = "do not delete X";
  const state = setup({ userRoleTexts: [message], reviewer: new LlmRationaleScopeReviewer({ complete }, "reviewer-model") });
  const candidate = { ...state.candidate, originalInput: { command: "rm -f X" }, finalInput: { command: "rm -f X" }, canonicalTargets: ["workspace/X"] };
  candidate.requestHumanApproval = createRationaleApprovalCallback({ candidate, approvalGate: state.approvalGate,
    evaluationContext: { ...state.evaluationContext, targetFilePaths: ["workspace/X"] } });
  const materialized = state.coordinator.materializeRationaleControl(candidate);
  if (!materialized) throw new Error("Negative-context request could not be materialized");
  const { control } = materialized;
  const result = await state.coordinator.handleRationaleRoundResult({ ticketId: control.ticketId,
    result: { kind: "calls", calls: [{ id: "resubmit", name: "permission_rationale",
      input: { ...responseFor(control), userQuote: "delete X", rationale: "The matching words authorize deletion." } }] }, now: NOW });
  expect(complete).toHaveBeenCalledTimes(1);
  const sent = complete.mock.calls[0]![0];
  expect(JSON.parse(sent.userPrompt)).toMatchObject({ verifiedUserQuote: "delete X", verifiedUserMessages: [message], matchedUserMessageIndex: 0,
    untrustedModelClaim: "The matching words authorize deletion." });
  expect(sent.systemPrompt).toContain("preserving negation, later revocations, conditions and limits");
  expect(result?.autoApproved).toBe(false);
  expect(state.approvalRequests).toHaveLength(0);
  expect(await state.coordinator.createSealedResume({ ticketId: control.ticketId, currentEligibilityContext: eligibilityContext, now: NOW })).toBeNull();
  await state.coordinator.promptForApproval(control.ticketId, { now: NOW });
  expect(state.approvalRequests).toHaveLength(1);
  } finally { vi.useRealTimers(); }
});

it.each(["x".repeat(16 * 1024 + 1), "가".repeat(5500)])("falls back to a card when the full matching native turn exceeds the evidence budget %#", async (prefix) => {
  const reviewer = { reevaluate: vi.fn() } satisfies RationaleScopeReviewer;
  const state = setup({ userRoleTexts: ["delete X", prefix + " do not delete X"], reviewer });
  const { control } = materialize(state);
  const result = await state.coordinator.handleRationaleRoundResult({ ticketId: control.ticketId,
    result: { kind: "calls", calls: [{ id: "resubmit", name: "permission_rationale",
      input: { ...responseFor(control), userQuote: "delete X" } }] }, now: NOW });
  expect(reviewer.reevaluate).not.toHaveBeenCalled();
  expect(result?.autoApproved).toBe(false);
  await state.coordinator.promptForApproval(control.ticketId, { now: NOW });
  expect(state.approvalRequests).toHaveLength(1);
});


it("includes later native revocation when the model quotes an earlier grant", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  try {
  const messages = ["Please delete X", "Do not delete X; I revoke that permission", "Continue inspecting the project"];
  const complete = vi.fn<LlmReviewerProvider["complete"]>(async () => ({
    text: JSON.stringify({ level: "high", reason: "The later user turn revokes permission.",
      scopeAlignment: "outside", scopeReasons: ["The earlier quote does not override the later constraint."] }),
    tokensIn: 1, tokensOut: 1, costUsd: 0,
  }));
  const state = setup({ userRoleTexts: messages, reviewer: new LlmRationaleScopeReviewer({ complete }, "reviewer-model") });
  const candidate = { ...state.candidate, originalInput: { command: "rm -f X" }, finalInput: { command: "rm -f X" }, canonicalTargets: ["workspace/X"] };
  candidate.requestHumanApproval = createRationaleApprovalCallback({ candidate, approvalGate: state.approvalGate,
    evaluationContext: { ...state.evaluationContext, targetFilePaths: ["workspace/X"] } });
  const materialized = state.coordinator.materializeRationaleControl(candidate);
  if (!materialized) throw new Error("Revoked-context request could not be materialized");
  const { control } = materialized;
  const result = await state.coordinator.handleRationaleRoundResult({ ticketId: control.ticketId,
    result: { kind: "calls", calls: [{ id: "resubmit", name: "permission_rationale",
      input: { ...responseFor(control), userQuote: messages[0]! } }] }, now: NOW });
  expect(complete).toHaveBeenCalledTimes(1);
  expect(JSON.parse(complete.mock.calls[0]![0].userPrompt)).toMatchObject({
    verifiedUserQuote: messages[0], verifiedUserMessages: messages, matchedUserMessageIndex: 0 });
  expect(result?.autoApproved).toBe(false);
  expect(await state.coordinator.createSealedResume({ ticketId: control.ticketId, currentEligibilityContext: eligibilityContext, now: NOW })).toBeNull();
  await state.coordinator.promptForApproval(control.ticketId, { now: NOW });
  expect(state.approvalRequests).toHaveLength(1);
  } finally { vi.useRealTimers(); }
});

it("falls back when the complete chronological evidence exceeds the total budget", async () => {
  const reviewer = { reevaluate: vi.fn() } satisfies RationaleScopeReviewer;
  const state = setup({ userRoleTexts: ["a".repeat(9000) + " delete X", "b".repeat(9000) + " do not delete X"], reviewer });
  const { control } = materialize(state);
  const result = await state.coordinator.handleRationaleRoundResult({ ticketId: control.ticketId,
    result: { kind: "calls", calls: [{ id: "resubmit", name: "permission_rationale", input: { ...responseFor(control), userQuote: "delete X" } }] }, now: NOW });
  expect(reviewer.reevaluate).not.toHaveBeenCalled();
  expect(result?.autoApproved).toBe(false);
  await state.coordinator.promptForApproval(control.ticketId, { now: NOW });
  expect(state.approvalRequests).toHaveLength(1);
});

it.each([false, true])("records a final model-accepted denial once without opening a card (headless=%s)", async (headless) => {
  const recordTerminalDenial = vi.fn(async (_reason: string) => {});
  const state = setup({ recordTerminalDenial, headless });
  const { control } = materialize(state);
  const { rationale: _rationale, userQuote: _quote, ...binding } = responseFor(control);
  const result = await state.coordinator.handleRationaleRoundResult({ ticketId: control.ticketId,
    result: { kind: "calls", calls: [{ id: "accept", name: "permission_rationale", input: { ...binding, choice: "accept" } }] }, now: NOW });
  expect(result?.modelDenied).toBe(true);
  expect(recordTerminalDenial).toHaveBeenCalledExactlyOnceWith(headless ? "Nobody can approve this request; do not retry."
    : "The model accepted the reviewer denial; the action was not executed.");
  expect(state.approvalRequests).toHaveLength(0);
  expect(await state.coordinator.handleRationaleRoundResult({ ticketId: control.ticketId,
    result: { kind: "calls", calls: [] }, now: NOW })).toBeNull();
  expect(recordTerminalDenial).toHaveBeenCalledTimes(1);
});

it("does not record a denied tool while the card is pending or when its caller cancels", async () => {
  const recordTerminalDenial = vi.fn(async (_reason: string) => {});
  const state = setup({ recordTerminalDenial, deferApproval: true });
  const { control } = materialize(state);
  await state.coordinator.handleRationaleRoundResult({ ticketId: control.ticketId,
    result: { kind: "calls", calls: [{ id: "resubmit", name: "permission_rationale", input: responseFor(control) }] }, now: NOW });
  expect(recordTerminalDenial).not.toHaveBeenCalled();
  const caller = new AbortController();
  const pending = state.coordinator.promptForApproval(control.ticketId, { abortSignal: caller.signal, now: NOW });
  expect(recordTerminalDenial).not.toHaveBeenCalled();
  caller.abort();
  await expect(pending).resolves.toBeNull();
  expect(recordTerminalDenial).not.toHaveBeenCalled();
});

it("requires the original non-headless approval callback instead of constructing a fallback card", async () => {
  const state = setup({ humanApprovalAvailable: false });
  const { control } = materialize(state);
  await state.coordinator.handleRationaleRoundResult({ ticketId: control.ticketId,
    result: { kind: "provider-failure", outcome: "generation-error" }, now: NOW });
  await expect(state.coordinator.promptForApproval(control.ticketId, { now: NOW })).rejects.toThrow("Human approval callback is unavailable");
  expect(state.approvalGate.requestAndWait).not.toHaveBeenCalled();
  expect(state.approvalRequests).toHaveLength(0);
  expect(await state.coordinator.createSealedResume({ ticketId: control.ticketId, currentEligibilityContext: eligibilityContext, now: NOW })).toBeNull();
});

it("denies headless fallback without requiring a human approval callback", async () => {
  const state = setup({ humanApprovalAvailable: false, headless: true });
  const { control } = materialize(state);
  await state.coordinator.handleRationaleRoundResult({ ticketId: control.ticketId,
    result: { kind: "provider-failure", outcome: "generation-error" }, now: NOW });
  await expect(state.coordinator.promptForApproval(control.ticketId, { now: NOW })).resolves.toMatchObject({
    outcome: "denied", reason: "Nobody can approve this request; do not retry." });
  expect(state.approvalGate.requestAndWait).not.toHaveBeenCalled();
});
