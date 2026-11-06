import "../../../../../test/renderer/setup.ts";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { usePluginAuthStatuses, usePluginAuthRevision, type PluginAuthState } from "../use-plugin-auth-status.js";
import type { AveApi, PluginCardSummary } from "../../types.js";

function makePlugin(id: string, withAuth: boolean, overrides: Partial<PluginCardSummary> = {}): PluginCardSummary {
  return {
    id,
    name: id,
    description: "",
    sampleTools: [],
    capabilities: [],
    tools: ["foo_status", "foo_login", "foo_signout"],
    loadStatus: "loaded",
    auth: withAuth
      ? {
          label: id,
          statusTool: "foo_status",
          loginTool: "foo_login",
          logoutTool: "foo_signout",
        }
      : undefined,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("usePluginAuthStatuses", () => {
  it("returns empty map when no plugin declares auth", async () => {
    const api = {
      callPluginMethod: vi.fn(),
    } as unknown as AveApi;
    const { result } = renderHook(() =>
      usePluginAuthStatuses(api, [makePlugin("a", false), makePlugin("b", false)]),
    );
    expect(result.current.statuses.size).toBe(0);
    expect(api.callPluginMethod).not.toHaveBeenCalled();
  });

  it("invokes statusTool on mount and surfaces authed state", async () => {
    const api = {
      callPluginMethod: vi.fn(async () => ({ authenticated: true, account: "u@x" })),
    } as unknown as AveApi;
    const { result } = renderHook(() =>
      usePluginAuthStatuses(api, [makePlugin("samplemail", true)]),
    );
    await waitFor(() => {
      expect(result.current.statuses.get("samplemail")?.kind).toBe("authed");
    });
    const state = result.current.statuses.get("samplemail");
    if (state?.kind === "authed") expect(state.account).toBe("u@x");
    expect(api.callPluginMethod).toHaveBeenCalledWith("foo_status");
  });

  it("treats { authenticated: false } as unauthed", async () => {
    const api = {
      callPluginMethod: vi.fn(async () => ({ authenticated: false })),
    } as unknown as AveApi;
    const { result } = renderHook(() =>
      usePluginAuthStatuses(api, [makePlugin("samplemail", true)]),
    );
    await waitFor(() => {
      expect(result.current.statuses.get("samplemail")?.kind).toBe("unauthed");
    });
  });

  it("keeps auth checks for inactive plugins that still have a loaded runtime", async () => {
    const api = {
      callPluginMethod: vi.fn(async () => ({ authenticated: false })),
    } as unknown as AveApi;

    const { result } = renderHook(() =>
      usePluginAuthStatuses(api, [
        makePlugin("inactive-auth", true, {
          loadStatus: "disabled",
          active: false,
          runtimeLoaded: true,
        }),
      ]),
    );

    await waitFor(() => {
      expect(result.current.statuses.get("inactive-auth")?.kind).toBe("unauthed");
    });
    expect(api.callPluginMethod).toHaveBeenCalledWith("foo_status");
  });

  it("skips auth checks for non-callable failed/preparing runtimes", async () => {
    const api = {
      callPluginMethod: vi.fn(),
    } as unknown as AveApi;

    const { result } = renderHook(() =>
      usePluginAuthStatuses(api, [
        makePlugin("failed-auth", true, { loadStatus: "failed", active: false, runtimeLoaded: false }),
        makePlugin("preparing-auth", true, { loadStatus: "preparing", active: false, runtimeLoaded: false }),
      ]),
    );

    expect(result.current.statuses.size).toBe(0);
    expect(api.callPluginMethod).not.toHaveBeenCalled();
  });

  it("polls auth through the status tool at a bounded cadence", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const callPluginMethod = vi.fn()
      .mockResolvedValueOnce({ authenticated: false })
      .mockResolvedValueOnce({ authenticated: true, account: "signed-in" });
    const api = { callPluginMethod } as unknown as AveApi;
    const { result, unmount } = renderHook(() => usePluginAuthStatuses(api, [makePlugin("samplemail", true)], ["samplemail"]));
    try {
      await act(async () => {});
      expect(result.current.statuses.get("samplemail")?.kind).toBe("unauthed");
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
      expect(result.current.statuses.get("samplemail")).toEqual({ kind: "authed", account: "signed-in" });
      expect(callPluginMethod).toHaveBeenCalledTimes(2);
    } finally {
      unmount();
      vi.useRealTimers();
    }
  });

  it("manual refresh does not invoke statusTool for a non-callable runtime", async () => {
    const api = {
      callPluginMethod: vi.fn(),
    } as unknown as AveApi;

    const { result } = renderHook(() =>
      usePluginAuthStatuses(api, [
        makePlugin("failed-auth", true, { loadStatus: "failed", active: false, runtimeLoaded: false }),
      ]),
    );

    act(() => result.current.refresh("failed-auth"));

    expect(result.current.statuses.size).toBe(0);
    expect(api.callPluginMethod).not.toHaveBeenCalled();
  });

  it("surfaces error when statusTool rejects", async () => {
    const api = {
      callPluginMethod: vi.fn(async () => {
        throw new Error("boom");
      }),
    } as unknown as AveApi;
    const { result } = renderHook(() =>
      usePluginAuthStatuses(api, [makePlugin("samplemail", true)]),
    );
    await waitFor(() => {
      expect(result.current.statuses.get("samplemail")?.kind).toBe("error");
    });
  });

  it("survives non-Error throws (null / string) without crashing the catch handler", async () => {
    const callPluginMethod = vi
      .fn()
      .mockRejectedValueOnce(null)              // initial mount poll
      .mockRejectedValueOnce("raw string");     // manual refresh
    const api = {
      callPluginMethod,
    } as unknown as AveApi;
    const { result } = renderHook(() =>
      usePluginAuthStatuses(api, [makePlugin("samplemail", true)]),
    );

    // Wait for the initial mount poll to consume the `null` reject AND surface a fallback message — proves the catch handler
    // did not crash.
    await waitFor(() => {
      expect(callPluginMethod).toHaveBeenCalledTimes(1);
      const s = result.current.statuses.get("samplemail");
      expect(s?.kind).toBe("error");
      expect(s?.kind === "error" && s.message).toBe("auth status invocation failed");
    });

    act(() => result.current.refresh("samplemail"));
    await waitFor(() => {
      expect(callPluginMethod).toHaveBeenCalledTimes(2);
      const s = result.current.statuses.get("samplemail");
      expect(s?.kind).toBe("error");
      expect(s?.kind === "error" && s.message).toBe("raw string");
    });
  });

  it("refreshes auth status on host focus without a plugin event channel", async () => {
    const callPluginMethod = vi.fn()
      .mockResolvedValueOnce({ authenticated: false })
      .mockResolvedValueOnce({ authenticated: true, account: "post-login@x" });
    const api = { callPluginMethod } as unknown as AveApi;
    const { result } = renderHook(() => usePluginAuthStatuses(api, [makePlugin("samplemail", true)], ["samplemail"]));
    await waitFor(() => expect(result.current.statuses.get("samplemail")?.kind).toBe("unauthed"));
    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(result.current.statuses.get("samplemail")?.kind).toBe("authed"));
    expect(callPluginMethod).toHaveBeenCalledTimes(2);
  });

  it("manual refresh re-invokes statusTool", async () => {
    const callPluginMethod = vi
      .fn()
      .mockResolvedValueOnce({ authenticated: false })
      .mockResolvedValueOnce({ authenticated: true });
    const api = {
      callPluginMethod,
    } as unknown as AveApi;
    const { result } = renderHook(() =>
      usePluginAuthStatuses(api, [makePlugin("samplemail", true)]),
    );
    await waitFor(() => {
      expect(result.current.statuses.get("samplemail")?.kind).toBe("unauthed");
    });
    act(() => result.current.refresh("samplemail"));
    await waitFor(() => {
      expect(result.current.statuses.get("samplemail")?.kind).toBe("authed");
    });
  });
});


