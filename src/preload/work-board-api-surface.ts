import { ipcRenderer } from "electron";
import { WORK_APPROVALS, WORK_BOARD } from "../contract/app-contract.js";
import type { OpenJoinIpcResult } from "../shared/work-board-types.js";
import type { ScheduleAttachmentRequest, ScheduleAttachment, WorkflowTemplateIpcResult, WorkflowTemplate, WorkflowTemplateRecord, WorkflowTemplateProposal, WorkflowTemplateDraftInput, WorkflowTemplateConfirmInput, WorkflowTemplateConfirmResult } from "../shared/workflow-template-types.js";
import { invokeWorkBoardDecision } from "./work-board-decision-intent.js";

export const workBoardApiSurface = {
  // Personal board CRUD + lifecycle. Each method maps 1:1 to a WORK_BOARD.* channel; the main-process store returns discriminated `status` envelopes (or `{ ok:false, error }` for
  // unauthorized-frame / no-store), forwarded verbatim; no fallback / re-shaping. Shared payload + result types come from the renderer-safe `shared/work-board-types.js` (no Node built-ins).
  listWorkflowTemplates: async () => ipcRenderer.invoke(WORK_BOARD.templateList) as Promise<WorkflowTemplateIpcResult<WorkflowTemplate[]>>,
  getWorkflowTemplate: async (id: string) => ipcRenderer.invoke(WORK_BOARD.templateGet, id) as Promise<WorkflowTemplateIpcResult<WorkflowTemplateRecord>>,
  getWorkflowTemplateProposal: async (id: string) => ipcRenderer.invoke(WORK_BOARD.templateProposalGet, id) as Promise<WorkflowTemplateIpcResult<WorkflowTemplateProposal>>,
  draftWorkflowTemplate: async (id: string | null, input: WorkflowTemplateDraftInput) => ipcRenderer.invoke(WORK_BOARD.templateDraft, id, input) as Promise<WorkflowTemplateIpcResult<WorkflowTemplateRecord>>,
  confirmWorkflowTemplate: async (id: string, input: WorkflowTemplateConfirmInput) => invokeWorkBoardDecision(WORK_BOARD.templateConfirm, id, input) as Promise<WorkflowTemplateIpcResult<WorkflowTemplateConfirmResult>>,
  detachWorkflowTemplateSchedule: async (id: string) => ipcRenderer.invoke(WORK_BOARD.templateDetachSchedule, id) as Promise<WorkflowTemplateIpcResult<boolean>>,
  attachWorkflowTemplateSchedule: async (input: ScheduleAttachmentRequest) => ipcRenderer.invoke(WORK_BOARD.templateAttachSchedule, input) as Promise<WorkflowTemplateIpcResult<ScheduleAttachment>>,
  archiveWorkflowTemplate: async (id: string) => ipcRenderer.invoke(WORK_BOARD.templateArchive, id) as Promise<WorkflowTemplateIpcResult<null>>,
  onWorkflowTemplatesChanged: (handler: () => void) => {
    const listener = () => handler();
    ipcRenderer.on(WORK_BOARD.templatesChanged, listener);
    return () => ipcRenderer.removeListener(WORK_BOARD.templatesChanged, listener);
  },
  listWorkBoard: async (filter?: import("../shared/work-board-types.js").WorkItemListFilter) =>
    ipcRenderer.invoke(WORK_BOARD.list, filter) as Promise<
      | import("../shared/work-board-types.js").WorkItemListResult
      | { ok: false; error: string }
    >,
  getWorkBoardItem: async (id: number, runId?: string) =>
    (runId === undefined ? ipcRenderer.invoke(WORK_BOARD.get, id) : ipcRenderer.invoke(WORK_BOARD.get, id, runId)) as Promise<
      | import("../shared/work-board-types.js").WorkItemGetResult
      | { ok: false; error: string }
    >,
  addWorkBoardItem: async (input: import("../shared/work-board-types.js").WorkItemCreateInput, launch?: import("../shared/work-board-types.js").TemplateRunRequest) =>
    (launch === undefined ? ipcRenderer.invoke(WORK_BOARD.add, input) : invokeWorkBoardDecision(WORK_BOARD.add, input, launch)) as Promise<
      | import("../shared/work-board-types.js").WorkItemCreateResult
      | { ok: false; error: string }
    >,
  updateWorkBoardItem: async (id: number, patch: import("../shared/work-board-types.js").WorkItemUpdateInput) =>
    ipcRenderer.invoke(WORK_BOARD.update, id, patch) as Promise<
      | import("../shared/work-board-types.js").WorkItemUpdateResult
      | { ok: false; error: string }
    >,
  transitionWorkBoardItem: async (id: number, to: import("../shared/work-board-types.js").WorkItemStatusStored, expectedRevision?: string) =>
    ipcRenderer.invoke(WORK_BOARD.transition, id, to, expectedRevision) as Promise<
      | import("../shared/work-board-types.js").WorkItemTransitionResult
      | { ok: false; error: string }
    >,
  completeWorkBoardItem: async (id: number, expectedRevision?: string) =>
    ipcRenderer.invoke(WORK_BOARD.complete, id, expectedRevision) as Promise<
      | import("../shared/work-board-types.js").WorkItemCompleteResult
      | { ok: false; error: string }
    >,
  reopenWorkBoardItem: async (id: number, expectedRevision?: string) =>
    ipcRenderer.invoke(WORK_BOARD.reopen, id, expectedRevision) as Promise<
      | import("../shared/work-board-types.js").WorkItemReopenResult
      | { ok: false; error: string }
    >,
  removeWorkBoardItem: async (id: number | null, target?: import("../shared/work-board-types.js").WorkItemDeleteTarget) =>
    ipcRenderer.invoke(WORK_BOARD.remove, id, target) as Promise<
      | import("../shared/work-board-types.js").WorkItemDeleteResult
      | import("../shared/work-board-types.js").WorkBoardEntryDeleteResult
      | { ok: false; error: string }
    >,
  clearWorkBoardRun: async (id: number, target: { revision: string; runId: string }) =>
    ipcRenderer.invoke(WORK_BOARD.clearRun, id, target) as Promise<
      | import("../shared/work-board-types.js").WorkItemUpdateResult
      | { ok: false; error: string }
    >,
  // Board view live refresh: emitted by the work-board IPC domain after any successful mutation
  // (created/updated/transitioned/completed/reopened/ removed) so the renderer board view re-lists without polling.
  onWorkBoardItemChanged: (
    handler: (payload: import("../shared/work-board-types.js").WorkItemChangedEventPayload) => void,
  ) => {
    const listener = (_e: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on(WORK_BOARD.itemChanged, listener);
    return () => ipcRenderer.removeListener(WORK_BOARD.itemChanged, listener);
  },
  // Agent-orchestration run: kick off plan→approve→execute for one item. The promise resolves with the terminal WorkItemRunResult, but live phase updates flow over
  // onWorkBoardRunProgress; coarse started/finished/failed markers (for the per-item running indicator) flow over the on* siblings. `opts.agentName` selects a named agent profile (drives the child model).
  // A template run names the tuple and project on the launch form.
  runWorkBoardItem: async (id: number, opts?: { agentName?: string; template?: import("../shared/work-board-types.js").TemplateRunRequest }) =>
    (opts?.template ? invokeWorkBoardDecision(WORK_BOARD.run, id, opts) : ipcRenderer.invoke(WORK_BOARD.run, id, opts)) as Promise<
      | import("../shared/work-board-types.js").WorkItemRunResult
      | { ok: false; error: string }
    >,
  // Generate a daily / weekly personal work report from the board state + activity log + learned memory.
  // Resolves with the report markdown (ok), an empty-period envelope, an error envelope (LLM failure), or no-reporter.
  generateWorkBoardReport: async (
    kind: "daily" | "weekly",
    input?: { date?: string; weekIso?: string; weekOffset?: number; projectRoot?: string; includeUnscoped?: boolean },
  ) =>
    ipcRenderer.invoke(WORK_BOARD.generateReport, kind, input) as Promise<
      | import("../shared/work-board-types.js").WorkBoardReportResult
      | { ok: false; error: string }
    >,
  // Run the daily / weekly briefing: a read-only sub-agent survey of the user's work whose findings are filed onto the board
  // as proposals. Resolves with the ids of the cards it wrote (ok), a nothing-found envelope, an error envelope, or no-engine.
  runWorkBoardBriefing: async (
    kind: import("../shared/work-board-types.js").WorkBoardBriefingKind,
    projectRoot?: string,
  ) =>
    ipcRenderer.invoke(WORK_BOARD.runBriefing, kind, projectRoot) as Promise<
      | import("../shared/work-board-types.js").WorkBoardBriefingResult
      | { ok: false; error: string }
    >,

  acceptWorkProposal: async (proposalId: string, projectRoot?: string) =>
    ipcRenderer.invoke(WORK_BOARD.acceptProposal, proposalId, projectRoot) as Promise<
      | import("../shared/work-board-types.js").WorkProposalAcceptResult
      | { ok: false; error: string }
    >,
  dismissWorkProposal: async (proposalId: string) =>
    ipcRenderer.invoke(WORK_BOARD.dismissProposal, proposalId) as Promise<
      | import("../shared/work-board-types.js").WorkProposalDismissResult
      | { ok: false; error: string }
    >,

  // Main consumes the native input for this steer.
  steerWorkBoardRun: async (itemId: number, text: string, stageId?: string) =>
    ipcRenderer.invoke(WORK_BOARD.steerRun, itemId, text, ...(stageId === undefined ? [] : [{ stageId }])) as Promise<
      | import("../shared/work-board-types.js").WorkBoardSteerIpcResult
      | { ok: false; error: string }
    >,
  // Decision bindings come from the displayed work object and its trusted control.
  decideWorkPlan: async (itemId: number, input: import("../shared/work-board-types.js").WorkPlanDecideInput) =>
    invokeWorkBoardDecision(WORK_BOARD.decidePlan, itemId, input) as Promise<
      | import("../shared/work-board-types.js").WorkPlanDecideIpcResult
      | { ok: false; error: string }
    >,
  // The user's decision at a stage gate or on a join of a template run, and a retry of a failed stage: the click's own activation is the
  // gesture. Each input names the run and the hash the card showed, never the output.
  decideWorkStage: async (itemId: number, input: import("../shared/work-board-types.js").StageGateDecideInput) =>
    invokeWorkBoardDecision(WORK_BOARD.decideStage, itemId, input) as Promise<
      | import("../shared/work-board-types.js").StageGateDecideIpcResult
      | { ok: false; error: string }
    >,
  decideWorkJoin: async (itemId: number, input: import("../shared/work-board-types.js").StageJoinDecideInput) =>
    invokeWorkBoardDecision(WORK_BOARD.decideJoin, itemId, input) as Promise<
      | import("../shared/work-board-types.js").StageJoinDecideIpcResult
      | { ok: false; error: string }
    >,
  retryWorkStageOutput: async (itemId: number, input: import("../shared/work-board-types.js").StageOutputRetryInput) =>
    invokeWorkBoardDecision(WORK_BOARD.retryOutput, itemId, input) as Promise<
      import("../shared/work-board-types.js").StageOutputRetryIpcResult | { ok: false; error: string }
    >,
  retryWorkStage: async (itemId: number, input: import("../shared/work-board-types.js").StageRetryInput) =>
    invokeWorkBoardDecision(WORK_BOARD.retryStage, itemId, input) as Promise<
      | import("../shared/work-board-types.js").StageRetryIpcResult
      | { ok: false; error: string }
    >,
  // Stop the item's running execute child; Main requires native input.
  cancelWorkBoardRun: async (itemId: number) =>
    ipcRenderer.invoke(WORK_BOARD.cancelRun, itemId) as Promise<
      | import("../shared/work-board-types.js").WorkBoardCancelIpcResult
      | { ok: false; error: string }
    >,
  openWorkBoardJoin: async (itemId: number, input: Omit<import("../shared/work-board-types.js").StageJoinDecideInput, "decision">) =>
    invokeWorkBoardDecision(WORK_BOARD.openJoin, itemId, input) as Promise<OpenJoinIpcResult | { ok: false; error: string }>,
  setWorkBoardProjectScope: async (root: string | undefined) =>
    ipcRenderer.invoke(WORK_BOARD.setProjectScope, root) as Promise<boolean>,
  // Work-level decisions ("확인 필요") for one project or every authorized project.
  listWorkApprovals: async (opts?: { projectRoot?: string } | { allProjects: true }) =>
    ipcRenderer.invoke(WORK_APPROVALS.list, opts) as Promise<
      | import("../shared/work-approvals-types.js").WorkApprovalListResult
      | { ok: false; error: string }
    >,
  onWorkApprovalsChanged: (handler: () => void) => {
    const listener = () => handler();
    ipcRenderer.on(WORK_APPROVALS.changed, listener);
    return () => ipcRenderer.removeListener(WORK_APPROVALS.changed, listener);
  },
  // Read a past run's persisted transcript (plan+execute conversation) for the run-history view. Resolves with the ordered events (empty when absent).
  getWorkBoardRunTranscript: async (itemId: number, runId: string) =>
    ipcRenderer.invoke(WORK_BOARD.runTranscript, itemId, runId) as Promise<
      | { events: import("../shared/work-board-types.js").RunTranscriptEvent[] }
      | { ok: false; error: string }
    >,
  // Live per-phase progress for an in-flight run (planning / awaiting_approval / executing / denied /
  // done / error / cancelled). Payload === the engine's WorkBoardRunEvent (aliased as RunProgressEventPayload).
  onWorkBoardRunProgress: (
    handler: (payload: import("../shared/work-board-types.js").RunProgressEventPayload) => void,
  ) => {
    const listener = (_e: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on(WORK_BOARD.runProgress, listener);
    return () => ipcRenderer.removeListener(WORK_BOARD.runProgress, listener);
  },
  // Coarse marker: a run started for `itemId` (renderer sets the running flag).
  onWorkBoardRunStarted: (
    handler: (payload: { itemId: number; at: string; resumed?: true }) => void,
  ) => {
    const listener = (_e: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on(WORK_BOARD.runStarted, listener);
    return () => ipcRenderer.removeListener(WORK_BOARD.runStarted, listener);
  },
  // Coarse marker: a run for `itemId` returned its result (renderer clears the running flag). `status` mirrors WorkItemRunResult.status.
  onWorkBoardRunFinished: (
    handler: (payload: {
      itemId: number;
      /** For a template run: the state it went quiet in, which may already be past a gate. Gate state comes from events. */
      status: import("../shared/work-board-types.js").WorkItemRunResult["status"];
      at: string;
    }) => void,
  ) => {
    const listener = (_e: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on(WORK_BOARD.runFinished, listener);
    return () => ipcRenderer.removeListener(WORK_BOARD.runFinished, listener);
  },
  // Coarse marker: the engine threw before producing a result (renderer clears the running flag and surfaces `reason`).
  onWorkBoardRunFailed: (
    handler: (payload: { itemId: number; reason: string; at: string }) => void,
  ) => {
    const listener = (_e: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on(WORK_BOARD.runFailed, listener);
    return () => ipcRenderer.removeListener(WORK_BOARD.runFailed, listener);
  },
};
