import type { StageJoin, TemplateVersionPin, WorkItemStageRun } from "../../shared/workflow-template-types.js";
export type { WorkflowRunRecord as RunRecord } from "../../shared/workflow-template-types.js";

/** Shipped shapes that are private to their module, derived from the exported aggregates. No new shape lives here. */
export type RunPin = TemplateVersionPin;
export type LaneBlockCode = NonNullable<WorkItemStageRun["blocked"]>["code"];
export type OutputExecution = NonNullable<WorkItemStageRun["outputExecutions"]>[number];
export type JoinConflict = NonNullable<StageJoin["conflict"]>;
export type StageFailure = NonNullable<WorkItemStageRun["failure"]>;
