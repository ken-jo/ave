import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useOnboardingTourController } from "../use-onboarding-tour-controller.js";

function createApi(options: {
  onboardingCompleted?: boolean;
  completedScenario?: boolean;
  stateReadFailed?: boolean;
  hasApiKey?: boolean;
} = {}) {
  const start = vi.fn(async () => ({ ok: true, scenarioId: "first-boot-essentials" }));
  const updateSettings = vi.fn(async () => ({ ok: true }));
  const hasApiKey = vi.fn(async () => options.hasApiKey ?? false);
  const getSettings = vi.fn(async () => ({
    features: { onboardingCompleted: options.onboardingCompleted ?? false },
  }));
  const listPending = vi.fn(async () => ({ ok: true as const, pending: [] }));
  const api = {
    hasApiKey,
    getSettings,
    updateSettings,
    onboarding: { listPending },
    tour: {
      getState: vi.fn(async () => options.stateReadFailed ? {
        ok: false, error: "read-failed", message: "Unable to read tour state",
      } : ({
        ok: true,
        state: {
          lastSeenScenario: null,
          completedScenarios: options.completedScenario ? ["first-boot-essentials"] : [],
          dismissedAt: null,
        },
      })),
      start,
    },
  };
  return { api: api as never, getState: api.tour.getState, getSettings, hasApiKey, listPending, start, updateSettings };
}

describe("useOnboardingTourController", () => {
  it("starts the optional tour once for a fresh keyless workspace and handles a dismissal once without writing settings", async () => {
    const { api, start, updateSettings, listPending } = createApi();
    const { result, rerender } = renderHook(() => useOnboardingTourController(api));

    await waitFor(() => expect(start).toHaveBeenCalledWith("first-boot-essentials"));
    rerender();
    expect(start).toHaveBeenCalledTimes(1);

    act(() => result.current.onTourDismiss());
    expect(result.current.documentEngineOnboardingOpen).toBe(false);
    expect(updateSettings).not.toHaveBeenCalled();
    // A dismissal is not a completion: the user said they did not want to be walked through the app, so no proposal is put in
    // front of them either.
    expect(listPending).not.toHaveBeenCalled();

    act(() => result.current.onTourComplete());
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("asks the host for proposals once, after the tour completes", async () => {
    const { api, start, listPending, updateSettings } = createApi();
    const { result, rerender } = renderHook(() => useOnboardingTourController(api));

    await waitFor(() => expect(start).toHaveBeenCalledWith("first-boot-essentials"));
    expect(listPending).not.toHaveBeenCalled();

    act(() => result.current.onTourComplete());
    await waitFor(() => expect(listPending).toHaveBeenCalledTimes(1));
    expect(result.current.documentEngineOnboardingOpen).toBe(true);
    act(() => result.current.dismissDocumentEngineOnboarding());
    expect(result.current.documentEngineOnboardingOpen).toBe(false);

    // The gate opens once per launch, however many times the tree re-renders.
    rerender();
    act(() => result.current.onTourComplete());
    expect(listPending).toHaveBeenCalledTimes(1);
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("asks for proposals at boot for a returning user, who gets no tour", async () => {
    const returning = createApi({ completedScenario: true });
    renderHook(() => useOnboardingTourController(returning.api));

    await waitFor(() => expect(returning.listPending).toHaveBeenCalledTimes(1));
    expect(returning.start).not.toHaveBeenCalled();
    expect(returning.getSettings).not.toHaveBeenCalled();
  });

  it("does not start for a returning user or an already configured provider", async () => {
    const returning = createApi({ completedScenario: true });
    renderHook(() => useOnboardingTourController(returning.api));
    await waitFor(() => expect(returning.getState).toHaveBeenCalled());
    expect(returning.start).not.toHaveBeenCalled();

    const configured = createApi({ hasApiKey: true });
    renderHook(() => useOnboardingTourController(configured.api));
    await waitFor(() => expect(configured.hasApiKey).toHaveBeenCalled());
    expect(configured.start).not.toHaveBeenCalled();
  });
  it("keeps legacy completion evidence effective when importing fails", async () => {
    const returning = createApi({ onboardingCompleted: true });
    returning.getState.mockRejectedValue(new Error("import failed"));
    renderHook(() => useOnboardingTourController(returning.api));
    await waitFor(() => expect(returning.listPending).toHaveBeenCalledTimes(1));
    expect(returning.start).not.toHaveBeenCalled();
    expect(returning.updateSettings).not.toHaveBeenCalled();
  });

  it("does not automatically replay a tour when state is unavailable", async () => {
    const fresh = createApi();
    fresh.getState.mockRejectedValue(new Error("read failed"));
    renderHook(() => useOnboardingTourController(fresh.api));
    await waitFor(() => expect(fresh.getState).toHaveBeenCalledTimes(1));
    expect(fresh.start).not.toHaveBeenCalled();
    expect(fresh.listPending).not.toHaveBeenCalled();
    expect(fresh.updateSettings).not.toHaveBeenCalled();
  });

  it("uses legacy evidence for a host import error without replaying onboarding", async () => {
    const returning = createApi({ onboardingCompleted: true, stateReadFailed: true });
    renderHook(() => useOnboardingTourController(returning.api));
    await waitFor(() => expect(returning.listPending).toHaveBeenCalledTimes(1));
    expect(returning.getSettings).toHaveBeenCalledTimes(1);
    expect(returning.start).not.toHaveBeenCalled();
    expect(returning.updateSettings).not.toHaveBeenCalled();
  });

});
