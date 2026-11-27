import type { RequestedOutput } from "../../shared/workflow-template-types.js";
import type { OutputExecution } from "./shipped-shapes.js";
import type { RunRef, StageOutputBranchWriter } from "./stage-workspace.js";

export function createRequestedOutputExecutor(keepBranch: StageOutputBranchWriter) {
  return async ({ run, stageId, attempt, output, canExecute }: {
    run: RunRef; stageId: string; attempt: number; output: RequestedOutput; canExecute: () => boolean;
  }): Promise<OutputExecution> => {
    const id = output.id;
    // Tool execution is session-bound. This work approval cannot authorize a new tool session or call a registry handler directly.
    if (output.decl.kind !== "branch") return { id, status: "denied", detail: "capability-unavailable" };
    const result = await keepBranch(run, stageId, attempt, canExecute);
    return result.ok ? { id, status: "done" } : { id, status: "failed", detail: result.code };
  };
}
