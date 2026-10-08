import "../../../../../test/renderer/setup.js";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { makeMockAveApi } from "../../../../../test/renderer/mock-ave-api.js";
import { usePluginLifecycleRefresh } from "../use-plugin-lifecycle-refresh.js";
import type { AveApi } from "../../types.js";

function renderLifecycleHook() {
  const { api, emitPluginInstallResult, emitBootstrapStatus } = makeMockAveApi();
  const refreshViews = vi.fn();
  const refreshCards = vi.fn();
  renderHook(() =>
    usePluginLifecycleRefresh({
      api: api as unknown as AveApi,
      pluginCards: [],
      refreshViews,
      refreshCards,
    }),
  );
  return {
    emitPluginInstallResult,
    emitBootstrapStatus,
    refreshViews,
    refreshCards,
  };
}

describe("usePluginLifecycleRefresh", () => {
  it("refreshes cards when a plugin install fails so Doctor cards can appear", () => {
    const { emitPluginInstallResult, refreshViews, refreshCards } = renderLifecycleHook();

    act(() => {
      emitPluginInstallResult({ slug: "meeting", success: false, error: "install failed" });
    });

    expect(refreshCards).toHaveBeenCalledTimes(1);
    expect(refreshViews).not.toHaveBeenCalled();
  });

  it("refreshes plugin surfaces when managed bootstrap completes with failures", () => {
    const { emitBootstrapStatus, refreshViews, refreshCards } = renderLifecycleHook();

    act(() => {
      emitBootstrapStatus({
        phase: "complete",
        installed: [],
        failed: [{ id: "meeting", error: "manifest grant mismatch" }],
      });
    });

    expect(refreshCards).toHaveBeenCalledTimes(1);
    expect(refreshViews).toHaveBeenCalledTimes(1);
  });
});
