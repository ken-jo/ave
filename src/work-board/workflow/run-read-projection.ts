import { outputHashOf, resultHashOf } from "../../shared/workflow-template-output.js";
import type { WorkItemResolved } from "../../shared/work-board-types.js";
import type { SerializedHistoryMessage } from "../../shared/chat-history.js";
import { maskSensitiveData } from "../../shared/dlp.js";
import type { ChatEntry, ToolEntryItem } from "../../lib/chat-stream-state.js";
import type { TemplateVersion, WorkItemStageRun, WorkflowRunRecord } from "../../shared/workflow-template-types.js";
import type { PendingWorkflowDecision, WorkflowDecisionHistoryEntry, WorkflowRunView, WorkflowStageActivity, WorkflowStageView } from "../../shared/workflow-run-view.js";
import { toolStepsOf } from "../tool-steps.js";
import { boundedStageInputs, stageInputsOf } from "./stage-prompt.js";
import { isAwaitingStageReview } from "./run-state.js";

const TURN_TEXT_LIMIT = 4_000;
const RECENT_TURN_LIMIT = 40;

export const maskWorkflowText = (value: string): string => maskSensitiveData(value).masked;

export function withoutWorkflowProjection<T extends WorkItemResolved>(item: T): T {
  const clean = { ...item };
  delete clean.templateRunState;
  delete clean.runPin;
  delete clean.workflowRunPins;
  delete clean.workflowRun;
  delete clean.pendingWorkflowDecisions;
  delete clean.delegatedSessions;
  return clean;
}

export function pendingWorkflowDecisions(run: WorkflowRunRecord): PendingWorkflowDecision[] {
  if (!isAwaitingStageReview(run)) return [];
  const pending: PendingWorkflowDecision[] = [];
  for (const stage of run.stageRuns) {
    if (stage.status !== "awaiting_gate" || stage.gate?.type !== "human" || stage.gate.status !== "pending"
      || stage.output === undefined || stage.resultHash === undefined || resultHashOf(stage.output) !== stage.resultHash
      || (stage.requestedOutputs?.length && outputHashOf(stage.output, stage.requestedOutputs) !== stage.outputHash)) continue;
    pending.push({
      kind: "stage-gate",
      binding: { runId: run.runId, stageId: stage.stageId, attempt: stage.attempt, resultHash: stage.resultHash, ...(stage.outputHash !== undefined && { outputHash: stage.outputHash }) },
      result: maskWorkflowText(stage.output),
      ...(stage.requestedOutputs?.length && { outputs: stage.requestedOutputs.map(output => ({ id: output.id, summary: maskWorkflowText(output.summary) })) }),
      arrivedAt: stage.endedAt ?? null,
    });
  }
  for (const join of run.stageJoins ?? []) {
    if (join.status !== "conflict" || !join.conflict) continue;
    const { conflictHash, reason, files, excerpt } = join.conflict;
    pending.push({
      kind: "join-conflict",
      binding: { runId: run.runId, joinId: join.joinId, conflictHash },
      evidence: {
        reason, files: files.map(file => ({ path: maskWorkflowText(file.path), stageIds: [...file.stageIds] })),
        ...(excerpt !== undefined && { excerpt: maskWorkflowText(excerpt) }),
      },
      arrivedAt: null,
    });
  }
  return pending;
}

export function workflowStageActivity(entries: readonly ChatEntry[]): WorkflowStageActivity {
  const turns = entries.filter((entry): entry is Extract<ChatEntry, { kind: "assistant" }> => entry.kind === "assistant" && entry.streaming !== true)
    .map((entry, index) => ({ turn: index + 1, text: maskWorkflowText(entry.text).slice(0, TURN_TEXT_LIMIT) })).slice(-RECENT_TURN_LIMIT);
  const tools = toolStepsOf(entries).map(step => ({
    ...step, name: maskWorkflowText(step.name), ...(step.label !== undefined && { label: maskWorkflowText(step.label) }),
  }));
  return { turns, tools };
}

export function savedWorkflowStageActivity(messages: readonly SerializedHistoryMessage[]): WorkflowStageActivity {
  const outcomes = new Map(messages.flatMap(message => message.role === "tool_result" && message.toolUseId ? [[message.toolUseId, message] as const] : []));
  const entries = messages.flatMap((message): ChatEntry[] => {
    if (message.role !== "assistant" || message.systemNotice) return [];
    const assistant: ChatEntry = { kind: "assistant", text: message.content };
    if (!message.toolCalls?.length) return [assistant];
    const tools = message.toolCalls.map((call, displayOrder): ToolEntryItem => {
      const outcome = outcomes.get(call.id);
      const status = !outcome || outcome.toolDisplay?.cancelled ? "cancelled" : outcome.isError ? "error" : "done";
      return { toolUseId: call.id, name: call.name, displayOrder, status, input: call.input, category: call.category, durationMs: outcome?.toolDisplay?.durationMs };
    });
    const groupId = String(message.index);
    return [assistant, { kind: "tool_group", groupId, groupIds: [groupId], status: "done", tools }];
  });
  return workflowStageActivity(entries);
}

function retainedDecision(stage: WorkItemStageRun): WorkflowDecisionHistoryEntry[] {
  const gate = stage.gate;
  if (gate?.type !== "human" || !gate.decidedAt || gate.status === "pending") return [];
  const decision = gate.status === "approved" ? "approve" : gate.status === "rejected" ? "reject" : "request_changes";
  return [{
    kind: "stage-gate", stageId: stage.stageId, attempt: gate.revision + 1, decision, at: gate.decidedAt,
    ...(gate.note !== undefined && { note: maskWorkflowText(gate.note) }),
  }];
}

export function projectWorkflowRun(
  run: WorkflowRunRecord,
  version: TemplateVersion | undefined,
  sessionFacts?: (stage: WorkItemStageRun) => Pick<WorkflowStageView, "activity" | "breaker">,
): WorkflowRunView {
  return {
    runId: run.runId, pin: { ...run.pin }, startedAt: run.startedAt,
    stages: run.stageRuns.map(stage => {
      const { stageId, attempt, status, childSessionId, startedAt, endedAt, failure, gate, output, resultHash } = stage;
      const definition = version?.stages.find(candidate => candidate.id === stageId);
      const receivedInputs = childSessionId && version && definition
        ? boundedStageInputs(stageInputsOf(version, definition, run.stageRuns))
          .map(input => ({ ...input, text: maskWorkflowText(input.text) }))
        : undefined;
      const shownGate = gate?.type === "auto" ? { ...gate, evidence: maskWorkflowText(gate.evidence) }
        : gate && { ...gate, ...(gate.note !== undefined && { note: maskWorkflowText(gate.note) }) };
      return {
        stageId, attempt, status, childSessionId, startedAt, endedAt, failure, gate: shownGate, receivedInputs,
        ...(output !== undefined && { result: maskWorkflowText(output) }), resultHash, ...sessionFacts?.(stage),
      };
    }),
    joins: (run.stageJoins ?? []).map(({ joinId, stageIds, status, decidedAt }) => ({ joinId, stageIds: [...stageIds], status, decidedAt })),
    decisions: [
      ...run.stageRuns.flatMap(retainedDecision),
      ...(run.stageJoins ?? []).flatMap((join): WorkflowDecisionHistoryEntry[] => join.decidedAt ? [{
        kind: "join-conflict", joinId: join.joinId, decision: join.status === "rejected" ? "reject" : "retry_merge", at: join.decidedAt,
      }] : []),
    ].sort((a, b) => a.at.localeCompare(b.at)),
  };
}
