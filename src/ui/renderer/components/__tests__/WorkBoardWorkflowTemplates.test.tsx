// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { approvalRequest, approvalSurfaceStub, withApprovalSurface } from "../../../../../test/renderer/helpers.js";
import { t } from "../../../../i18n/runtime.js";
import { TEST_IDS } from "../../../../shared/test-ids.js";
import type { RunProgressEventPayload, WorkItemResolved } from "../../../../shared/work-board-types.js";
import type { TemplateVersion, WorkflowTemplate, WorkflowTemplateDraftInput } from "../../../../shared/workflow-template-types.js";
import { WorkBoardPanel } from "../WorkBoardPanel.js";
import type { ApprovalRequest, AveApi } from "../../types.js";

const at = "2026-11-26T05:00:00.000Z";
const graphHash = "a".repeat(64);
const template: WorkflowTemplate = {
  id: "daily", name: "Daily report", scope: { kind: "all" }, currentVersion: 2, createdAt: at, updatedAt: at,
};
const draft: WorkflowTemplateDraftInput = {
  name: template.name, scope: template.scope,
  stages: [
    { id: "gather", name: "Gather sources", goal: "Read reports", inputs: [], toolScope: "read", allowSubAgents: false, gate: { type: "auto", pass: { kind: "stage_ok" } } },
    { id: "summarize", name: "Summarize", goal: "Summarize the sources", inputs: ["gather"], toolScope: "read", allowSubAgents: false, gate: { type: "auto", pass: { kind: "model_verdict" } } },
  ],
  edges: [{ from: "gather", to: "summarize" }],
};
const pin = { templateId: template.id, version: 2, graphHash };
const version: TemplateVersion = {
  stages: draft.stages, edges: draft.edges, ...pin, confirmedAt: at, confirmation: { ...pin, who: "user", at, origin: "local-desktop" },
};
const older = { ...version, version: 1, stages: draft.stages.slice(0, 1), edges: [] };
const item: WorkItemResolved = {
  id: 8, title: "Wednesday report", templateId: template.id, status: "in_progress", status_resolved: "in_progress",
  priority: "medium", created_at: at, updated_at: at, runId: "run-a", runStatus: "executing", templateRunState: "awaiting_review",
};

const project = { projectRoot: "/workspace/report", projectName: "Report workspace" };

function mount(items: WorkItemResolved[] = [], templates: WorkflowTemplate[] = [template], queue: ApprovalRequest[] = []) {
  let progress: (event: RunProgressEventPayload) => void = () => {};
  const api = {
    listWorkBoard: vi.fn(async () => ({ status: "ok", items })),
    getWorkBoardRunTranscript: vi.fn(async () => ({ events: [] })),
    getSettings: vi.fn(async () => ({ workBoard: { toolApprovalSurface: "chat" } })),
    getWorkBoardItem: vi.fn(async () => ({ status: "found", item: { ...item, ...project } })),
    listAgentProfiles: vi.fn(async () => ({ agents: [] })),
    listWorkflowTemplates: vi.fn(async () => ({ ok: true, value: templates })),
    getWorkflowTemplate: vi.fn(async () => ({ ok: true, value: { template, versions: [older, version] } })),
    onWorkflowTemplatesChanged: () => () => {},
    draftWorkflowTemplate: vi.fn(async (_id: string, input: WorkflowTemplateDraftInput) => ({
      ok: true, value: { template, versions: [older, version], draft: { ...input, graphHash, revision: "draft-a", updatedAt: at } },
    })),
    confirmWorkflowTemplate: vi.fn(async () => ({ ok: true, value: { ...version, version: 3 } })),
    addWorkBoardItem: vi.fn(async () => ({ status: "created", itemId: 8, item: { ...item, ...project } })),
    completeWorkBoardItem: vi.fn(async () => ({ status: "completed", itemId: 8, item: { ...item, status: "completed" } })),
    runWorkBoardItem: vi.fn(async () => ({ status: "completed" })),
    captureUserKeyboardIntent: vi.fn(() => ({ inputOrigin: "user-keyboard", token: "click" })),
    decideWorkStage: vi.fn(),
    retryWorkStage: vi.fn(async () => ({ ok: true })),
    onWorkBoardItemChanged: () => () => {},
    onWorkBoardRunFinished: () => () => {},
    onWorkBoardRunProgress: (callback: typeof progress) => { progress = callback; return () => {}; },
  };
  const surface = { ...approvalSurfaceStub(), queue };
  render(withApprovalSurface(<WorkBoardPanel api={api as unknown as AveApi} project={project} />, surface));
  return { api, surface, emit: (event: RunProgressEventPayload) => act(() => progress(event)) };
}

