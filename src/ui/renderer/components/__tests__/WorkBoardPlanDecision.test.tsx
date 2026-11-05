// @vitest-environment jsdom
/** A plan waiting for the user's work approval is decided in the item's detail: approve and run, request changes with a note, or reject.
 * The panel sends the run id and the stored plan hash, never the plan text, and says why a refused decision was refused. */
import "../../../../../test/renderer/setup.js";
import { withApprovalSurface } from "../../../../../test/renderer/helpers.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WorkBoardPanel } from "../WorkBoardPanel.js";
import type { AveApi } from "../../types.js";
import type { RunProgressEventPayload, WorkItemResolved } from "../../../../shared/work-board-types.js";

const HASH = "b".repeat(64);

function awaitingItem(overrides: Partial<WorkItemResolved> = {}): WorkItemResolved {
  return {
    id: 5,
    title: "Tidy the release notes",
    status: "planned",
    status_resolved: "planned",
    priority: "medium",
    created_at: "2026-11-04T00:00:00.000Z",
    updated_at: "2026-11-04T00:00:00.000Z",
    runStatus: "awaiting_approval",
    runId: "run-7",
    plan: "PLAN: tidy",
    planApproval: { runId: "run-7", planHash: HASH, itemDigest: "d".repeat(64), requestedAt: "2026-11-04T00:00:00.000Z", status: "pending", revision: 0 },
    ...overrides,
  };
}

function stubApi(item: WorkItemResolved, decideWorkPlan: AveApi["decideWorkPlan"]) {
  const noop = () => () => {};
  return {
    listWorkBoard: async () => ({ status: "ok" as const, items: [item] }),
    getWorkBoardItem: async () => ({ status: "found" as const, item }),
    decideWorkPlan,
    onWorkBoardItemChanged: noop,
    onWorkBoardRunProgress: noop,
    onWorkBoardRunStarted: noop,
    onWorkBoardRunFinished: noop,
    onWorkBoardRunFailed: noop,
  } as unknown as AveApi;
}

async function openDetail(api: AveApi) {
  render(withApprovalSurface(<WorkBoardPanel api={api} />));
  fireEvent.click(await screen.findByTestId("work-board-card"));
  return screen.findByTestId("work-board-plan-decision");
}

describe("Work Board — plan decision", () => {
  afterEach(() => cleanup());

  it("approves the stored plan by its run and hash", async () => {
    const decide = vi.fn(async () => ({ ok: true as const, status: "approved" as const }));
    await openDetail(stubApi(awaitingItem(), decide));
    fireEvent.click(screen.getByTestId("work-board-plan-approve"));
    await waitFor(() => expect(decide).toHaveBeenCalledWith(5, { runId: "run-7", planHash: HASH, decision: "approve" }));
  });

  it("asks for a note before sending a plan back, then sends it with the note", async () => {
    const decide = vi.fn(async () => ({ ok: true as const, status: "changes_requested" as const }));
    await openDetail(stubApi(awaitingItem(), decide));
    const requestChanges = screen.getByTestId("work-board-plan-request-changes") as HTMLButtonElement;
    expect(requestChanges.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("work-board-plan-note"), { target: { value: "  split it in two  " } });
    expect(requestChanges.disabled).toBe(false);
    fireEvent.click(requestChanges);
    await waitFor(() => expect(decide).toHaveBeenCalledWith(5, { runId: "run-7", planHash: HASH, decision: "request_changes", note: "split it in two" }));
  });

  it("says a stale plan must be sent back for changes", async () => {
    const decide = vi.fn(async () => ({ ok: false as const, reason: "plan_stale" as const }));
    await openDetail(stubApi(awaitingItem(), decide));
    fireEvent.click(screen.getByTestId("work-board-plan-approve"));
    expect((await screen.findByTestId("work-board-plan-decision-error")).textContent).toContain("수정 요청으로 다시 계획");
  });

  it("asks to retry a decision sent while the plan's run is still closing, and keeps the plan open", async () => {
    const decide = vi.fn(async () => ({ ok: false as const, reason: "plan_settling" as const }));
    await openDetail(stubApi(awaitingItem(), decide));
    fireEvent.click(screen.getByTestId("work-board-plan-approve"));
    expect((await screen.findByTestId("work-board-plan-decision-error")).textContent).toContain("잠시 후 다시 시도");
    expect(screen.getByTestId("work-board-plan-approve")).toBeTruthy();
  });

  it("says the item is gone when it was deleted before the decision arrived", async () => {
    const decide = vi.fn(async () => ({ ok: false as const, reason: "not_found" as const }));
    await openDetail(stubApi(awaitingItem(), decide));
    fireEvent.click(screen.getByTestId("work-board-plan-reject"));
    const error = await screen.findByTestId("work-board-plan-decision-error");
    expect(error.textContent).toContain("삭제되어");
    expect(error.textContent).not.toContain("not_found");
  });

  it("shows the decision in a detail opened before the plan was ready, once the run reaches awaiting_approval", async () => {
    let progress: ((ev: RunProgressEventPayload) => void) | undefined;
    let current = awaitingItem({ runStatus: "planning", plan: undefined, planApproval: undefined });
    const noop = () => () => {};
    const api = {
      listWorkBoard: async () => ({ status: "ok" as const, items: [current] }),
      getWorkBoardItem: async () => ({ status: "found" as const, item: current }),
      decideWorkPlan: vi.fn(),
      onWorkBoardItemChanged: noop,
      onWorkBoardRunProgress: (cb: (ev: RunProgressEventPayload) => void) => { progress = cb; return () => {}; },
      onWorkBoardRunStarted: noop,
      onWorkBoardRunFinished: noop,
      onWorkBoardRunFailed: noop,
    } as unknown as AveApi;
    render(withApprovalSurface(<WorkBoardPanel api={api} />));
    fireEvent.click(await screen.findByTestId("work-board-card"));
    await screen.findByTestId("work-board-detail-no-deadline");
    await waitFor(() => expect(progress).toBeDefined());
    expect(screen.queryByTestId("work-board-plan-decision")).toBeNull();
    current = awaitingItem();
    act(() => progress!({ itemId: 5, phase: "awaiting_approval", at: "2026-11-04T00:00:01.000Z" }));
    expect(await screen.findByTestId("work-board-plan-decision")).toBeTruthy();
  });

  it("offers no decision once the plan is no longer pending", async () => {
    const api = stubApi(awaitingItem({ runStatus: "executing", planApproval: { ...awaitingItem().planApproval!, status: "approved" } }), vi.fn());
    render(withApprovalSurface(<WorkBoardPanel api={api} />));
    fireEvent.click(await screen.findByTestId("work-board-card"));
    await screen.findByTestId("work-board-run-output");
    expect(screen.queryByTestId("work-board-plan-decision")).toBeNull();
  });
});
