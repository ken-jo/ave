import type { Tool } from "../base.js";
import type { ToolCategory } from "../types.js";
import type { AuditLogger } from "../../audit/audit-logger.js";
import { inspectHostRisk } from "../../permissions/reviewer/host-risk-inspector.js";
import { emitRiskShadowLog } from "../../permissions/reviewer/risk-shadow-log.js";
import { maxOperationRisk, type GovernedRiskFloor } from "../plugin-operation-governance.js";

// Always log host/declared category divergence; enforce host classification only while enabled.
// Read classification requires positive evidence from the inspector.
export function resolveEnforcedCategory(args: {
  tool: Tool;
  declaredCategory: ToolCategory;
  finalInput: Record<string, unknown>;
  correlationId: string;
  hostClassifiesRisk: boolean;
  sandboxFsContained?: boolean;
  auditLogger: AuditLogger;
  operationFloor?: GovernedRiskFloor;
}): ToolCategory {
  const {
    tool,
    declaredCategory,
    finalInput,
    correlationId,
    hostClassifiesRisk,
    auditLogger,
    operationFloor,
  } = args;
  // Reclassify untrusted plugin/external declarations; trusted builtins and meta control flow retain their declared category.
  const eligibleForHostDerivation =
    (tool.source === "plugin" || tool.source === "mcp") &&
    declaredCategory !== "meta";

  // Risk inspection uses source and finalInput; Layer-1 path containment remains separately enforced by isPathAllowed.
  const hostDerivedCategory = eligibleForHostDerivation
    ? inspectHostRisk({ source: tool.source, finalInput })
    : declaredCategory;

  const enforced = hostClassifiesRisk;
  emitRiskShadowLog(
    {
      toolName: tool.name,
      source: tool.source,
      ...(tool.pluginId ? { pluginId: tool.pluginId } : {}),
      declaredCategory,
      hostDerivedCategory,
      enforced,
      // Join category and effect audit for this invocation using the same correlationId.
      correlationId,
    },
    auditLogger,
  );

  const inspectedCategory = enforced && eligibleForHostDerivation ? hostDerivedCategory : declaredCategory;
  const baseline = tool.source === "plugin" && inspectedCategory === "read" && args.sandboxFsContained !== true
    ? "write" : inspectedCategory;
  return operationFloor === undefined
    ? baseline
    : maxOperationRisk(baseline, declaredCategory, hostDerivedCategory, operationFloor);
}
