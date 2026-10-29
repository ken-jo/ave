import { describe, expect, it } from "vitest";
import { PANEL_COMMANDS, panelCommandFor } from "../panel-commands.js";
import { decodeSurfaceDrag, encodeSurfaceDrag } from "../../preview/surface-moves.js";

const key = (k: string, mods: Partial<Record<"metaKey" | "ctrlKey" | "shiftKey" | "altKey", boolean>> = {}) => ({
  key: k, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods,
});

describe("panel commands", () => {
  it("binds each chord on the platform's primary modifier, exactly", () => {
    expect(panelCommandFor(key("ArrowLeft", { metaKey: true, shiftKey: true, altKey: true }), true)).toBe("pane.moveLeft");
    expect(panelCommandFor(key("ArrowLeft", { ctrlKey: true, shiftKey: true, altKey: true }), false)).toBe("pane.moveLeft");
    // Ctrl is not ⌘ on macOS, and a fourth modifier is a different chord.
    expect(panelCommandFor(key("ArrowLeft", { ctrlKey: true, shiftKey: true, altKey: true }), true)).toBeNull();
    expect(panelCommandFor(key("ArrowLeft", { metaKey: true, ctrlKey: true, shiftKey: true, altKey: true }), true)).toBeNull();
    expect(panelCommandFor(key("T", { metaKey: true, shiftKey: true }), true)).toBe("surface.reopenClosed");
    expect(panelCommandFor(key("B", { metaKey: true, shiftKey: true }), true)).toBe("sidebar.toggleVisibility");
    expect(panelCommandFor(key("B", { ctrlKey: true, shiftKey: true }), false)).toBe("sidebar.toggleVisibility");
    expect(panelCommandFor(key("Enter", { metaKey: true, shiftKey: true }), true)).toBe("pane.toggleMaximize");
    expect(panelCommandFor(key("t", { metaKey: true }), true)).toBeNull();
  });

  it("has one row per command", () => {
    const ids = PANEL_COMMANDS.map((command) => command.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("surface drag payload", () => {
  it("round-trips a payload and rejects anything else", () => {
    const payload = { tabId: "terminal:3", kind: "terminal" as const, from: { side: "main" } };
    expect(decodeSurfaceDrag(encodeSurfaceDrag(payload))).toEqual(payload);
    expect(decodeSurfaceDrag(encodeSurfaceDrag({ tabId: "browser:4", kind: "browser", from: { pane: "group-2" } }))).toEqual({ tabId: "browser:4", kind: "browser", from: { pane: "group-2" } });
    expect(decodeSurfaceDrag("not json")).toBeNull();
    expect(decodeSurfaceDrag(JSON.stringify({ tabId: "x", kind: "preview", from: { side: "a" } }))).toBeNull();
    expect(decodeSurfaceDrag(JSON.stringify({ tabId: "x", kind: "terminal", from: {} }))).toBeNull();
  });
});
