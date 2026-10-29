// @vitest-environment jsdom
/** Terminal and web panes in the main area: the store that owns their records and the pane body each kind draws. */
import "../../../../../test/renderer/setup.js";
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "../../../../components/ui/tooltip.js";
import { SurfacePane, directoryName, webPanelTitle } from "../MainSurfacePanels.js";
import type { SideChatRuntime } from "../SideChatView.js";
import { DEFAULT_PROCESSING_DISPLAY_LEVEL } from "../../../../shared/processing-display-level.js";

/** The pane chat's model readiness: a configured API-key model, settings loaded. */
const CHAT_RUNTIME: SideChatRuntime = {
  hasApiKey: true, settingsLoaded: true, onOpenSettings: () => {},
  llmVendor: "openai", llmModel: "test-model", llmRouteModalities: undefined,
  processingDisplayLevel: DEFAULT_PROCESSING_DISPLAY_LEVEL, usageAvailable: true,
};
import { WebSurfaceLayer } from "../WebSurfaceLayer.js";
import { useMainSurfaces, type MainSurface } from "../../preview/main-surfaces.js";
import { getWebSurfaces, noteWebSurfaceLocation, setWebSurfaceElement } from "../../preview/web-surfaces.js";
import { makeMockAveApi } from "../../../../../test/renderer/mock-ave-api.js";
import { __resetBrowserTabBridgeForTest, registerBrowserTabHost } from "../../preview/agent-browser-bridge.js";
import { browserControlFixture } from "../../../../__tests__/support/browser-control-fixture.js";
import { terminalSessionFixture } from "../../../../__tests__/support/terminal-session-fixtures.js";
import type { BrowserTabControlState } from "../../../../shared/browser-surface.js";
import { BrowserTabRegistry, type BrowserGuest } from "../../../../main/browser/browser-tab-registry.js";

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    options = {};
    cols = 80;
    rows = 24;
    parser = { registerOscHandler: () => ({ dispose() {} }) };
    loadAddon() {}
    open() {}
    onData() { return { dispose() {} }; }
    write() {}
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));

function terminalApi() {
  return {
    spawn: vi.fn(async (ref) => ({ ok: true, tabId: ref.tabId, replayed: false, session: terminalSessionFixture(ref.tabId, ref.lane) })),
    input: vi.fn(async () => undefined),
    resize: vi.fn(async () => undefined),
    onData: vi.fn(() => () => {}),
    onExit: vi.fn(() => () => {}),
    listFileReviews: vi.fn(async () => ({ ok: true as const, snapshot: { files: [], warnings: [] } })),
    reviewFiles: vi.fn(async () => ({ ok: true as const })),
    listBlocks: vi.fn(async () => ({ ok: true as const, integrated: true, blocks: [] as unknown[] })),
    getBlock: vi.fn(async () => ({ ok: false as const, error: "block-not-found" })),
  };
}

afterEach(async () => {
  // Let the surface reconcile drop whatever a test left published.
  await act(async () => { await Promise.resolve(); });
});

describe("directoryName", () => {
  it("keeps the last segment of a path for the header", () => {
    expect(directoryName("/work/repo/app")).toBe("app");
    expect(directoryName("/work/repo/app/")).toBe("app");
    expect(directoryName("/")).toBe("/");
  });
});

describe("useMainSurfaces", () => {
  it("creates window-unique surfaces, hands them out without closing them, and remembers closed ones", async () => {
    const { result, unmount } = renderHook(() => useMainSurfaces());
    let terminal!: MainSurface;
    let page!: MainSurface;
    act(() => {
      terminal = result.current.create("terminal");
      page = result.current.create("browser", "https://example.com/");
    });
    expect(terminal.tabId).toMatch(/^terminal:[0-9a-f]{8}-\d+$/);
    expect(page.tabId).toMatch(/^browser:[0-9a-f]{8}-\d+$/);
    expect(result.current.surfaces.map((each) => each.tabId)).toEqual([terminal.tabId, page.tabId]);

    // Released (moving to a side panel): gone from here, not remembered as closed.
    let released: MainSurface | undefined;
    act(() => { released = result.current.release(terminal.tabId); });
    expect(released).toEqual(terminal);
    act(() => { result.current.adopt(terminal); });
    expect(result.current.get(terminal.tabId)).toEqual(terminal);

    // The page moved on its own; reopening brings back where it was, not where it started.
    noteWebSurfaceLocation(page.tabId, "https://example.com/next");
    act(() => { result.current.close(page.tabId); });
    expect(result.current.surfaces.map((each) => each.tabId)).toEqual([terminal.tabId]);
    // A terminal remembers where its shell last was, for its replacement.
    act(() => { result.current.setCwd(terminal.tabId, "/work/repo"); });
    expect(result.current.get(terminal.tabId)?.cwd).toBe("/work/repo");
    act(() => { result.current.close(terminal.tabId); });
    expect(result.current.takeLastClosed()).toEqual({ kind: "terminal", url: null, cwd: "/work/repo" });
    expect(result.current.takeLastClosed()).toEqual({ kind: "browser", url: "https://example.com/next", cwd: null });
    expect(result.current.takeLastClosed()).toBeUndefined();
    unmount();
  });

  it("keeps a main browser surface's guest alive while the store lists it", async () => {
    const { result, unmount } = renderHook(() => useMainSurfaces());
    let page!: MainSurface;
    act(() => { page = result.current.create("browser", "https://example.com/"); });
    render(
      <TooltipProvider>
        <SurfacePane chatOpen={false} onChatOpenChange={() => {}} chatRuntime={CHAT_RUNTIME} api={makeMockAveApi().api as never} surface={page} paneId="main" frame={{}} onNavigate={() => {}} />
        <WebSurfaceLayer api={makeMockAveApi().api as never} />
      </TooltipProvider>,
    );
    await act(async () => { await Promise.resolve(); });
    expect(getWebSurfaces().map((each) => each.tabId)).toEqual([page.tabId]);
    act(() => { result.current.close(page.tabId); });
    await act(async () => { await Promise.resolve(); });
    expect(getWebSurfaces()).toHaveLength(0);
    unmount();
  });
});

