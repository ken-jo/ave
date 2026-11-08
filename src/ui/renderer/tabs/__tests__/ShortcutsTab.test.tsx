import "../../../../../test/renderer/setup.js";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeMockAveApi, MOCK_DEFAULT_SETTINGS } from "../../../../../test/renderer/mock-ave-api.js";
import { applyShortcutBindingsPatch, type ShortcutSettings } from "../../../../shared/shortcuts.js";
import { __resetShortcutsForTest, matchesShortcut, useShortcutSettingsSync } from "../../hooks/use-shortcuts.js";
import * as shortcutHooks from "../../hooks/use-shortcuts.js";
import type { AveApi } from "../../types.js";
import { ShortcutsTab } from "../ShortcutsTab.js";
import { ko } from "../../../../i18n/messages/ko.js";

/** The mock's generic section merge replaces `bindings` wholesale; apply rebinds the way the store does instead, so a
 * reset (writing the default) really leaves no override behind. These tests run as a non-Mac renderer in Korean. */
function installApi(bindings: ShortcutSettings["bindings"] = {}) {
  let shortcuts: ShortcutSettings = { toggleWindow: null, enabled: false, bindings };
  const { api } = makeMockAveApi({ settings: { ...MOCK_DEFAULT_SETTINGS, shortcuts } });
  const listeners = new Set<(settings: unknown) => void>();
  api.onSettingsUpdated.mockImplementation((handler: (settings: unknown) => void) => {
    listeners.add(handler);
    return () => listeners.delete(handler);
  });
  const snapshot = () => ({ ...MOCK_DEFAULT_SETTINGS, shortcuts });
  api.getSettings.mockImplementation(async () => snapshot());
  api.updateSettings.mockImplementation(async (patch: { shortcuts?: { bindings?: Record<string, string> } }) => {
    if (patch.shortcuts?.bindings) {
      shortcuts = { ...shortcuts, bindings: applyShortcutBindingsPatch(shortcuts, patch.shortcuts.bindings, "other") };
    }
    const next = snapshot();
    for (const listener of listeners) listener(next);
    return next;
  });
  (globalThis as unknown as { window: typeof window }).window.aveApi = api as never;
  return api;
}

function Harness({ api }: { api: unknown }) {
  useShortcutSettingsSync(api as AveApi);
  return <ShortcutsTab />;
}

const press = (init: KeyboardEventInit) => act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })); });

afterEach(() => {
  __resetShortcutsForTest();
});

