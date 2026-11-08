import { describe, expect, it } from "vitest";
import { en } from "../../i18n/messages/en.js";
import { ko } from "../../i18n/messages/ko.js";
import {
  acceleratorFromEvent,
  acceleratorKeycaps,
  applyShortcutBindingsPatch,
  canonicalAccelerator,
  conflictingShortcutIds,
  formatAccelerator,
  isShortcutId,
  loadShortcutBindings,
  matchesAccelerator,
  NO_SHORTCUT_OVERRIDES,
  normalizeAccelerator,
  normalizeShortcuts,
  resolveShortcut,
  resolveShortcuts,
  SHORTCUT_SCOPE_LABEL_KEYS,
  SHORTCUTS,
  ShortcutBindingsPatchError,
  shortcutBindingRefusal,
  type ShortcutDefinition,
  type ShortcutKeyEvent,
} from "../shortcuts.js";

/** A key event from its key and the modifiers held. */
function ev(key: string, mods: Partial<ShortcutKeyEvent> = {}): ShortcutKeyEvent {
  return { key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods };
}

describe("normalizeAccelerator", () => {
  it("accepts a valid accelerator, trimmed", () => {
    expect(normalizeAccelerator("  CommandOrControl+Shift+Space  ")).toBe(
      "CommandOrControl+Shift+Space",
    );
    expect(normalizeAccelerator("Alt+F1")).toBe("Alt+F1");
  });

  it("rejects non-strings, empty, oversized, and control-char input", () => {
    expect(normalizeAccelerator(42)).toBeNull();
    expect(normalizeAccelerator(null)).toBeNull();
    expect(normalizeAccelerator("")).toBeNull();
    expect(normalizeAccelerator("   ")).toBeNull();
    expect(normalizeAccelerator("A".repeat(200))).toBeNull();
    expect(normalizeAccelerator("Ctrl+\n+K")).toBeNull();
  });

  it("rejects lone modifiers and empty '+' segments", () => {
    expect(normalizeAccelerator("Shift")).toBeNull();
    expect(normalizeAccelerator("CommandOrControl")).toBeNull();
    expect(normalizeAccelerator("Ctrl+")).toBeNull();
    expect(normalizeAccelerator("Ctrl++K")).toBeNull();
  });
});

describe("normalizeShortcuts", () => {
  const fallback = { toggleWindow: "Alt+F1", enabled: true, bindings: {} } as const;
  const noDrops = () => { throw new Error("no binding should be dropped"); };

  it("returns fallback for non-object input", () => {
    expect(normalizeShortcuts(null, { ...fallback }, "darwin", noDrops)).toEqual(fallback);
    expect(normalizeShortcuts([], { ...fallback }, "darwin", noDrops)).toEqual(fallback);
  });

  it("accepts null toggleWindow (explicit clear)", () => {
    expect(normalizeShortcuts({ toggleWindow: null }, { ...fallback }, "darwin", noDrops).toggleWindow).toBeNull();
  });

  it("keeps fallback when an invalid accelerator is supplied", () => {
    const out = normalizeShortcuts({ toggleWindow: "Shift" }, { ...fallback }, "darwin", noDrops);
    expect(out.toggleWindow).toBe("Alt+F1");
  });

  it("applies a valid accelerator + enabled", () => {
    const out = normalizeShortcuts(
      { toggleWindow: "CommandOrControl+K", enabled: false },
      { ...fallback },
      "darwin",
      noDrops,
    );
    expect(out).toEqual({ toggleWindow: "CommandOrControl+K", enabled: false, bindings: {} });
  });
});

