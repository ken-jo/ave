import "../../../../test/renderer/setup.js";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp } from "../../../../test/renderer/render-app.js";
import { approvalRequest } from "../../../../test/renderer/helpers.js";
import { MOCK_DEFAULT_SESSION_ID } from "../../../../test/renderer/mock-ave-api.js";
import { t } from "../../../i18n/runtime.js";

describe("App sidebar visibility", () => {
  it("defaults to hidden at the minimum width without saving a preference", async () => {
    const view = await renderApp({ hasApiKey: true, shellWidth: 360, canvasWidth: 360 });
    await waitFor(() => expect(view.container.querySelector('[data-testid="sidebar-show"]')).not.toBeNull());
    expect(view.container.querySelector('[data-testid="primary-sidebar"]')).toBeNull();
    const main = view.container.querySelector("main")!;
    expect(main.style.paddingLeft).toBe("0px");
    expect(main.classList.contains("pl-(--shell-collapsed-rail-edge)")).toBe(false);
    expect(main.querySelector('[data-testid="pane-row"]')).toHaveClass("pl-(--chrome-gap-tight)");
    expect(view.api.updateSettings.mock.calls.filter(([patch]) =>
      (patch as { system?: { sidebarState?: string } }).system?.sidebarState)).toHaveLength(0);
  });

  it("uses one collapse control and preserves the rail choice on resize and remount", async () => {
    const view = await renderApp({ hasApiKey: true, shellWidth: 1243, canvasWidth: 1000 });
    const toggle = await waitFor(() => {
      const button = view.container.querySelector('[data-testid="sidebar-collapse-toggle"]');
      expect(button).not.toBeNull();
      return button!;
    });
    expect(view.container.querySelectorAll('[data-testid="sidebar-collapse-toggle"]')).toHaveLength(1);
    expect(view.container.querySelector('[data-testid="sidebar-hide"]')).toBeNull();
    await act(async () => { fireEvent.click(toggle); });
    // Folded, the list's header button is gone and the band's unfold button takes its place: still one control.
    const unfold = () => view.container.querySelector('[data-testid="sidebar-collapse-toggle"]');
    expect(view.container.querySelectorAll('[data-testid="sidebar-collapse-toggle"]')).toHaveLength(1);
    expect(unfold()?.getAttribute("aria-pressed")).toBe("false");
    expect(view.container.querySelector('[data-testid="primary-sidebar"]')).not.toBeNull();
    expect(view.container.querySelector('[data-testid="sidebar-rail"]')).not.toBeNull();
    expect(view.container.querySelector('[data-testid="sidebar-card"]')).toBeNull();
    await view.resizeContainers({ shellWidth: 360, canvasWidth: 360 });
    expect(unfold()?.getAttribute("aria-pressed")).toBe("false");
    expect(view.api.updateSettings).toHaveBeenCalledWith({ system: { sidebarState: "rail" } });
    const saved = await view.api.getSettings();
    view.unmount();
    const reopened = await renderApp({ hasApiKey: true, settings: saved, shellWidth: 360, canvasWidth: 360 });
    await waitFor(() => expect(reopened.container.querySelector('[data-testid="sidebar-collapse-toggle"]')?.getAttribute("aria-pressed")).toBe("false"));
  });

  it("hides and restores with the visibility shortcut and restores from the title bar", async () => {
    const view = await renderApp({ hasApiKey: true });
    await waitFor(() => expect(view.container.querySelector('[data-testid="sidebar-collapse-toggle"]')).not.toBeNull());
    const toggle = () => act(async () => { fireEvent.keyDown(window, { key: "B", ctrlKey: true, shiftKey: true }); });
    await toggle();
    await waitFor(() => expect(view.container.querySelector('[data-testid="primary-sidebar"]')).toBeNull());
    expect(document.activeElement).toBe(view.container.querySelector('[data-testid="sidebar-show"]'));
    expect(view.api.updateSettings).toHaveBeenCalledWith({ system: { sidebarState: "hidden" } });
    await toggle();
    await waitFor(() => expect(view.container.querySelector('[data-testid="sidebar-collapse-toggle"]')).not.toBeNull());
    await toggle();
    await act(async () => { fireEvent.click(view.container.querySelector('[data-testid="sidebar-show"]')!); });
    await waitFor(() => expect(view.container.querySelector('[data-testid="sidebar-collapse-toggle"]')?.getAttribute("aria-pressed")).toBe("true"));
  });

  it.each([
    ["rail", "shortcut"], ["rail", "titlebar"],
    ["expanded", "shortcut"], ["expanded", "titlebar"],
  ] as const)("restores the previous %s state using the %s", async (sidebarState, restore) => {
    const view = await renderApp({ hasApiKey: true, settings: { system: { sidebarState } }, shellWidth: 1243 });
    const state = () => view.container.querySelector('[data-testid="app-shell"]')?.getAttribute("data-sidebar-state");
    await waitFor(() => expect(state()).toBe(sidebarState));
    const toggleVisibility = () => act(async () => { fireEvent.keyDown(window, { key: "B", ctrlKey: true, shiftKey: true }); });
    const restoreVisibility = async () => {
      if (restore === "shortcut") await toggleVisibility();
      else await act(async () => { fireEvent.click(view.container.querySelector('[data-testid="sidebar-show"]')!); });
    };
    await toggleVisibility();
    await waitFor(() => expect(state()).toBe("hidden"));
    await restoreVisibility();
    await waitFor(() => expect(state()).toBe(sidebarState));
    expect(view.api.updateSettings).toHaveBeenLastCalledWith({ system: { sidebarState } });
    expect(document.activeElement).toBe(view.container.querySelector('[data-testid="sidebar-collapse-toggle"]'));

    await act(async () => { fireEvent.click(view.container.querySelector('[data-testid="sidebar-collapse-toggle"]')!); });
    const changedState = sidebarState === "rail" ? "expanded" : "rail";
    await waitFor(() => expect(state()).toBe(changedState));
    await toggleVisibility();
    await waitFor(() => expect(state()).toBe("hidden"));
    await restoreVisibility();
    await waitFor(() => expect(state()).toBe(changedState));
    expect(view.api.updateSettings).toHaveBeenLastCalledWith({ system: { sidebarState: changedState } });
  });

  it.each([360, 1243])("restores a persisted hidden sidebar visibly at %s pixels", async (width) => {
    const view = await renderApp({ hasApiKey: true, settings: { system: { sidebarState: "hidden" } }, shellWidth: width, canvasWidth: width });
    const show = await waitFor(() => {
      const button = view.container.querySelector('[data-testid="sidebar-show"]');
      expect(button).not.toBeNull();
      return button!;
    });
    expect(view.container.querySelector('[data-testid="primary-sidebar"]')).toBeNull();
    await act(async () => { fireEvent.click(show); });
    await waitFor(() => expect(view.container.querySelector('[data-testid="sidebar-collapse-toggle"]')?.getAttribute("aria-pressed")).toBe("true"));
    expect(document.activeElement).toBe(view.container.querySelector('[data-testid="sidebar-collapse-toggle"]'));
    expect(view.container.querySelector('[data-testid="sidebar-hide"]')).toBeNull();
    expect(view.api.updateSettings).toHaveBeenCalledWith({ system: { sidebarState: "expanded" } });
  });

  it.each(["expanded", "rail", "hidden"] as const)("keeps saved %s at 360 pixels", async (sidebarState) => {
    const { container } = await renderApp({ hasApiKey: true, settings: { system: { sidebarState } }, shellWidth: 360, canvasWidth: 360 });
    await waitFor(() => expect(container.querySelector('[data-testid="app-shell"]')?.getAttribute("data-sidebar-state")).toBe(sidebarState));
    const aside = container.querySelector('[data-testid="primary-sidebar"]');
    if (sidebarState === "hidden") expect(aside).toBeNull();
    else {
      expect(aside).not.toBeNull();
      expect(container.querySelector('[data-testid="sidebar-collapse-toggle"]')?.getAttribute("aria-pressed")).toBe(String(sidebarState === "expanded"));
    }
  });
});