describe("ShortcutsTab", () => {
  it.each(["darwin", "other"] as const)("refuses shifted Equal and preserves another plus location on %s", async (platform) => {
    const platformSpy = vi.spyOn(shortcutHooks, "rendererShortcutPlatform").mockReturnValue(platform);
    try {
      const api = installApi();
      render(<Harness api={api} />);
      fireEvent.click(await screen.findByTestId("shortcuts:record-app.search"));
      for (const [code, shiftKey] of [["Equal", true], ["BracketRight", false], ["BracketRight", true]] as const) {
        press({ key: "+", code, shiftKey, metaKey: platform === "darwin", ctrlKey: platform === "other" });
        expect(screen.getByTestId("shortcuts:notice-app.search").textContent).toContain(ko["be_main.menuZoomIn"]);
        expect(api.updateSettings).not.toHaveBeenCalled();
      }
      expect(screen.getByTestId("shortcuts:notice-app.search").textContent).toContain(ko["be_main.menuZoomIn"]);
      expect(api.updateSettings).not.toHaveBeenCalled();
      expect(screen.getByTestId("shortcuts:record-app.search").getAttribute("aria-pressed")).toBe("true");
      press({ key: "+", code: "BracketRight", altKey: true });
      await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ shortcuts: { bindings: { "app.search": "Alt+Plus" } } }));
    } finally {
      platformSpy.mockRestore();
    }
  });

  it.each([
    ["0", "Numpad0", "num0", "be_main.menuResetZoom"],
    ["+", "NumpadAdd", "numadd", "be_main.menuZoomIn"],
    ["-", "NumpadSubtract", "numsub", "be_main.menuZoomOut"],
  ] as const)("refuses fixed keypad %s then records an Alt binding", async (key, code, token, labelKey) => {
    const api = installApi();
    render(<Harness api={api} />);
    fireEvent.click(await screen.findByTestId("shortcuts:record-app.search"));
    press({ key, code, ctrlKey: true });
    expect(screen.getByTestId("shortcuts:notice-app.search").textContent).toContain(ko[labelKey]);
    expect(api.updateSettings).not.toHaveBeenCalled();
    expect(screen.getByTestId("shortcuts:record-app.search").getAttribute("aria-pressed")).toBe("true");
    press({ key, code, altKey: true });
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ shortcuts: { bindings: { "app.search": `Alt+${token}` } } }));
    await waitFor(() => expect(matchesShortcut("app.search", new KeyboardEvent("keydown", { key, code, altKey: true }))).toBe(true));
  });

  it("groups rows by scope, shows platform keycaps, and marks fixed rows with their reason", async () => {
    installApi();
    render(<Harness api={(window as unknown as { aveApi: unknown }).aveApi} />);
    const search = await screen.findByTestId("shortcuts:row-app.search");
    expect(within(search).getByTestId("shortcuts:record-app.search").textContent).toBe("CtrlF");
    expect(screen.getByRole("heading", { name: ko["shortcutsTab.scope.app"] })).toBeTruthy();
    expect(screen.getByRole("heading", { name: ko["shortcutsTab.scope.composer"] })).toBeTruthy();
    // A fixed row has no record button, and says why.
    expect(screen.queryByTestId("shortcuts:record-edit.copy")).toBeNull();
    expect(screen.getByTestId("shortcuts:reason-edit.copy").textContent).toBe(ko["shortcutsTab.readOnly.edit"]);
    expect(screen.getByTestId("shortcuts:reason-system.toggleWindow").textContent).toBe(ko["shortcutsTab.readOnly.global"]);
  });

  it("lists primary and alternate zoom keys as fixed menu commands", async () => {
    installApi();
    render(<Harness api={(window as unknown as { aveApi: unknown }).aveApi} />);
    await screen.findByTestId("shortcuts:row-app.search");
    const rows = [
      ["menu.zoomIn", "be_main.menuZoomIn", "Ctrl="],
      ["menu.zoomInShifted", "be_main.menuZoomIn", "CtrlShift="],
      ["menu.zoomInKeypad", "be_main.menuZoomIn", "CtrlNum +"],
      ["menu.zoomOut", "be_main.menuZoomOut", "Ctrl-"],
      ["menu.zoomOutShifted", "be_main.menuZoomOut", "CtrlShift-"],
      ["menu.zoomOutKeypad", "be_main.menuZoomOut", "CtrlNum −"],
      ["menu.resetZoom", "be_main.menuResetZoom", "CtrlNum 0"],
    ] as const;
    for (const [id, labelKey, keycaps] of rows) {
      const row = screen.getByTestId(`shortcuts:row-${id}`);
      expect(within(row).getByText(ko[labelKey])).toBeTruthy();
      expect(Array.from(screen.getByTestId(`shortcuts:fixed-${id}`).querySelectorAll("kbd"), (key) => key.textContent).join("")).toBe(keycaps);
      expect(screen.queryByTestId(`shortcuts:record-${id}`)).toBeNull();
      expect(screen.getByTestId(`shortcuts:reason-${id}`).textContent).toBe(ko["shortcutsTab.readOnly.zoom"]);
    }
  });

  it("filters by search over labels and keys", async () => {
    installApi();
    render(<Harness api={(window as unknown as { aveApi: unknown }).aveApi} />);
    await screen.findByTestId("shortcuts:row-app.search");
    fireEvent.change(screen.getByTestId("shortcuts:search"), { target: { value: "팔레트" } });
    expect(screen.getByTestId("shortcuts:row-app.commandPalette")).toBeTruthy();
    expect(screen.queryByTestId("shortcuts:row-app.search")).toBeNull();
    fireEvent.change(screen.getByTestId("shortcuts:search"), { target: { value: "zzz-nothing" } });
    expect(screen.getByText(ko["shortcutsTab.empty"])).toBeTruthy();
  });

  it("records a new key, persists it, and the consumer follows it", async () => {
    const api = installApi();
    render(<Harness api={(window as unknown as { aveApi: unknown }).aveApi} />);
    const statusNode = await screen.findByTestId("shortcuts:status");
    fireEvent.click(await screen.findByTestId("shortcuts:record-app.search"));
    // The page's one live region announces the recording; it is the same node, not a freshly mounted one.
    expect(screen.getByTestId("shortcuts:status")).toBe(statusNode);
    expect(statusNode.textContent).toBe(ko["shortcutsTab.recordingHint"]);
    // While recording, the old key is not a command.
    expect(matchesShortcut("app.search", new KeyboardEvent("keydown", { key: "f", code: "KeyF", ctrlKey: true }))).toBe(false);
    press({ key: "Shift", shiftKey: true });
    press({ key: "y", code: "KeyY", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ shortcuts: { bindings: { "app.search": "CommandOrControl+Shift+Y" } } }));
    await waitFor(() => expect(screen.getByTestId("shortcuts:record-app.search").textContent).toBe("CtrlShiftY"));
    expect(matchesShortcut("app.search", new KeyboardEvent("keydown", { key: "y", code: "KeyY", ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(matchesShortcut("app.search", new KeyboardEvent("keydown", { key: "f", code: "KeyF", ctrlKey: true }))).toBe(false);
  });

  it("refuses a bare key, an OS key and a fixed row's key, saying why, and keeps recording", async () => {
    const api = installApi();
    render(<Harness api={(window as unknown as { aveApi: unknown }).aveApi} />);
    fireEvent.click(await screen.findByTestId("shortcuts:record-app.search"));
    press({ key: "j", code: "KeyJ" });
    expect(screen.getByTestId("shortcuts:notice-app.search").textContent).toBe(ko["shortcutsTab.notice.needsModifier"]);
    press({ key: "F4", altKey: true });
    expect(screen.getByTestId("shortcuts:notice-app.search").textContent).toBe(ko["shortcutsTab.notice.osReserved"]);
    press({ key: "c", code: "KeyC", ctrlKey: true });
    expect(screen.getByTestId("shortcuts:notice-app.search").textContent).toContain(ko["shortcuts.label.stopWithCopyKey"]);
    expect(api.updateSettings).not.toHaveBeenCalled();
    press({ key: "Escape" });
    expect(screen.queryByTestId("shortcuts:notice-app.search")).toBeNull();
    expect(screen.getByTestId("shortcuts:record-app.search").getAttribute("aria-pressed")).toBe("false");
  });

  it("badges conflicts, filters to them, and resets a row to its default", async () => {
    const api = installApi({ "app.search": "CommandOrControl+K" });
    render(<Harness api={(window as unknown as { aveApi: unknown }).aveApi} />);
    await screen.findByTestId("shortcuts:conflict-app.search");
    expect(screen.getByTestId("shortcuts:conflict-app.commandPalette")).toBeTruthy();

    const conflictsChip = screen.getByTestId("shortcuts:filter-conflicts");
    expect(conflictsChip.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(conflictsChip);
    expect(conflictsChip.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("shortcuts:filter-all").getAttribute("aria-pressed")).toBe("false");
    const shown = screen.getAllByTestId(/^shortcuts:row-/).map((row) => row.dataset.testid);
    expect(shown.sort()).toEqual(["shortcuts:row-app.commandPalette", "shortcuts:row-app.search"]);

    const reset = screen.getByTestId("shortcuts:reset-app.search");
    expect((reset as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTestId("shortcuts:reset-app.commandPalette") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(reset);
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ shortcuts: { bindings: { "app.search": "CommandOrControl+F" } } }));
    await waitFor(() => expect(screen.queryByTestId("shortcuts:conflict-app.search")).toBeNull());
    fireEvent.click(screen.getByTestId("shortcuts:filter-all"));
    expect(screen.getByTestId("shortcuts:record-app.search").textContent).toBe("CtrlF");
    expect((screen.getByTestId("shortcuts:reset-app.search") as HTMLButtonElement).disabled).toBe(true);
  });

  it("moves between rows with the arrow keys", async () => {
    installApi();
    render(<Harness api={(window as unknown as { aveApi: unknown }).aveApi} />);
    const first = await screen.findByTestId("shortcuts:record-app.commandPalette");
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByTestId("shortcuts:record-app.search"));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowUp" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "End" });
    expect(document.activeElement).toBe(screen.getByTestId("shortcuts:fixed-system.toggleWindow"));
  });
});
