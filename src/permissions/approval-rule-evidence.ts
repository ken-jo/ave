import type { ToolInvocationContext, RiskVerdict } from "./reviewer/risk-classifier.js";
import type { PermissionEvaluationContext } from "./evaluation-context.js";
import { canonicalStringify, captureApprovalWorkingDirectory } from "./user-approval-store.js";

export interface ApprovalRuleBasis {
  readonly ruleVerdict: RiskVerdict["level"];
  readonly workingDirectory: Readonly<{ path: string; identity: string }>;
  readonly requestIdentity: string;
}

interface ApprovalRuleRequest {
  toolName: string;
  args: unknown;
  source?: string;
  toolCategory?: string;
  trustOrigin?: string;
  approvalCacheKey?: string;
  evaluationContext?: PermissionEvaluationContext;
}

const issuedBases = new WeakSet<ApprovalRuleBasis>();

// Only the existing host risk assessment issues provenance; the approval gate consumes it.
export function issueApprovalRuleBasis(
  context: ToolInvocationContext,
  verdict: RiskVerdict,
  approvalCacheKey?: string,
): ApprovalRuleBasis {
  const basis = Object.freeze({
    ruleVerdict: verdict.level,
    workingDirectory: captureApprovalWorkingDirectory(context.executionCwd),
    requestIdentity: canonicalStringify({
      toolName: context.toolName, args: context.finalInput, source: context.source,
      category: context.category, trustOrigin: context.trustOrigin, approvalCacheKey,
      executionCwd: context.executionCwd,
    }),
  });
  issuedBases.add(basis);
  return basis;
}

export function matchesApprovalRuleBasis(
  basis: ApprovalRuleBasis | undefined,
  request: ApprovalRuleRequest,
): basis is ApprovalRuleBasis {
  return basis !== undefined && issuedBases.has(basis) && basis.requestIdentity === canonicalStringify({
    toolName: request.toolName, args: request.args, source: request.source,
    category: request.toolCategory, trustOrigin: request.trustOrigin,
    approvalCacheKey: request.approvalCacheKey, executionCwd: request.evaluationContext?.executionCwd,
  });
}