describe("SurfacePane", () => {
  const surface = (kind: MainSurface["kind"], url: string | null = null): MainSurface => ({ tabId: `${kind}:90${kind.length}`, kind, ordinal: 2, url });

  it.each(["address", "back", "forward", "reload"])("revokes restored agent ownership before user %s navigation without a control report", async (action) => {
    __resetBrowserTabBridgeForTest();
    const tabs = new BrowserTabRegistry<BrowserGuest>();
    let requestId = "";
    tabs.setRendererLink({ sendTabOp: (_window, request) => { requestId = request.requestId; return true; }, sendControl: () => {} });
    const guest = { id: 71, url: "about:blank", isDestroyed: () => false, getURL() { return this.url; }, getTitle: () => "Page" };
    const opened = tabs.requestTabOp(1, { op: "new", url: "https://a.example/" });
    tabs.guestAttached(guest, 1);
    const tabId = "browser:restored";
    tabs.bindTab(1, { tabId, webContentsId: guest.id, requestId });
    const result = await opened;
    if (!result.ok) throw new Error(result.error);
    const record = tabs.liveTab(result.tabId)!;
    guest.url = "https://a.example/";
    tabs.navigationStarted(guest.id, guest.url);
    tabs.guestDestroyed(guest.id);
    const next = { ...guest, id: 72 };
    tabs.guestAttached(next, 1);
    const pendingAction = record.actions.signal;
    const stop = vi.fn(async (id: string) => ({ ok: tabs.stop(1, id) }));
    const api = { ...makeMockAveApi().api, browserTabs: { stop, bindTab: vi.fn(), getState: async () => ({ revision: 0, tabs: [] }), onTabOp: () => () => {}, onControl: () => () => {} } };
    const navigate = vi.fn(() => {
      next.url = "https://a.example/user-chosen";
      tabs.navigationStarted(next.id, next.url);
    });
    const element = Object.assign(document.createElement("webview"), {
      getURL: () => next.url, getTitle: () => "Page", canGoBack: () => true, canGoForward: () => true,
      goBack: navigate, goForward: navigate, reload: navigate,
    });
    setWebSurfaceElement(tabId, element);
    const unregister = registerBrowserTabHost(api as never, { sessionId: () => null, hasTab: () => false, selectTab: () => {}, closeTab: () => {} });
    try {
      render(<TooltipProvider><SurfacePane chatOpen={false} onChatOpenChange={() => {}} chatRuntime={CHAT_RUNTIME} api={api as never} surface={{ kind: "browser", tabId, ordinal: 1, url: guest.url }} paneId="main" frame={{}} onNavigate={navigate} /></TooltipProvider>);
      expect(screen.queryByTestId("agent-browser-control-badge")).toBeNull();
      await act(async () => {
        if (action === "address") {
          const address = screen.getByTestId("web-panel-address");
          fireEvent.change(address, { target: { value: "https://a.example/user-chosen" } });
          fireEvent.submit(address.closest("form")!);
        } else fireEvent.click(screen.getByTestId(`web-panel-${action}`));
      });
      expect(next.url).toBe("https://a.example/user-chosen");
      tabs.bindTab(1, { tabId, webContentsId: next.id });
      expect(tabs.liveTab(result.tabId)?.opener).toBe("user");
      expect(tabs.liveTab(result.tabId)?.agentOrigin).toBeNull();
      expect(pendingAction.aborted).toBe(true);
      expect(stop.mock.invocationCallOrder[0]!).toBeLessThan(navigate.mock.invocationCallOrder[0]!);
    } finally {
      unregister();
      setWebSurfaceElement(tabId, null);
      __resetBrowserTabBridgeForTest();
    }
  });

  it("draws a terminal pane on its tab's PTY, mounted at the pane", async () => {
    const { api } = makeMockAveApi();
    const terminal = terminalApi();
    render(
      <TooltipProvider>
        <SurfacePane chatOpen={false} onChatOpenChange={() => {}} chatRuntime={CHAT_RUNTIME} api={{ ...api, terminal } as never} surface={surface("terminal")} paneId="group-2" frame={{}} onNavigate={() => {}} />
      </TooltipProvider>,
    );
    expect(screen.getByTestId("pane-header").textContent).toMatch(/ 2$/);
    await act(async () => { await Promise.resolve(); });
    expect(terminal.spawn).toHaveBeenCalledWith(expect.objectContaining({ tabId: "terminal:908" }));
  });

  it("draws an empty web pane until an address is entered, and validates the address", async () => {
    const onNavigate = vi.fn();
    render(
      <TooltipProvider>
        <SurfacePane chatOpen={false} onChatOpenChange={() => {}} chatRuntime={CHAT_RUNTIME} api={makeMockAveApi({ browserTabs: true }).api as never} surface={surface("browser")} paneId="main" frame={{}} onNavigate={onNavigate} />
      </TooltipProvider>,
    );
    expect(screen.getByTestId("web-panel-empty")).toBeTruthy();
    expect(screen.queryByTestId("web-surface-slot")).toBeNull();
    const address = screen.getByTestId("web-panel-address");
    fireEvent.change(address, { target: { value: "javascript:alert(1)" } });
    fireEvent.submit(address.closest("form")!);
    expect(onNavigate).not.toHaveBeenCalled();
    expect(screen.getByTestId("web-panel-address-error")).toBeTruthy();
    fireEvent.change(address, { target: { value: "example.com/docs" } });
    await act(async () => { fireEvent.submit(address.closest("form")!); });
    expect(onNavigate).toHaveBeenCalledWith("browser:907", "https://example.com/docs");
  });

  it("badges a web pane the agent controls; its stop, and the user driving the address row, take the tab back", async () => {
    let emitControl: (state: BrowserTabControlState) => void = () => {};
    const stop = vi.fn(async () => ({ ok: true as const }));
    const api = {
      ...makeMockAveApi().api,
      browserTabs: {
        bindTab: vi.fn(async () => ({ ok: true as const })),
        stop,
        pause: stop,
        resume: vi.fn(async () => ({ ok: true as const })),
        getState: vi.fn(async () => ({ revision: 0, tabs: [] })),
        onTabOp: vi.fn(() => () => undefined),
        onControl: vi.fn((handler: (state: BrowserTabControlState) => void) => {
          emitControl = handler;
          return () => undefined;
        }),
      },
    };
    const unregister = registerBrowserTabHost(api as never, { sessionId: () => null, hasTab: () => false, selectTab: vi.fn(), closeTab: vi.fn() });
    try {
      const onNavigate = vi.fn();
      const page = { ...surface("browser"), url: "https://a.example/" };
      render(
        <TooltipProvider>
          <SurfacePane chatOpen={false} onChatOpenChange={() => {}} chatRuntime={CHAT_RUNTIME} api={api as never} surface={page} paneId="main" frame={{}} onNavigate={onNavigate} />
        </TooltipProvider>,
      );
      const address = screen.getByTestId("web-panel-address");
      // The badge is only a mirror: navigation always asks main to revoke control.
      expect(screen.queryByTestId("agent-browser-control-badge")).toBeNull();
      fireEvent.change(address, { target: { value: "https://b.example/" } });
      await act(async () => { fireEvent.submit(address.closest("form")!); });
      expect(onNavigate).toHaveBeenLastCalledWith(page.tabId, "https://b.example/");
      expect(stop).toHaveBeenCalledWith(page.tabId);

      act(() => emitControl(browserControlFixture([page.tabId])));
      expect(screen.getByTestId("web-panel")).toContainElement(screen.getByTestId("agent-browser-control-badge"));
      fireEvent.click(screen.getByTestId("agent-browser-control-stop"));
      expect(stop).toHaveBeenLastCalledWith(page.tabId);

      stop.mockClear();
      fireEvent.change(address, { target: { value: "https://c.example/" } });
      await act(async () => { fireEvent.submit(address.closest("form")!); });
      expect(stop).toHaveBeenCalledWith(page.tabId);
      expect(stop.mock.invocationCallOrder[0]!).toBeLessThan(onNavigate.mock.invocationCallOrder.at(-1)!);
      expect(onNavigate).toHaveBeenLastCalledWith(page.tabId, "https://c.example/");
    } finally {
      unregister();
      __resetBrowserTabBridgeForTest();
    }
  });

  it("names a web pane by its page's title, else its host", () => {
    const none = { url: null, title: null, canGoBack: false, canGoForward: false };
    expect(webPanelTitle({ ...none, title: "Docs" }, "https://example.com/", "Browser 1")).toBe("Docs");
    expect(webPanelTitle({ ...none, url: "https://a.example.org/x" }, null, "Browser 1")).toBe("a.example.org");
    expect(webPanelTitle(none, "https://example.com/", "Browser 1")).toBe("example.com");
    expect(webPanelTitle(none, null, "Browser 1")).toBe("Browser 1");
  });
});
