// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AveApi, AppSettings } from "../../types.js";
import { useSidebarState } from "../use-sidebar-state.js";

function makeApi(sidebarState?: unknown) {
  const updateSettings = vi.fn(async (_patch: unknown) => ({} as AppSettings));
  const getSettings = vi.fn(async () => ({ system: { sidebarState } } as AppSettings));
  return { api: { getSettings, updateSettings } as unknown as AveApi, getSettings, updateSettings };
}

describe("useSidebarState", () => {
  it("uses hidden at the minimum width and expanded above it without writing a default", async () => {
    const { api, getSettings, updateSettings } = makeApi();
    const { result, rerender } = renderHook(({ width }) => useSidebarState(api, width), { initialProps: { width: 360 } });
    expect(result.current.sidebarState).toBe("hidden");
    await act(async () => { await getSettings.mock.results[0]?.value; });
    rerender({ width: 900 });
    expect(result.current.sidebarState).toBe("expanded");
    rerender({ width: 360 });
    expect(result.current.sidebarState).toBe("hidden");
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it.each(["expanded", "rail", "hidden"] as const)("restores %s at every width without persisting the hydration", async (sidebarState) => {
    const { api, updateSettings } = makeApi(sidebarState);
    const { result, rerender } = renderHook(({ width }) => useSidebarState(api, width), { initialProps: { width: 360 } });
    await waitFor(() => expect(result.current.sidebarState).toBe(sidebarState));
    rerender({ width: 1243 });
    expect(result.current.sidebarState).toBe(sidebarState);
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("persists all three explicit choices once and restores the last choice on remount", async () => {
    let saved: unknown;
    const { api, getSettings, updateSettings } = makeApi();
    getSettings.mockImplementation(async () => ({ system: { sidebarState: saved } } as AppSettings));
    updateSettings.mockImplementation(async (patch: unknown) => {
      saved = (patch as { system: { sidebarState: unknown } }).system.sidebarState;
      return {} as AppSettings;
    });
    const view = renderHook(({ width }) => useSidebarState(api, width), { initialProps: { width: 360 } });
    await act(async () => { await getSettings.mock.results[0]?.value; });
    for (const choice of ["expanded", "rail", "hidden"] as const) {
      act(() => view.result.current.setSidebarState(choice));
      expect(view.result.current.sidebarState).toBe(choice);
      expect(updateSettings).toHaveBeenLastCalledWith({ system: { sidebarState: choice } });
      act(() => view.result.current.setSidebarState(choice));
    }
    expect(updateSettings).toHaveBeenCalledTimes(3);
    view.rerender({ width: 1243 });
    expect(view.result.current.sidebarState).toBe("hidden");
    view.unmount();
    const reloaded = renderHook(() => useSidebarState(api, 1243));
    await waitFor(() => expect(reloaded.result.current.sidebarState).toBe("hidden"));
    expect(updateSettings).toHaveBeenCalledTimes(3);
  });

  it("keeps an explicit choice made before hydration instead of replacing it with stale settings", async () => {
    let resolveSettings!: (settings: AppSettings) => void;
    const { api, getSettings, updateSettings } = makeApi();
    getSettings.mockImplementation(() => new Promise<AppSettings>((resolve) => { resolveSettings = resolve; }));
    const { result } = renderHook(() => useSidebarState(api, 360));
    act(() => result.current.setSidebarState("rail"));
    await act(async () => { resolveSettings({ system: { sidebarState: "expanded" } } as AppSettings); });
    expect(result.current.sidebarState).toBe("rail");
    expect(updateSettings).toHaveBeenCalledExactlyOnceWith({ system: { sidebarState: "rail" } });
  });

  it("ignores an invalid stored choice", async () => {
    const { api, getSettings, updateSettings } = makeApi("invalid");
    const { result } = renderHook(() => useSidebarState(api, 360));
    await act(async () => { await getSettings.mock.results[0]?.value; });
    expect(result.current.sidebarState).toBe("hidden");
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("handles unavailable reads and rejected writes while retaining the local choice", async () => {
    const { api, getSettings, updateSettings } = makeApi();
    getSettings.mockRejectedValue(new Error("Settings unavailable"));
    updateSettings.mockRejectedValue(new Error("Settings unavailable"));
    const { result } = renderHook(() => useSidebarState(api, 360));
    await act(async () => { await Promise.resolve(); });
    await act(async () => { result.current.setSidebarState("rail"); });
    expect(result.current.sidebarState).toBe("rail");
  });
});
