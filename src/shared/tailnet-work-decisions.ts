import type { StageGateDecideInput, StageJoinDecideInput, StageOutputRetryInput, WorkPlanApprovalStatus, WorkPlanDecideInput } from "./work-board-types.js";
import type { RequestedOutputCardChoice, RequestedOutputCardView } from "./requested-output-card.js";
import type { RoutineRecord } from "./routines-types.js";
import type { WorkApprovalProject, WorkPlanApprovalView, WorkflowApprovalView } from "./work-approvals-types.js";
import type { RequestedOutput, ScheduleAttachmentRequest, TemplateGraph, TemplateScope, TemplateVersionPin, WorkflowTemplateConfirmInput, WorkflowTemplateDraftInput } from "./workflow-template-types.js";

export const TAILNET_WORK_DECISION_PATH = "/tailnet/v2/web/work-decisions";
export const TAILNET_WORK_DECISION_CAPABILITY = "work-decision";
export const TAILNET_OUTPUT_CARD_HEADER = "x-ave-tailnet-output-card";

export interface TailnetRequestedOutputDecision {
  itemId: number;
  runId: string;
  stageId: string;
  attempt: number;
  outputHash: string;
  decision: "approve" | "reject";
}

type TailnetWorkObjectDecision =
  | { kind: "plan"; itemId: number; input: WorkPlanDecideInput }
  | { kind: "stage"; itemId: number; input: StageGateDecideInput }
  | { kind: "join"; itemId: number; input: StageJoinDecideInput }
  | { kind: "template-confirmation"; templateId: string; input: WorkflowTemplateConfirmInput }
  | { kind: "create-and-run"; input: TemplateVersionPin & { projectRoot?: string; title: string; detail?: string } }
  | { kind: "schedule-attachment"; input: ScheduleAttachmentRequest }
  | { kind: "requested-output"; input: TailnetRequestedOutputDecision }
  | { kind: "output-execution-card"; input: { handle: string; choice: RequestedOutputCardChoice } }
  | { kind: "output-retry"; itemId: number; input: StageOutputRetryInput };

/** Same-origin POST with the Web session cookie and CSRF header. Reuse the UUID for a retry of the same submission. */
export type TailnetWorkDecisionRequest = TailnetWorkObjectDecision & {
  id: string;
  /** Opaque conversation scope from the current Web snapshot. */
  scope: string;
  reviewHandle?: string;
};

type DecisionBinding<Kind extends TailnetWorkObjectDecision["kind"], Omitted extends string = never> =
  Omit<Extract<TailnetWorkObjectDecision, { kind: Kind }>, "kind" | "input"> & {
    input: Omit<Extract<TailnetWorkObjectDecision, { kind: Kind }>["input"], Omitted>;
  };

export type TailnetRequestedOutputReview = {
  kind: "requested-output";
  deny: "reject";
  binding: DecisionBinding<"requested-output", "decision">;
  review: { outputs: readonly (Pick<RequestedOutput, "id" | "decl" | "summary"> & {
    push?: { remote: string; url: string; ref: string; sha: string };
    files?: readonly { path: string; sha256: string; size: number }[];
  })[] };
  reviewHandle?: string;
};

type TailnetTemplateRunReview = {
  name: string;
  scope: TemplateScope;
  graph: TemplateGraph;
  projects: readonly WorkApprovalProject[];
};

export type TailnetWorkReview =
  | { kind: "plan"; deny: "reject"; binding: DecisionBinding<"plan", "decision" | "note">; review: WorkPlanApprovalView }
  | { kind: "stage"; deny: "reject"; binding: DecisionBinding<"stage", "decision" | "note">; review: Extract<WorkflowApprovalView, { kind: "stage-gate" }>; reviewHandle?: string }
  | { kind: "join"; deny: "reject"; binding: DecisionBinding<"join", "decision">; review: Extract<WorkflowApprovalView, { kind: "join-conflict" }> }
  | { kind: "template-confirmation"; deny: "dismiss"; binding: DecisionBinding<"template-confirmation">; review: WorkflowTemplateDraftInput }
  | { kind: "create-and-run"; deny: "dismiss"; binding: DecisionBinding<"create-and-run">; review: TailnetTemplateRunReview }
  | { kind: "schedule-attachment"; deny: "dismiss"; binding: { input: ScheduleAttachmentRequest }; review: {
      name: string; existingPin?: TemplateVersionPin;
      routine?: Pick<RoutineRecord, "schedule" | "title" | "templateAttention" | "pausedAt" | "lastTemplateSkip" | "lastFailure">;
    } }
  | TailnetRequestedOutputReview;

/** Part of the existing Web snapshot. A dismiss action stays on the client. */
export interface TailnetWorkReviewSnapshot {
  readonly scope: string;
  readonly workReviews?: readonly TailnetWorkReview[];
  readonly outputCards?: readonly RequestedOutputCardView[];
  readonly outputRetries?: readonly { itemId: number; input: StageOutputRetryInput; summary: string; detail?: string; refusal?: string }[];
}

export type TailnetWorkDecisionResponse =
  | { ok: true; kind: "plan" | "stage"; status: Exclude<WorkPlanApprovalStatus, "pending"> }
  | { ok: true; kind: "join" | "requested-output" | "output-execution-card" | "output-retry" }
  | { ok: true; kind: "template-confirmation"; pin: TemplateVersionPin }
  | { ok: true; kind: "create-and-run"; itemId: number; runId: string }
  | { ok: true; kind: "schedule-attachment"; attachmentId: string; scheduleId: string }
  | { ok: false; error: string };
