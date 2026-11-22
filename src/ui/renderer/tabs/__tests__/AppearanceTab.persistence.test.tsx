import { ok as assertPresent } from "node:assert/strict";
import "../../../../../test/renderer/setup.js";
import { act, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeMockAveApi, MOCK_DEFAULT_SETTINGS } from "../../../../../test/renderer/mock-ave-api.js";
import { ThemeProvider } from "../../theme/ThemeProvider.js";
import { SavedToastProvider } from "../../context/SavedToastContext.js";
import { AppearanceTab } from "../AppearanceTab.js";
import { I18nProvider } from "../../../../i18n/react.js";
import { ZoomControls } from "../../components/ZoomControls.js";
import { zoomLevelToZoomFactor } from "../../../../shared/app-zoom.js";

function setup(content: "appearance" | "zoom" = "appearance") {
  const settings = structuredClone(MOCK_DEFAULT_SETTINGS);
  const { api } = makeMockAveApi({ settings });
  window.aveApi = api as never;
  const notifySaved = vi.fn();
  const view = render(<ThemeProvider api={api as never} initialAppearance={settings.appearance}>
    <SavedToastProvider value={notifySaved}>{content === "appearance" ? <AppearanceTab /> : <ZoomControls />}</SavedToastProvider>
  </ThemeProvider>);
  return { ...view, api, notifySaved, settings };
}

afterEach(() => {
  document.documentElement.removeAttribute("data-glass-capable");
  document.documentElement.removeAttribute("data-glass");
});

