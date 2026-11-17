// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { withApprovalSurface } from "../../../../../test/renderer/helpers.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { WorkBoardPanel } from "../WorkBoardPanel.js";
import type { AveApi } from "../../types.js";
import type { WorkItemChangedEventPayload, WorkItemResolved } from "../../../../shared/work-board-types.js";
import { t } from "../../../../i18n/index.js";

const result: WorkItemResolved = { id: 2, title: "Export journal", status: "in_progress", status_resolved: "overdue", mutationRevision: "a".repeat(64), priority: "high", runStatus: "completed", output: "Export finished with 3 files", runId: "run-2", created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-02T00:00:00Z" };
const itemChanged: WorkItemChangedEventPayload = { itemId: 2, change: "updated", changedAt: "2026-01-01T00:00:00.000Z" };
function apiFor(items: WorkItemResolved[]) {
  const noop = () => () => {};
  return {
    listWorkApprovals: vi.fn(async () => ({ ok: true, items: [], total: 0, projects: [] })),
    listWorkBoard: vi.fn(async () => ({ status: "ok", items })),
    getWorkBoardItem: vi.fn(async () => ({ status: "found", item: items[0] })),
    completeWorkBoardItem: vi.fn(async () => ({ status: "completed" })),
    decideWorkPlan: vi.fn(async () => ({ ok: true, status: "approved" })),
    onWorkBoardItemChanged: noop, onWorkBoardRunProgress: noop, onWorkBoardRunStarted: noop,
    onWorkBoardRunFinished: noop, onWorkBoardRunFailed: noop,
  } as unknown as AveApi;
}

afterEach(cleanup);
describe("work board review", () => {
  it("explains a run pending review beside the listed rows and clears the notice after a trusted refresh", async () => {
    const api = apiFor([result]);
    const pending: WorkItemResolved = { ...result, id: 3, title: "Template run", templateId: "template-1", runStatus: "executing", templateRunError: "template-runs-pending-review" };
    vi.mocked(api.listWorkBoard).mockResolvedValueOnce({ status: "ok", items: [pending, result] });
    let changed = () => {};
    api.onWorkBoardItemChanged = handler => { changed = () => handler(itemChanged); return () => {}; };
    render(withApprovalSurface(<WorkBoardPanel api={api} />));
    const notice = await screen.findByTestId("work-board-pending-review");
    expect(notice).toHaveTextContent(t("settingsContent.tabPermissions"));
    expect(notice).toHaveTextContent(t("permissionsTab.homeTrustTitle"));
    expect(notice.textContent).not.toMatch(/\{(?:tabPermissions|homeTrustTitle)\}/);
    expect(screen.getAllByTestId("work-board-card")).toHaveLength(2);
    changed();
    await waitFor(() => expect(screen.queryByTestId("work-board-pending-review")).toBeNull());
    expect(screen.getAllByTestId("work-board-card")).toHaveLength(1);
  });
  it("places a completed run only in Review and opens its summary below the lanes", async () => {
    render(withApprovalSurface(<WorkBoardPanel api={apiFor([result])} />));
    const card = await screen.findByTestId("work-board-card");
    expect(within(screen.getByTestId("work-board-column-review")).getByTestId("work-board-card")).toBe(card);
    expect(within(screen.getByTestId("work-board-column-in-progress")).queryByTestId("work-board-card")).toBeNull();
    fireEvent.click(card);
    expect(await screen.findByTestId("work-board-review-summary")).toHaveTextContent(result.output ?? "");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(card).toHaveTextContent("기한 지남");
  });
  it("completes the current reviewed result through the existing lifecycle API", async () => {
    const api = apiFor([result]);
    render(withApprovalSurface(<WorkBoardPanel api={api} />));
    fireEvent.click(await screen.findByTestId("work-board-card"));
    fireEvent.click(await screen.findByTestId("work-board-review-complete"));
    await waitFor(() => expect(api.completeWorkBoardItem).toHaveBeenCalledWith(result.id, result.mutationRevision));
  });
  it("refuses a result that changed after selection", async () => {
    const api = apiFor([result]);
    vi.mocked(api.completeWorkBoardItem).mockResolvedValue({ status: "invalid", itemId: result.id, reason: "work-item-changed" });
    render(withApprovalSurface(<WorkBoardPanel api={api} />));
    fireEvent.click(await screen.findByTestId("work-board-card"));
    fireEvent.click(await screen.findByTestId("work-board-review-complete"));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("검토"));
    expect(api.completeWorkBoardItem).toHaveBeenCalledWith(result.id, result.mutationRevision);
  });
  it("retains the result and shows a failed save", async () => {
    const api = apiFor([result]);
    vi.mocked(api.completeWorkBoardItem).mockRejectedValue(new Error("offline"));
    render(withApprovalSurface(<WorkBoardPanel api={api} />));
    fireEvent.click(await screen.findByTestId("work-board-card"));
    fireEvent.click(await screen.findByTestId("work-board-review-complete"));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByTestId("work-board-review-summary")).toHaveTextContent(result.output ?? "");
  });
  it("shows a pending plan with its existing run-bound decision actions", async () => {
    const item: WorkItemResolved = { ...result, runStatus: "awaiting_approval", plan: "Export three files", planApproval: { runId: "run-2", planHash: "b".repeat(64), itemDigest: "d".repeat(64), requestedAt: result.created_at, status: "pending", revision: 0 } };
    const api = apiFor([item]);
    render(withApprovalSurface(<WorkBoardPanel api={api} />));
    fireEvent.click(await screen.findByTestId("work-board-card"));
    expect(await screen.findByTestId("work-board-review-summary")).toHaveTextContent(item.plan ?? "");
    fireEvent.click(screen.getByTestId("work-board-plan-approve"));
    await waitFor(() => expect(api.decideWorkPlan).toHaveBeenCalledWith(item.id, { runId: "run-2", planHash: "b".repeat(64), decision: "approve" }));
  });
  it("says how many rows of the board file cannot be read beside the listed rows, and clears it when none are left", async () => {
    const api = apiFor([result]);
    vi.mocked(api.listWorkBoard).mockResolvedValueOnce({ status: "ok", items: [result], unreadableRows: 2 });
    let changed = () => {};
    api.onWorkBoardItemChanged = handler => { changed = () => handler(itemChanged); return () => {}; };
    render(withApprovalSurface(<WorkBoardPanel api={api} />));
    expect(await screen.findByTestId("work-board-unreadable-rows")).toHaveTextContent(t("workBoard.unreadableRows", { count: 2 }));
    expect(screen.getAllByTestId("work-board-card")).toHaveLength(1);
    changed();
    await waitFor(() => expect(screen.queryByTestId("work-board-unreadable-rows")).toBeNull());
  });
  it("shows a load error instead of an empty board when the first read fails", async () => {
    const api = apiFor([result]);
    vi.mocked(api.listWorkBoard).mockResolvedValueOnce({ ok: false, error: "invalid-template-run" });
    render(withApprovalSurface(<WorkBoardPanel api={api} />));
    expect(await screen.findByTestId("work-board-load-error")).toHaveTextContent(t("workBoard.boardLoadFailed"));
    expect(screen.queryByTestId("work-board-card")).toBeNull();
  });
  it("keeps the listed rows and shows a load error when a refresh fails", async () => {
    const api = apiFor([result]);
    let changed = () => {};
    api.onWorkBoardItemChanged = handler => { changed = () => handler(itemChanged); return () => {}; };
    render(withApprovalSurface(<WorkBoardPanel api={api} />));
    expect(await screen.findByTestId("work-board-card")).toBeTruthy();
    vi.mocked(api.listWorkBoard).mockResolvedValueOnce({ ok: false, error: "invalid-template-run" });
    changed();
    expect(await screen.findByTestId("work-board-load-error")).toHaveTextContent(t("workBoard.boardLoadFailed"));
    expect(screen.getByTestId("work-board-card")).toBeTruthy();
    vi.mocked(api.listWorkBoard).mockRejectedValueOnce(new Error("read failed"));
    changed();
    await waitFor(() => expect(api.listWorkBoard).toHaveBeenCalledTimes(3));
    expect(screen.getByTestId("work-board-load-error")).toBeTruthy();
    expect(screen.getByTestId("work-board-card")).toBeTruthy();
    changed();
    await waitFor(() => expect(screen.queryByTestId("work-board-load-error")).toBeNull());
    expect(screen.getByTestId("work-board-card")).toBeTruthy();
  });
});
