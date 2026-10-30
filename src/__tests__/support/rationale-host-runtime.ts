import { vi, type Mock } from "vitest";
import { RATIONALE_UNKNOWN_SCOPE_SENTINEL, InMemoryHostAnchorRoundCasStore, createActionIdentity, createRationaleRequiredControl } from "../../tools/pipeline/rationale-control.js";
import { createTestRequestAnchor } from "../../tools/pipeline/__tests__/rationale-fixtures.js";
import { createRationaleExecutorControlOutcome } from "../../tools/pipeline/rationale-pr1-contract.js";
import { createRationaleReviewRequiredRecord } from "../../tools/pipeline/rationale-ticket-lifecycle.js";
import type { RationaleControlCandidate, RationaleHostRuntime, RationaleRuntimeMaterialization } from "../../tools/pipeline/rationale-orchestrator.js";

export function createRationaleHostRuntime(anchor = createTestRequestAnchor()): {
  runtime: RationaleHostRuntime & { requestAnchor: NonNullable<RationaleHostRuntime["requestAnchor"]> };
  materialize: Mock<(candidate: RationaleControlCandidate) => RationaleRuntimeMaterialization>;
} {
  const cas = new InMemoryHostAnchorRoundCasStore();
  const materialize = vi.fn(
    (candidate: RationaleControlCandidate): RationaleRuntimeMaterialization => {
      const canonicalTargets = candidate.canonicalTargets.length > 0
        ? [...candidate.canonicalTargets]
        : [RATIONALE_UNKNOWN_SCOPE_SENTINEL];
      const action = createActionIdentity({
        anchorId: candidate.requestAnchor.anchorId,
        invocationTrustOrigin: candidate.invocationTrustOrigin,
        rationaleProvenance: candidate.rationaleProvenance,
        toolName: candidate.toolName,
        toolVersion: candidate.toolVersion,
        source: candidate.source,
        category: candidate.category,
        ...(candidate.pluginId === undefined ? {} : { pluginId: candidate.pluginId }),
        ...(candidate.mcpServerId === undefined ? {} : { mcpServerId: candidate.mcpServerId }),
        ...(candidate.workerId === undefined ? {} : { workerId: candidate.workerId }),
        finalInput: { ...candidate.finalInput },
        ...(candidate.approvalCacheKey === undefined
          ? {}
          : { approvalCacheKey: candidate.approvalCacheKey }),
        canonicalTargets,
        requestedEffects: [candidate.category],
        affectedResources: canonicalTargets[0] === RATIONALE_UNKNOWN_SCOPE_SENTINEL
          ? [RATIONALE_UNKNOWN_SCOPE_SENTINEL]
          : ["declared-targets"],
        requiredAuthority: "mid",
        policyEpoch: "test-policy-epoch",
        registryGeneration: "test-registry-generation",
        sandboxGeneration: "test-sandbox-generation",
        sandboxExecutionPlan: structuredClone(
          candidate.sandboxExecutionPlan,
        ) as Record<string, unknown>,
      });
      const reservation = cas.tryReserve({
        anchor: candidate.requestAnchor,
        action,
        triggeringBatchDisposition: candidate.triggeringBatchDisposition,
        round: 1,
        now: candidate.now,
      });
      if (!reservation) throw new Error("test anchor round was already reserved");
      const control = createRationaleRequiredControl({
        anchor: candidate.requestAnchor,
        action,
        triggeringBatchDisposition: candidate.triggeringBatchDisposition,
        anchorRoundReservation: reservation,
        hostAnchorRoundCas: cas,
        sealedAction: {
          toolUseId: candidate.toolUseId,
          toolName: candidate.toolName,
          originalInput: { ...candidate.originalInput },
          finalInput: { ...candidate.finalInput },
        },
        eligibilityContext: candidate.eligibilityContext,
        permission: candidate.permission,
        now: candidate.now,
      });
      return {
        action,
        control,
        ticket: createRationaleReviewRequiredRecord(control, candidate.now),
        executorControl: createRationaleExecutorControlOutcome(control, candidate.now),
      };
    },
  );
  return {
    runtime: {
      requestAnchor: anchor,
      rationaleProvenance: { startedFromUserKeyboard: true, taint: "none" },
      materializeRationaleControl: materialize,
    },
    materialize,
  };
}
