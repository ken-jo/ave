import "../../../../../test/renderer/setup.js";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { WorkBoardApprovalSettingsContent } from "../WorkBoardApprovalSettingsContent.js";
import { makeMockAveApi, MOCK_DEFAULT_SETTINGS } from "../../../../../test/renderer/mock-ave-api.js";

function install() {
  const { api } = makeMockAveApi({ settings: { ...MOCK_DEFAULT_SETTINGS } });
  window.aveApi = api as never;
  const update = vi.spyOn(api, "updateSettings");
  return { api, update };
}

describe("work board tool-approval surface preference", () => {
  it.each(["chat", "dialog"] as const)("shows the stored %s choice and saves the other place through user settings", async (stored) => {
    const { update } = install();
    const view = render(<WorkBoardApprovalSettingsContent stored={stored} loadNotice={null} />);
    const other = stored === "chat" ? "dialog" : "chat";
    const group = view.getByTestId("work-board-approval-surface");
    expect(group.querySelector(`[data-value="${stored}"]`)?.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(group.querySelector(`[data-value="${other}"]`)!);
    await waitFor(() => expect(update).toHaveBeenCalledWith({ workBoard: { toolApprovalSurface: other } }));
    await waitFor(() => expect(group.querySelector(`[data-value="${other}"]`)?.getAttribute("aria-checked")).toBe("true"));
  });

  it("keeps the saved choice when persistence fails", async () => {
    const { update } = install();
    update.mockRejectedValueOnce(new Error("disk unavailable"));
    const view = render(<WorkBoardApprovalSettingsContent stored="dialog" loadNotice={null} />);
    const group = view.getByTestId("work-board-approval-surface");
    fireEvent.click(group.querySelector('[data-value="chat"]')!);
    await waitFor(() => expect(view.getByRole("alert")).toBeTruthy());
    expect(group.querySelector('[data-value="dialog"]')?.getAttribute("aria-checked")).toBe("true");
  });

  it("shows the tab's load notice instead of controls until its settings read is ready", () => {
    install();
    const view = render(<WorkBoardApprovalSettingsContent stored={null} loadNotice={<p data-testid="notice">loading</p>} />);
    expect(view.getByTestId("notice")).toBeTruthy();
    expect(view.queryByTestId("work-board-approval-surface")).toBeNull();
  });

  it("says a stored value it cannot read is unreadable instead of picking one", () => {
    install();
    const view = render(<WorkBoardApprovalSettingsContent stored="invalid" loadNotice={null} />);
    expect(view.getByTestId("work-board-approval-surface-invalid").getAttribute("role")).toBe("alert");
    expect(view.queryByTestId("work-board-approval-surface")).toBeNull();
  });
});
