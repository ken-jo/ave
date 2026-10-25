// Menu navigation and in-panel selection must share tab state, including reopening the same menu command.
import "./setup.js";
import { describe, it, expect, afterEach, vi } from "vitest";
import { act, waitFor } from "@testing-library/react";
import { renderApp } from "./render-app.js";
import { activeSettingsTab, clickSettingsTab } from "./helpers.js";

afterEach(() => vi.restoreAllMocks());

describe("settings tab: app-menu path and in-panel moves stay on one value", () => {
  it("re-runs a menu command for a tab the user has since navigated away from", async () => {
    const { container, emitViewActivate } = await renderApp({ hasApiKey: true });

    await act(async () => {
      emitViewActivate("settings", "permissions");
    });
    await waitFor(() => expect(activeSettingsTab(container)).toBe("permissions"));

    await act(async () => {
      clickSettingsTab(container, "chat");
    });
    await waitFor(() => expect(activeSettingsTab(container)).toBe("chat"));

    // Reopening the menu must honor the panel's changed tab rather than stale app state.
    await act(async () => {
      emitViewActivate("settings", "permissions");
    });
    await waitFor(() => expect(activeSettingsTab(container)).toBe("permissions"));
  });
});
