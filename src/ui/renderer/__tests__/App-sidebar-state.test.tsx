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

  it("hides the whole rail, reopens from the title bar and preserves the choice on resize and remount", async () => {
    const view = await renderApp({ hasApiKey: true, shellWidth: 1243, canvasWidth: 1000 });
    const toggle = await waitFor(() => {
      const button = view.container.querySelector('[data-testid="sidebar-collapse-toggle"]');
      expect(button).not.toBeNull();
      return button!;
    });
    await act(async () => { fireEvent.click(toggle); });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    const hide = view.container.querySelector('[data-testid="sidebar-hide"]');
    expect(hide).not.toBeNull();
    await act(async () => { fireEvent.click(hide!); });
    await waitFor(() => expect(view.container.querySelector('[data-testid="primary-sidebar"]')).toBeNull());
    const show = view.container.querySelector('[data-testid="sidebar-show"]')!;
    expect(document.activeElement).toBe(show);
    expect(view.container.querySelector("main")!.style.paddingLeft).toBe("0px");
    await view.resizeContainers({ shellWidth: 360, canvasWidth: 360 });
    expect(view.container.querySelector('[data-testid="primary-sidebar"]')).toBeNull();
    await act(async () => { fireEvent.click(show); });
    await waitFor(() => expect(view.container.querySelector('[data-testid="primary-sidebar"]')?.getAttribute("data-sidebar-overlay")).toBe("true"));
    const restored = view.container.querySelector('[data-testid="sidebar-collapse-toggle"]')!;
    expect(document.activeElement).toBe(restored);
    await view.resizeContainers({ shellWidth: 900, canvasWidth: 660 });
    expect(restored.getAttribute("aria-pressed")).toBe("true");
    expect(view.container.querySelector('[data-testid="primary-sidebar"]')?.hasAttribute("data-sidebar-overlay")).toBe(false);
    expect(view.api.updateSettings).toHaveBeenCalledWith({ system: { sidebarState: "rail" } });
    expect(view.api.updateSettings).toHaveBeenCalledWith({ system: { sidebarState: "hidden" } });
    expect(view.api.updateSettings).toHaveBeenCalledWith({ system: { sidebarState: "expanded" } });
    const saved = await view.api.getSettings();
    view.unmount();
    const reopened = await renderApp({ hasApiKey: true, settings: saved, shellWidth: 360, canvasWidth: 360 });
    await waitFor(() => expect(reopened.container.querySelector('[data-testid="sidebar-collapse-toggle"]')?.getAttribute("aria-pressed")).toBe("true"));
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
