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
  it("shows one card marked invalid per row of the board file that cannot be read, beside the listed rows, and clears them when none are left", async () => {
    const api = apiFor([result]);
    vi.mocked(api.listWorkBoard).mockResolvedValueOnce({ status: "ok", items: [result], unreadableRows: [{ id: 7, position: 0, hash: "a".repeat(64) }, { position: 1, hash: "b".repeat(64) }, { id: 7, position: 2, hash: "c".repeat(64) }] });
    let changed = () => {};
    api.onWorkBoardItemChanged = handler => { changed = () => handler(itemChanged); return () => {}; };
    render(withApprovalSurface(<WorkBoardPanel api={api} />));
    const list = await screen.findByTestId("work-board-unreadable-rows");
    expect(list).toHaveAccessibleName(t("workBoard.unreadableRowsLabel"));
    const cards = within(list).getAllByTestId("work-board-unreadable-row");
    expect(cards.map(card => card.textContent)).toEqual([
      `${t("workBoard.unreadableRowBadge")}${t("workBoard.unreadableRow", { id: 7 })}${t("workBoard.deleteButton")}`,
      `${t("workBoard.unreadableRowBadge")}${t("workBoard.unreadableRowNoId")}${t("workBoard.deleteButton")}`,
      `${t("workBoard.unreadableRowBadge")}${t("workBoard.unreadableRow", { id: 7 })}${t("workBoard.deleteButton")}`,
    ]);
    // Nothing on a card opens or moves the row; every card, one without an id too, can delete its own entry.
    expect(cards.map(card => within(card).queryAllByRole("button").map(button => button.getAttribute("aria-label")))).toEqual([
      [t("workBoard.unreadableRowDeleteLabel", { id: 7 })], [t("workBoard.unreadableRowNoIdDeleteLabel", { n: 2 })], [t("workBoard.unreadableRowDeleteLabel", { id: 7 })],
    ]);
    expect(screen.getAllByTestId("work-board-card")).toHaveLength(1);
    changed();
    await waitFor(() => expect(screen.queryByTestId("work-board-unreadable-rows")).toBeNull());
  });
  it.each([{ id: 7 }, {}])("deletes an invalid row (%o) from its card at once, with no confirm, by its place and content in the board file, then reads the board again", async (id) => {
    const api = apiFor([result]);
    vi.mocked(api.listWorkBoard).mockResolvedValueOnce({ status: "ok", items: [result], unreadableRows: [{ ...id, position: 3, hash: "d".repeat(64) }] });
    const remove = vi.fn(async () => ({ status: "deleted" as const, ...id }));
    api.removeWorkBoardItem = remove;
    render(withApprovalSurface(<WorkBoardPanel api={api} />));
    fireEvent.click(await screen.findByTestId("work-board-unreadable-row-delete"));
    await waitFor(() => expect(screen.queryByTestId("work-board-unreadable-rows")).toBeNull());
    expect(remove).toHaveBeenCalledWith(null, { invalidRow: { position: 3, hash: "d".repeat(64) } });
    expect(api.listWorkBoard).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByTestId("work-board-unreadable-row-error")).toBeNull();
  });
  it.each([
    [{ status: "not_found" as const }, "workBoard.errorMutationRefused"],
    [{ status: "invalid" as const, reason: "work-board-row-changed" as const }, "workBoard.unreadableRowChanged"],
  ] as const)("says why a refused invalid row delete (%o) did nothing and keeps the card", async (refusal, message) => {
    const api = apiFor([result]);
    vi.mocked(api.listWorkBoard).mockResolvedValue({ status: "ok", items: [result], unreadableRows: [{ id: 7, position: 0, hash: "a".repeat(64) }] });
    api.removeWorkBoardItem = vi.fn(async () => refusal);
    render(withApprovalSurface(<WorkBoardPanel api={api} />));
    fireEvent.click(await screen.findByTestId("work-board-unreadable-row-delete"));
    expect(await screen.findByTestId("work-board-unreadable-row-error")).toHaveTextContent(t(message));
    expect(screen.getByTestId("work-board-unreadable-row")).toBeTruthy();
  });
  it("shows one card per unreadable run record, which only discards it, and discards it at once by its place and content, then reads the board again", async () => {
    const api = apiFor([result]);
    vi.mocked(api.listWorkBoard).mockResolvedValueOnce({ status: "ok", items: [result], unreadableRuns: [{ itemId: 2, position: 1, hash: "a".repeat(64) }, { position: 4, hash: "b".repeat(64) }] });
    const remove = vi.fn(async () => ({ status: "deleted" as const }));
    api.removeWorkBoardItem = remove;
    render(withApprovalSurface(<WorkBoardPanel api={api} />));
    const list = await screen.findByTestId("work-board-unreadable-runs");
    expect(list).toHaveAccessibleName(t("workBoard.unreadableRunsLabel"));
    const cards = within(list).getAllByTestId("work-board-unreadable-run");
    expect(cards.map(card => card.textContent)).toEqual([
      `${t("workBoard.unreadableRunBadge")}${t("workBoard.unreadableRun", { id: 2 })}${t("workBoard.discardRunButton")}`,
      `${t("workBoard.unreadableRunBadge")}${t("workBoard.unreadableRunNoRow")}${t("workBoard.discardRunButton")}`,
    ]);
    expect(cards.map(card => within(card).queryAllByRole("button").map(button => button.getAttribute("aria-label")))).toEqual([
      [t("workBoard.unreadableRunDiscardLabel", { id: 2 })], [t("workBoard.unreadableRunNoRowDiscardLabel", { n: 5 })],
    ]);
    fireEvent.click(within(cards[1]).getByTestId("work-board-unreadable-run-discard"));
    await waitFor(() => expect(screen.queryByTestId("work-board-unreadable-runs")).toBeNull());
    expect(remove).toHaveBeenCalledExactlyOnceWith(null, { runRecord: { position: 4, hash: "b".repeat(64) } });
    expect(api.listWorkBoard).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByTestId("work-board-unreadable-row-error")).toBeNull();
  });
  it.each([
    [{ status: "invalid" as const, reason: "template-runs-too-large" as const }, "reasonCodes.template-runs-too-large"],
    [{ status: "invalid" as const, reason: "work-board-row-changed" as const }, "workBoard.unreadableRunChanged"],
  ] as const)("says why a refused unreadable run record discard (%o) did nothing and keeps the card", async (refusal, message) => {
    const api = apiFor([result]);
    vi.mocked(api.listWorkBoard).mockResolvedValue({ status: "ok", items: [result], unreadableRuns: [{ itemId: 2, position: 0, hash: "a".repeat(64) }] });
    api.removeWorkBoardItem = vi.fn(async () => refusal);
    render(withApprovalSurface(<WorkBoardPanel api={api} />));
    fireEvent.click(await screen.findByTestId("work-board-unreadable-run-discard"));
    expect(await screen.findByTestId("work-board-unreadable-row-error")).toHaveTextContent(t(message));
    expect(screen.getByTestId("work-board-unreadable-run")).toBeTruthy();
  });
  const missingRun: WorkItemResolved = {
    id: 3, title: "Sync notes", status: "in_progress", status_resolved: "in_progress", mutationRevision: "c".repeat(64), priority: "medium", templateId: "template-1",
    runId: "run-3", runStatus: "error", templateRunError: "template-run-not-found", created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-02T00:00:00Z",
  };
  const missingRunCard = async () => {
    const badge = await screen.findByTestId("work-board-run-not-found");
    const card = badge.closest<HTMLElement>("[data-testid='work-board-card']");
    if (!card) throw new Error("no card");
    return card;
  };
  it("shows a row whose run has no record as run record not found, with Clear in place of Run, and clears it as its card shows it, then reads the board again", async () => {
    const api = apiFor([missingRun]);
    const clear = vi.fn(async () => ({ status: "updated" as const, itemId: 3, item: { ...missingRun, templateRunError: undefined } }));
    api.clearWorkBoardRun = clear;
    render(withApprovalSurface(<WorkBoardPanel api={api} />));
    const card = await missingRunCard();
    expect(within(card).getByTestId("work-board-run-not-found")).toHaveTextContent(t("workBoard.runRecordNotFound"));
    expect(within(card).queryByTestId("work-board-run")).toBeNull();
    expect(within(card).queryByTestId("work-board-run-error")).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: t("workBoard.clearRunLabel", { id: 3 }) }));
    await waitFor(() => expect(api.listWorkBoard).toHaveBeenCalledTimes(2));
    expect(clear).toHaveBeenCalledExactlyOnceWith(3, { revision: "c".repeat(64), runId: "run-3" });
    expect(screen.queryByTestId("work-board-unreadable-row-error")).toBeNull();
  });
  it.each([
    [{ status: "invalid" as const, itemId: 3, reason: "work-item-changed" }, "workBoard.itemChangedReload"],
    [{ status: "invalid" as const, itemId: 3, reason: "moveRunActive" }, "workBoard.errorMutationRefused"],
  ] as const)("says why a refused clear (%o) did nothing and keeps the card", async (refusal, message) => {
    const api = apiFor([missingRun]);
    api.clearWorkBoardRun = vi.fn(async () => refusal);
    render(withApprovalSurface(<WorkBoardPanel api={api} />));
    fireEvent.click(within(await missingRunCard()).getByTestId("work-board-clear-run"));
    expect(await screen.findByTestId("work-board-unreadable-row-error")).toHaveTextContent(t(message));
    expect(screen.getByTestId("work-board-run-not-found")).toBeTruthy();
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
