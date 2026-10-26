/** Shell width chooses sidebar overlay or reserve; dismissal returns focus to the toggle. */
import "../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { renderApp } from "../../../../test/renderer/render-app.js";
import {
  BAND_EDGE_PAD,
  CONTENT_TITLE_INSET,
  SHELL_GUTTER,
  collapsedBandLeadClearance,
} from "../../../shared/shell-geometry.js";
import { SIDEBAR_DEFAULT_WIDTH } from "../../../shared/side-panel.js";

/** jsdom has no OS lights: the band's collapsed lead is the plain-platform one. */
const COLLAPSED_BAND_LEAD = `${Math.max(BAND_EDGE_PAD, collapsedBandLeadClearance(false))}px`;
const EXPANDED_BAND_LEAD = `${SIDEBAR_DEFAULT_WIDTH + SHELL_GUTTER + CONTENT_TITLE_INSET}px`;
const EXPANDED_MAIN_RESERVE = `${SIDEBAR_DEFAULT_WIDTH + SHELL_GUTTER}px`;

async function mountShell(container: HTMLElement) {
  const toggle = await waitFor(() => {
    const el = container.querySelector('[data-testid="sidebar-collapse-toggle"]');
    expect(el).not.toBeNull();
    return el as HTMLButtonElement;
  });
  const aside = container.querySelector('[data-testid="primary-sidebar"]') as HTMLElement;
  const main = container.querySelector("main") as HTMLElement;
  const band = container.querySelector('[data-testid^="custom-titlebar"]') as HTMLElement;
  expect(aside).toBeTruthy();
  expect(main).toBeTruthy();
  expect(band).toBeTruthy();
  return { toggle, aside, main, band };
}

function expectCollapsedGeometry(main: HTMLElement, band: HTMLElement) {
  expect(main.classList.contains("pl-(--shell-collapsed-rail-reserve)")).toBe(true);
  expect(main.style.paddingLeft).toBe("");
  expect(band.style.paddingLeft).toBe(COLLAPSED_BAND_LEAD);
}

