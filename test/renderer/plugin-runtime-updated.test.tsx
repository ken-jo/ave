// Runtime updates refresh UI extensions and performance state so guests remount with the new revision.
import "./setup.js";
import { describe, it, expect, vi, afterEach } from "vitest";
import { waitFor, act } from "@testing-library/react";
import { renderApp } from "./render-app.js";

describe("App — plugin runtime-updated subscription", () => {
  it("re-fetches plugin views and cards when the runtime is updated", async () => {
    const { api, emitPluginRuntimeUpdated } = await renderApp();
    await waitFor(() => expect(api.onPluginRuntimeUpdated).toHaveBeenCalled());
    await waitFor(() => expect(api.listPluginUiExtensions).toHaveBeenCalled());
    api.listPluginUiExtensions.mockClear();
    api.listPluginCards.mockClear();

    await act(async () => {
      emitPluginRuntimeUpdated({ pluginId: "meeting" });
    });

    await waitFor(() => expect(api.listPluginUiExtensions).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(api.listPluginCards).toHaveBeenCalledTimes(1));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
