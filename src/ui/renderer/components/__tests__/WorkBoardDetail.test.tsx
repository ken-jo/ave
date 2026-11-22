// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { withApprovalSurface } from "../../../../../test/renderer/helpers.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WorkBoardPanel } from "../WorkBoardPanel.js";
import type { AveApi } from "../../types.js";
import type { WorkItemResolved } from "../../../../shared/work-board-types.js";
import { SUPPORTED_LOCALES } from "../../../../i18n/locale.js";
import { loadLocaleMessages } from "../../../../i18n/messages/index.js";
import { getLocale, setLocale, t } from "../../../../i18n/runtime.js";

const ITEM: WorkItemResolved = {
  id: 1, title: "Export notes", status: "planned", status_resolved: "planned", mutationRevision: "a".repeat(64),
  priority: "medium", created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z",
};
const originalLocale = getLocale();

function apiFor(item = ITEM): AveApi {
  const unsubscribe = () => () => {};
  return {
    listWorkApprovals: vi.fn(async () => ({ ok: true, items: [], total: 0, projects: [] })),
    listWorkBoard: vi.fn(async () => ({ status: "ok", items: [item] })),
    getWorkBoardItem: vi.fn(async () => ({ status: "found", itemId: item.id, item: { ...item } })),
    completeWorkBoardItem: vi.fn(async () => ({ status: "completed", itemId: item.id, item })),
    reopenWorkBoardItem: vi.fn(async () => ({ status: "reopened", itemId: item.id, item })),
    removeWorkBoardItem: vi.fn(async () => ({ status: "deleted", itemId: item.id })),
    updateWorkBoardItem: vi.fn(async () => ({ status: "updated", itemId: item.id, item })),
    onWorkBoardItemChanged: unsubscribe, onWorkBoardRunProgress: unsubscribe, onWorkBoardRunStarted: unsubscribe,
    onWorkBoardRunFinished: unsubscribe, onWorkBoardRunFailed: unsubscribe,
  } as unknown as AveApi;
}

async function openDetails(api: AveApi) {
  render(withApprovalSurface(<WorkBoardPanel api={api} />));
  fireEvent.click(await screen.findByTestId("work-board-card"));
  await screen.findByTestId("work-board-detail-title");
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setLocale(originalLocale);
});