describe("shortcut registry", () => {
  const platforms = ["darwin", "other"] as const;

  it("has one row per id", () => {
    const ids = SHORTCUTS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("names every label, scope and reason with a key both catalogs have", () => {
    const keys: string[] = Object.values(SHORTCUT_SCOPE_LABEL_KEYS);
    for (const entry of SHORTCUTS as readonly ShortcutDefinition[]) {
      keys.push(entry.labelKey);
      if (entry.readOnly) keys.push(entry.readOnly.reasonKey);
    }
    for (const key of keys) {
      expect(en, key).toHaveProperty([key]);
      expect(ko, key).toHaveProperty([key]);
    }
  });

  it("spells every default canonically", () => {
    for (const entry of SHORTCUTS as readonly ShortcutDefinition[]) {
      if (entry.layeredOn !== undefined) {
        expect(isShortcutId(entry.layeredOn), entry.id).toBe(true);
        continue;
      }
      for (const platform of platforms) {
        const accelerator = entry.defaults[platform];
        if (accelerator !== null) expect(canonicalAccelerator(accelerator), `${entry.id} on ${platform}`).toBe(accelerator);
      }
    }
  });

  it.each(platforms)("ships conflict-free defaults on %s", (platform) => {
    const rows = resolveShortcuts(NO_SHORTCUT_OVERRIDES, platform);
    expect([...conflictingShortcutIds(rows, platform)]).toEqual([]);
  });

  it.each(platforms)("lets every rebindable default pass its own binding rules on %s", (platform) => {
    for (const row of resolveShortcuts(NO_SHORTCUT_OVERRIDES, platform)) {
      if (!row.rebindable || row.accelerator === null) continue;
      expect(shortcutBindingRefusal(row.id, row.accelerator, platform, NO_SHORTCUT_OVERRIDES), row.id).toBeNull();
    }
  });

  it("gives a layered row the key of the row it follows, rebinds included", () => {
    const input = { ...NO_SHORTCUT_OVERRIDES, bindings: { "app.commandPalette": "CommandOrControl+J" } };
    expect(resolveShortcut("composer.guide", NO_SHORTCUT_OVERRIDES, "darwin")).toBe("CommandOrControl+K");
    expect(resolveShortcut("composer.guide", input, "darwin")).toBe("CommandOrControl+J");
  });

  it("ignores a stored binding for a fixed row", () => {
    const input = { ...NO_SHORTCUT_OVERRIDES, bindings: { "edit.copy": "CommandOrControl+J" } as Record<string, string> };
    expect(resolveShortcut("edit.copy", input, "darwin")).toBe("CommandOrControl+C");
  });

  it("lists the system-wide toggle with the key set under Startup, only while it is on", () => {
    const off = resolveShortcuts({ ...NO_SHORTCUT_OVERRIDES, toggleWindow: "Alt+F1", enabled: false }, "darwin");
    const on = resolveShortcuts({ ...NO_SHORTCUT_OVERRIDES, toggleWindow: "Alt+F1", enabled: true }, "darwin");
    expect(off.find((row) => row.id === "system.toggleWindow")?.accelerator).toBeNull();
    expect(on.find((row) => row.id === "system.toggleWindow")?.accelerator).toBe("Alt+F1");
  });

  it("leaves out a row that has no key on a platform", () => {
    expect(resolveShortcuts(NO_SHORTCUT_OVERRIDES, "darwin").some((row) => row.id === "app.quit")).toBe(true);
    expect(resolveShortcuts(NO_SHORTCUT_OVERRIDES, "other").some((row) => row.id === "app.quit")).toBe(false);
  });
});

describe("conflict detection", () => {
  it("flags two rebindable rows on one key in overlapping scopes", () => {
    const input = { ...NO_SHORTCUT_OVERRIDES, bindings: { "app.search": "CommandOrControl+K" } };
    const conflicts = conflictingShortcutIds(resolveShortcuts(input, "darwin"), "darwin");
    expect([...conflicts].sort()).toEqual(["app.commandPalette", "app.search"]);
  });

  it("compares the keys pressed, not the spelling", () => {
    // CommandOrControl is Ctrl off macOS, so a Control binding is the same chord there and a different one on a Mac.
    const input = { ...NO_SHORTCUT_OVERRIDES, bindings: { "app.search": "Control+K" } };
    expect(conflictingShortcutIds(resolveShortcuts(input, "other"), "other").has("app.search")).toBe(true);
    expect(conflictingShortcutIds(resolveShortcuts(input, "darwin"), "darwin").has("app.search")).toBe(false);
  });

  it("does not flag rows whose surfaces never have focus together", () => {
    // The workspace launcher ignores key presses in text fields; the composer keys only fire there.
    const input = { ...NO_SHORTCUT_OVERRIDES, bindings: { "composer.backgroundCommand": "CommandOrControl+T" } };
    expect(conflictingShortcutIds(resolveShortcuts(input, "darwin"), "darwin").size).toBe(0);
  });

  it("flags a menu accelerator against a renderer key", () => {
    const input = { ...NO_SHORTCUT_OVERRIDES, bindings: { "menu.settings": "CommandOrControl+F" } };
    expect([...conflictingShortcutIds(resolveShortcuts(input, "darwin"), "darwin")].sort()).toEqual(["app.search", "menu.settings"]);
  });
});

describe("shortcutBindingRefusal", () => {
  const none = NO_SHORTCUT_OVERRIDES;

  it("refuses unknown and fixed rows", () => {
    expect(shortcutBindingRefusal("nope.nothing", "CommandOrControl+J", "darwin", none)).toEqual({ reason: "unknown-shortcut" });
    expect(shortcutBindingRefusal("edit.copy", "CommandOrControl+J", "darwin", none)).toEqual({ reason: "read-only" });
  });

  it("refuses a key with no modifier, except a function key", () => {
    expect(shortcutBindingRefusal("app.search", "J", "darwin", none)).toEqual({ reason: "needs-modifier" });
    expect(shortcutBindingRefusal("app.search", "Shift+J", "darwin", none)).toEqual({ reason: "needs-modifier" });
    expect(shortcutBindingRefusal("app.search", "F6", "darwin", none)).toBeNull();
  });

  it("refuses keys the operating system owns", () => {
    expect(shortcutBindingRefusal("app.search", "CommandOrControl+H", "darwin", none)).toEqual({ reason: "os-reserved" });
    expect(shortcutBindingRefusal("app.search", "Alt+F4", "other", none)).toEqual({ reason: "os-reserved" });
    expect(shortcutBindingRefusal("app.search", "Command+J", "other", none)).toEqual({ reason: "os-reserved" });
  });

  it("refuses a fixed row's key and names the row", () => {
    expect(shortcutBindingRefusal("app.search", "CommandOrControl+C", "darwin", none)).toMatchObject({ reason: "fixed-key" });
    expect(shortcutBindingRefusal("app.search", "Alt+Enter", "darwin", none)).toEqual({ reason: "fixed-key", ownerId: "tree.openBeside" });
    const withToggle = { ...none, toggleWindow: "Alt+F1", enabled: true };
    expect(shortcutBindingRefusal("app.search", "Alt+F1", "darwin", withToggle)).toEqual({ reason: "fixed-key", ownerId: "system.toggleWindow" });
  });

  it("refuses a non-canonical spelling", () => {
    expect(shortcutBindingRefusal("app.search", "Cmd+J", "darwin", none)).toEqual({ reason: "malformed" });
  });

  it("allows another rebindable row's key: that is a conflict, not a refusal", () => {
    expect(shortcutBindingRefusal("app.search", "CommandOrControl+K", "darwin", none)).toBeNull();
  });
});

describe("matchesAccelerator", () => {

  it("resolves CommandOrControl to ⌘ on macOS and Ctrl elsewhere, exactly", () => {
    expect(matchesAccelerator("CommandOrControl+K", ev("k", { metaKey: true }), "darwin")).toBe(true);
    expect(matchesAccelerator("CommandOrControl+K", ev("k", { ctrlKey: true }), "darwin")).toBe(false);
    expect(matchesAccelerator("CommandOrControl+K", ev("k", { ctrlKey: true }), "other")).toBe(true);
    expect(matchesAccelerator("CommandOrControl+K", ev("k", { metaKey: true, ctrlKey: true }), "darwin")).toBe(false);
    expect(matchesAccelerator("CommandOrControl+K", ev("K", { metaKey: true, shiftKey: true }), "darwin")).toBe(false);
  });

  it("keeps Control distinct from ⌘ on macOS", () => {
    expect(matchesAccelerator("Control+Shift+G", ev("G", { ctrlKey: true, shiftKey: true }), "darwin")).toBe(true);
    expect(matchesAccelerator("Control+Shift+G", ev("G", { metaKey: true, shiftKey: true }), "darwin")).toBe(false);
  });

  it("matches the layout's printed key, not the physical position", () => {
    // AZERTY: the key printed A sits where QWERTY has Q.
    expect(matchesAccelerator("CommandOrControl+Shift+A", ev("A", { code: "KeyQ", metaKey: true, shiftKey: true }), "darwin")).toBe(true);
    expect(matchesAccelerator("CommandOrControl+Shift+A", ev("Q", { code: "KeyA", metaKey: true, shiftKey: true }), "darwin")).toBe(false);
    // Dvorak: printed K sits on QWERTY V, printed T on QWERTY K.
    expect(matchesAccelerator("CommandOrControl+K", ev("k", { code: "KeyV", ctrlKey: true }), "other")).toBe(true);
    expect(matchesAccelerator("CommandOrControl+K", ev("t", { code: "KeyK", ctrlKey: true }), "other")).toBe(false);
    // QWERTZ: "?" is Shift+ß, still the tour key.
    expect(matchesAccelerator("CommandOrControl+Shift+/", ev("?", { code: "Minus", metaKey: true, shiftKey: true }), "darwin")).toBe(true);
    expect(acceleratorFromEvent(ev("a", { code: "KeyQ", metaKey: true }), "darwin")).toEqual({ kind: "accelerator", accelerator: "CommandOrControl+A" });
  });

  it("falls back to the physical key when the printed one is not a bindable token", () => {
    // ⌥⌘S types "ß" on a Mac; ⌘⇧/ reports "?"; a Hangul input source reports a jamo; Shift+1 reports "!".
    expect(matchesAccelerator("CommandOrControl+Alt+S", ev("ß", { code: "KeyS", metaKey: true, altKey: true }), "darwin")).toBe(true);
    expect(matchesAccelerator("CommandOrControl+Shift+/", ev("?", { code: "Slash", metaKey: true, shiftKey: true }), "darwin")).toBe(true);
    expect(matchesAccelerator("CommandOrControl+K", ev("ㅏ", { code: "KeyK", metaKey: true }), "darwin")).toBe(true);
    expect(matchesAccelerator("CommandOrControl+[", ev("[", { code: "BracketLeft", metaKey: true }), "darwin")).toBe(true);
    expect(matchesAccelerator("CommandOrControl+Shift+1", ev("!", { code: "Digit1", ctrlKey: true, shiftKey: true }), "other")).toBe(true);
  });

  it("maps named keys", () => {
    expect(matchesAccelerator("Alt+Left", ev("ArrowLeft", { altKey: true }), "other")).toBe(true);
    expect(matchesAccelerator("CommandOrControl+Shift+Enter", ev("Enter", { metaKey: true, shiftKey: true }), "darwin")).toBe(true);
    expect(matchesAccelerator(null, ev("k", { metaKey: true }), "darwin")).toBe(false);
  });
});

describe("acceleratorFromEvent", () => {
  const recorded = (accelerator: string) => ({ kind: "accelerator", accelerator });

  it("stores ⌘ and off-macOS Ctrl as the portable CommandOrControl", () => {
    expect(acceleratorFromEvent(ev("k", { metaKey: true, shiftKey: true }), "darwin")).toEqual(recorded("CommandOrControl+Shift+K"));
    expect(acceleratorFromEvent(ev("k", { ctrlKey: true, shiftKey: true }), "other")).toEqual(recorded("CommandOrControl+Shift+K"));
  });

  it("keeps ⌃ as Control on macOS and records the Windows key as Command", () => {
    expect(acceleratorFromEvent(ev("g", { ctrlKey: true }), "darwin")).toEqual(recorded("Control+G"));
    expect(acceleratorFromEvent(ev("g", { metaKey: true }), "other")).toEqual(recorded("Command+G"));
  });

  it("maps space, arrows, escape and function keys to Electron tokens", () => {
    expect(acceleratorFromEvent(ev(" ", { altKey: true }), "darwin")).toEqual(recorded("Alt+Space"));
    expect(acceleratorFromEvent(ev("ArrowUp", { ctrlKey: true }), "other")).toEqual(recorded("CommandOrControl+Up"));
    expect(acceleratorFromEvent(ev("Escape", { ctrlKey: true }), "other")).toEqual(recorded("CommandOrControl+Esc"));
    expect(acceleratorFromEvent(ev("F5", { altKey: true }), "other")).toEqual(recorded("Alt+F5"));
    expect(acceleratorFromEvent(ev("ß", { code: "KeyS", metaKey: true, altKey: true }), "darwin")).toEqual(recorded("CommandOrControl+Alt+S"));
  });

  it("waits on a modifier-only press and refuses keys it cannot name", () => {
    expect(acceleratorFromEvent(ev("Shift", { shiftKey: true }), "darwin")).toEqual({ kind: "pending" });
    expect(acceleratorFromEvent(ev("Meta", { metaKey: true }), "darwin")).toEqual({ kind: "pending" });
    expect(acceleratorFromEvent(ev("Process", { metaKey: true }), "darwin")).toEqual({ kind: "unsupported" });
  });
});

describe("formatAccelerator", () => {
  it("writes glyphs on macOS and words elsewhere", () => {
    expect(formatAccelerator("CommandOrControl+Alt+S", "darwin")).toBe("⌥⌘S");
    expect(formatAccelerator("CommandOrControl+Alt+S", "other")).toBe("Ctrl+Alt+S");
    expect(formatAccelerator("Control+Shift+G", "darwin")).toBe("⌃⇧G");
    expect(formatAccelerator("CommandOrControl+Shift+Enter", "darwin")).toBe("⇧⌘↩");
    expect(acceleratorKeycaps("CommandOrControl+Shift+Left", "other")).toEqual(["Ctrl", "Shift", "←"]);
  });

  it("throws on a malformed accelerator instead of printing a guess", () => {
    expect(() => formatAccelerator("Cmd+", "darwin")).toThrow(/Malformed/);
  });
});

describe("persisted bindings", () => {
  const settings = { toggleWindow: null, enabled: false, bindings: {} };

  it("loads valid rebinds and reports each one it drops, with the reason", () => {
    const loaded = loadShortcutBindings({
      "app.search": "CommandOrControl+Shift+Y",
      "gone.row": "CommandOrControl+J",
      "edit.copy": "CommandOrControl+J",
      "app.commandPalette": "J",
      "menu.settings": "CommandOrControl+,",
      "app.viewBack": 3,
    }, "darwin");
    expect(loaded.bindings).toEqual({ "app.search": "CommandOrControl+Shift+Y" });
    expect(loaded.dropped).toEqual([
      { id: "gone.row", value: "CommandOrControl+J", reason: "unknown-id" },
      { id: "edit.copy", value: "CommandOrControl+J", reason: "read-only" },
      { id: "app.commandPalette", value: "J", reason: "needs-modifier" },
      { id: "menu.settings", value: "CommandOrControl+,", reason: "equals-default" },
      { id: "app.viewBack", value: 3, reason: "malformed" },
    ]);
    expect(loadShortcutBindings("nonsense", "darwin")).toEqual({ bindings: {}, dropped: [{ id: "*", value: "nonsense", reason: "not-an-object" }] });
    expect(loadShortcutBindings(undefined, "darwin")).toEqual({ bindings: {}, dropped: [] });
  });

  it("drops a rebind equal to the platform default, which differs by platform", () => {
    expect(loadShortcutBindings({ "app.viewBack": "Alt+Left" }, "other").bindings).toEqual({});
    expect(loadShortcutBindings({ "app.viewBack": "Alt+Left" }, "darwin").bindings).toEqual({ "app.viewBack": "Alt+Left" });
  });

  it("applies a rebind, stores a default as no override, and resets with null", () => {
    const rebound = applyShortcutBindingsPatch(settings, { "app.search": "CommandOrControl+Shift+Y" }, "darwin");
    expect(rebound).toEqual({ "app.search": "CommandOrControl+Shift+Y" });
    expect(applyShortcutBindingsPatch({ ...settings, bindings: rebound }, { "app.search": null }, "darwin")).toEqual({});
    expect(applyShortcutBindingsPatch({ ...settings, bindings: rebound }, { "app.search": "CommandOrControl+F" }, "darwin")).toEqual({});
  });

  it("throws on a refused entry instead of dropping it", () => {
    expect(() => applyShortcutBindingsPatch(settings, { "gone.row": "CommandOrControl+J" }, "darwin")).toThrow(ShortcutBindingsPatchError);
    expect(() => applyShortcutBindingsPatch(settings, { "edit.copy": "CommandOrControl+J" }, "darwin")).toThrow(/read-only/);
    expect(() => applyShortcutBindingsPatch(settings, { "app.search": 5 }, "darwin")).toThrow(ShortcutBindingsPatchError);
    expect(() => applyShortcutBindingsPatch(settings, [], "darwin")).toThrow(ShortcutBindingsPatchError);
  });

  it("lets two rebindable rows share a key in one patch", () => {
    // Both rows may share a key (a conflict, shown with a badge), but neither may take a fixed row's key.
    expect(applyShortcutBindingsPatch(settings, { "app.search": "CommandOrControl+J", "menu.settings": "CommandOrControl+J" }, "darwin"))
      .toEqual({ "app.search": "CommandOrControl+J", "menu.settings": "CommandOrControl+J" });
  });
});
