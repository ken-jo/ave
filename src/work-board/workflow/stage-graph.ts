import type { StageJoin, TemplateGraph, TemplateStage, TemplateVersion, WorkItemStageRun } from "../../shared/workflow-template-types.js";
import { graphHashOf } from "../template-graph.js";
import type { RunPin } from "./shipped-shapes.js";
import { WorkflowInvariantError } from "./workflow-errors.js";

/** The version a run executes must be the pinned one, and its content must still hash to the pin. */
export function assertPinnedVersion(version: TemplateVersion, pin: RunPin): void {
  if (version.templateId !== pin.templateId || version.version !== pin.version) throw new WorkflowInvariantError("version-missing");
  if (version.graphHash !== pin.graphHash || graphHashOf(version) !== pin.graphHash) throw new WorkflowInvariantError("graph-mismatch");
}

function predecessorsOf(graph: TemplateGraph, stage: TemplateStage): string[] {
  return [...new Set([...stage.inputs, ...graph.edges.filter(edge => edge.to === stage.id).map(edge => edge.from)])];
}

/** Steps in run order: a stage sits one step after its latest predecessor. Throws on an unknown stage id or a cycle. */
export function stepsOf(graph: TemplateGraph): string[][] {
  const byId = new Map(graph.stages.map(stage => [stage.id, stage]));
  if (byId.size !== graph.stages.length) throw new WorkflowInvariantError("graph-invalid");
  for (const edge of graph.edges) if (!byId.has(edge.from) || !byId.has(edge.to)) throw new WorkflowInvariantError("stage-not-in-version");
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const depthOf = (id: string): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    const stage = byId.get(id);
    if (!stage) throw new WorkflowInvariantError("stage-not-in-version");
    if (visiting.has(id)) throw new WorkflowInvariantError("graph-invalid");
    visiting.add(id);
    const value = predecessorsOf(graph, stage).reduce((max, pred) => Math.max(max, depthOf(pred) + 1), 0);
    visiting.delete(id);
    depth.set(id, value);
    return value;
  };
  const steps: string[][] = [];
  for (const stage of graph.stages) {
    const depth = depthOf(stage.id);
    steps[depth] = [...(steps[depth] ?? []), stage.id];
  }
  return steps;
}

export const joinIdOfStep = (step: number): string => `step-${step + 1}`;

/** The stages that run beside `stageId`: its whole step, itself included. */
export function parallelGroupOf(graph: TemplateGraph, stageId: string): string[] {
  const group = stepsOf(graph).find(step => step.includes(stageId));
  if (!group) throw new WorkflowInvariantError("stage-not-in-version");
  return group;
}

/** The first step whose collected result is not integrated yet; `steps.length` when every step is. */
export function currentStepOf(graph: TemplateGraph, joins: readonly StageJoin[]): number {
  const steps = stepsOf(graph);
  const index = steps.findIndex((_, step) => joins.find(join => join.joinId === joinIdOfStep(step))?.status !== "integrated");
  return index === -1 ? steps.length : index;
}

/** Waiting stages whose inputs and incoming edges all passed and were integrated, in graph order. */
export function readyStages(graph: TemplateGraph, stageRuns: readonly WorkItemStageRun[], joins: readonly StageJoin[]): string[] {
  const step = stepsOf(graph)[currentStepOf(graph, joins)] ?? [];
  return step.filter(id => stageRuns.find(run => run.stageId === id)?.status === "waiting");
}
