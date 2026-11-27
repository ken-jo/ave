import type { StageGateDecideInput, StageJoinDecideInput, WorkPlanApprovalStatus, WorkPlanDecideInput } from "./work-board-types.js";
import type { ScheduleAttachmentRequest, TemplateVersionPin, WorkflowTemplateConfirmInput } from "./workflow-template-types.js";

export const TAILNET_WORK_DECISION_PATH = "/tailnet/v2/web/work-decisions";
export const TAILNET_WORK_DECISION_CAPABILITY = "work-decision";

export interface TailnetRequestedOutputDecision {
  itemId: number;
  runId: string;
  stageId: string;
  attempt: number;
  outputId: string;
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
  | { kind: "requested-output"; input: TailnetRequestedOutputDecision };

/** Same-origin POST with the Web session cookie and CSRF header. Reuse the UUID for a retry of the same submission. */
export type TailnetWorkDecisionRequest = TailnetWorkObjectDecision & {
  id: string;
  /** Opaque conversation scope from the current Web snapshot. */
  scope: string;
};

export type TailnetWorkDecisionResponse =
  | { ok: true; kind: "plan" | "stage"; status: Exclude<WorkPlanApprovalStatus, "pending"> }
  | { ok: true; kind: "join" | "requested-output" }
  | { ok: true; kind: "template-confirmation"; pin: TemplateVersionPin }
  | { ok: true; kind: "create-and-run"; itemId: number; runId: string }
  | { ok: true; kind: "schedule-attachment"; attachmentId: string; scheduleId: string }
  | { ok: false; error: string };
