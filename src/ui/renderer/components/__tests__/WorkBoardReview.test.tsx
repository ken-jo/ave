// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { withApprovalSurface } from "../../../../../test/renderer/helpers.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { WorkBoardPanel } from "../WorkBoardPanel.js";
import type { AveApi } from "../../types.js";
import type { WorkItemChangedEventPayload, WorkItemResolved } from "../../../../shared/work-board-types.js";
import { t } from "../../../../i18n/index.js";
import { en } from "../../../../i18n/messages/en.js";
import { ko } from "../../../../i18n/messages/ko.js";

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
    expect(notice.textContent).toBe("워크플로 실행 상태는 검토가 필요합니다. 설정 > 권한 > Ave 폴더의 내용 검토에서 work-board/workflow-runs.json을 검토한 뒤 Ave를 다시 시작하세요.");
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
    expect(list).toHaveAccessibleName("작업 보드 파일에서 읽을 수 없는 항목");
    const cards = within(list).getAllByTestId("work-board-unreadable-row");
    expect(cards.map(card => card.textContent)).toEqual([
      "읽을 수 없음작업 보드 파일의 항목 #7을(를) 읽을 수 없어 여기서는 열거나 고칠 수 없고 삭제만 할 수 있습니다. 삭제하면 이 항목만 바로 파일에서 지워집니다. 보드에서 되돌릴 수는 없지만, 지우기 전 파일을 먼저 옆에 복사해 둡니다.삭제",
      "읽을 수 없음작업 보드 파일에 항목 번호를 읽을 수 없는 항목이 있어 여기서는 열거나 고칠 수 없고 삭제만 할 수 있습니다. 삭제하면 이 항목만 바로 파일에서 지워집니다. 보드에서 되돌릴 수는 없지만, 지우기 전 파일을 먼저 옆에 복사해 둡니다.삭제",
      "읽을 수 없음작업 보드 파일의 항목 #7을(를) 읽을 수 없어 여기서는 열거나 고칠 수 없고 삭제만 할 수 있습니다. 삭제하면 이 항목만 바로 파일에서 지워집니다. 보드에서 되돌릴 수는 없지만, 지우기 전 파일을 먼저 옆에 복사해 둡니다.삭제",
    ]);
    // Nothing on a card opens or moves the row; every card, one without an id too, can delete its own entry.
    expect(cards.map(card => within(card).queryAllByRole("button").map(button => button.getAttribute("aria-label")))).toEqual([
      ["작업 보드 파일에서 항목 #7 삭제"], ["작업 보드 파일에서 항목 번호가 없는 읽을 수 없는 항목 2 삭제"], ["작업 보드 파일에서 항목 #7 삭제"],
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
    [{ status: "not_found" as const }, "변경 사항을 적용하지 못했습니다. 다시 시도하세요."],
    [{ status: "invalid" as const, reason: "work-board-row-changed" as const }, "작업 보드 파일에서 이 항목이 바뀌어 아무것도 삭제하지 않았습니다. 보드에 지금 파일 내용을 다시 표시했으니 확인한 뒤 다시 시도하세요."],
  ] as const)("says why a refused invalid row delete (%o) did nothing and keeps the card", async (refusal, message) => {
    const api = apiFor([result]);
    vi.mocked(api.listWorkBoard).mockResolvedValue({ status: "ok", items: [result], unreadableRows: [{ id: 7, position: 0, hash: "a".repeat(64) }] });
    api.removeWorkBoardItem = vi.fn(async () => refusal);
    render(withApprovalSurface(<WorkBoardPanel api={api} />));
    fireEvent.click(await screen.findByTestId("work-board-unreadable-row-delete"));
    expect(await screen.findByTestId("work-board-unreadable-row-error")).toHaveTextContent(message);
    expect(screen.getByTestId("work-board-unreadable-row")).toBeTruthy();
  });
  it("shows one card per unreadable run record, which only discards it, and discards it at once by its place and content, then reads the board again", async () => {
    const api = apiFor([result]);
    vi.mocked(api.listWorkBoard).mockResolvedValueOnce({ status: "ok", items: [result], unreadableRuns: [{ itemId: 2, position: 1, hash: "a".repeat(64) }, { position: 4, hash: "b".repeat(64) }] });
    const remove = vi.fn(async () => ({ status: "deleted" as const }));
    api.removeWorkBoardItem = remove;
    render(withApprovalSurface(<WorkBoardPanel api={api} />));
    const list = await screen.findByTestId("work-board-unreadable-runs");
    expect(list).toHaveAccessibleName("작업 보드 실행 파일에서 읽을 수 없는 실행 기록");
    const cards = within(list).getAllByTestId("work-board-unreadable-run");
    expect(cards.map(card => card.textContent)).toEqual([
      "읽을 수 없는 실행 기록작업 보드 실행 파일에서 항목 #2의 실행 기록을 읽을 수 없어 그 실행이 끝났는지 알 수 없습니다. 버리면 이 기록만 바로 파일에서 지워지고, 어떤 실행도 시작하거나 멈추지 않습니다. 보드에서 되돌릴 수는 없지만, 지우기 전 파일을 먼저 옆에 복사해 둡니다.버리기",
      "읽을 수 없는 실행 기록작업 보드 실행 파일에 항목 번호를 읽을 수 없는 실행 기록이 있어 어떤 실행이었는지, 끝났는지 알 수 없습니다. 버리면 이 기록만 바로 파일에서 지워지고, 어떤 실행도 시작하거나 멈추지 않습니다. 보드에서 되돌릴 수는 없지만, 지우기 전 파일을 먼저 옆에 복사해 둡니다.버리기",
    ]);
    expect(cards.map(card => within(card).queryAllByRole("button").map(button => button.getAttribute("aria-label")))).toEqual([
      ["항목 #2의 읽을 수 없는 실행 기록 버리기"], ["실행 파일의 5번째 항목, 항목 번호가 없는 읽을 수 없는 실행 기록 버리기"],
    ]);
    fireEvent.click(within(cards[1]).getByTestId("work-board-unreadable-run-discard"));
    await waitFor(() => expect(screen.queryByTestId("work-board-unreadable-runs")).toBeNull());
    expect(remove).toHaveBeenCalledExactlyOnceWith(null, { runRecord: { position: 4, hash: "b".repeat(64) } });
    expect(api.listWorkBoard).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByTestId("work-board-unreadable-row-error")).toBeNull();
  });
  it.each([
    [{ status: "invalid" as const, reason: "template-runs-too-large" as const }, "워크플로 실행 파일이 너무 커서 실행을 더 저장할 수 없습니다. 오래된 템플릿 실행 항목을 삭제한 뒤 다시 시도하세요."],
    [{ status: "invalid" as const, reason: "work-board-run-owner-unknown" as const }, "삭제하지 않았습니다. 워크플로 실행 파일의 이 손상된 항목에는 실행이 어느 프로젝트에서 시작되었는지가 Ave가 읽을 수 있는 형태로 남아 있지 않아, 삭제해도 되는 항목인지 알 수 없습니다. 지워야 한다면 workflow-runs.json에서 직접 지우세요."],
    [{ status: "invalid" as const, reason: "work-board-row-changed" as const }, "실행 파일에서 이 실행 기록이 바뀌어 아무것도 버리지 않았습니다. 보드에 지금 파일 내용을 다시 표시했으니 확인한 뒤 다시 시도하세요."],
  ] as const)("says why a refused unreadable run record discard (%o) did nothing and keeps the card", async (refusal, message) => {
    const api = apiFor([result]);
    vi.mocked(api.listWorkBoard).mockResolvedValue({ status: "ok", items: [result], unreadableRuns: [{ itemId: 2, position: 0, hash: "a".repeat(64) }] });
    api.removeWorkBoardItem = vi.fn(async () => refusal);
    render(withApprovalSurface(<WorkBoardPanel api={api} />));
    fireEvent.click(await screen.findByTestId("work-board-unreadable-run-discard"));
    expect(await screen.findByTestId("work-board-unreadable-row-error")).toHaveTextContent(message);
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
    expect(within(card).getByTestId("work-board-run-not-found")).toHaveTextContent("실행 기록 없음");
    expect(within(card).queryByTestId("work-board-run")).toBeNull();
    expect(within(card).queryByTestId("work-board-run-error")).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: t("workBoard.clearRunLabel", { id: 3 }) }));
    await waitFor(() => expect(api.listWorkBoard).toHaveBeenCalledTimes(2));
    expect(clear).toHaveBeenCalledExactlyOnceWith(3, { revision: "c".repeat(64), runId: "run-3" });
    expect(screen.queryByTestId("work-board-unreadable-row-error")).toBeNull();
  });
  it.each([
    [{ status: "invalid" as const, itemId: 3, reason: "work-item-changed" }, "작업이 변경되었습니다. 항목을 다시 불러와 최신 내용을 확인한 뒤 다시 시도하세요. 저장하지 않은 편집 내용은 사라집니다."],
    [{ status: "invalid" as const, itemId: 3, reason: "moveRunActive" }, "변경 사항을 적용하지 못했습니다. 다시 시도하세요."],
  ] as const)("says why a refused clear (%o) did nothing and keeps the card", async (refusal, message) => {
    const api = apiFor([missingRun]);
    api.clearWorkBoardRun = vi.fn(async () => refusal);
    render(withApprovalSurface(<WorkBoardPanel api={api} />));
    fireEvent.click(within(await missingRunCard()).getByTestId("work-board-clear-run"));
    expect(await screen.findByTestId("work-board-unreadable-row-error")).toHaveTextContent(message);
    expect(screen.getByTestId("work-board-run-not-found")).toBeTruthy();
  });
  it("shows a load error instead of an empty board when the first read fails", async () => {
    const api = apiFor([result]);
    vi.mocked(api.listWorkBoard).mockResolvedValueOnce({ ok: false, error: "invalid-template-run" });
    render(withApprovalSurface(<WorkBoardPanel api={api} />));
    expect(await screen.findByTestId("work-board-load-error")).toHaveTextContent("작업 보드를 불러오지 못했습니다.");
    expect(screen.queryByTestId("work-board-card")).toBeNull();
  });
  it("says why the board cannot be read when its run file holds a key twice", async () => {
    const api = apiFor([result]);
    vi.mocked(api.listWorkBoard).mockResolvedValueOnce({ ok: false, error: "workflow-runs-duplicate-key" });
    render(withApprovalSurface(<WorkBoardPanel api={api} />));
    expect(await screen.findByTestId("work-board-load-error")).toHaveTextContent("작업 보드가 템플릿 실행을 읽을 수 없습니다. 워크플로 실행 파일 workflow-runs.json의 한 항목에 같은 키가 두 번 들어 있어 어느 값이 맞는지 알 수 없습니다. 파일은 그대로 두었고 아무것도 쓰지 않습니다. 각 항목에 키가 한 번씩만 나오도록 workflow-runs.json을 직접 고친 뒤 보드를 다시 여세요.");
    expect(t("reasonCodes.workflow-runs-duplicate-key")).toContain("workflow-runs.json");
  });
  it("lists the rows of a board file that holds a key twice and says no write goes over it until it is fixed", async () => {
    const api = apiFor([result]);
    let changed = () => {};
    api.onWorkBoardItemChanged = handler => { changed = () => handler(itemChanged); return () => {}; };
    vi.mocked(api.listWorkBoard).mockResolvedValueOnce({ status: "ok", items: [result], writesRefused: "work-board-duplicate-key" });
    render(withApprovalSurface(<WorkBoardPanel api={api} />));
    expect(await screen.findByTestId("work-board-writes-refused")).toHaveTextContent("작업 보드에 아무것도 저장하지 않았습니다. 보드 파일 board.json의 한 항목에 같은 키가 두 번 들어 있어 어느 값이 맞는지 알 수 없고, 다시 쓰면 다른 값을 잃게 됩니다. 보드는 파일이 읽히는 대로 보여 줍니다. 각 항목에 키가 한 번씩만 나오도록 board.json을 직접 고치세요. 그 전에는 이 파일에 아무것도 쓰지 않습니다.");
    expect(t("reasonCodes.work-board-duplicate-key")).toContain("board.json");
    expect(screen.getByTestId("work-board-card")).toBeTruthy();
    changed();
    await waitFor(() => expect(screen.queryByTestId("work-board-writes-refused")).toBeNull());
  });
  it("shows one notice while a list says writes wait for the run file, and drops it once a list no longer does", async () => {
    const api = apiFor([result]);
    let changed = () => {};
    api.onWorkBoardItemChanged = handler => { changed = () => handler(itemChanged); return () => {}; };
    vi.mocked(api.listWorkBoard).mockResolvedValueOnce({ status: "ok", items: [result], writesRefused: "work-board-runs-unreadable" });
    render(withApprovalSurface(<WorkBoardPanel api={api} />));
    expect(await screen.findAllByTestId("work-board-writes-refused")).toHaveLength(1);
    expect(screen.getByTestId("work-board-writes-refused")).toHaveTextContent("저장하지 않았습니다. 지금은 워크플로 실행 파일(작업 보드 폴더의 workflow-runs.json)을 읽을 수 없어, 이 변경이 끝나지 않은 템플릿 실행의 ID를 작업 보드 파일에서 지우는지 알 수 없습니다. 보드와 실행은 그대로 두었습니다. Ave가 요청하면 workflow-runs.json을 검토하거나 고치세요. 다시 읽을 수 있게 되면 다음 변경은 평소대로 저장됩니다.");
    for (const catalog of [en, ko]) expect(catalog["reasonCodes.work-board-runs-unreadable"]).toContain("workflow-runs.json");
    expect(screen.getByTestId("work-board-card")).toBeTruthy();
    changed();
    await waitFor(() => expect(screen.queryByTestId("work-board-writes-refused")).toBeNull());
  });
  it("keeps the listed rows and shows a load error when a refresh fails", async () => {
    const api = apiFor([result]);
    let changed = () => {};
    api.onWorkBoardItemChanged = handler => { changed = () => handler(itemChanged); return () => {}; };
    render(withApprovalSurface(<WorkBoardPanel api={api} />));
    expect(await screen.findByTestId("work-board-card")).toBeTruthy();
    vi.mocked(api.listWorkBoard).mockResolvedValueOnce({ ok: false, error: "invalid-template-run" });
    changed();
    expect(await screen.findByTestId("work-board-load-error")).toHaveTextContent("작업 보드를 불러오지 못했습니다.");
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

it("shows a held run's coded notice once and removes it after recovery", async () => {
  const item = { ...result, runStatus: "executing" as const };
  const api = apiFor([item]);
  const handlers: Parameters<AveApi["onWorkBoardRunProgress"]>[0][] = [];
  api.onWorkBoardRunProgress = handler => { handlers.push(handler); return () => {}; };
  const progress = (event: Parameters<Parameters<AveApi["onWorkBoardRunProgress"]>[0]>[0]) => act(() => { for (const handler of handlers) handler(event); });
  render(withApprovalSurface(<WorkBoardPanel api={api} />));
  await screen.findByTestId("work-board-card");
  const held = { itemId: item.id, phase: "executing" as const, message: "template-runs-board-unread", reasonCode: "template-runs-board-unread", at: item.updated_at };
  progress(held);
  expect(await screen.findAllByTestId("work-board-run-held")).toHaveLength(1);
  progress(held);
  expect(await screen.findAllByTestId("work-board-run-held")).toHaveLength(1);
  expect(screen.getByTestId("work-board-run-held")).toHaveTextContent("작업 보드 파일이 없거나 읽을 수 없는 동안에는 이전 실행을 항목과 맞출 수 없어 템플릿 실행이 멈춥니다. 파일을 읽을 수 있게 되면 다시 진행됩니다.");
  expect(screen.queryByTestId("work-board-run-error")).toBeNull();
  progress({ itemId: item.id, phase: "executing", message: "resumed", at: item.updated_at });
  await waitFor(() => expect(screen.queryByTestId("work-board-run-held")).toBeNull());
});
