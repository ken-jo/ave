// @vitest-environment jsdom
/** Move slots without recreating guests; placement must clip, hide and avoid occluders while retaining page state. */
import "../../../../../test/renderer/setup.js";
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AveApi, AvePreviewApi } from "../../types.js";
import type { AgentObservationEvent } from "../../../../shared/agent-observation.js";
import { connectBrowserObservations } from "../../preview/browser-observation-bridge.js";
import { useState } from "react";
import { readFileSync } from "node:fs";
import { FAVICON_SCHEMES, faviconSource } from "../../preview/favicon-source.js";
import { WebSurfaceLayer, WebSurfaceSlot, placeWebSurfaces } from "../WebSurfaceLayer.js";
import { EdgeResizeBar } from "../EdgeResizeBar.js";
import {
  beginSurfaceDrag,
  committedWebSurfaceLocation,
  endSurfaceDrag,
  getWebSurfaces,
  publishLiveWebTabs,
  registerWebSurfaceOccluder,
  withdrawLiveWebTabs,
  webSurfaceFavicon,
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
      <WebSurfaceLayer api={layerApi} />
    </>
  );
}

const bindTab = vi.fn(async (_request: { tabId: string; webContentsId: number; requestId?: string }) => ({ ok: true as const }));
const layerApi = { browserTabs: { bindTab } } as unknown as AveApi;

