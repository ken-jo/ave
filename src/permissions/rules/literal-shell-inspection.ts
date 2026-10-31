import type { ShellExecutionFacts } from "../../shared/shell-execution.js";
import type { PreparedShellAnalysis } from "../../shared/shell-analysis.js";
import type { LiteralBodyBudget } from "../../shared/shell-literal-bodies.js";
import type { ShellCommandInput } from "./shell-prefix-policy.js";
import { ShellFloorContext, SHELL_FLOOR_BUDGET_REASON } from "./shell-floor-policy.js";
import { inspectPosixShellCommand, inspectLiteralShellArgv, SHELL_RUNTIME_EVALUATION_REASON } from "./shell-exfiltration.js";
import { inspectPowerShellCommand, inspectPowerShellPermissionPaths } from "./powershell-exfiltration.js";
import { inspectPosixShellPermissionPaths } from "../../tools/shell-path-policy.js";

/** One recursive entry binds each parsed literal body to its actual dialect. */
export function inspectShellCommand(input: ShellCommandInput, cwd?: string, context?: ShellFloorContext, budget: LiteralBodyBudget = { tokens: { count: 0 }, depth: 0 }) {
  return inspectPosixShellCommand(input, cwd, context, budget, inspectPowerShellCommand);
}

export function inspectShellPermissionPaths(command: string, cwd: string, facts?: ShellExecutionFacts, prepared?: PreparedShellAnalysis) {
  return inspectPosixShellPermissionPaths(command, cwd, facts, prepared, undefined, inspectPowerShellPermissionPaths);
}
export function shellExfiltrationSignal(input: ShellCommandInput | readonly (string | undefined)[], cwd?: string, context?: ShellFloorContext): string | null { return Array.isArray(input) ? inspectLiteralShellArgv(input, cwd, context).exfiltration : inspectShellCommand(input as ShellCommandInput, cwd, context).exfiltration; }
export function shellSensitivePathSignal(input: ShellCommandInput, cwd?: string): string | null { return inspectShellCommand(input, cwd).sensitive; }
export function shellScanProofBlocker(input: ShellCommandInput, cwd?: string): string | null { const result = inspectShellCommand(input, cwd); return result.analysisLimited ? result.ordinaryAsk ?? SHELL_FLOOR_BUDGET_REASON : result.exactLiteralEvaluation ? null : result.outcome === "unproven" ? result.ordinaryAsk ?? SHELL_RUNTIME_EVALUATION_REASON : null; }
export function shellScanOrdinaryAsk(input: ShellCommandInput, cwd?: string): string | null { const result = inspectShellCommand(input, cwd); return result.outcome === "unproven" ? result.ordinaryAsk ?? SHELL_RUNTIME_EVALUATION_REASON : null; }
export function _inspectShellForTest(input: ShellCommandInput, cwd?: string) { const context = new ShellFloorContext(); context.visits.frames += 1; return { ...inspectShellCommand(input, cwd, context), visits: { ...context.visits } }; }
