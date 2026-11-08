// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { NO_SHORTCUT_OVERRIDES } from "../../../../shared/shortcuts.js";
import { __resetShortcutsForTest, matchesShortcut, setShortcutCaptureActive, setShortcutSettings, shortcutHint } from "../../hooks/use-shortcuts.js";
import { WORKSPACE_TAB_LAUNCHER } from "../command-actions.js";

function keyEvent(over: Partial<KeyboardEvent>): Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey"> {
  return { key: "a", code: "", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...over };
}

function setPlatform(isDarwin: boolean): void {
  (window as unknown as { avePlatform: unknown }).avePlatform = { isDarwin, windowControls: isDarwin ? "native" : "trailing" };
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