describe("WebSurfaceLayer", () => {
  it("keeps host favicon helper schemes aligned with the renderer img-src CSP", () => {
    const html = readFileSync("src/index.html", "utf8");
    const policy = html.match(/content="([^"]*default-src[^"]*)"/)![1]!;
    const sources = policy.match(/(?:^|;)\s*img-src\s+([^;]+)/)![1]!.trim().split(/\s+/);
    expect(sources).toContain("'self'");
    expect([...FAVICON_SCHEMES].sort()).toEqual(sources.filter((value) => value !== "'self'").sort());
    const candidates = ["data:image/png;base64,YQ==", "blob:null/favicon", "ave-content://installed/icon.png",
      "https://site.example/icon.png", "http://site.example/icon.png", "file:///private/icon.png", "javascript:alert(1)"];
    const allowedSchemes: string[] = [];
    for (const candidate of candidates) {
      const scheme = candidate.slice(0, candidate.indexOf(":") + 1);
      expect(faviconSource(candidate)).toBe(sources.includes(scheme) ? candidate : null);
      if (faviconSource(candidate) !== null) allowedSchemes.push(scheme);
    }
    expect(allowedSchemes.sort()).toEqual(sources.filter((value) => value !== "'self'").sort());
    expect(faviconSource("./icon.png")).toBe("./icon.png");
    expect(faviconSource("//site.example/icon.png")).toBeNull();
  });

  it.each([
    ["internal content", "ave-content://installed/icon.png", null],
    ["blob", "blob:https://site.example/icon", null],
    ["script", "javascript:alert(1)", null],
    ["file", "file:///private/icon.png", null],
    ["relative", "./icon.png", null],
    ["bare path", "icon.png", null],
    ["root path", "/icon.png", null],
    ["protocol relative", "//site.example/icon.png", null],
    ["non-image data", "data:text/html,<p>icon</p>", null],
    ["empty image type", "data:image/;base64,YQ==", null],
    ["credentials", "https://user:password@site.example/icon.png", null],
    ["oversized URL", "https://site.example/" + "a".repeat(8192), null],
    ["padded URL", " https://site.example/icon.png", null],
    ["malformed URL", "https://", null],
    ["non-string", null, null],
    ["http", "http://site.example/icon.png", null],
    ["https", "https://site.example/icon.png", null],
    ["image data", "data:image/png;base64,YQ==", "data:image/png;base64,YQ=="],
    ["vector image data", "data:image/svg+xml,%3Csvg/%3E", "data:image/svg+xml,%3Csvg/%3E"],
  ])("filters a guest's %s favicon at the event boundary", (_label, candidate, expected) => {
    publishLiveWebTabs(source, new Set(["browser:icon"]));
    render(<><WebSurfaceSlot tabId="browser:icon" url="https://example.com/" location="side-panel" /><WebSurfaceLayer api={layerApi} /></>);
    const guest = guests()[0]!;
    act(() => { guest.dispatchEvent(Object.assign(new Event("page-favicon-updated"), { favicons: ["data:image/png;base64,YQ=="] })); });
    act(() => { guest.dispatchEvent(Object.assign(new Event("page-favicon-updated"), { favicons: [candidate] })); });
    expect(webSurfaceFavicon("browser:icon")).toBe(expected);
  });

  it("skips rejected guest favicon candidates before choosing image data", () => {
    publishLiveWebTabs(source, new Set(["browser:icon"]));
    render(<><WebSurfaceSlot tabId="browser:icon" url="https://example.com/" location="side-panel" /><WebSurfaceLayer api={layerApi} /></>);
    act(() => { guests()[0]!.dispatchEvent(Object.assign(new Event("page-favicon-updated"), {
      favicons: ["https://site.example/icon.png", "ave-content://installed/icon.png", "./icon.png", "data:image/png;base64,YQ=="],
    })); });
    expect(webSurfaceFavicon("browser:icon")).toBe("data:image/png;base64,YQ==");
  });
  it("binds a guest that cannot name itself at attach on its first dom-ready, and only then", async () => {
    bindTab.mockClear();
    publishLiveWebTabs(source, new Set(["browser:8"]));
    render(
      <>
        <WebSurfaceSlot tabId="browser:8" url="https://example.com/" location="side-panel" />
        <WebSurfaceLayer api={layerApi} />
      </>,
    );
    const guest = guests()[0]! as HTMLElement & { getWebContentsId?: () => number };
    // As Electron does until the guest's first dom-ready.
    guest.getWebContentsId = () => { throw new Error("The WebView must be attached to the DOM and the dom-ready event emitted"); };
    act(() => { guest.dispatchEvent(new Event("did-attach")); });
    await act(async () => { await Promise.resolve(); });
    expect(bindTab).not.toHaveBeenCalled();
    guest.getWebContentsId = () => 31;
    act(() => { guest.dispatchEvent(new Event("dom-ready")); });
    act(() => { guest.dispatchEvent(new Event("dom-ready")); });
    await act(async () => { await Promise.resolve(); });
    expect(bindTab.mock.calls).toEqual([[{ tabId: "browser:8", webContentsId: 31 }]]);
  });

  it("binds a tab's guest for the agent tools once, with the request it was opened for, and keeps that binding across a move", async () => {
    bindTab.mockClear();
    publishLiveWebTabs(source, new Set(["browser:9"]));
    const Moving = ({ where }: { where: "side" | "pane" }) => (
      <>
        {where === "side"
          ? <WebSurfaceSlot tabId="browser:9" url="about:blank" location="side-panel" bindRequestId="browser-op-9" />
          : <WebSurfaceSlot tabId="browser:9" url="about:blank" location="pane:main" />}
        <WebSurfaceLayer api={layerApi} />
      </>
    );
    const { rerender } = render(<Moving where="side" />);
    const guest = guests()[0]! as HTMLElement & { getWebContentsId?: () => number };
    guest.getWebContentsId = () => 77;
    act(() => { guest.dispatchEvent(new Event("did-attach")); });
    await act(async () => { await Promise.resolve(); });
    expect(bindTab.mock.calls).toEqual([[{ tabId: "browser:9", webContentsId: 77, requestId: "browser-op-9" }]]);

    // The main frame's committed address is recorded; a subframe's is not.
    act(() => { guest.dispatchEvent(Object.assign(new Event("did-navigate"), { url: "https://a.example/" })); });
    act(() => { guest.dispatchEvent(Object.assign(new Event("did-navigate-in-page"), { url: "https://frame.example/", isMainFrame: false })); });
    expect(committedWebSurfaceLocation("browser:9")).toBe("https://a.example/");
    act(() => { guest.dispatchEvent(Object.assign(new Event("page-favicon-updated"), { favicons: ["data:image/png;base64,YQ=="] })); });
    expect(webSurfaceFavicon("browser:9")).toBe("data:image/png;base64,YQ==");
    act(() => { guest.dispatchEvent(Object.assign(new Event("page-favicon-updated"), { favicons: ["file:///private/icon.png", "https://user:password@a.example/icon.png", "https://a.example/" + "a".repeat(8192)] })); });
    expect(webSurfaceFavicon("browser:9")).toBeNull();
    act(() => { guest.dispatchEvent(Object.assign(new Event("page-favicon-updated"), { favicons: [null, "data:image/png;base64,YQ=="] })); });
    act(() => { guest.dispatchEvent(Object.assign(new Event("did-navigate-in-page"), { url: "https://a.example/route", isMainFrame: true })); });
    expect(webSurfaceFavicon("browser:9")).toBe("data:image/png;base64,YQ==");

    // Moved to a pane: the same guest, not bound again, its request kept.
    rerender(<Moving where="pane" />);
    expect(guests()).toEqual([guest]);
    expect(webSurfaceFavicon("browser:9")).toBe("data:image/png;base64,YQ==");
    expect(bindTab).toHaveBeenCalledTimes(1);
    expect(getWebSurfaces().find((surface) => surface.tabId === "browser:9")?.bindRequestId).toBe("browser-op-9");

    // A new guest process: the old address is forgotten and the guest bound again.
    act(() => { guest.dispatchEvent(new Event("did-attach")); });
    expect(webSurfaceFavicon("browser:9")).toBeNull();
    await act(async () => { await Promise.resolve(); });
    expect(committedWebSurfaceLocation("browser:9")).toBeNull();
    expect(bindTab).toHaveBeenLastCalledWith({ tabId: "browser:9", webContentsId: 77, requestId: "browser-op-9" });
  });

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
          <WebSurfaceLayer api={layerApi} />
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

  it("wraps the notice of a second slot in the agent's live preview, which waits until the slot is laid out", () => {
    publishLiveWebTabs(source, new Set(["browser:1"]));
    let emit!: (events: AgentObservationEvent[]) => void;
    const requestObservationPreview = vi.fn(async () => ({ ok: true }));
    const disconnect = connectBrowserObservations({ onAgentObservation: (handler: typeof emit) => { emit = handler; return () => {}; },
      acknowledgeObservation: async () => ({ ok: true }), onObservationPreview: () => () => {}, requestObservationPreview } as unknown as AvePreviewApi);
    try {
      render(<>
        <WebSurfaceSlot tabId="browser:1" url="https://example.com/" location="side-panel" sessionId="agent-session" />
        <WebSurfaceSlot tabId="browser:1" url="https://example.com/" location="pane:main" />
        <WebSurfaceLayer api={layerApi} />
      </>);
      expect(screen.queryByTestId("browser-observation-preview")).toBeNull();
      act(() => emit([{ source: "browser", actor: "agent", sessionId: "agent-session",
        target: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", path: "browser", hostSessionId: "agent-session" }, seq: 1, ts: 1, kind: "action",
        before: null, after: { action: "click", tabId: "tab-1", rendererTabId: "browser:1", url: "https://example.com/", title: "Example" } }]));
      const preview = screen.getByTestId("browser-observation-preview");
      expect(preview.contains(screen.getByTestId("web-surface-mounted-elsewhere"))).toBe(true);
      // jsdom lays nothing out, exactly like a panel that is mounted but not shown.
      expect(requestObservationPreview).not.toHaveBeenCalled();
    } finally {
      disconnect();
    }
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
          <WebSurfaceLayer api={layerApi} />
        </>
      );
    }
    render(<Clipped />);
    Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, value: 1200 });
    Object.defineProperty(document.documentElement, "clientHeight", { configurable: true, value: 800 });
    stubBox(screen.getByTestId("web-surface-slot"), { left: 100, top: 50, width: 600, height: 400 });
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
        <WebSurfaceLayer api={layerApi} />
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