describe("App sidebar overlay", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([false, true])("keeps keyboard focus inside the overlay when shift is %s", async (shift) => {
    const user = userEvent.setup();
    const view = await renderApp({
      hasApiKey: true, shellWidth: 360, canvasWidth: 360,
      settings: { system: { sidebarState: "expanded", sidebarWidth: 480 } },
    });
    const { aside } = await mountShell(view.container);
    await waitFor(() => expect(aside.getAttribute("data-sidebar-overlay")).toBe("true"));
    const first = view.container.querySelector('[data-testid="sidebar-resize-handle"]') as HTMLElement;
    const last = view.container.querySelector('[data-testid="sidebar-hide"]') as HTMLElement;
    expect(first).toBeTruthy();
    expect(last).toBeTruthy();
    (shift ? first : last).focus();
    await user.tab({ shift });
    expect(document.activeElement).toBe(shift ? last : first);
    expect(aside.contains(document.activeElement)).toBe(true);
  });

  it("lets an open dialog own Escape while the sidebar remains expanded", async () => {
    const view = await renderApp({ hasApiKey: true, shellWidth: 500, canvasWidth: 500 });
    const { aside } = await mountShell(view.container);
    await waitFor(() => expect(aside.getAttribute("data-sidebar-overlay")).toBe("true"));
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const button = document.createElement("button");
    dialog.append(button);
    document.body.append(dialog);
    try {
      button.focus();
      await act(async () => { fireEvent.keyDown(button, { key: "Escape" }); });
      expect(aside.getAttribute("data-sidebar-overlay")).toBe("true");
      expect(document.activeElement).toBe(button);
    } finally {
      dialog.remove();
    }
  });

  it("expanding the sidebar on a narrow shell floats the card over the tile", async () => {
    const { container } = await renderApp({ hasApiKey: true, shellWidth: 500, canvasWidth: 500 });
    const { toggle, aside, main, band } = await mountShell(container);
    await waitFor(() => expect(aside.getAttribute("data-sidebar-overlay")).toBe("true"));
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expectCollapsedGeometry(main, band);
    await act(async () => { fireEvent.click(toggle); });
    expect(aside.hasAttribute("data-sidebar-overlay")).toBe(false);
    await act(async () => { fireEvent.click(toggle); });
    await waitFor(() => expect(aside.getAttribute("data-sidebar-overlay")).toBe("true"));
    expect(main.getAttribute("data-sidebar-overlay")).toBe("true");
    const card = container.querySelector('[data-testid="sidebar-card"]') as HTMLElement;
    expect(card.getAttribute("data-surface")).toBe("card");
    expect(card.style.width).toBe(`${SIDEBAR_DEFAULT_WIDTH}px`);
    expectCollapsedGeometry(main, band);
    expect(card.contains(document.activeElement)).toBe(true);
  });

  it("Escape collapses the narrow overlay and hands focus back to the toggle", async () => {
    const { container } = await renderApp({ hasApiKey: true, shellWidth: 500, canvasWidth: 500 });
    const { toggle, aside, main, band } = await mountShell(container);
    await waitFor(() => expect(aside.getAttribute("data-sidebar-overlay")).toBe("true"));
    await act(async () => { fireEvent.keyDown(document, { key: "Escape" }); });
    await waitFor(() => expect(aside.hasAttribute("data-sidebar-overlay")).toBe(false));
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(main.hasAttribute("data-sidebar-overlay")).toBe(false);
    expectCollapsedGeometry(main, band);
    expect(document.activeElement).toBe(toggle);
  });

  it("a pointer down beside the overlay collapses it; one inside the card keeps it open", async () => {
    const { container } = await renderApp({ hasApiKey: true, shellWidth: 500, canvasWidth: 500 });
    const { toggle, aside, main } = await mountShell(container);
    await waitFor(() => expect(aside.getAttribute("data-sidebar-overlay")).toBe("true"));
    const card = container.querySelector('[data-testid="sidebar-card"]') as HTMLElement;
    await act(async () => { fireEvent.pointerDown(card); });
    expect(aside.getAttribute("data-sidebar-overlay")).toBe("true");
    await act(async () => { fireEvent.pointerDown(main); });
    await waitFor(() => expect(aside.hasAttribute("data-sidebar-overlay")).toBe(false));
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
  });

  it("the expanded sidebar reserves its width on a wide shell", async () => {
    const { container } = await renderApp({ hasApiKey: true, shellWidth: 1600, canvasWidth: 1200 });
    const { toggle, aside, main, band } = await mountShell(container);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(aside.hasAttribute("data-sidebar-overlay")).toBe(false);
    expect(main.hasAttribute("data-sidebar-overlay")).toBe(false);
    expect(main.classList.contains("pl-(--shell-collapsed-rail-reserve)")).toBe(false);
    expect(main.style.paddingLeft).toBe(EXPANDED_MAIN_RESERVE);
    expect(band.style.paddingLeft).toBe(EXPANDED_BAND_LEAD);
    await act(async () => { fireEvent.keyDown(document, { key: "Escape" }); });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(main.style.paddingLeft).toBe(EXPANDED_MAIN_RESERVE);
  });

  it("resizing an expanded sidebar uses a dead band without changing its expanded choice", async () => {
    const view = await renderApp({ hasApiKey: true, shellWidth: 500, canvasWidth: 500 });
    const { toggle, aside, main, band } = await mountShell(view.container);
    await waitFor(() => expect(aside.getAttribute("data-sidebar-overlay")).toBe("true"));
    const threshold = SIDEBAR_DEFAULT_WIDTH + 8 + 320;
    await view.resizeContainers({ shellWidth: threshold + 59 });
    expect(aside.getAttribute("data-sidebar-overlay")).toBe("true");
    await view.resizeContainers({ shellWidth: threshold + 60 });
    expect(aside.hasAttribute("data-sidebar-overlay")).toBe(false);
    expect(main.style.paddingLeft).toBe(EXPANDED_MAIN_RESERVE);
    expect(band.style.paddingLeft).toBe(EXPANDED_BAND_LEAD);
    await view.resizeContainers({ shellWidth: threshold });
    expect(aside.hasAttribute("data-sidebar-overlay")).toBe(false);
    await view.resizeContainers({ shellWidth: threshold - 1 });
    expect(aside.getAttribute("data-sidebar-overlay")).toBe("true");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expectCollapsedGeometry(main, band);
  });
});