describe("mounted auth observation", () => {
  it("does not keep polling auth plugins with no mounted view, and stops after a view closes", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const callPluginMethod = vi.fn(async () => ({ authenticated: true }));
    const api = { callPluginMethod } as unknown as AveApi;
    const plugins = [makePlugin("mounted", true), makePlugin("closed", true)];
    const { rerender, unmount } = renderHook(({ mounted }) => usePluginAuthStatuses(api, plugins, mounted),
      { initialProps: { mounted: [] as string[] } });
    try {
      await act(async () => {});
      expect(callPluginMethod).toHaveBeenCalledTimes(2);
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
      expect(callPluginMethod).toHaveBeenCalledTimes(2);
      rerender({ mounted: ["mounted"] });
      await act(async () => {});
      expect(callPluginMethod).toHaveBeenCalledTimes(3);
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
      expect(callPluginMethod).toHaveBeenCalledTimes(4);
      rerender({ mounted: [] });
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
      expect(callPluginMethod).toHaveBeenCalledTimes(4);
    } finally { unmount(); vi.useRealTimers(); }
  });

  it("remounts only after a known authenticated/account identity changes", () => {
    const { result, rerender } = renderHook(({ status }) => usePluginAuthRevision(status),
      { initialProps: { status: { kind: "loading" } as PluginAuthState } });
    expect(result.current).toBe(0);
    rerender({ status: { kind: "authed", account: "account-a" } });
    expect(result.current).toBe(0);
    rerender({ status: { kind: "error", message: "first error" } });
    rerender({ status: { kind: "error", message: "different error" } });
    expect(result.current).toBe(0);
    rerender({ status: { kind: "authed", account: "account-a" } });
    expect(result.current).toBe(0);
    rerender({ status: { kind: "authed", account: "account-b" } });
    expect(result.current).toBe(1);
    rerender({ status: { kind: "unauthed" } });
    expect(result.current).toBe(2);
  });
});
