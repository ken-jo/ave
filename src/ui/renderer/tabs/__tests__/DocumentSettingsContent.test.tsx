import "../../../../../test/renderer/setup.js";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { deferred } from "../../../../__tests__/support/deferred.js";
import { DocumentSettingsContent } from "../DocumentSettingsContent.js";
import { makeMockAveApi, MOCK_DEFAULT_SETTINGS } from "../../../../../test/renderer/mock-ave-api.js";

function install(openMode: "direct" | "link") {
  const { api } = makeMockAveApi({ settings: { ...MOCK_DEFAULT_SETTINGS, documents: { openMode, editorCommand: "" } } });
  window.aveApi = api as never;
  const update = vi.spyOn(api, "updateSettings");
  return { api, update };
}

describe("document opening preference", () => {
  it.each(["direct", "link"] as const)("loads %s and saves the other mode through user settings", async (openMode) => {
    const { api, update } = install(openMode);
    const initial = deferred<unknown>();
    api.getSettings.mockReturnValueOnce(initial.promise);
    const view = render(<DocumentSettingsContent />);
    const other = openMode === "direct" ? "link" : "direct";
    const group = view.getByTestId("document-open-mode");
    const target = group.querySelector<HTMLButtonElement>(`[data-value="${other}"]`)!;
    // The default choice is visible before the snapshot enables interaction.
    expect(target).toBeDisabled();
    fireEvent.click(target);
    expect(update).not.toHaveBeenCalled();
    await act(async () => { initial.resolve({ ...MOCK_DEFAULT_SETTINGS, documents: { openMode, editorCommand: "" } }); });
    await waitFor(() => expect(group.querySelector(`[data-value="${openMode}"]`)?.getAttribute("aria-checked")).toBe("true"));
    await waitFor(() => expect(target).toBeEnabled());
    fireEvent.click(target);
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
    await act(async () => { initial.resolve({ ...MOCK_DEFAULT_SETTINGS, documents: { openMode: "direct", editorCommand: "" } }); });
    expect(view.getByTestId("document-open-mode").querySelector('[data-value="link"]')?.getAttribute("aria-checked")).toBe("true");
  });

  it("reports a malformed initial response instead of silently disabling the controls", async () => {
    const { api } = install("direct");
    api.getSettings.mockResolvedValueOnce({ ...MOCK_DEFAULT_SETTINGS, documents: { openMode: "other", editorCommand: "" } });
    const view = render(<DocumentSettingsContent />);
    await waitFor(() => expect(view.getByRole("alert")).toBeTruthy());
  });

  it("saves the editor command when the field is left or Enter is pressed, and not when nothing changed", async () => {
    const { update } = install("direct");
    const view = render(<DocumentSettingsContent />);
    const field = view.getByTestId("document-editor-command") as HTMLInputElement;
    await waitFor(() => expect(field).toBeEnabled());
    fireEvent.blur(field);
    expect(update).not.toHaveBeenCalled();
    fireEvent.change(field, { target: { value: "  edit --goto {file}:{line} " } });
    expect(update).not.toHaveBeenCalled();
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(update).toHaveBeenCalledWith({ documents: { editorCommand: "edit --goto {file}:{line}" } }));
    await waitFor(() => expect(field.value).toBe("edit --goto {file}:{line}"));
    fireEvent.blur(field);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("refuses an editor command with an open quote before saving, and Escape puts the saved one back", async () => {
    const { update } = install("direct");
    const view = render(<DocumentSettingsContent />);
    const field = view.getByTestId("document-editor-command") as HTMLInputElement;
    await waitFor(() => expect(field).toBeEnabled());
    fireEvent.change(field, { target: { value: 'edit "{file}' } });
    fireEvent.blur(field);
    expect(view.getByTestId("document-editor-command-invalid")).toBeTruthy();
    expect(update).not.toHaveBeenCalled();
    fireEvent.keyDown(field, { key: "Escape" });
    expect(field.value).toBe("");
    expect(view.queryByTestId("document-editor-command-invalid")).toBeNull();
  });

  it("shows a failed save when the reply does not carry the new editor command", async () => {
    const { update } = install("direct");
    update.mockResolvedValueOnce({ ...MOCK_DEFAULT_SETTINGS, documents: { openMode: "direct", editorCommand: "" } } as never);
    const view = render(<DocumentSettingsContent />);
    const field = view.getByTestId("document-editor-command") as HTMLInputElement;
    await waitFor(() => expect(field).toBeEnabled());
    fireEvent.change(field, { target: { value: "ed {file}" } });
    fireEvent.blur(field);
    await waitFor(() => expect(view.getByRole("alert")).toBeTruthy());
  });

});
