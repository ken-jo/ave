// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { withApprovalSurface } from "../../../../../test/renderer/helpers.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { WorkBoardPanel } from "../WorkBoardPanel.js";
import type { AveApi } from "../../types.js";
import type { WorkItemResolved } from "../../../../shared/work-board-types.js";
import { t } from "../../../../i18n/index.js";

const result: WorkItemResolved = { id: 2, title: "Export journal", status: "in_progress", status_resolved: "overdue", mutationRevision: "a".repeat(64), priority: "high", runStatus: "completed", output: "Export finished with 3 files", runId: "run-2", created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-02T00:00:00Z" };
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
    api.onWorkBoardItemChanged = handler => { changed = handler; return () => {}; };
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
});