describe.each(SUPPORTED_LOCALES)("%s work item detail refusals", (locale) => {
  beforeEach(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    await loadLocaleMessages(locale);
    setLocale(locale);
  });

  it.each([
    ["moveRunActive", "workBoard.moveRunActive"],
    ["movePlanDecision", "workBoard.movePlanDecision"],
    ["moveReviewDerived", "workBoard.moveReviewDerived"],
    ["moveResultDecision", "workBoard.moveResultDecision"],
    ["unknown-host-refusal", "workBoard.errorMutationRefused"],
    ["__proto__", "workBoard.errorMutationRefused"],
  ])("localizes and records %s from the host in the actual detail dialog", async (reason, key) => {
    const api = apiFor();
    vi.mocked(api.completeWorkBoardItem).mockResolvedValue(Object.assign(
      { status: "invalid" as const, itemId: ITEM.id, reason },
      { item: ITEM, userText: "Private user text" },
    ));
    await openDetails(api);
    fireEvent.click(screen.getByTestId("work-board-detail-toggle"));
    const alert = await screen.findByRole("alert");
    expect(t(key)).not.toBe(key);
    expect(alert.textContent).toBe(t(key));
    expect(alert).not.toHaveTextContent(reason);
    expect(screen.getByTestId("work-board-detail-dialog")).toBeVisible();
    expect(api.completeWorkBoardItem).toHaveBeenCalledWith(ITEM.id, ITEM.mutationRevision);
    expect(console.warn).toHaveBeenCalledExactlyOnceWith("[ave] work-board mutation refused", {
      operation: "complete", itemId: ITEM.id, reason,
    });
    expect(console.error).not.toHaveBeenCalled();
  });

  it("reloads a stale snapshot and retries completion with the new revision", async () => {
    const api = apiFor();
    await openDetails(api);
    fireEvent.change(screen.getByTestId("work-board-detail-title"), { target: { value: "Unsaved title" } });
    const edited = { ...ITEM, title: "Edited in another window", mutationRevision: "b".repeat(64) };
    vi.mocked(api.getWorkBoardItem).mockResolvedValue({ status: "found", itemId: ITEM.id, item: edited });
    vi.mocked(api.completeWorkBoardItem).mockResolvedValueOnce({ status: "invalid", itemId: ITEM.id, reason: "work-item-changed" });
    fireEvent.click(screen.getByTestId("work-board-detail-toggle"));
    expect(await screen.findByRole("alert")).toHaveTextContent(t("workBoard.itemChangedReload"));
    expect(screen.getByTestId("work-board-detail-title")).toHaveValue("Unsaved title");
    const reload = screen.getByRole("button", { name: t("workBoard.reloadItem") });
    expect(reload).toBeEnabled();
    fireEvent.click(reload);
    await waitFor(() => expect(screen.getByTestId("work-board-detail-title")).toHaveValue(edited.title));
    expect(api.getWorkBoardItem).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByTestId("work-board-detail-reload")).toBeNull();
    fireEvent.click(screen.getByTestId("work-board-detail-toggle"));
    await waitFor(() => expect(api.completeWorkBoardItem).toHaveBeenLastCalledWith(ITEM.id, edited.mutationRevision));
    await waitFor(() => expect(screen.queryByTestId("work-board-detail-dialog")).toBeNull());
  });

  it("localizes a stale reopen refusal through the same detail controls", async () => {
    const api = apiFor({ ...ITEM, status: "completed", status_resolved: "completed" });
    vi.mocked(api.reopenWorkBoardItem).mockResolvedValue({ status: "invalid", itemId: ITEM.id, reason: "work-item-changed" });
    await openDetails(api);
    fireEvent.click(screen.getByTestId("work-board-detail-toggle"));
    expect(await screen.findByRole("alert")).toHaveTextContent(t("workBoard.itemChangedReload"));
    expect(screen.getByRole("button", { name: t("workBoard.reloadItem") })).toBeVisible();
  });

  it("keeps a failed reload localized and lets the user retry loading", async () => {
    const api = apiFor();
    await openDetails(api);
    vi.mocked(api.completeWorkBoardItem).mockResolvedValue({ status: "invalid", itemId: ITEM.id, reason: "work-item-changed" });
    fireEvent.click(screen.getByTestId("work-board-detail-toggle"));
    await screen.findByRole("alert");
    vi.mocked(api.getWorkBoardItem).mockResolvedValueOnce({ ok: false, error: "no-store" });
    fireEvent.click(screen.getByRole("button", { name: t("workBoard.reloadItem") }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(t("workBoard.errorLoadFailed")));
    fireEvent.click(screen.getByRole("button", { name: t("workBoard.reloadItem") }));
    await waitFor(() => expect(screen.getByTestId("work-board-detail-title")).toHaveValue(ITEM.title));
    expect(api.getWorkBoardItem).toHaveBeenCalledTimes(3);
  });

  it("reports missing items visibly without exposing a status code", async () => {
    const api = apiFor();
    vi.mocked(api.completeWorkBoardItem).mockResolvedValue({ status: "not_found", itemId: ITEM.id });
    await openDetails(api);
    fireEvent.click(screen.getByTestId("work-board-detail-toggle"));
    expect(await screen.findByRole("alert")).toHaveTextContent(t("workBoard.errorMutationRefused"));
    expect(console.warn).toHaveBeenCalledExactlyOnceWith("[ave] work-board mutation refused", {
      operation: "complete", itemId: ITEM.id, reason: "not_found",
    });
  });

  it.each(["complete", "reopen", "delete"] as const)("reports and records %s exceptions with only diagnostic fields", async (operation) => {
    const api = apiFor(operation === "reopen" ? { ...ITEM, status: "completed", status_resolved: "completed" } : ITEM);
    const method = operation === "complete" ? "completeWorkBoardItem" : operation === "reopen" ? "reopenWorkBoardItem" : "removeWorkBoardItem";
    const error = Object.assign(new TypeError("internal-host-error"), { item: ITEM, userText: "Private user text" });
    vi.mocked(api[method]).mockRejectedValue(error);
    await openDetails(api);
    fireEvent.click(screen.getByTestId(operation === "delete" ? "work-board-detail-delete" : "work-board-detail-toggle"));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(t("workBoard.errorMutationRefused"));
    expect(alert).not.toHaveTextContent("internal-host-error");
    expect(console.error).toHaveBeenCalledExactlyOnceWith("[ave] work-board mutation failed", {
      operation, itemId: ITEM.id, name: "TypeError", message: "internal-host-error",
    });
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("reports and records save exceptions without recording the edited fields", async () => {
    const api = apiFor();
    const error = Object.assign(new Error("save-host-error"), { item: ITEM, userText: "Private user text" });
    vi.mocked(api.updateWorkBoardItem).mockRejectedValue(error);
    await openDetails(api);
    fireEvent.change(screen.getByTestId("work-board-detail-title"), { target: { value: "Private edited title" } });
    fireEvent.change(screen.getByTestId("work-board-detail-detail"), { target: { value: "Private edited description" } });
    fireEvent.click(screen.getByTestId("work-board-detail-save"));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(t("workBoard.errorMutationRefused"));
    expect(alert).not.toHaveTextContent("save-host-error");
    expect(console.error).toHaveBeenCalledExactlyOnceWith("[ave] work-board mutation failed", {
      operation: "save", itemId: ITEM.id, name: "Error", message: "save-host-error",
    });
    expect(console.warn).not.toHaveBeenCalled();
  });
});

describe("work item delete", () => {
  it("deletes an item only as its card showed it, by its id and revision, and says so when the host finds it changed", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const api = apiFor();
    vi.mocked(api.removeWorkBoardItem).mockResolvedValue({ status: "invalid", itemId: ITEM.id, reason: "work-item-changed" });
    await openDetails(api);
    fireEvent.click(screen.getByTestId("work-board-detail-delete"));
    expect(await screen.findByRole("alert")).toHaveTextContent(t("workBoard.itemChangedReload"));
    expect(api.removeWorkBoardItem).toHaveBeenCalledExactlyOnceWith(ITEM.id, { revision: ITEM.mutationRevision });
  });
});
