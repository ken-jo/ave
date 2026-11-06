import { describe, expect, it, vi } from "vitest";

const nativeTheme = vi.hoisted(() => ({ themeSource: "system" as string }));
vi.mock("electron", () => ({ nativeTheme }));

import { applyMainWindowGlass, getMainWindowGlassOptions, mainWindowGlassEnabled, syncNativeThemeSource } from "../window-chrome.js";

describe("main-window glass", () => {
  it("is macOS-only and yields to the OS reduce-transparency switch", () => {
    expect(mainWindowGlassEnabled("darwin", false)).toBe(true);
    expect(mainWindowGlassEnabled("darwin", true)).toBe(false);
    expect(mainWindowGlassEnabled("win32", false)).toBe(false);
    expect(mainWindowGlassEnabled("linux", false)).toBe(false);
  });

  it("asks for vibrancy and a clear window fill, never a transparent window", () => {
    expect(getMainWindowGlassOptions(true)).toEqual({ vibrancy: "under-window", visualEffectState: "followWindow", backgroundColor: "#00000000" });
    expect(getMainWindowGlassOptions(false)).toEqual({});
    expect(getMainWindowGlassOptions(true)).not.toHaveProperty("transparent");
  });

  it("drops the material for an opaque fill when transparency is reduced, and restores it", () => {
    const win = { setVibrancy: vi.fn(), setBackgroundColor: vi.fn() };
    applyMainWindowGlass(win, false, true);
    expect(win.setVibrancy).toHaveBeenLastCalledWith(null);
    expect(win.setBackgroundColor).toHaveBeenLastCalledWith("#1E1E1E");
    applyMainWindowGlass(win, false, false);
    expect(win.setBackgroundColor).toHaveBeenLastCalledWith("#FFFFFF");
    applyMainWindowGlass(win, true, false);
    expect(win.setVibrancy).toHaveBeenLastCalledWith("under-window");
    expect(win.setBackgroundColor).toHaveBeenLastCalledWith("#00000000");
  });

  it("makes the native theme follow the app's mode on every platform", () => {
    syncNativeThemeSource("dark");
    expect(nativeTheme.themeSource).toBe("dark");
    syncNativeThemeSource("light");
    expect(nativeTheme.themeSource).toBe("light");
    syncNativeThemeSource(undefined);
    expect(nativeTheme.themeSource).toBe("light");
    syncNativeThemeSource("system");
    expect(nativeTheme.themeSource).toBe("system");
  });
});
