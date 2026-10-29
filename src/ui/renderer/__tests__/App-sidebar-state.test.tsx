import "../../../../test/renderer/setup.js";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp } from "../../../../test/renderer/render-app.js";

describe("App sidebar visibility", () => {
  it("defaults to hidden at the minimum width without saving a preference", async () => {
    const view = await renderApp({ hasApiKey: true, shellWidth: 360, canvasWidth: 360 });
    await waitFor(() => expect(view.container.querySelector('[data-testid="sidebar-show"]')).not.toBeNull());
    expect(view.container.querySelector('[data-testid="primary-sidebar"]')).toBeNull();
    const main = view.container.querySelector("main")!;
    expect(main.style.paddingLeft).toBe("0px");
    expect(main.classList.contains("pl-(--shell-collapsed-rail-reserve)")).toBe(false);
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
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(view.container.querySelector('[data-testid="primary-sidebar"]')).not.toBeNull();
    await view.resizeContainers({ shellWidth: 360, canvasWidth: 360 });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
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
