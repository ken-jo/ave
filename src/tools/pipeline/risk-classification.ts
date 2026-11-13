import { extractShellCommands } from "../../shared/shell-command-fields.js";
import type { Tool } from "../base.js";
import type { ToolCategory } from "../types.js";
import { inspectHostRisk } from "../../permissions/reviewer/host-risk-inspector.js";
import { maxOperationRisk, type GovernedRiskFloor } from "../plugin-operation-governance.js";

// Host inference governs non-meta plugin/MCP risk. Supplying operationFloor marks
// a governed operation and retains its registered category as a raise-only floor.
// Command reads need containment; validated ordinary read hints retain their own lane.
export function resolveEnforcedCategory(args: {
  tool: Tool;
  // A floor for governed operations; otherwise the host-resolved builtin/meta category or read hint baseline.
  registeredCategoryFloor: ToolCategory;
  finalInput: Record<string, unknown>;
  sandboxFsContained?: boolean;
  operationFloor?: GovernedRiskFloor;
}): ToolCategory {
  const {
    tool,
    registeredCategoryFloor,
    finalInput,
    operationFloor,
  } = args;
  // Trusted builtins and meta control flow retain their host-resolved category.
  const eligibleForHostDerivation =
    (tool.source === "plugin" || tool.source === "mcp") &&
    registeredCategoryFloor !== "meta";

  const declaredRead = tool.source === "plugin" && tool.mcpReadOnlyHint === true && registeredCategoryFloor === "read";
  // A declaration cannot supply filesystem containment for a command-bearing tool.
  const declaredOrdinaryRead = declaredRead && extractShellCommands(finalInput).length === 0;
  // Risk inspection uses source and finalInput; Layer-1 path containment remains separately enforced by isPathAllowed.
  const hostInferredCategory = eligibleForHostDerivation
    ? inspectHostRisk({ source: tool.source, finalInput, readOnlyHint: declaredOrdinaryRead })
    : registeredCategoryFloor;
  const baseline = tool.source === "plugin" && hostInferredCategory === "read" && args.sandboxFsContained !== true && !declaredOrdinaryRead
    ? "write" : hostInferredCategory;
  return operationFloor === undefined
    ? baseline
    : maxOperationRisk(baseline, registeredCategoryFloor, operationFloor);
}