async function templates() {
  fireEvent.click(screen.getByRole("button", { name: t("workflowTemplates.library") }));
  return within(await screen.findByRole("dialog", { name: t("workflowTemplates.library") }));
}

afterEach(cleanup);

it("opens the empty template library by keyboard and returns focus on Escape", async () => {
  mount([], []);
  const user = userEvent.setup();
  const button = screen.getByRole("button", { name: t("workflowTemplates.library") });
  button.focus();
  await user.keyboard("{Enter}");
  expect(await screen.findByText(t("workflowTemplates.empty"))).toBeVisible();
  expect(screen.getByRole("button", { name: t("workflowTemplates.newTemplate") })).toHaveFocus();
  await user.keyboard("{Escape}");
  await vi.waitFor(() => expect(button).toHaveFocus());
});

it("browses immutable versions and confirms an edited graph against the saved draft revision", async () => {
  const { api } = mount();
  const library = await templates();
  fireEvent.click(await library.findByRole("button", { name: template.name }));
  const history = await library.findByLabelText(t("workflowTemplates.versions"));
  fireEvent.change(history, { target: { value: "1" } });
  expect(library.queryByText("Summarize")).toBeNull();
  fireEvent.change(history, { target: { value: "2" } });
  fireEvent.click(library.getByRole("button", { name: t("workflowTemplates.editVersion") }));
  expect(library.getByLabelText(t("workflowTemplates.templateName"))).toHaveFocus();
  fireEvent.click(library.getByRole("button", { name: /Summarize/ }));
  fireEvent.change(library.getByLabelText(t("workflowTemplates.gate")), { target: { value: "human" } });
  fireEvent.click(library.getByRole("button", { name: t("workflowTemplates.reviewVersion") }));
  expect(await library.findByText(graphHash)).toBeVisible();
  expect(api.draftWorkflowTemplate).toHaveBeenCalledWith(template.id, expect.objectContaining({
    basedOn: 2,
    stages: expect.arrayContaining([expect.objectContaining({ id: "summarize", gate: { type: "human" } })]),
  }));
  expect(api.confirmWorkflowTemplate).not.toHaveBeenCalled();
  fireEvent.click(library.getByRole("button", { name: t("workflowTemplates.confirmVersion", { version: 3 }) }));
  expect(api.confirmWorkflowTemplate).toHaveBeenCalledExactlyOnceWith(template.id, { expectedGraphHash: graphHash, expectedDraftRevision: "draft-a" });
});

it("creates and launches a board item with the displayed template pin and the click's captured intent", async () => {
  const { api } = mount();
  const library = await templates();
  fireEvent.click(await library.findByRole("button", { name: template.name }));
  fireEvent.click(await library.findByRole("button", { name: t("workflowTemplates.startRun") }));
  fireEvent.change(library.getByLabelText(t("workflowTemplates.workTitle")), { target: { value: "Wednesday report" } });
  fireEvent.click(library.getByRole("button", { name: t("workflowTemplates.createAndRun") }));
  await vi.waitFor(() => expect(api.runWorkBoardItem).toHaveBeenCalledExactlyOnceWith(8, { template: { ...pin, projectRoot: project.projectRoot } }, { inputOrigin: "user-keyboard", token: "click" }));
  expect(api.addWorkBoardItem).toHaveBeenCalledExactlyOnceWith({ templateId: template.id, title: "Wednesday report", ...project });
  const run = within(await screen.findByRole("dialog", { name: "Wednesday report" }));
  expect(run.getByText(t("workflowTemplates.requestedVersion", { version: 2 }))).toBeVisible();
  expect(run.getByRole("list", { name: t("workflowTemplates.stageGraph") })).toHaveTextContent("Gather sources");
});

