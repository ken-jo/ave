import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useSettingsPersistence } from "../use-settings-persistence.js";

describe("settings persistence", () => {
  it("rolls back a refused IPC write, exposes the failure, and never reports saved", async () => {
    const saved = vi.fn();
    const rollback = vi.fn();
    const { result } = renderHook(() => useSettingsPersistence(saved));
    await act(async () => {
      expect(await result.current.persist(async () => ({ ok: false, error: "invalid-args" }), { rollback })).toBeNull();
    });
    expect(rollback).toHaveBeenCalledOnce();
    expect(saved).not.toHaveBeenCalled();
    expect(result.current.error).toBeTruthy();
    expect(result.current.saving).toBe(false);
  });

  it("retains an explicit error from a rejected write and clears it after a successful write", async () => {
    const saved = vi.fn();
    const { result } = renderHook(() => useSettingsPersistence(saved));
    await act(async () => {
      await result.current.persist(async () => { throw new Error("Storage unavailable"); });
    });
    expect(result.current.error).toBe("Storage unavailable");
    await act(async () => {
      expect(await result.current.persist(async () => ({ ok: true }))).toEqual({ ok: true });
    });
    expect(result.current.error).toBeNull();
    expect(saved).toHaveBeenCalledOnce();
  });

  it("keeps the saving state while another write remains pending", async () => {
    let finish!: () => void;
    const { result } = renderHook(() => useSettingsPersistence());
    let pending!: Promise<unknown>;
    act(() => {
      pending = result.current.persist(() => new Promise<void>((resolve) => { finish = resolve; }));
    });
    expect(result.current.saving).toBe(true);
    await act(async () => { await result.current.persist(async () => ({ ok: true })); });
    expect(result.current.saving).toBe(true);
    await act(async () => { finish(); await pending; });
    expect(result.current.saving).toBe(false);
  });
});