describe("font and zoom persistence failures", () => {
  it.each(["refused", "thrown"])("restores a UI font family after a %s save and never reports success", async (failure) => {
    const view = setup();
    await waitFor(() => expect(view.getByTestId("appearance-font-controls")).not.toBeDisabled());
    const presets = within(view.getByTestId("font-family-presets"));
    const previous = presets.getAllByRole("radio").find((radio) => radio.getAttribute("aria-checked") === "true");
    assertPresent(previous);
    if (failure === "refused") view.api.updateSettings.mockResolvedValueOnce({ ok: false, error: "settings-write-failed" });
    else view.api.updateSettings.mockRejectedValueOnce(new Error("Write failed"));
    const [, next] = presets.getAllByRole("radio");
    assertPresent(next);
    fireEvent.click(next);
    await view.findByRole("alert");
    expect(previous).toHaveAttribute("aria-checked", "true");
    expect(view.notifySaved).not.toHaveBeenCalled();
  });

  it("keeps a newer authoritative font broadcast when an older write fails", async () => {
    const view = setup();
    await waitFor(() => expect(view.getByTestId("appearance-font-controls")).not.toBeDisabled());
    let rejectOld!: (error: Error) => void;
    view.api.updateSettings.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOld = reject; }));
    const [, next] = within(view.getByTestId("font-family-presets")).getAllByRole("radio");
    assertPresent(next);
    fireEvent.click(next);
    await act(async () => { await view.api.updateSettings({ appearance: { font: { family: "Saved Sans, sans-serif" } } }); });
    await act(async () => { rejectOld(new Error("Earlier write failed")); });
    expect(view.getByTestId("font-chat-preview")).toHaveStyle({ fontFamily: "Saved Sans, sans-serif" });
    expect(view.notifySaved).not.toHaveBeenCalled();
    expect(await view.findByRole("alert")).toBeTruthy();
  });

  it("shows initial font-read failure and retries the actual saved configuration", async () => {
    const { api } = makeMockAveApi({ settings: { ...MOCK_DEFAULT_SETTINGS, appearance: { ...MOCK_DEFAULT_SETTINGS.appearance, font: { family: "Saved Sans, sans-serif", sizeScale: 1.125 } } } });
    window.aveApi = api as never;
    api.getSettings.mockRejectedValueOnce(new Error("Read failed"));
    const view = render(<ThemeProvider initialAppearance={MOCK_DEFAULT_SETTINGS.appearance}><SavedToastProvider value={vi.fn()}><AppearanceTab /></SavedToastProvider></ThemeProvider>);
    const error = await view.findByRole("alert");
    expect(view.getByTestId("appearance-font-controls")).toBeDisabled();
    fireEvent.click(within(error).getByRole("button"));
    await waitFor(() => expect(view.getByTestId("appearance-font-controls")).not.toBeDisabled());
    expect(api.getSettings).toHaveBeenCalledTimes(2);
    expect(view.getByTestId("font-chat-preview")).toHaveStyle({ fontFamily: "Saved Sans, sans-serif" });
    expect(view.queryByRole("alert")).toBeNull();
  });

  it.each(["refused", "thrown"])("restores terminal metrics after a %s save without reporting success", async (failure) => {
    const view = setup();
    await waitFor(() => expect(view.getByTestId("appearance-font-controls")).not.toBeDisabled());
    const preview = view.getByTestId("terminal-font-preview");
    const size = preview.style.fontSize;
    if (failure === "refused") view.api.updateSettings.mockResolvedValueOnce({ ok: false, error: "settings-write-failed" });
    else view.api.updateSettings.mockRejectedValueOnce(new Error("Write failed"));
    fireEvent.click(within(view.getByRole("group", { name: "크기 (px)" })).getByRole("button", { name: /\+/ }));
    await view.findByRole("alert");
    expect(preview.style.fontSize).toBe(size);
    expect(view.notifySaved).not.toHaveBeenCalled();
  });

  it("does not restore stale terminal metrics over a newer host broadcast", async () => {
    const view = setup();
    await waitFor(() => expect(view.getByTestId("appearance-font-controls")).not.toBeDisabled());
    let rejectOld!: (error: Error) => void;
    view.api.updateSettings.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOld = reject; }));
    fireEvent.click(within(view.getByRole("group", { name: "크기 (px)" })).getByRole("button", { name: /\+/ }));
    await act(async () => { await view.api.updateSettings({ appearance: { terminalFont: { ...view.settings.appearance.terminalFont, size: 24 } } }); });
    await act(async () => { rejectOld(new Error("Earlier write failed")); });
    expect(view.getByTestId("terminal-font-preview").style.fontSize).toBe("24px");
    expect(await view.findByRole("alert")).toBeTruthy();
    expect(view.notifySaved).not.toHaveBeenCalled();
  });

  it.each(["refused", "thrown"])("restores zoom after a %s write and reports an inline failure", async (failure) => {
    const view = setup("zoom");
    await act(async () => {});
    const before = view.getByTestId("zoom-controls").textContent;
    assertPresent(before);
    if (failure === "refused") view.api.updateSettings.mockResolvedValueOnce({ ok: false, error: "settings-write-failed" });
    else view.api.updateSettings.mockRejectedValueOnce(new Error("Write failed"));
    fireEvent.click(view.getByRole("button", { name: /^확대 \(/ }));
    await view.findByRole("alert");
    expect(view.getByTestId("zoom-controls").textContent).toContain(before.replace(/\s+/g, " ").trim());
    expect(view.notifySaved).not.toHaveBeenCalled();
  });

  it("preserves a newer zoom broadcast when an earlier write fails", async () => {
    const view = setup("zoom");
    let rejectOld!: (error: Error) => void;
    view.api.updateSettings.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOld = reject; }));
    fireEvent.click(view.getByRole("button", { name: /^확대 \(/ }));
    await act(async () => { await view.api.updateSettings({ appearance: { zoomLevel: 2 } }); });
    await act(async () => { rejectOld(new Error("Earlier write failed")); });
    expect(view.getByTestId("zoom-controls")).toHaveTextContent(`${Math.round(zoomLevelToZoomFactor(2) * 100)}%`);
    expect(view.queryByRole("alert")).toBeNull();
  });
  it.each(["mode", "scheme"])("does not report a refused %s choice as saved", async (choice) => {
    const view = setup();
    await waitFor(() => expect(view.getByTestId("appearance-font-controls")).not.toBeDisabled());
    view.api.updateSettings.mockResolvedValueOnce({ ok: false, error: "settings-write-failed" });
    const target = choice === "mode" ? view.getByTestId("appearance-mode-light")
      : view.container.querySelector<HTMLElement>('[data-scheme-id][aria-checked="false"]');
    assertPresent(target);
    fireEvent.click(target);
    await view.findByRole("alert");
    expect(view.notifySaved).not.toHaveBeenCalled();
  });

  it("waits for the language owner's checked result before notifying success", async () => {
    const { api } = makeMockAveApi(); window.aveApi = api as never;
    const notifySaved = vi.fn();
    const setLocale = vi.fn(async () => ({ ok: false as const }));
    const view = render(<I18nProvider locale="ko" setLocale={setLocale}><ThemeProvider initialAppearance={MOCK_DEFAULT_SETTINGS.appearance}><SavedToastProvider value={notifySaved}><AppearanceTab /></SavedToastProvider></ThemeProvider></I18nProvider>);
    fireEvent.click(view.getByTestId("language-option-en"));
    await view.findByRole("alert");
    expect(setLocale).toHaveBeenCalledWith("en");
    expect(notifySaved).not.toHaveBeenCalled();
  });

  it("does not report a failed material-tint commit as saved", async () => {
    document.documentElement.setAttribute("data-glass-capable", "true");
    document.documentElement.setAttribute("data-glass", "true");
    const view = setup();
    await waitFor(() => expect(view.getByTestId("appearance-font-controls")).not.toBeDisabled());
    const tint = view.getByRole("slider") as HTMLInputElement;
    const before = tint.value;
    fireEvent.change(tint, { target: { value: String(Number(before) + 1) } });
    view.api.updateSettings.mockResolvedValueOnce({ ok: false, error: "settings-write-failed" });
    fireEvent.pointerUp(tint);
    await view.findAllByRole("alert");
    expect(view.notifySaved).not.toHaveBeenCalled();
    expect(tint.value).toBe(before);
  });

});
