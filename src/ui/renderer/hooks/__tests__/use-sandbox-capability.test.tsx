// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxCapabilityInfo } from "../../../../shared/sandbox-capability-info.js";
import { useSandboxCapability } from "../use-sandbox-capability.js";

const CAPABILITY: SandboxCapabilityInfo = {
  workerRestartPending: false,
  platform: "darwin", enabled: false, available: true, kind: "full", reason: "",
  confines: { filesystem: false, process: false, network: false },
  shell: { state: "off", setting: false, envForced: false, causes: [] },
};

describe("useSandboxCapability", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reports initial query uncertainty and clears it when a bounded retry succeeds", async () => {
    const permission = { sandboxCapability: vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(CAPABILITY) };
    const { result } = renderHook(() => useSandboxCapability(permission));
    await act(async () => {});
    expect(result.current.capability).toBeNull();
    expect(result.current.statusQueryFailed).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(permission.sandboxCapability).toHaveBeenCalledTimes(2);
    expect(result.current.statusQueryFailed).toBe(false);
    expect(result.current.capability).toEqual(CAPABILITY);
  });

  it("stops after three attempts and can recover through an explicit retry", async () => {
    const permission = { sandboxCapability: vi.fn().mockRejectedValue(new Error("offline")) };
    const { result } = renderHook(() => useSandboxCapability(permission));
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(permission.sandboxCapability).toHaveBeenCalledTimes(3);
    expect(result.current.statusQueryFailed).toBe(true);
    permission.sandboxCapability.mockResolvedValue(CAPABILITY);
    await act(async () => { await result.current.refresh(); });
    expect(result.current.statusQueryFailed).toBe(false);
    expect(result.current.capability).toEqual(CAPABILITY);
  });

  it("cancels pending retries when the surface unmounts", async () => {
    const permission = { sandboxCapability: vi.fn().mockRejectedValue(new Error("offline")) };
    const { unmount } = renderHook(() => useSandboxCapability(permission));
    await act(async () => {});
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(permission.sandboxCapability).toHaveBeenCalledTimes(1);
  });
});
