import type { AuditLogger } from "../audit/audit-logger.js";
import { isRecord } from "../shared/is-record.js";
import { localDateKey } from "../shared/local-date.js";
import { workBoardOriginSessionId } from "../shared/work-board-types.js";
import type { WorkflowDecisionHistoryEntry, WorkflowRunView } from "../shared/workflow-run-view.js";
import { isStageId, isTemplateId } from "../work-board/template-graph.js";

export async function readWorkflowDecisionHistory(
  audit: Pick<AuditLogger, "search">, itemId: number, run: WorkflowRunView,
): Promise<WorkflowDecisionHistoryEntry[]> {
  const { entries } = await audit.search({
    dateFrom: localDateKey(new Date(run.startedAt)), type: "approval", textSearch: run.runId,
  });
  const origin = workBoardOriginSessionId(itemId);
  const retained = [...run.decisions];
  const earlier: WorkflowDecisionHistoryEntry[] = [];
  for (const entry of entries) {
    if (entry.sessionId !== origin || typeof entry.output !== "string") continue;
    let data: unknown;
    try { data = JSON.parse(entry.output); } catch { continue; }
    if (!isRecord(data) || data.runId !== run.runId || data.event !== "work-approval:stage-decided") continue;
    const { stageId, attempt, joinId, decision } = data;
    if (isStageId(stageId) && typeof attempt === "number" && Number.isInteger(attempt) && attempt > 0) {
      const action = decision === "approved" ? "approve" : decision === "rejected" ? "reject" : decision === "changes_requested" ? "request_changes" : undefined;
      if (!action || retained.some(row => row.kind === "stage-gate" && row.stageId === stageId && row.attempt === attempt)) continue;
      earlier.push({ kind: "stage-gate", stageId, attempt, decision: action, at: entry.timestamp });
    } else if (isTemplateId(joinId) && (decision === "retry_merge" || decision === "reject")) {
      const newest = retained.findIndex(row => row.kind === "join-conflict" && row.joinId === joinId && row.decision === decision);
      if (newest >= 0) {
        earlier.push(...retained.splice(newest, 1));
        continue;
      }
      earlier.push({ kind: "join-conflict", joinId, decision, at: entry.timestamp });
    }
  }
  return [...retained, ...earlier].sort((a, b) => a.at.localeCompare(b.at));
}
