import type { ApprovalGate } from "../../permissions/approval-gate.js";
import type { PermissionEvaluationContext } from "../../permissions/evaluation-context.js";
import type { RationaleControlCandidate } from "../../tools/pipeline/rationale-orchestrator.js";

export function createRationaleApprovalCallback(input: {
  candidate: RationaleControlCandidate;
  approvalGate: Pick<ApprovalGate, "requestAndWait">;
  evaluationContext: PermissionEvaluationContext;
  ownerUnattended?: boolean;
}): NonNullable<RationaleControlCandidate["requestHumanApproval"]> {
  const candidate = input.candidate;
  const finalInput = structuredClone(candidate.finalInput);
  const target = input.evaluationContext.targetFilePaths[0];
  return ({ requestId, abortSignal }) => input.approvalGate.requestAndWait({
    id: requestId,
    category: "tool",
    kind: "tool",
    toolName: candidate.toolName,
    toolCategory: candidate.category,
    sessionId: candidate.requestAnchor.sessionId,
    args: finalInput,
    reason: "Review the sealed invocation.",
    source: candidate.source,
    ...(candidate.pluginId === undefined ? {} : { sourcePluginId: candidate.pluginId }),
    createdAt: Date.now(),
    trustOrigin: candidate.invocationTrustOrigin,
    approvalCacheKey: candidate.approvalCacheKey,
    evaluationContext: input.evaluationContext,
    sandboxCapability: candidate.sandboxCapability,
    reviewerVerdict: candidate.permission.reviewer.verdict,
    reviewerOutcome: candidate.permission.reviewer.outcome,
    ownerUnattended: input.ownerUnattended === true,
    ...(abortSignal === undefined ? {} : { abortSignal }),
    ...(target === undefined ? {} : { target: { filePath: target } }),
  });
}
