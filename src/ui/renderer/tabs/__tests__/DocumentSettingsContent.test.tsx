import "../../../../../test/renderer/setup.js";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { deferred } from "../../../../__tests__/support/deferred.js";
import { DocumentSettingsContent } from "../DocumentSettingsContent.js";
import { makeMockAveApi, MOCK_DEFAULT_SETTINGS } from "../../../../../test/renderer/mock-ave-api.js";

function install(openMode: "direct" | "link") {
  const { api } = makeMockAveApi({ settings: { ...MOCK_DEFAULT_SETTINGS, documents: { openMode } } });
  window.aveApi = api as never;
  const update = vi.spyOn(api, "updateSettings");
  return { api, update };
}

describe("document opening preference", () => {
  it.each(["direct", "link"] as const)("loads %s and saves the other mode through user settings", async (openMode) => {
    const { update } = install(openMode);
    const view = render(<DocumentSettingsContent />);
    const other = openMode === "direct" ? "link" : "direct";
    const group = view.getByTestId("document-open-mode");
    await waitFor(() => expect(group.querySelector(`[data-value="${openMode}"]`)?.getAttribute("aria-checked")).toBe("true"));
    fireEvent.click(group.querySelector(`[data-value="${other}"]`)!);
    await waitFor(() => expect(update).toHaveBeenCalledWith({ documents: { openMode: other } }));
    await waitFor(() => expect(group.querySelector(`[data-value="${other}"]`)?.getAttribute("aria-checked")).toBe("true"));
  });

  it("keeps the saved choice when persistence fails", async () => {
    const { update } = install("link");
    update.mockRejectedValueOnce(new Error("disk unavailable"));
    const view = render(<DocumentSettingsContent />);
    const group = view.getByTestId("document-open-mode");
    await waitFor(() => expect(group.querySelector('[data-value="link"]')?.getAttribute("aria-checked")).toBe("true"));
    fireEvent.click(group.querySelector('[data-value="direct"]')!);
    await waitFor(() => expect(view.getByRole("alert")).toBeTruthy());
    expect(group.querySelector('[data-value="link"]')?.getAttribute("aria-checked")).toBe("true");
  });
  it("keeps a settings event newer than the initial snapshot", async () => {
    const { api } = install("direct");
    const initial = deferred<unknown>();
    api.getSettings.mockReturnValueOnce(initial.promise);
    const view = render(<DocumentSettingsContent />);
    await act(async () => { await api.updateSettings({ documents: { openMode: "link" } }); });
    await act(async () => { initial.resolve({ ...MOCK_DEFAULT_SETTINGS, documents: { openMode: "direct" } }); });
    expect(view.getByTestId("document-open-mode").querySelector('[data-value="link"]')?.getAttribute("aria-checked")).toBe("true");
  });

  it("reports a malformed initial response instead of silently disabling the controls", async () => {
    const { api } = install("direct");
    api.getSettings.mockResolvedValueOnce({ ...MOCK_DEFAULT_SETTINGS, documents: { openMode: "other" } });
    const view = render(<DocumentSettingsContent />);
    await waitFor(() => expect(view.getByRole("alert")).toBeTruthy());
  });

});
