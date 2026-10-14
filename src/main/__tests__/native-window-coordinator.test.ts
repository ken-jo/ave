import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configureNativeWindowCoordinator,
  requestNativeChromeRefresh,
  requestOpenNewMainWindow,
  requestShowOrCreateMainWindow,
  resetNativeWindowCoordinatorForTests,
} from "../native-window-coordinator.js";

afterEach(() => {
  resetNativeWindowCoordinatorForTests();
});

describe("native window coordinator", () => {
  it("fails clearly before the composition root configures it", () => {
    expect(() => requestShowOrCreateMainWindow("settings-open")).toThrowError(
      "native-window-coordinator-not-configured",
    );
    expect(() => requestNativeChromeRefresh()).toThrowError(
      "native-window-coordinator-not-configured",
    );
    expect(() => requestOpenNewMainWindow("menu-new-window")).toThrowError(
      "native-window-coordinator-not-configured",
    );
  });

  it("forwards window activation, new-window and native chrome refresh requests", () => {
    const showOrCreateMainWindow = vi.fn();
    const openNewMainWindow = vi.fn();
    const refreshNativeChrome = vi.fn();
    configureNativeWindowCoordinator({ showOrCreateMainWindow, openNewMainWindow, refreshNativeChrome });

    requestShowOrCreateMainWindow("settings-open");
    requestOpenNewMainWindow("menu-new-window");
    requestNativeChromeRefresh();

    expect(openNewMainWindow).toHaveBeenCalledWith("menu-new-window");
    expect(showOrCreateMainWindow).not.toHaveBeenCalledWith("menu-new-window");
    expect(showOrCreateMainWindow).toHaveBeenCalledOnce();
    expect(showOrCreateMainWindow).toHaveBeenCalledWith("settings-open");
    expect(refreshNativeChrome).toHaveBeenCalledOnce();
  });

  it("rejects a second owner instead of silently replacing the boundary", () => {
    const first = {
      showOrCreateMainWindow: vi.fn(),
      openNewMainWindow: vi.fn(),
      refreshNativeChrome: vi.fn(),
    };
    configureNativeWindowCoordinator(first);

    expect(() => configureNativeWindowCoordinator(first)).toThrowError(
      "native-window-coordinator-already-configured",
    );
  });
});
