// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { withApprovalSurface } from "../../../../../test/renderer/helpers.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { WorkBoardPanel } from "../WorkBoardPanel.js";
import type { AveApi } from "../../types.js";
import type { WorkItemResolved } from "../../../../shared/work-board-types.js";

const item: WorkItemResolved = { id: 1, title: "Export notes", status: "planned", status_resolved: "planned", mutationRevision: "a".repeat(64), priority: "medium", created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z" };
function apiFor(current = item) {
  const noop = () => () => {};
  return {
    listWorkApprovals: vi.fn(async () => ({ ok: true, items: [], total: 0, projects: [] })),
    listWorkBoard: vi.fn(async () => ({ status: "ok", items: [current] })),
    getWorkBoardItem: vi.fn(async () => ({ status: "found", itemId: current.id, item: current })),
    transitionWorkBoardItem: vi.fn(async () => ({ status: "transitioned", itemId: current.id, to: "in_progress", item: { ...current, status: "in_progress" } })),
    completeWorkBoardItem: vi.fn(async () => ({ status: "completed" })),
    reopenWorkBoardItem: vi.fn(async () => ({ status: "reopened" })),
    onWorkBoardItemChanged: noop, onWorkBoardRunProgress: noop, onWorkBoardRunStarted: noop,
    onWorkBoardRunFinished: noop, onWorkBoardRunFailed: noop,
  } as unknown as AveApi;
}
async function openMove(api: AveApi, destination?: string) {
  render(withApprovalSurface(<WorkBoardPanel api={api} />));
  fireEvent.click(await screen.findByTestId("work-board-move"));
  if (destination) fireEvent.change(screen.getByRole("combobox"), { target: { value: destination } });
}
afterEach(cleanup);
describe("work board moves", () => {
  it("previews a menu move, waits for confirmation, and calls the existing transition", async () => {
    const api = apiFor();
    await openMove(api, "in_progress");
    expect(api.transitionWorkBoardItem).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("work-board-move-confirm"));
    await waitFor(() => expect(api.transitionWorkBoardItem).toHaveBeenCalledWith(item.id, "in_progress", item.mutationRevision));
  });
  it("rejects arbitrary Review destinations visibly without mutating", async () => {
    const api = apiFor();
    await openMove(api);
    expect(screen.queryByRole("option", { name: /^검토$/ })).toBeNull();
    expect(screen.getByTestId("work-board-unavailable-lanes")).toHaveTextContent("수동으로 지정할 수 없습니다");
    expect(screen.getByTestId("work-board-move-confirm")).toBeDisabled();
    expect(api.transitionWorkBoardItem).not.toHaveBeenCalled();
  });
  it("retains the card when the host refuses a move", async () => {
    const api = apiFor();
    vi.mocked(api.transitionWorkBoardItem).mockResolvedValue({ status: "invalid", itemId: item.id, reason: "refused" });
    await openMove(api, "in_progress");
    fireEvent.click(screen.getByTestId("work-board-move-confirm"));
    await screen.findByRole("alert");
    expect(within(screen.getByTestId("work-board-column-planned")).getByTestId("work-board-card")).toBeTruthy();
  });
  it("refuses stale destinations after a run starts elsewhere", async () => {
    const api = apiFor();
    vi.mocked(api.transitionWorkBoardItem).mockResolvedValue({ status: "invalid", itemId: item.id, reason: "work-item-changed" });
    await openMove(api, "in_progress");
    fireEvent.click(screen.getByTestId("work-board-move-confirm"));
    await screen.findByRole("alert");
    expect(api.transitionWorkBoardItem).toHaveBeenCalledWith(item.id, "in_progress", item.mutationRevision);
  });
  it("offers a completed result only its valid derived review destination", async () => {
    await openMove(apiFor({ ...item, status: "completed", runStatus: "completed", output: "Saved output" }));
    expect(screen.getAllByRole("option").map((option) => (option as HTMLOptionElement).value)).toEqual(["", "review"]);
  });
  it("offers no free lifecycle targets for a pending plan", async () => {
    await openMove(apiFor({ ...item, runStatus: "awaiting_approval" }));
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByTestId("work-board-unavailable-lanes")).toHaveTextContent("계획을 승인");
  });
  it("does not move when the preview is cancelled", async () => {
    const api = apiFor();
    await openMove(api, "in_progress");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(api.transitionWorkBoardItem).not.toHaveBeenCalled();
  });
  it("disables dragging a live run and explains a menu refusal", async () => {
    await openMove(apiFor({ ...item, runStatus: "executing" }));
    expect(screen.getByTestId("work-board-drag-handle")).toBeDisabled();
    expect(screen.getByTestId("work-board-unavailable-lanes")).toHaveTextContent("실행을 중지");
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByTestId("work-board-move-confirm")).toBeDisabled();
  });
});
