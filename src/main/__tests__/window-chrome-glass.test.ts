import { describe, expect, it, vi } from "vitest";

const nativeTheme = vi.hoisted(() => ({ themeSource: "system" as string }));
vi.mock("electron", () => ({ nativeTheme }));

import { getMainWindowGlassOptions, mainWindowGlassEnabled, mainWindowGlassMaterial, syncNativeThemeSource } from "../window-chrome.js";

describe("main-window glass", () => {
  it("draws vibrancy on macOS and Mica only from Windows 11 22H2 (build 22621)", () => {
    expect(mainWindowGlassMaterial("darwin", "25.5.0")).toBe("vibrancy");
    expect(mainWindowGlassMaterial("win32", "10.0.22621")).toBe("mica");
    expect(mainWindowGlassMaterial("win32", "10.0.26100")).toBe("mica");
    // Windows 11 21H2 and Windows 10: Electron would make the window translucent but draw no backdrop.
    expect(mainWindowGlassMaterial("win32", "10.0.22000")).toBeNull();
    expect(mainWindowGlassMaterial("win32", "10.0.19045")).toBeNull();
    expect(mainWindowGlassMaterial("linux", "6.8.0")).toBeNull();
  });

  it("draws no material on a Windows release it cannot read", () => {
    for (const release of ["", "10.0", "10.0.22621.1", "10.0.x", "garbage"]) expect(mainWindowGlassMaterial("win32", release)).toBeNull();
  });

  it("yields to the OS reduce-transparency switch on every platform with a material", () => {
    expect(mainWindowGlassEnabled("vibrancy", false)).toBe(true);
    expect(mainWindowGlassEnabled("vibrancy", true)).toBe(false);
    expect(mainWindowGlassEnabled("mica", false)).toBe(true);
    expect(mainWindowGlassEnabled("mica", true)).toBe(false);
    expect(mainWindowGlassEnabled(null, false)).toBe(false);
  });

  it("asks for the material and a clear window fill, never a transparent window", () => {
    expect(getMainWindowGlassOptions("vibrancy")).toEqual({ vibrancy: "under-window", visualEffectState: "followWindow", backgroundColor: "#00000000" });
    expect(getMainWindowGlassOptions("mica")).toEqual({ backgroundMaterial: "mica", backgroundColor: "#00000000" });
    expect(getMainWindowGlassOptions(null)).toEqual({});
    expect(getMainWindowGlassOptions("vibrancy")).not.toHaveProperty("transparent");
    expect(getMainWindowGlassOptions("mica")).not.toHaveProperty("transparent");
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
