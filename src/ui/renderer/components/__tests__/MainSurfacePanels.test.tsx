// @vitest-environment jsdom
/**
 * Terminal and web panes in the main area: the store that owns their records
 * and the pane body each kind draws.
 */
import "../../../../../test/renderer/setup.js";
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "../../../../components/ui/tooltip.js";
import { SurfacePane, directoryName, webPanelTitle } from "../MainSurfacePanels.js";
import { WebSurfaceLayer } from "../WebSurfaceLayer.js";
import { useMainSurfaces, type MainSurface } from "../../preview/main-surfaces.js";
import { getWebSurfaces } from "../../preview/web-surfaces.js";
import { makeMockAveApi } from "../../../../../test/renderer/mock-ave-api.js";

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
    spawn: vi.fn(async () => ({ ok: true })),
    input: vi.fn(async () => undefined),
    resize: vi.fn(async () => undefined),
    onData: vi.fn(() => () => {}),
    onExit: vi.fn(() => () => {}),
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
    expect(terminal.tabId).toMatch(/^terminal:\d+$/);
    expect(page.tabId).toMatch(/^browser:\d+$/);
    expect(result.current.surfaces.map((each) => each.tabId)).toEqual([terminal.tabId, page.tabId]);

    // Released (moving to a side panel): gone from here, not remembered as closed.
    let released: MainSurface | undefined;
    act(() => { released = result.current.release(terminal.tabId); });
    expect(released).toEqual(terminal);
    act(() => { result.current.adopt(terminal); });
    expect(result.current.get(terminal.tabId)).toEqual(terminal);

    act(() => { result.current.close(page.tabId); });
    expect(result.current.surfaces.map((each) => each.tabId)).toEqual([terminal.tabId]);
    // A terminal remembers where its shell last was, for its replacement.
    act(() => { result.current.setCwd(terminal.tabId, "/work/repo"); });
    expect(result.current.get(terminal.tabId)?.cwd).toBe("/work/repo");
    act(() => { result.current.close(terminal.tabId); });
    expect(result.current.takeLastClosed()).toEqual({ kind: "terminal", url: null, cwd: "/work/repo" });
    expect(result.current.takeLastClosed()).toEqual({ kind: "browser", url: "https://example.com/", cwd: null });
    expect(result.current.takeLastClosed()).toBeUndefined();
    unmount();
  });

  it("keeps a main browser surface's guest alive while the store lists it", async () => {
    const { result, unmount } = renderHook(() => useMainSurfaces());
    let page!: MainSurface;
    act(() => { page = result.current.create("browser", "https://example.com/"); });
    render(
      <TooltipProvider>
        <SurfacePane api={makeMockAveApi().api as never} surface={page} paneId="main" frame={{}} onNavigate={() => {}} onCwd={() => {}} />
        <WebSurfaceLayer />
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

  it("draws a terminal pane on its tab's PTY, mounted at the pane", async () => {
    const { api } = makeMockAveApi();
    const terminal = terminalApi();
    render(
      <TooltipProvider>
        <SurfacePane api={{ ...api, terminal } as never} surface={surface("terminal")} paneId="group-2" frame={{}} onNavigate={() => {}} onCwd={() => {}} />
      </TooltipProvider>,
    );
    expect(screen.getByTestId("pane-header").textContent).toMatch(/ 2$/);
    await act(async () => { await Promise.resolve(); });
    expect(terminal.spawn).toHaveBeenCalledWith(expect.objectContaining({ tabId: "terminal:908" }));
  });

  it("draws an empty web pane until an address is entered, and validates the address", () => {
    const onNavigate = vi.fn();
    render(
      <TooltipProvider>
        <SurfacePane api={makeMockAveApi().api as never} surface={surface("browser")} paneId="main" frame={{}} onNavigate={onNavigate} onCwd={() => {}} />
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
    fireEvent.submit(address.closest("form")!);
    expect(onNavigate).toHaveBeenCalledWith("browser:907", "https://example.com/docs");
  });

  it("names a web pane by its page's title, else its host", () => {
    const none = { url: null, title: null, canGoBack: false, canGoForward: false };
    expect(webPanelTitle({ ...none, title: "Docs" }, "https://example.com/", "Browser 1")).toBe("Docs");
    expect(webPanelTitle({ ...none, url: "https://a.example.org/x" }, null, "Browser 1")).toBe("a.example.org");
    expect(webPanelTitle(none, "https://example.com/", "Browser 1")).toBe("example.com");
    expect(webPanelTitle(none, null, "Browser 1")).toBe("Browser 1");
  });
});
