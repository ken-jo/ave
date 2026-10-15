// @vitest-environment jsdom
/**
 * Browser tab pages live in one window-level layer and are laid over their
 * tab's slot. These pin the two properties the main-area panels rely on: a
 * slot may move without the guest being recreated (a recreated guest reloads
 * the page), and placement follows the slot — clipped, hidden, cut around
 * occluding cards, and out of the pointer's way during a drag.
 */
import "../../../../../test/renderer/setup.js";
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useState } from "react";
import { WebSurfaceLayer, WebSurfaceSlot, placeWebSurfaces } from "../WebSurfaceLayer.js";
import { EdgeResizeBar } from "../EdgeResizeBar.js";
import {
  beginSurfaceDrag,
  endSurfaceDrag,
  getWebSurfaces,
  publishLiveWebTabs,
  registerWebSurfaceOccluder,
  withdrawLiveWebTabs,
} from "../../preview/web-surfaces.js";

const source = Symbol("test-store");

afterEach(async () => {
  withdrawLiveWebTabs(source);
  await act(async () => { await Promise.resolve(); });
});

function stubBox(element: Element, box: { left: number; top: number; width: number; height: number }) {
  const rect = { ...box, x: box.left, y: box.top, right: box.left + box.width, bottom: box.top + box.height, toJSON: () => box };
  Object.defineProperty(element, "getBoundingClientRect", { configurable: true, value: () => rect });
  Object.defineProperty(element, "getClientRects", { configurable: true, value: () => [rect] });
}

function guests(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[data-testid="web-surface-layer"] webview')];
}

function frame(tabId: string): HTMLElement {
  return document.querySelector<HTMLElement>(`[data-testid="web-surface-frame"][data-tab-id="${tabId}"]`)!;
}

function Harness({ where }: { where: "side" | "pane" | "none" }) {
  return (
    <>
      <div data-testid="side">{where === "side" ? <WebSurfaceSlot tabId="browser:1" url="https://example.com/" location="side-panel" /> : null}</div>
      <div data-testid="pane">{where === "pane" ? <WebSurfaceSlot tabId="browser:1" url="https://example.com/" location="pane:main" /> : null}</div>
      <WebSurfaceLayer />
    </>
  );
}

describe("WebSurfaceLayer", () => {
  it("keeps one guest for a tab while its slot moves, hides it with no slot, and lets it go when the tab closes", async () => {
    publishLiveWebTabs(source, new Set(["browser:1"]));
    const { rerender } = render(<Harness where="side" />);
    expect(guests()).toHaveLength(1);
    const original = guests()[0]!;
    expect(original.getAttribute("src")).toBe("https://example.com/");
    expect(original.getAttribute("data-tab-id")).toBe("browser:1");

    rerender(<Harness where="pane" />);
    expect(guests()).toEqual([original]);

    // No slot anywhere: hidden, not destroyed — the page stays loaded.
    rerender(<Harness where="none" />);
    expect(guests()).toEqual([original]);
    act(() => { placeWebSurfaces(); });
    expect(frame("browser:1").style.visibility).toBe("hidden");

    rerender(<Harness where="side" />);
    expect(guests()).toEqual([original]);

    // The tab leaves every store: the guest is destroyed.
    await act(async () => {
      publishLiveWebTabs(source, new Set());
      await Promise.resolve();
    });
    expect(guests()).toHaveLength(0);
    expect(getWebSurfaces()).toHaveLength(0);
  });

  it("shows a second slot of the same tab as a notice until the first one goes", () => {
    publishLiveWebTabs(source, new Set(["browser:1"]));
    function Two({ both }: { both: boolean }) {
      return (
        <>
          {both ? <WebSurfaceSlot tabId="browser:1" url="https://example.com/" location="side-panel" /> : null}
          <WebSurfaceSlot tabId="browser:1" url="https://example.com/" location="pane:main" />
          <WebSurfaceLayer />
        </>
      );
    }
    const { rerender } = render(<Two both />);
    const notice = screen.getByTestId("web-surface-mounted-elsewhere");
    expect(notice.getAttribute("data-owner-location")).toBe("side-panel");
    rerender(<Two both={false} />);
    expect(screen.queryByTestId("web-surface-mounted-elsewhere")).toBeNull();
    expect(guests()).toHaveLength(1);
  });

  it("places the guest over the visible part of its slot and cuts occluding cards out of it", () => {
    publishLiveWebTabs(source, new Set(["browser:1"]));
    function Clipped() {
      const [ready] = useState(true);
      return (
        <>
          <div data-testid="clip" style={{ overflowX: "hidden", overflowY: "hidden" }}>
            {ready ? <WebSurfaceSlot tabId="browser:1" url="https://example.com/" location="pane:main" /> : null}
          </div>
          <div data-testid="card" />
          <WebSurfaceLayer />
        </>
      );
    }
    render(<Clipped />);
    Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, value: 1200 });
    Object.defineProperty(document.documentElement, "clientHeight", { configurable: true, value: 800 });
    stubBox(screen.getByTestId("web-surface-slot"), { left: 100, top: 50, width: 600, height: 400 });
    // The pane clips the slot's top 30px away (scrolled or collapsed).
    stubBox(screen.getByTestId("clip"), { left: 100, top: 80, width: 600, height: 370 });

    act(() => { placeWebSurfaces(); });
    const placed = frame("browser:1");
    expect(placed.style.visibility).toBe("visible");
    expect([placed.style.left, placed.style.top, placed.style.width, placed.style.height]).toEqual(["100px", "80px", "600px", "370px"]);
    const guest = guests()[0]!;
    // The page keeps the slot's full size; the frame shows only its visible part.
    expect([guest.style.left, guest.style.top, guest.style.width, guest.style.height]).toEqual(["0px", "-30px", "600px", "400px"]);
    expect(placed.style.pointerEvents).toBe("auto");
    expect(placed.style.clipPath).toBe("");

    const card = screen.getByTestId("card");
    stubBox(card, { left: 400, top: 300, width: 200, height: 100 });
    const release = registerWebSurfaceOccluder(card);
    act(() => { placeWebSurfaces(); });
    expect(placed.style.clipPath).toBe('path(evenodd, "M0 0H600V370H0ZM300 220H500V320H300Z")');
    release();

    beginSurfaceDrag();
    act(() => { placeWebSurfaces(); });
    expect(placed.style.pointerEvents).toBe("none");
    endSurfaceDrag();
    act(() => { placeWebSurfaces(); });
    expect(placed.style.pointerEvents).toBe("auto");
  });

  it("cuts a resize bar out of the page it overlaps, so the bar can still be grabbed", () => {
    publishLiveWebTabs(source, new Set(["browser:1"]));
    render(
      <>
        <WebSurfaceSlot tabId="browser:1" url="https://example.com/" location="side-panel" />
        <EdgeResizeBar width={448} edge="start" variant="inset" onWidthChange={() => {}} onWidthCommit={() => {}} min={300} max={900} resetWidth={448} ariaLabel="resize" data-testid="bar" />
        <WebSurfaceLayer />
      </>,
    );
    Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, value: 1400 });
    Object.defineProperty(document.documentElement, "clientHeight", { configurable: true, value: 800 });
    stubBox(screen.getByTestId("web-surface-slot"), { left: 774, top: 128, width: 448, height: 615 });
    stubBox(screen.getByTestId("bar"), { left: 774, top: 49, width: 8, height: 694 });
    act(() => { placeWebSurfaces(); });
    expect(frame("browser:1").style.clipPath).toBe('path(evenodd, "M0 0H448V615H0ZM0 0H8V615H0Z")');
  });
});
