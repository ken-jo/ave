import type { StageGateDecideInput, StageJoinDecideInput, WorkBoardRunToolStep, WorkPlanDecision } from "./work-board-types.js";
import type { StageJoin, TemplateVersionPin, WorkItemStageRun } from "./workflow-template-types.js";

/** Host-generated output invocations have their own approval session; the run dialog claims only its current run. */
export function workflowOutputSessionPrefix(itemId: number, runId: string): string {
  return `workflow-output:${itemId}:${runId}:`;
}

type JoinEvidence = Omit<NonNullable<StageJoin["conflict"]>, "conflictHash">;

export type PendingWorkflowDecision =
  | { kind: "stage-gate"; binding: Omit<StageGateDecideInput, "decision" | "note">; result: string; outputs?: { id: string; summary: string; payload: string; pushRunBranch?: boolean; httpsAccountsHelp?: boolean }[]; arrivedAt: string | null }
  | { kind: "join-conflict"; binding: Omit<StageJoinDecideInput, "decision">; evidence: JoinEvidence; canOpenFolder?: boolean; arrivedAt: null };

export interface WorkflowRunPinView {
  runId: string;
  pin: TemplateVersionPin;
  startedAt: string;
}

export interface WorkflowStageActivity {
  turns: { turn: number; text: string }[];
  tools: WorkBoardRunToolStep[];
}

interface WorkflowStageBreaker {
  open: boolean;
  consecutive: number;
  total: number;
}

export interface WorkflowStageInputView {
  stageId: string;
  text: string;
  truncated: boolean;
}

export interface WorkflowStageView extends Pick<WorkItemStageRun, "stageId" | "attempt" | "status" | "childSessionId" | "startedAt" | "endedAt" | "failure" | "failureReason" | "blocked" | "toolchainReadRoots" | "gate" | "outputExecutions"> {
  deniedCalls?: WorkItemStageRun["deniedCalls"];
  result?: string;
  resultHash?: string;
  outputRetry?: { hash: string; ids: string[] };
  receivedInputs?: WorkflowStageInputView[];
  activity?: WorkflowStageActivity;
  breaker?: WorkflowStageBreaker;
}

export type WorkflowDecisionHistoryEntry =
  | { kind: "stage-gate"; stageId: string; attempt: number; decision: WorkPlanDecision; at: string; note?: string }
  | { kind: "join-conflict"; joinId: string; decision: StageJoinDecideInput["decision"]; at: string };

export function workflowDecisionHistoryKey(entry: WorkflowDecisionHistoryEntry): string {
  return entry.kind === "stage-gate" ? `stage:${entry.stageId}:${entry.attempt}` : `join:${entry.joinId}:${entry.at}:${entry.decision}`;
}

export interface WorkflowRunView extends WorkflowRunPinView {
  stages: WorkflowStageView[];
  joins: Pick<StageJoin, "joinId" | "stageIds" | "status" | "decidedAt">[];
  decisions: WorkflowDecisionHistoryEntry[];
}

export interface WorkflowStageActivityUpdate {
  runId: string;
  stageId: string;
  attempt: number;
  childSessionId: string;
  activity: WorkflowStageActivity;
  breaker?: WorkflowStageBreaker;
}
