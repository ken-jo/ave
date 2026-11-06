import { extractShellCommands } from "../../shared/shell-command-fields.js";
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

  const declaredRead = tool.source === "plugin" && tool.mcpReadOnlyHint === true && declaredCategory === "read";
  // A declaration cannot supply filesystem containment for a command-bearing tool.
  const declaredOrdinaryRead = declaredRead && extractShellCommands(finalInput).length === 0;
  // Risk inspection uses source and finalInput; Layer-1 path containment remains separately enforced by isPathAllowed.
  const hostDerivedCategory = eligibleForHostDerivation
    ? inspectHostRisk({ source: tool.source, finalInput, readOnlyHint: declaredOrdinaryRead })
    : declaredCategory;

  const enforced = hostClassifiesRisk || declaredRead;
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
  const baseline = tool.source === "plugin" && inspectedCategory === "read" && args.sandboxFsContained !== true && !declaredOrdinaryRead
    ? "write" : inspectedCategory;
  return operationFloor === undefined
    ? baseline
    : maxOperationRisk(baseline, declaredCategory, hostDerivedCategory, operationFloor);
}