it("shows parked work and labels only the model decisions reported by the live host", async () => {
  const { api, emit } = mount([item]);
  await screen.findByText(item.title);
  emit({ itemId: item.id, stageId: "gather", attempt: 1, phase: "executing", runSessionId: "gather-session", at });
  emit({ itemId: item.id, stageId: "gather", attempt: 1, phase: "stage_passed", at });
  emit({ itemId: item.id, stageId: "summarize", attempt: 1, phase: "stage_gate", judgedBy: "model", at });
  fireEvent.click(screen.getByRole("button", { name: t("workflowTemplates.openRun") }));
  const view = await screen.findByRole("dialog", { name: item.title });
  expect(within(view).getByText(t("workflowTemplates.parked"))).toBeVisible();
  expect(within(view).getByText(t("workflowTemplates.modelGate"))).toBeVisible();
  expect(within(view).getByText(t("workflowTemplates.stageSession", { session: "gather-session" }))).toBeVisible();
  expect(within(view).getByText(t("workflowTemplates.stagePassed"))).toBeVisible();
  expect(within(view).getByText(t("workflowTemplates.gateDetailsUnavailable"))).toBeVisible();
  expect(api.decideWorkStage).not.toHaveBeenCalled();
});

it("retries only the failed stage observed for the displayed run", async () => {
  const { api, emit } = mount([{
    ...item, templateRunState: "running", runHistory: [{ runId: "run-a", startedAt: at, status: "executing" }],
  }]);
  await screen.findByText(item.title);
  const failed: RunProgressEventPayload = { itemId: item.id, stageId: "summarize", attempt: 1, phase: "stage_failed", at };
  emit({ ...failed, at: "2026-11-26T04:00:00.000Z" });
  fireEvent.click(screen.getByRole("button", { name: t("workflowTemplates.openRun") }));
  expect(screen.queryByRole("button", { name: t("workflowTemplates.retryStage") })).toBeNull();
  emit(failed);
  const retry = screen.getByRole("button", { name: t("workflowTemplates.retryStage") });
  fireEvent.click(retry);
  expect(api.retryWorkStage).toHaveBeenCalledExactlyOnceWith(item.id, { runId: "run-a", stageId: "summarize" });
  await vi.waitFor(() => expect(retry).toBeDisabled());
  emit({ ...failed, attempt: 2, phase: "executing", runSessionId: "second-attempt" });
  expect(screen.queryByRole("button", { name: t("workflowTemplates.retryStage") })).toBeNull();
});

it("shows the host's completed output and marks the item complete only on user action", async () => {
  const revision = "d".repeat(64);
  const output = "The source digest is ready.";
  const { api } = mount([{ ...item, templateRunState: undefined, runStatus: "completed", output, mutationRevision: revision }]);
  await screen.findByText(item.title);
  fireEvent.click(screen.getByRole("button", { name: t("workflowTemplates.openRun") }));
  const run = within(screen.getByRole("dialog", { name: item.title }));
  expect(run.getByText(output)).toBeVisible();
  expect(api.completeWorkBoardItem).not.toHaveBeenCalled();
  await act(async () => { fireEvent.click(run.getByRole("button", { name: t("workBoard.completeButton") })); });
  expect(api.completeWorkBoardItem).toHaveBeenCalledExactlyOnceWith(item.id, revision);
});

it("shows separate stage approval lanes in the run view and answers through the shared approval surface", async () => {
  const queue = [
    { stageId: "gather", stageName: "Gather", sessionId: "gather-session" },
    { stageId: "summarize", stageName: "Summarize", sessionId: "summary-session" },
  ].map(({ stageId, stageName, sessionId }) => approvalRequest({
    id: stageId, sessionId, toolName: "read_file", runStage: { stageId, stageName, runAllowOffered: false },
  }) as unknown as ApprovalRequest);
  const { emit, surface } = mount([item], [template], queue);
  await screen.findByText(item.title);
  for (const { runStage, sessionId } of queue) {
    emit({ itemId: item.id, stageId: runStage?.stageId, attempt: 1, phase: "executing", runSessionId: sessionId, at });
  }
  fireEvent.click(screen.getByRole("button", { name: t("workflowTemplates.openRun") }));
  const dialog = within(screen.getByRole("dialog", { name: item.title }));
  const lanes = dialog.getAllByTestId("work-board-approval-lane");
  expect(lanes.map(lane => lane.dataset.stageId)).toEqual(["gather", "summarize"]);
  fireEvent.click(within(lanes[1]).getByTestId(TEST_IDS.approveButton));
  expect(vi.mocked(surface.decide).mock.calls.map(call => call[0])).toEqual(["summarize"]);
});
