import type { RuntimePlugin } from "../plugins/types.js";
import { readPluginInstanceIntegrity } from "../plugins/runtime-integrity-evidence.js";
import { exactCanonicalStringify } from "../shared/exact-json.js";
import { isPluginReadjudicationEvidence, type PluginReadjudicationEvidence } from "../shared/permissions-events.js";
import type { ToolCategory, ToolSource } from "../tools/types.js";
import type { PermissionEvaluationContext } from "./evaluation-context.js";
import type { ReviewerDispatchOutcome } from "./permission-manager.js";
import type { SandboxCapability } from "./sandbox-capability.js";
import { inspectHostRisk } from "./reviewer/host-risk-inspector.js";
import { matchesStaticMissingWritePathVerdict, type RiskVerdict } from "./reviewer/risk-classifier.js";

export interface PluginReadjudicationBasis {
  readonly evidence: PluginReadjudicationEvidence;
  readonly requestIdentity: string;
}

interface ReadjudicationRequest {
  readonly toolName: string;
  readonly args: unknown;
  readonly source?: string;
  readonly sourcePluginId?: string;
  readonly toolCategory?: string;
  readonly trustOrigin?: string;
  readonly approvalCacheKey?: string;
  readonly evaluationContext?: PermissionEvaluationContext;
}

const issuedBases = new WeakSet<PluginReadjudicationBasis>();

function requestIdentity(request: ReadjudicationRequest): string {
  return exactCanonicalStringify({
    toolName: request.toolName, args: request.args,
    ...(request.source === undefined ? {} : { source: request.source }),
    ...(request.sourcePluginId === undefined ? {} : { pluginId: request.sourcePluginId }),
    ...(request.toolCategory === undefined ? {} : { category: request.toolCategory }),
    ...(request.trustOrigin === undefined ? {} : { trustOrigin: request.trustOrigin }),
    ...(request.approvalCacheKey === undefined ? {} : { approvalCacheKey: request.approvalCacheKey }),
    ...(request.evaluationContext?.executionCwd === undefined ? {} : { executionCwd: request.evaluationContext.executionCwd }),
  });
}

export function createPluginReadjudicationBasis(input: {
  toolName: string;
  source: ToolSource;
  pluginId?: string;
  category: ToolCategory;
  finalInput: Record<string, unknown>;
  executionCwd: string;
  trustOrigin?: string;
  approvalCacheKey?: string;
  ruleVerdict: RiskVerdict;
  reviewerVerdict?: RiskVerdict;
  reviewerOutcome?: ReviewerDispatchOutcome;
  runtimeInstance?: RuntimePlugin;
  sandboxCapability: SandboxCapability;
}): PluginReadjudicationBasis | undefined {
  if (input.source !== "plugin" || input.category !== "write" || input.pluginId === undefined ||
      input.runtimeInstance === undefined || !matchesStaticMissingWritePathVerdict(input.ruleVerdict, input)) return undefined;
  if (input.reviewerVerdict === undefined ? input.reviewerOutcome !== undefined
      : input.reviewerVerdict.level !== "high" || input.reviewerOutcome !== "host-determined") return undefined;
  if (inspectHostRisk({ source: input.source, finalInput: input.finalInput }) !== "write") return undefined;
  const capability = input.sandboxCapability;
  if (capability.confidence !== "verified" || capability.kind === "none" || capability.kind === "partial" ||
      capability.confines?.filesystem !== true || capability.confines.process !== true) return undefined;
  const snapshot = readPluginInstanceIntegrity(input.runtimeInstance);
  if (snapshot?.pluginId !== input.pluginId || snapshot.integrity.installSource !== "marketplace") return undefined;
  const evidence = {
    pluginId: input.pluginId,
    artifactSha256: snapshot.integrity.artifactSha256,
    signerKeyId: snapshot.integrity.signerKeyId,
    staticReason: "write-path-not-declared" as const,
  };
  if (!isPluginReadjudicationEvidence(evidence)) return undefined;
  const basis = Object.freeze({
    evidence: Object.freeze(evidence),
    requestIdentity: exactCanonicalStringify({
      toolName: input.toolName, args: input.finalInput, source: input.source,
      pluginId: input.pluginId, category: input.category,
      ...(input.trustOrigin === undefined ? {} : { trustOrigin: input.trustOrigin }),
      ...(input.approvalCacheKey === undefined ? {} : { approvalCacheKey: input.approvalCacheKey }),
      executionCwd: input.executionCwd,
    }),
  });
  issuedBases.add(basis);
  return basis;
}

// This verifies pending-request binding only; it performs no runtime or containment lookup.
export function matchesPluginReadjudicationBasis(
  basis: PluginReadjudicationBasis | undefined,
  request: ReadjudicationRequest,
): basis is PluginReadjudicationBasis {
  if (basis === undefined || !issuedBases.has(basis) || request.source !== "plugin" ||
      basis.evidence.pluginId !== request.sourcePluginId) return false;
  try {
    return basis.requestIdentity === requestIdentity(request);
  } catch {
    return false;
  }
}
