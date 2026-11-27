import { resultHashOf } from "../../shared/workflow-template-output.js";
import type { WorkItemResolved } from "../../shared/work-board-types.js";
import type { SerializedHistoryMessage } from "../../shared/chat-history.js";
import { redactHomePathsInText } from "../../audit/dlp-filter.js";
import { maskSensitiveData } from "../../shared/dlp.js";
import type { ChatEntry, ToolEntryItem } from "../../lib/chat-stream-state.js";
import type { TemplateVersion, WorkItemStageRun, WorkflowRunRecord } from "../../shared/workflow-template-types.js";
import type { PendingWorkflowDecision, WorkflowDecisionHistoryEntry, WorkflowRunView, WorkflowStageActivity, WorkflowStageView } from "../../shared/workflow-run-view.js";
import { toolStepsOf } from "../tool-steps.js";
import { boundedStageInputs, stageInputsOf } from "./stage-prompt.js";
import { isAwaitingStageReview } from "./run-state.js";
import { requestedOutputHash, requestedOutputsMatchStage } from "./requested-outputs.js";
import { isWorkflowPush } from "./host-git.js";

const TURN_TEXT_LIMIT = 4_000;
const RECENT_TURN_LIMIT = 40;

export const maskWorkflowText = (value: string): string => redactHomePathsInText(maskSensitiveData(value).masked);

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

export type WorkflowRunReadSurface = "local-desktop" | "tailnet";

export function pendingWorkflowDecisions(run: WorkflowRunRecord, surface?: WorkflowRunReadSurface, version?: TemplateVersion): PendingWorkflowDecision[] {
  if (!isAwaitingStageReview(run)) return [];
  const pending: PendingWorkflowDecision[] = [];
  for (const stage of run.stageRuns) {
    if (stage.status !== "awaiting_gate" || stage.gate?.type !== "human" || stage.gate.status !== "pending"
      || stage.output === undefined || stage.resultHash === undefined || resultHashOf(stage.output) !== stage.resultHash) continue;
    const outputs = stage.requestedOutputs;
    if (outputs?.length) {
      const definition = version?.stages.find(candidate => candidate.id === stage.stageId);
      if (!definition || !requestedOutputsMatchStage(definition, outputs)) continue;
    }
    const outputHash = requestedOutputHash(stage);
    pending.push({
      kind: "stage-gate",
      binding: { runId: run.runId, stageId: stage.stageId, attempt: stage.attempt, resultHash: stage.resultHash, ...(outputHash !== undefined && { outputHash }) },
      result: maskWorkflowText(stage.output),
      ...(surface === "local-desktop" && outputs?.length && { outputs: outputs.map(output => {
        const pushRunBranch = isWorkflowPush(output.decl);
        const args = JSON.parse(output.args);
        return {
          id: output.id, summary: maskWorkflowText(output.summary), pushRunBranch,
          httpsAccountsHelp: pushRunBranch && /^https?:/iu.test(args.url),
          payload: JSON.stringify({ ...output.decl, args }, null, 2),
        };
      }) }),
      arrivedAt: stage.endedAt ?? null,
    });
  }
  for (const join of run.stageJoins ?? []) {
    if (join.status !== "conflict" || !join.conflict) continue;
    const { conflictHash, reason, files, excerpt } = join.conflict;
    pending.push({
      kind: "join-conflict",
      binding: { runId: run.runId, joinId: join.joinId, conflictHash, generation: join.conflictGeneration ?? 0 },
      ...(run.runWorkspace?.kind === "git" && { canOpenFolder: true }),
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
  localOutputRetry = false,
): WorkflowRunView {
  return {
    runId: run.runId, pin: { ...run.pin }, startedAt: run.startedAt,
    stages: run.stageRuns.map(stage => {
      const { stageId, attempt, status, childSessionId, startedAt, endedAt, failure, gate, output, resultHash, outputExecutions } = stage;
      const definition = version?.stages.find(candidate => candidate.id === stageId);
      const receivedInputs = childSessionId && version && definition
        ? boundedStageInputs(stageInputsOf(version, definition, run.stageRuns))
          .map(input => ({ ...input, text: maskWorkflowText(input.text) }))
        : undefined;
      const shownGate = gate?.type === "auto" ? { ...gate, evidence: maskWorkflowText(gate.evidence) }
        : gate && { ...gate, ...(gate.note !== undefined && { note: maskWorkflowText(gate.note) }) };
      const hash = localOutputRetry ? requestedOutputHash(stage) : undefined;
      const retryIds = hash && status === "passed" && gate?.type === "human" && gate.status === "approved"
        ? outputExecutions?.flatMap(entry => {
          const request = stage.requestedOutputs?.find(candidate => candidate.id === entry.id);
          return request && !isWorkflowPush(request.decl) && (entry.status === "failed" || entry.status === "denied") ? [entry.id] : [];
        }) : undefined;
      return {
        stageId, attempt, status, childSessionId, startedAt, endedAt, failure, gate: shownGate, receivedInputs,
        ...(outputExecutions?.length && { outputExecutions: outputExecutions.map(({ id, status, detail }) => ({ id, status, ...(detail !== undefined && { detail: maskWorkflowText(detail) }) })) }),
        ...(hash && retryIds?.length && { outputRetry: { hash, ids: retryIds } }),
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
