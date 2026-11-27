import type { OutputExecution } from "./shipped-shapes.js";
import type { WebContents } from "electron";
import type { StageOutputRetryInput, StageOutputRetryResult } from "../../shared/work-board-types.js";
import type { TemplateStage, TemplateVersion, WorkItemStageRun, RequestedOutput } from "../../shared/workflow-template-types.js";
import { resultHashOf } from "../../shared/workflow-template-output.js";
import { isWorkflowPush } from "./host-git.js";
import { declaredOutputOf, requestedOutputHash, type RequestedOutputHooks } from "./requested-outputs.js";
import type { RunRecord, WorkflowRunState } from "./run-state.js";
import type { RunRef } from "./stage-workspace.js";

function sameApprovedStage(stage: WorkItemStageRun | undefined, attempt: number, hash: string | undefined): stage is WorkItemStageRun {
  return hash !== undefined && stage?.attempt === attempt && stage.status === "passed" && stage.gate?.type === "human"
    && stage.gate.status === "approved" && stage.output !== undefined && stage.resultHash === resultHashOf(stage.output)
    && requestedOutputHash(stage) === hash;
}

export function createRecordedOutputEffects(deps: {
  records: WorkflowRunState; outputs?: RequestedOutputHooks; resolvePinned: (pin: RunRecord["pin"]) => Promise<TemplateVersion>;
  /** The run's effect authority and its read with the committed row (WorkBoardStore.runAuthority, admitsRunEffect). */
  canAdmitRunEffect: (run: RunRef) => boolean;
  runAuthority: (run: RunRef) => AbortSignal;
  resolveProjectRoot: (root: string) => string | null;
  scheduledProject: (source: Extract<RunRecord["runStartedBy"], { kind: "schedule-attachment" }>) => Promise<string | undefined | null>;
  notifyItemChanged: (id: number) => void;
}) {
  const { records, outputs, resolvePinned, resolveProjectRoot, notifyItemChanged } = deps;

  async function execute(record: RunRecord, stage: WorkItemStageRun, definition: TemplateStage, output: RequestedOutput,
    run: RunRef, approvalSurface: WebContents, canExecute: () => boolean, signal: AbortSignal,
    rowRemoved?: () => boolean): Promise<boolean> {
    if (rowRemoved?.()) return false;
    const hash = requestedOutputHash(stage);
    const read = await records.get(run.itemId, run.runId);
    const current = read?.stageRuns.find(row => row.stageId === stage.stageId);
    if (!sameApprovedStage(current, stage.attempt, hash) || current.outputExecutions?.find(entry => entry.id === output.id)?.status !== "pending") return false;
    const workspaceRoot = stage.workspace?.root;
    let result: OutputExecution;
    if (!declaredOutputOf(definition, output.decl.toolName, output.decl.owner, output.decl.ownerId)) {
      result = { id: output.id, status: "denied", detail: "output-not-declared" };
    } else if (!workspaceRoot || !outputs) {
      result = { id: output.id, status: "failed", detail: "workspace-unavailable" };
    } else {
      // Every launch point reads the run's authority with the caller's own liveness, right before it acts.
      result = await outputs.execute({ run, stageId: stage.stageId, output, approvalSurface, signal, authority: deps.runAuthority(run),
        canExecute: () => canExecute() && deps.canAdmitRunEffect(run),
        workspace: { root: workspaceRoot, repository: record.runWorkspace?.kind === "git" ? run.projectRoot : undefined },
      }).catch(() => ({ id: output.id, status: "failed", detail: signal.aborted ? "output-execution-interrupted" : "output-execution-failed" }));
    }
    if (rowRemoved?.()) return false;
    const saved = await records.update(run.itemId, run.runId, stored => {
      const latest = stored.stageRuns.find(row => row.stageId === stage.stageId);
      if (!sameApprovedStage(latest, stage.attempt, hash) || latest.outputExecutions?.find(entry => entry.id === output.id)?.status !== "pending") return null;
      const outcome = { ...result, at: new Date().toISOString() };
      return { ...stored, stageRuns: stored.stageRuns.map(row => row === latest
        ? { ...latest, outputExecutions: latest.outputExecutions?.map(entry => entry.id === output.id ? outcome : entry) } : row) };
    });
    if (saved.ok) notifyItemChanged(run.itemId);
    return saved.ok;
  }

  async function retry(itemId: number, input: StageOutputRetryInput, surface: WebContents): Promise<StageOutputRetryResult> {
    const { runId, stageId, attempt, outputId, outputHash } = input;
    const record = await records.get(itemId, runId);
    if (!record) return { ok: false, reason: "not_found" };
    const definition = (await resolvePinned(record.pin).catch(() => undefined))?.stages.find(row => row.id === stageId);
    if (!definition) return { ok: false, reason: "graph_mismatch" };
    const project = record.runStartedBy.kind === "local-create-and-run" ? record.runStartedBy.projectRoot : await deps.scheduledProject(record.runStartedBy);
    if (project === null) return { ok: false, reason: "not_found" };
    const projectRoot = project === undefined ? undefined : resolveProjectRoot(project);
    const canExecute = () => !surface.isDestroyed() && (project === undefined || resolveProjectRoot(project) === projectRoot && projectRoot !== null);
    if (!canExecute()) return { ok: false, reason: "not_found" };

    let selected: RequestedOutput | undefined;
    let reason: Extract<StageOutputRetryResult, { ok: false }>["reason"] = "not_pending";
    const reserved = await records.update(itemId, runId, stored => {
      const stage = stored.stageRuns.find(row => row.stageId === stageId);
      if (!sameApprovedStage(stage, attempt, outputHash)) { reason = "output_mismatch"; return null; }
      const output = stage.requestedOutputs?.find(row => row.id === outputId);
      if (!output) return null;
      if (isWorkflowPush(output.decl)) { reason = "push-retry-forbidden"; return null; }
      const previous = stage.outputExecutions?.find(row => row.id === outputId);
      if (previous?.status !== "failed" && previous?.status !== "denied") return null;
      selected = output;
      return { ...stored, stageRuns: stored.stageRuns.map(row => row === stage
        ? { ...stage, outputExecutions: stage.outputExecutions?.map(entry => entry === previous ? { id: outputId, status: "pending" } : entry) } : row) };
    });
    const stage = reserved.ok && reserved.run.stageRuns.find(row => row.stageId === stageId);
    if (!stage || !selected) return { ok: false, reason };
    const run = { itemId, runId, runKey: `work-board:${itemId}#${runId}`, projectRoot: projectRoot ?? undefined };
    if (!await execute(record, stage, definition, selected, run, surface, canExecute, new AbortController().signal)) return { ok: false, reason: "run_mismatch" };
    return { ok: true };
  }

  return { execute, retry };
}
