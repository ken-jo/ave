// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AppSettings, AveApi, SettingsUpdateResult } from "../../types.js";
import { useFileTreeWidth } from "../use-file-tree-width.js";

function makeApi(seed?: number) {
  const update = vi.fn<AveApi["updateSettings"]>(async () => ({ system: { sidePanelFileTreeWidth: seed } }) as AppSettings);
  const api = {
    getSettings: vi.fn(async () => ({ system: { sidePanelFileTreeWidth: seed } })),
    updateSettings: update,
  } as unknown as AveApi;
  return { api, update };
}

describe("useFileTreeWidth", () => {
  it("starts at the 300 pixel tree width and reads the persisted preference", async () => {
    const { api } = makeApi(360);
    const { result } = renderHook(() => useFileTreeWidth(api));
    expect(result.current.treeWidth).toBe(300);
    await waitFor(() => expect(result.current.treeWidth).toBe(360));
  });

  it("keeps drag changes local and persists the clamped keyboard or release value once", async () => {
    const { api, update } = makeApi(300);
    const { result } = renderHook(() => useFileTreeWidth(api));
    await waitFor(() => expect(api.getSettings).toHaveBeenCalledOnce());
    act(() => result.current.setTreeWidth(411.6));
    expect(result.current.treeWidth).toBe(412);
    expect(update).not.toHaveBeenCalled();
    act(() => result.current.commitTreeWidth(600));
    expect(result.current.treeWidth).toBe(520);
    expect(update).toHaveBeenCalledExactlyOnceWith({ system: { sidePanelFileTreeWidth: 520 } });
    act(() => result.current.commitTreeWidth(600));
    expect(update).toHaveBeenCalledOnce();
    act(() => result.current.commitTreeWidth(1));
    expect(result.current.treeWidth).toBe(180);
  });

  it("clamps a saved width without writing settings during mount", async () => {
    const { api, update } = makeApi(900);
    const { result } = renderHook(() => useFileTreeWidth(api));
    await waitFor(() => expect(result.current.treeWidth).toBe(520));
    expect(update).not.toHaveBeenCalled();
  });

  it("does not apply a delayed seed from the previous API", async () => {
    let release!: (value: unknown) => void;
    const previous = makeApi();
    vi.mocked(previous.api.getSettings).mockReturnValueOnce(new Promise((resolve) => { release = resolve; }) as never);
    const next = makeApi(240);
    const { result, rerender } = renderHook(({ api }) => useFileTreeWidth(api), { initialProps: { api: previous.api } });
    rerender({ api: next.api });
    await waitFor(() => expect(result.current.treeWidth).toBe(240));
    await act(async () => release({ system: { sidePanelFileTreeWidth: 500 } }));
    expect(result.current.treeWidth).toBe(240);
  });

  it("retains the default after a failed seed read", async () => {
    const { api } = makeApi();
    vi.mocked(api.getSettings).mockRejectedValueOnce(new Error("unavailable"));
    const { result } = renderHook(() => useFileTreeWidth(api));
    await act(async () => {});
    expect(result.current.treeWidth).toBe(300);
  });

  it("allows the same width to be retried after settings refuses the save", async () => {
    const { api, update } = makeApi(300);
    update.mockResolvedValueOnce({ ok: false, error: "save-failed" });
    const { result } = renderHook(() => useFileTreeWidth(api));
    await waitFor(() => expect(api.getSettings).toHaveBeenCalledOnce());
    await act(async () => result.current.commitTreeWidth(400));
    expect(result.current.treeWidth).toBe(400);
    act(() => result.current.commitTreeWidth(400));
    expect(update).toHaveBeenCalledTimes(2);
  });

  it("keeps a newer successful width acknowledged when an older save later fails", async () => {
    let release!: (result: SettingsUpdateResult) => void;
    const { api, update } = makeApi(300);
    update.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    const { result } = renderHook(() => useFileTreeWidth(api));
    await waitFor(() => expect(api.getSettings).toHaveBeenCalledOnce());
    act(() => result.current.commitTreeWidth(360));
    await act(async () => result.current.commitTreeWidth(400));
    await act(async () => release({ ok: false, error: "save-failed" }));
    act(() => result.current.commitTreeWidth(400));
    expect(update).toHaveBeenCalledTimes(2);
  });

  it("allows a failed transport save to retry without an unhandled rejection", async () => {
    const { api, update } = makeApi(300);
    update.mockRejectedValueOnce(new Error("transport unavailable"));
    const { result } = renderHook(() => useFileTreeWidth(api));
    await waitFor(() => expect(api.getSettings).toHaveBeenCalledOnce());
    await act(async () => result.current.commitTreeWidth(400));
    act(() => result.current.commitTreeWidth(400));
    expect(update).toHaveBeenCalledTimes(2);
  });
});