describe("sidebar reveal attention", () => {
  it.each([
    [360, undefined], [360, "hidden"], [360, "rail"],
    [640, "hidden"], [640, "rail"], [1243, "hidden"], [1243, "rail"],
  ] as const)("marks hidden conversation approvals at %spx with sidebar %s", async (width, sidebarState) => {
    const { container, emitApproval, emitApprovalSettled } = await renderApp({
      hasApiKey: true, shellWidth: width, canvasWidth: width,
      settings: { system: { sidebarState } },
      sessions: [{ id: MOCK_DEFAULT_SESSION_ID, title: "Visible conversation", modifiedAt: "2026-11-09T00:00:00Z" },
        { id: "waiting-session", title: "Waiting conversation", modifiedAt: "2026-11-09T00:00:00Z" }],
    });
    const controlId = sidebarState === "rail" ? "sidebar-collapse-toggle" : "sidebar-show";
    await waitFor(() => expect(container.querySelector('[data-testid="app-shell"]')).toHaveAttribute("data-sidebar-state", sidebarState ?? "hidden"));
    const control = await waitFor(() => {
      const element = container.querySelector(`[data-testid="${controlId}"]`);
      expect(element).not.toBeNull();
      if (element === null) throw new Error("Missing sidebar reveal control");
      return element;
    });
    expect(control.querySelector('[role="img"]')).toBeNull();
    await act(async () => { emitApproval(approvalRequest({ id: "waiting-approval", sessionId: "waiting-session" })); });
    await waitFor(() => expect(control.querySelector('[role="img"]')).toHaveAttribute("aria-label", t("pendingAnswerDot.label")));
    expect(control).toHaveAttribute("aria-label", expect.stringContaining(t("pendingAnswerDot.label")));
    expect(container.querySelector('[data-testid="tool-approval-panel"]')).toBeNull();
    expect(container.querySelector('[data-testid="status-toast"]')).toBeNull();
    await act(async () => { emitApprovalSettled("waiting-approval"); });
    await waitFor(() => expect(control.querySelector('[role="img"]')).toBeNull());
  });

  it.each(["hidden", "rail"] as const)("does not mark the %s sidebar when the requesting conversation card is visible", async (sidebarState) => {
    const { container, emitApproval } = await renderApp({ hasApiKey: true, settings: { system: { sidebarState } } });
    await act(async () => { emitApproval(approvalRequest({ sessionId: MOCK_DEFAULT_SESSION_ID })); });
    await waitFor(() => expect(container.querySelector('[data-testid="tool-approval-panel"]')).not.toBeNull());
    expect(container.querySelector('[data-testid$="-pending-answer"]')).toBeNull();
  });
});
