// @vitest-environment jsdom
/** A template run's stage sessions each ask on their own lane of the run's step panel: one head card per stage, answered on its own. */
import "../../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { WorkBoardPanel } from "../WorkBoardPanel.js";
import { stageApprovalLanes } from "../work-board/use-board-approvals.js";
import type { AveApi, ApprovalRequest } from "../../types.js";
import type { RunProgressEventPayload, WorkItemResolved } from "../../../../shared/work-board-types.js";
import { TEST_IDS } from "../../../../shared/test-ids.js";
import { t } from "../../../../i18n/runtime.js";
import { approvalRequest, approvalSurfaceStub, withApprovalSurface } from "../../../../../test/renderer/helpers.js";

const PLAN = "sub-stage-plan";
const BUILD = "sub-stage-build";

const item: WorkItemResolved = {
  id: 4, title: "Ship the report", detail: "Two stages in parallel", status: "in_progress", status_resolved: "in_progress", priority: "high",
  created_at: "2026-11-16T02:00:00.000Z", updated_at: "2026-11-16T02:00:00.000Z", runStatus: "executing", runId: "run-b",
  runHistory: [{ runId: "run-b", startedAt: "2026-11-16T03:00:00.000Z", status: "planning" }],
};

const stageRequest = (id: string, sessionId: string, stageId: string, stageName: string): ApprovalRequest => approvalRequest({
  id, sessionId, toolName: "run_shell", toolCategory: "shell", args: { command: `echo ${id}` },
  runStage: { stageId, stageName, runAllowOffered: true },
}) as unknown as ApprovalRequest;

async function mountBoard(queue: ApprovalRequest[]) {
  const progress: Array<(p: RunProgressEventPayload) => void> = [];
  const noop = () => () => {};
  const api = {
    listWorkBoard: vi.fn(async () => ({ status: "ok" as const, items: [item] })),
    getWorkBoardRunTranscript: vi.fn(async () => ({ events: [] })),
    runWorkBoardItem: vi.fn(() => new Promise(() => {})),
    getSettings: vi.fn(async () => ({ workBoard: { toolApprovalSurface: "chat" } })),
    onSettingsUpdated: noop, onWorkBoardItemChanged: noop, onWorkBoardRunStarted: noop, onWorkBoardRunFinished: noop, onWorkBoardRunFailed: noop,
    onWorkBoardRunProgress: (h: (p: RunProgressEventPayload) => void) => { progress.push(h); return () => {}; },
    steerWorkBoardRun: vi.fn(), cancelWorkBoardRun: vi.fn(), updateWorkBoardItem: vi.fn(),
    captureUserKeyboardIntent: () => ({ inputOrigin: "user-keyboard" as const, token: "tok" }),
  } as unknown as AveApi;
  const surface = { ...approvalSurfaceStub(), queue };
  render(withApprovalSurface(<WorkBoardPanel api={api} />, surface));
  await screen.findByText("Ship the report");
  for (const runSessionId of [PLAN, BUILD]) {
    await act(async () => { for (const h of progress) h({ at: "2026-11-16T03:04:00.000Z", itemId: 4, phase: "executing", runSessionId }); });
  }
  fireEvent.click(screen.getByTestId("work-board-show-steps"));
  return { surface, panel: await screen.findByTestId("live-step-panel") };
}

/** The element at `index`, which the test has just counted. */
function at(elements: readonly HTMLElement[], index: number): HTMLElement {
  const element = elements[index];
  if (element === undefined) throw new Error(`no element at ${index}`);
  return element;
}

describe("Work Board — one approval lane per stage session", () => {
  afterEach(() => cleanup());

  it("draws two stage sessions' requests in two lanes, each named by its stage, and deciding one leaves the other pending", async () => {
    const queue = [
      stageRequest("req-plan-1", PLAN, "plan", "Plan"),
      stageRequest("req-build-1", BUILD, "build", "Build"),
      stageRequest("req-plan-2", PLAN, "plan", "Plan"),
    ];
    const { surface, panel } = await mountBoard(queue);
    const lanes = within(panel).getAllByTestId("work-board-approval-lane");
    expect(lanes.map((lane) => lane.dataset.stageId)).toEqual(["plan", "build"]);
    expect(within(at(lanes, 0)).getByTestId("work-board-approval-lane-stage")).toHaveTextContent(t("toolApprovalDialog.runStage", { stage: "Plan" }));
    expect(within(at(lanes, 1)).getByTestId("work-board-approval-lane-stage")).toHaveTextContent(t("toolApprovalDialog.runStage", { stage: "Build" }));
    // Each lane draws its own head: the build stage's card is not queued behind the plan stage's two.
    const cards = lanes.map((lane) => within(lane).getByTestId("approval-lane-card"));
    expect(cards.map((card) => card.dataset.approvalRequestId)).toEqual(["req-plan-1", "req-build-1"]);
    expect(within(at(cards, 1)).getByTestId("approval-run-stage")).toHaveAttribute("data-stage-id", "build");

    fireEvent.click(within(at(cards, 1)).getByTestId(TEST_IDS.approveButton));
    expect(surface.decide).toHaveBeenCalledTimes(1);
    expect(vi.mocked(surface.decide).mock.calls[0]?.[0]).toBe("req-build-1");
    // The plan stage's card is still drawn and unanswered.
    expect(within(at(lanes, 0)).getByTestId("approval-lane-card").dataset.approvalRequestId).toBe("req-plan-1");
  });

  it("keeps a run with no stages on one unnamed lane", async () => {
    const plain = approvalRequest({ id: "req-plain", sessionId: PLAN, toolName: "run_shell", toolCategory: "shell", args: { command: "ls" } }) as unknown as ApprovalRequest;
    const { panel } = await mountBoard([plain]);
    const lanes = within(panel).getAllByTestId("work-board-approval-lane");
    expect(lanes).toHaveLength(1);
    expect(at(lanes, 0).dataset.stageId).toBe("");
    expect(within(at(lanes, 0)).queryByTestId("work-board-approval-lane-stage")).toBeNull();
  });

  it("splits requests by the host-derived stage, in the order each stage first asked", () => {
    const requests = [stageRequest("a", PLAN, "plan", "Plan"), stageRequest("b", BUILD, "build", "Build"), stageRequest("c", PLAN, "plan", "Plan")];
    expect(stageApprovalLanes(requests).map((lane) => [lane.stage?.stageId, lane.requests.map((request) => request.id)])).toEqual([["plan", ["a", "c"]], ["build", ["b"]]]);
    expect(stageApprovalLanes([])).toEqual([]);
  });
});
