// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { makeMockAveApi } from "../../../../../test/renderer/mock-ave-api.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAppBootstrap } from "../../hooks/use-app-bootstrap.js";
import { useSearch } from "../../hooks/use-search.js";
import type { AveApi } from "../../types.js";
import { NO_SHORTCUT_OVERRIDES } from "../../../../shared/shortcuts.js";
import { __resetShortcutsForTest, matchesShortcut, setShortcutCaptureActive, setShortcutSettings, shortcutHint } from "../../hooks/use-shortcuts.js";
import { WORKSPACE_TAB_LAUNCHER } from "../command-actions.js";

function keyEvent(over: Partial<KeyboardEvent>): Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey"> {
  return { key: "a", code: "", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...over };
}

function setPlatform(isDarwin: boolean): void {
  (window as unknown as { avePlatform: unknown }).avePlatform = { isDarwin };
}

afterEach(() => {
  __resetShortcutsForTest();
  delete (window as unknown as { avePlatform?: unknown }).avePlatform;
});

describe("workspace launcher shortcuts", () => {
  it("binds the side chat to ⌥⌘S through the registry", () => {
    setPlatform(true);
    const sideChat = WORKSPACE_TAB_LAUNCHER.find((item) => item.kind === "side-chat");
    expect(sideChat?.shortcutId).toBe("workspace.openSideChat");
    expect(shortcutHint("workspace.openSideChat")).toBe("⌥⌘S");
    // Option turns S into ß on a Mac; the physical key still matches.
    expect(matchesShortcut("workspace.openSideChat", keyEvent({ key: "ß", code: "KeyS", metaKey: true, altKey: true }))).toBe(true);
    expect(matchesShortcut("workspace.openSideChat", keyEvent({ key: "s", code: "KeyS", metaKey: true }))).toBe(false);
  });

  it("uses Ctrl off macOS and shows it in words", () => {
    setPlatform(false);
    expect(shortcutHint("workspace.openSideChat")).toBe("Ctrl+Alt+S");
    expect(matchesShortcut("workspace.openSideChat", keyEvent({ key: "s", code: "KeyS", ctrlKey: true, altKey: true }))).toBe(true);
  });

  it("follows a rebind and drops the old key", () => {
    setPlatform(true);
    setShortcutSettings({ ...NO_SHORTCUT_OVERRIDES, bindings: { "workspace.openBrowser": "CommandOrControl+Shift+Y" } });
    expect(matchesShortcut("workspace.openBrowser", keyEvent({ key: "y", code: "KeyY", metaKey: true, shiftKey: true }))).toBe(true);
    expect(matchesShortcut("workspace.openBrowser", keyEvent({ key: "t", code: "KeyT", metaKey: true }))).toBe(false);
    expect(shortcutHint("workspace.openBrowser")).toBe("⇧⌘Y");
  });

  it("matches nothing while a new key is being recorded", () => {
    setPlatform(true);
    setShortcutCaptureActive(true);
    expect(matchesShortcut("workspace.openBrowser", keyEvent({ key: "t", code: "KeyT", metaKey: true }))).toBe(false);
  });

  it("gives every launcher row with a key a registry id", () => {
    for (const item of WORKSPACE_TAB_LAUNCHER) {
      if (item.shortcutId !== null) expect(shortcutHint(item.shortcutId)).not.toBeNull();
    }
  });
});


it.each([true, false])("dispatches the real search and palette handlers once with darwin=%s", (darwin) => {
  setPlatform(darwin);
  setShortcutSettings({ ...NO_SHORTCUT_OVERRIDES, bindings: { "app.search": "Alt+Shift+Plus", "app.commandPalette": "Alt+Shift+=" } });
  const toggleSlashPicker = vi.fn();
  const { api } = makeMockAveApi();
  const hook = renderHook(() => {
    const search = useSearch([]);
    useAppBootstrap({ api: api as unknown as AveApi, refreshViews: vi.fn(), refreshCards: vi.fn(), checkApiKey: vi.fn(), setActiveView: vi.fn(), onOpenSettings: vi.fn(), toggleSlashPicker });
    return search;
  });
  const press = (code: string) => act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "+", code, altKey: true, shiftKey: true })); });
  press("Equal");
  expect(toggleSlashPicker).not.toHaveBeenCalled();
  expect(hook.result.current.open).toBe(true);
  press("BracketRight");
  expect(toggleSlashPicker).not.toHaveBeenCalled();
  expect(hook.result.current.open).toBe(true);
  act(() => hook.result.current.closeOverlay());
  setShortcutSettings({ ...NO_SHORTCUT_OVERRIDES, bindings: { "app.search": "Alt+Shift+Plus", "app.commandPalette": "Alt+Shift+numadd" } });
  press("NumpadAdd");
  expect(toggleSlashPicker).toHaveBeenCalledTimes(1);
  expect(hook.result.current.open).toBe(false);
  hook.unmount();
});
