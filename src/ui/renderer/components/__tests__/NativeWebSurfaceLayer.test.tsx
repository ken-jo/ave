// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AveApi } from "../../types.js";
import type { BrowserNativeSurfaceResult } from "../../../../shared/browser-native-surface.js";
import type { SessionTabBindingsState } from "../../../../shared/browser-surface.js";
import { nativeSurfaceFixture } from "../../../../__tests__/support/native-browser-surface.js";
import { navigateBrowserSurface, useBrowserSurface, useGuestNavigation } from "../../hooks/use-browser-navigation.js";
import { committedWebSurfaceLocation, nativeWebSurfaceState, publishLiveWebTabs, setNativeBrowserTabIds, setNativeWebSurfaceState, withdrawLiveWebTabs, webSurfaceFavicon } from "../../preview/web-surfaces.js";
import { WebSurfaceLayer, WebSurfaceSlot, placeWebSurfaces } from "../WebSurfaceLayer.js";
const source = Symbol("native-pages");
beforeEach(() => {
  setNativeBrowserTabIds([]);
  Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, value: 1200 });
  Object.defineProperty(document.documentElement, "clientHeight", { configurable: true, value: 800 });
});
afterEach(async () => { withdrawLiveWebTabs(source); await act(async () => {}); });
function slotBox() {
  const slot = screen.getByTestId("web-surface-slot");
  const rect = { left: 10, top: 20, right: 650, bottom: 500, width: 640, height: 480 };
  Object.defineProperty(slot, "getBoundingClientRect", { value: () => rect, configurable: true });
  Object.defineProperty(slot, "getClientRects", { value: () => [rect], configurable: true });
  return slot;
}
function Navigation() {
  const surface = useBrowserSurface("browser:native");
  const navigation = useGuestNavigation(surface);
  return <button onClick={() => navigateBrowserSurface(surface, "back")}>{navigation.title}:{navigation.url}:{String(navigation.canGoBack)}</button>;
}
describe("native page presentation", () => {
  it("creates an agent page without an embedded guest, presents without focus, and retains it through slot moves", async () => {
    const fixture = nativeSurfaceFixture();
    publishLiveWebTabs(source, new Set(["browser:native"]));
    const Harness = ({ location }: { location: string }) => <><WebSurfaceSlot tabId="browser:native" url="about:blank" bindRequestId="request:new" location={location} /><WebSurfaceLayer api={{ browserTabs: fixture.api } as AveApi} /></>;
    const view = render(<Harness location="side-panel" />);
    await act(async () => {});
    expect(document.querySelector("webview")).toBeNull();
    expect(fixture.nativeSurface.mock.calls.filter(([r]) => r.action === "create")).toEqual([[{ action: "create", tabId: "browser:native", requestId: "request:new" }]]);
    slotBox();
    await act(async () => { placeWebSurfaces(); });
    expect(fixture.nativeSurface).toHaveBeenCalledWith(expect.objectContaining({ action: "present", bounds: { x: 10, y: 20, width: 640, height: 480 }, sequence: expect.any(Number) }));
    expect(fixture.nativeSurface.mock.calls.some(([r]) => r.action === "focus")).toBe(false);
    const element = screen.getByTestId("chat-side-panel-browser-native");
    view.rerender(<Harness location="pane:main" />);
    await act(async () => {});
    expect(screen.getByTestId("chat-side-panel-browser-native")).toBe(element);
    expect(fixture.nativeSurface.mock.calls.filter(([r]) => r.action === "create")).toHaveLength(1);
    fireEvent.focus(element);
    expect(fixture.nativeSurface).toHaveBeenLastCalledWith({ action: "focus", tabId: "browser:native", webContentsId: 42 });
    view.unmount();
    await act(async () => {});
    expect(fixture.nativeSurface.mock.calls.some(([r]) => r.action === "close")).toBe(false);
  });
  it("waits for parking acknowledgement before hiding the placeholder and keeps the native page alive", async () => {
    const fixture = nativeSurfaceFixture();
    publishLiveWebTabs(source, new Set(["browser:native"]));
    render(<><WebSurfaceSlot tabId="browser:native" url="about:blank" bindRequestId="request:new" location="side-panel" /><WebSurfaceLayer api={{ browserTabs: fixture.api } as AveApi} /></>);
    await act(async () => {});
    const slot = slotBox();
    await act(async () => { placeWebSurfaces(); });
    const frame = screen.getByTestId("web-surface-frame");
    const run = fixture.nativeSurface.getMockImplementation()!;
    let acknowledge!: (result: BrowserNativeSurfaceResult) => void;
    fixture.nativeSurface.mockImplementation((request) => request.action === "present" && request.bounds === null
      ? new Promise((resolve) => { acknowledge = resolve; }) : run(request));
    slot.style.visibility = "hidden";
    act(() => { placeWebSurfaces(); });
    expect(frame.style.visibility).toBe("visible");
    expect(fixture.states.get("browser:native")?.visible).toBe(true);
    await act(async () => acknowledge({ ok: true, surface: { ...fixture.states.get("browser:native")!, visible: false } }));
    expect(frame.style.visibility).toBe("hidden");
    expect(fixture.nativeSurface.mock.calls.some(([r]) => r.action === "close")).toBe(false);
  });
  it("waits for durable restored identity, navigates the retained address once and closes only on source removal", async () => {
    setNativeBrowserTabIds(null);
    const fixture = nativeSurfaceFixture();
    let resolve!: (state: SessionTabBindingsState) => void;
    fixture.api.getSessionBindings = () => new Promise((done) => { resolve = done; });
    publishLiveWebTabs(source, new Set(["browser:native"]));
    render(<><WebSurfaceSlot tabId="browser:native" url="https://example.com/restored" location="side-panel" /><WebSurfaceLayer api={{ browserTabs: fixture.api } as AveApi} /></>);
    expect(document.querySelector("webview")).toBeNull();
    expect(fixture.nativeSurface).not.toHaveBeenCalled();
    await act(async () => resolve({ revision: 1, bindings: [], nativeBrowserTabIds: ["browser:native"] }));
    expect(document.querySelector("webview")).toBeNull();
    expect(fixture.nativeSurface.mock.calls.filter(([r]) => r.action === "navigate")).toEqual([[{ action: "navigate", tabId: "browser:native", webContentsId: 42, url: "https://example.com/restored" }]]);
    await act(async () => { withdrawLiveWebTabs(source); });
    expect(fixture.nativeSurface).toHaveBeenCalledWith({ action: "close", tabId: "browser:native", webContentsId: 42 });
  });
  it.each(["https://example.com/self-navigation", "about:blank"])("preserves a retained native address through delayed reacquisition (%s)", async (liveUrl) => {
    const fixture = nativeSurfaceFixture();
    fixture.api.getSessionBindings = async () => ({ revision: 1, bindings: [], nativeBrowserTabIds: ["browser:native"] });
    publishLiveWebTabs(source, new Set(["browser:native"]));
    const Harness = ({ layer }: { layer: boolean }) => <><WebSurfaceSlot tabId="browser:native" url="https://example.com/restored" location="side-panel" />{layer ? <WebSurfaceLayer api={{ browserTabs: fixture.api } as AveApi} /> : null}</>;
    const view = render(<Harness layer />);
    await act(async () => {});
    expect(fixture.nativeSurface.mock.calls.filter(([r]) => r.action === "navigate")).toHaveLength(1);
    const id = fixture.states.get("browser:native")!.webContentsId;
    act(() => { fixture.publish("browser:native", { url: liveUrl }); });
    view.rerender(<Harness layer={false} />);
    await act(async () => {});
    const run = fixture.nativeSurface.getMockImplementation()!;
    let complete!: () => void;
    fixture.nativeSurface.mockImplementationOnce(async (request) => {
      const result = await run(request);
      await new Promise<void>((resolve) => { complete = resolve; });
      return result;
    });
    view.rerender(<Harness layer />);
    await act(async () => {});
    expect(fixture.nativeSurface.mock.calls.filter(([r]) => r.action === "navigate")).toHaveLength(1);
    await act(async () => complete());
    expect(fixture.nativeSurface.mock.calls.filter(([r]) => r.action === "navigate")).toHaveLength(1);
    expect(fixture.states.get("browser:native")?.url).toBe(liveUrl);
    expect(nativeWebSurfaceState("browser:native")?.url).toBe(liveUrl);
    expect(nativeWebSurfaceState("browser:native")?.webContentsId).toBe(id);
    expect(fixture.nativeSurface.mock.calls.some(([r]) => r.action === "close")).toBe(false);
  });
  it("publishes native navigation and safe icons, ignores stale state, and routes chrome commands by native identity", async () => {
    const fixture = nativeSurfaceFixture();
    publishLiveWebTabs(source, new Set(["browser:native"]));
    render(<><WebSurfaceSlot tabId="browser:native" url="about:blank" bindRequestId="request:new" location="side-panel" /><WebSurfaceLayer api={{ browserTabs: fixture.api } as AveApi} /><Navigation /></>);
    await act(async () => {});
    act(() => { fixture.publish("browser:native", { url: "https://example.com/committed", title: "Page", canGoBack: true, favicon: "data:image/png;base64,YQ==" }); });
    expect(screen.getByRole("button").textContent).toBe("Page:https://example.com/committed:true");
    expect(committedWebSurfaceLocation("browser:native")).toBe("https://example.com/committed");
    expect(webSurfaceFavicon("browser:native")).toBe("data:image/png;base64,YQ==");
    const state = nativeWebSurfaceState("browser:native")!;
    act(() => setNativeWebSurfaceState("browser:native", { ...state, revision: state.revision - 1, title: "Stale" }));
    expect(nativeWebSurfaceState("browser:native")?.title).toBe("Page");
    fireEvent.click(screen.getByRole("button"));
    expect(fixture.nativeSurface).toHaveBeenLastCalledWith({ action: "back", tabId: "browser:native", webContentsId: 42 });
    act(() => { fixture.publish("browser:native", { favicon: "file:///private/icon.png" }); });
    expect(webSurfaceFavicon("browser:native")).toBeNull();
  });
});
