// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AveApi } from "../../types.js";
import type { BrowserTabControlState } from "../../../../shared/browser-surface.js";
import { browserControlFixture } from "../../../../__tests__/support/browser-control-fixture.js";
import { TooltipProvider } from "../../../../components/ui/tooltip.js";
import { ApprovalSurfaceProvider } from "../../hooks/use-approval.js";
import { approvalSurfaceStub, emptyToolActivity } from "../../../../../test/renderer/helpers.js";
import { makeMockAveNamespace } from "../../../../../test/renderer/mock-ave-api.js";
import { SIDE_PANEL_MIN_WIDTH } from "../../../../shared/side-panel.js";
import { ChatSidePanel } from "../ChatSidePanel.js";
import { UrlDocumentViewer } from "../ChatSidePanelPreview.js";
import { WebSurfaceLayer } from "../WebSurfaceLayer.js";
import { nativeSurfaceFixture } from "../../../../__tests__/support/native-browser-surface.js";
import { committedWebSurfaceLocation, setNativeBrowserTabIds } from "../../preview/web-surfaces.js";
import { clearActiveSurface, useReportActiveSurface } from "../../preview/active-surface.js";

/** The window's active-surface report to main, mounted once as App mounts it. */
function ActiveSurfaceReport({ api }: { api: AveApi }) {
  useReportActiveSurface(api);
  return null;
}
import { useWorkspaceTabs, type WorkspaceTabsStore } from "../../preview/workspace-tabs.js";
import { __resetBrowserTabBridgeForTest, registerBrowserTabHost } from "../../preview/agent-browser-bridge.js";

/** Keep hidden page guests alive in WebSurfaceLayer and let main own agent-control status and navigation records. */
function makeApi() {
  const native = nativeSurfaceFixture();
  let controlHandler: ((state: BrowserTabControlState) => void) | null = null;
  const api = {
    openExternalUrl: vi.fn(async () => ({ ok: true })),
    getSettings: vi.fn(async () => ({}) as never),
    updateSettings: vi.fn(async () => ({ ok: true }) as never),
    setActiveSurface: vi.fn(async () => ({ ok: true as const })),
    browserTabs: {
      ...native.api,
      bindTab: vi.fn(async () => ({ ok: true as const })),
      stop: vi.fn(async () => ({ ok: true as const })),
      pause: vi.fn(async () => ({ ok: true as const })),
      resume: vi.fn(async () => ({ ok: true as const })),
      getState: vi.fn(async () => ({ revision: 0, tabs: [] })),
      onTabOp: vi.fn(() => () => undefined),
      onControl: vi.fn((handler: (state: BrowserTabControlState) => void) => {
        controlHandler = handler;
        return () => {
          controlHandler = null;
        };
      }),
    },
  } as unknown as AveApi;
  return { api, native, emitControl: (state: BrowserTabControlState) => controlHandler?.(state) };
}

let store: WorkspaceTabsStore | null = null;
function openNativeAgentTab(url: string, requestId: string): string {
  if (!store) throw new Error("Workspace tabs are unavailable");
  const tabId = store.openAgentBrowserTab(url, requestId, true, "s1");
  if (!tabId) throw new Error("Agent page did not open");
  return tabId;
}

let previousWindowAve: unknown;
beforeEach(() => {
  setNativeBrowserTabIds([]);
  previousWindowAve = window.ave;
  (window as unknown as { ave: unknown }).ave = makeMockAveNamespace().ns;
});

// `session: null` is a new chat, which has no session yet.
function Harness({ api, session = "s1" }: { api: AveApi; session?: string | null }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const workspaceTabs = useWorkspaceTabs();
  store = workspaceTabs;
  return (
    <TooltipProvider>
      <ApprovalSurfaceProvider value={approvalSurfaceStub()}>
        <ChatSidePanel
          api={api}
          {...(session === null ? {} : { sessionId: session })}
          targets={[]}
          files={[]}
          selectedId={selectedId}
          onSelect={setSelectedId}
          workspaceTabs={workspaceTabs}
          subAgentSpawns={[]}
          width={SIDE_PANEL_MIN_WIDTH}
          onWidthChange={vi.fn()}
          onWidthCommit={vi.fn()}
          onClose={vi.fn()}
          activity={emptyToolActivity()}
        />
        <WebSurfaceLayer api={api} />
        <ActiveSurfaceReport api={api} />
      </ApprovalSurfaceProvider>
    </TooltipProvider>
  );
}

afterEach(() => {
  (window as unknown as { ave: unknown }).ave = previousWindowAve;
  store = null;
  clearActiveSurface();
  __resetBrowserTabBridgeForTest();
});

describe("ChatSidePanel agent browser", () => {
  it("lists an agent tab only in the chat that opened it, keeping its page mounted elsewhere", () => {
    const { api } = makeApi();
    const view = render(<Harness api={api} />);
    act(() => { store!.openAgentBrowserTab("https://a.example/", "browser-op-owned", true, "s1"); });
    expect(screen.getAllByTestId("chat-side-panel-tab")).toHaveLength(1);
    view.rerender(<Harness api={api} session={null} />);
    expect(screen.queryAllByTestId("chat-side-panel-tab")).toHaveLength(0);
    expect(screen.getByTestId("chat-side-panel-browser-tab-host")).toHaveAttribute("aria-hidden", "true");
    view.rerender(<Harness api={api} session="s1" />);
    expect(screen.getAllByTestId("chat-side-panel-tab")).toHaveLength(1);
    expect(screen.getByTestId("chat-side-panel-browser-tab-host")).not.toHaveAttribute("aria-hidden");
  });

  it("revokes control before side-panel address navigation without a badge report", async () => {
    const { api } = makeApi();
    render(<Harness api={api} />);
    act(() => store!.adoptTab({ id: "browser:restored", kind: "browser", ordinal: 1 }, "https://a.example/"));
    expect(screen.queryByTestId("agent-browser-control-badge")).toBeNull();
    const address = screen.getByTestId("chat-side-panel-browser-address");
    await act(async () => {
      fireEvent.change(address, { target: { value: "https://a.example/user-chosen" } });
      fireEvent.submit(address.closest("form")!);
    });
    expect(api.browserTabs!.stop).toHaveBeenCalledWith("browser:restored");
    expect(store!.browserUrlByTab["browser:restored"]).toBe("https://a.example/user-chosen");
    expect(screen.getByTestId("chat-side-panel-browser-webview")).toHaveAttribute("src", "https://a.example/user-chosen");
  });

  it("creates a request-bound blank native page and retains it after navigation and tab switches", async () => {
    const { api, native } = makeApi();
    render(<Harness api={api} />);
    let tabId = "";
    await act(async () => { tabId = openNativeAgentTab("about:blank", "browser-op-blank"); });
    const page = screen.getByTestId("chat-side-panel-browser-native");
    const viewer = screen.getByTestId("chat-side-panel-url-viewer");
    const openExternal = within(viewer).getByRole("button");
    expect(openExternal).toBeDisabled();
    expect(native.nativeSurface).toHaveBeenCalledWith({ action: "create", tabId, requestId: "browser-op-blank" });
    expect(native.nativeSurface.mock.calls.some(([r]) => r.action === "navigate")).toBe(false);
    act(() => {
      native.publish(tabId, { url: "https://a.example/approved" });
      store!.openPinned({ source: "browser", url: "https://b.example/" });
    });
    act(() => store!.setActiveTabId(tabId));
    expect(within(viewer).getByText("https://a.example/approved")).toBeInTheDocument();
    fireEvent.click(openExternal);
    expect(api.openExternalUrl).toHaveBeenCalledWith("https://a.example/approved");
    expect(screen.getByTestId("chat-side-panel-browser-native")).toBe(page);
    expect(store!.tabs.find((tab) => tab.id === tabId)?.content).toEqual({ source: "browser", url: "about:blank" });
  });

  it.each(["javascript:alert(1)", "data:text/html,<script>1</script>", "https://user:pass@a.example/", "a.example/no-scheme", "about:blank"])("disables external opening after an invalid committed native URL (%s)", async (url) => {
    const { api, native } = makeApi();
    render(<Harness api={api} />);
    let tabId = "";
    await act(async () => { tabId = openNativeAgentTab("about:blank", "browser-op-observed"); });
    const viewer = screen.getByTestId("chat-side-panel-url-viewer");
    const page = screen.getByTestId("chat-side-panel-browser-native");
    const openExternal = within(viewer).getByRole("button");
    act(() => { native.publish(tabId, { url: "https://a.example/committed" }); });
    expect(openExternal).toBeEnabled();
    act(() => { native.publish(tabId, { url }); });
    expect(openExternal).toBeDisabled();
    fireEvent.click(openExternal);
    expect(api.openExternalUrl).not.toHaveBeenCalled();
    expect(screen.getByTestId("chat-side-panel-browser-native")).toBe(page);
  });

  it("tracks only main-frame in-page URL changes without reloading a user guest", async () => {
    const { api } = makeApi();
    render(<Harness api={api} />);
    await act(async () => { store!.openPinned({ source: "browser", url: "https://a.example/bootstrap" }); });
    const viewer = screen.getByTestId("chat-side-panel-url-viewer");
    const webview = screen.getByTestId("chat-side-panel-browser-webview");
    act(() => webview.dispatchEvent(Object.assign(new Event("did-navigate"), { url: "https://a.example/page" })));
    act(() => webview.dispatchEvent(Object.assign(new Event("did-navigate-in-page"), { url: "https://a.example/page#section", isMainFrame: true })));
    const tabId = webview.dataset.tabId;
    if (!tabId) throw new Error("Page identity is missing");
    expect(committedWebSurfaceLocation(tabId)).toBe("https://a.example/page#section");
    act(() => webview.dispatchEvent(Object.assign(new Event("did-navigate-in-page"), { url: "https://frame.example/", isMainFrame: false })));
    expect(committedWebSurfaceLocation(tabId)).toBe("https://a.example/page#section");
    fireEvent.click(within(viewer).getByRole("button"));
    expect(api.openExternalUrl).toHaveBeenCalledWith("https://a.example/bootstrap");
    expect(webview).toHaveAttribute("src", "https://a.example/bootstrap");
  });

  it("discards a previously observed URL when a user guest reattaches", async () => {
    const { api } = makeApi();
    render(<Harness api={api} />);
    await act(async () => { store!.openPinned({ source: "browser", url: "https://a.example/bootstrap" }); });
    const viewer = screen.getByTestId("chat-side-panel-url-viewer");
    const webview = screen.getByTestId("chat-side-panel-browser-webview");
    const openExternal = within(viewer).getByRole("button");
    act(() => webview.dispatchEvent(Object.assign(new Event("did-navigate"), { url: "https://a.example/previous" })));
    expect(openExternal).toBeEnabled();
    act(() => webview.dispatchEvent(new Event("did-attach")));
    const tabId = webview.dataset.tabId;
    if (!tabId) throw new Error("Page identity is missing");
    expect(committedWebSurfaceLocation(tabId)).toBeNull();
    expect(openExternal).toBeEnabled();
    expect(within(viewer).getByText("https://a.example/bootstrap")).toBeInTheDocument();
  });

  it.each([
    { url: "about:blank", requestId: undefined },
    { url: "about:blank", requestId: "" },
    { url: "about:blank#fragment", requestId: "browser-op-blank" },
    { url: "javascript:alert(1)", requestId: "browser-op-blank" },
    { url: "data:text/html,<script>1</script>", requestId: "browser-op-blank" },
  ])("refuses an untrusted blank or executable URL at the viewer boundary (%j)", ({ url, requestId }) => {
    const { api } = makeApi();
    render(
      <TooltipProvider>
        <UrlDocumentViewer
          api={api}
          target={{ id: "blank", kind: "url", title: "Page", sourceLabel: "Address", createdOrder: 1, url, origin: "address" }}
          browserTab={{ tabId: "browser:blank", ...(requestId === undefined ? {} : { agentRequestId: requestId }) }}
        />
      </TooltipProvider>,
    );
    expect(screen.queryByTestId("chat-side-panel-browser-webview")).toBeNull();
  });

  it("keeps a hidden browser page tab mounted and badges only the agent's tab", async () => {
    const { api, emitControl } = makeApi();
    // The bridge subscribes to main's control events once a host registers.
    const unregister = registerBrowserTabHost(api, {
      sessionId: () => "s1",
      hasTab: () => false,
      openAgentTab: vi.fn(),
      selectTab: vi.fn(),
      closeTab: vi.fn(),
    });
    render(<Harness api={api} />);

    let agentTabId: string | null = null;
    act(() => {
      agentTabId = store!.openAgentBrowserTab("https://a.example/", "browser-op-1", true, "s1");
    });
    act(() => {
      store!.openPinned({ source: "browser", url: "https://b.example/" });
    });
    await act(async () => {});
    expect(agentTabId).not.toBeNull();

    const hosts = screen.getAllByTestId("chat-side-panel-browser-tab-host");
    expect(hosts.map((host) => host.getAttribute("data-tab-id"))).toEqual([agentTabId, expect.any(String)]);
    expect(hosts[0]).toHaveAttribute("aria-hidden", "true");
    expect(hosts[1]).not.toHaveAttribute("aria-hidden");
    expect(screen.getAllByTestId("chat-side-panel-browser-webview")).toHaveLength(1);
    expect(screen.getByTestId("chat-side-panel-browser-native")).toBeInTheDocument();

    act(() => emitControl(browserControlFixture([agentTabId!])));
    const badge = screen.getByTestId("agent-browser-control-badge");
    expect(hosts[0]).toContainElement(badge);
    const marks = screen.getAllByTestId("chat-side-panel-tab-agent-controlled");
    expect(marks).toHaveLength(1);
    expect(marks[0]!.closest("[data-tab-id]")).toHaveAttribute("data-tab-id", agentTabId);
    // Agent control is activity, not "needs your answer": neither mark takes the warning token.
    expect(marks[0]?.getAttribute("class")).toContain("text-muted-foreground");
    expect(marks[0]?.getAttribute("class")).not.toContain("text-warning");
    expect(badge.innerHTML).not.toContain("text-warning");
    fireEvent.click(screen.getByTestId("agent-browser-control-stop"));
    expect(api.browserTabs!.pause).toHaveBeenCalledWith(agentTabId);
    // A successful RPC alone does not alter control; only main's newer snapshot does.
    await act(async () => {});
    expect(screen.queryByTestId("agent-browser-control-resume")).toBeNull();
    act(() => emitControl(browserControlFixture([agentTabId!], "human-paused", 2)));
    expect(screen.queryByTestId("chat-side-panel-tab-agent-controlled")).toBeNull();
    fireEvent.click(screen.getByTestId("agent-browser-control-resume"));
    expect(api.browserTabs!.resume).toHaveBeenCalledWith(agentTabId);
    act(() => emitControl(browserControlFixture([agentTabId!], "agent-active", 1)));
    expect(screen.getByTestId("agent-browser-control-resume")).toBeInTheDocument();
    unregister();
  });

  it("reports the active browser tab as the window's active surface", async () => {
    const { api } = makeApi();
    render(<Harness api={api} />);
    let tabId: string | null = null;
    act(() => {
      tabId = store!.openAgentBrowserTab("https://a.example/", "browser-op-2", true, "s1");
    });
    await waitFor(() => expect(api.setActiveSurface).toHaveBeenLastCalledWith({ kind: "browser", tabId }));
  });

  it("constructs an agent page directly in the native host without a renderer guest bind", async () => {
    const { api, native } = makeApi();
    render(<Harness api={api} />);
    let tabId = "";
    await act(async () => { tabId = openNativeAgentTab("https://a.example/", "browser-op-3"); });
    expect(native.nativeSurface.mock.calls.filter(([r]) => r.action === "create")).toEqual([[{ action: "create", tabId, requestId: "browser-op-3" }]]);
    expect(api.browserTabs!.bindTab).not.toHaveBeenCalled();
    expect(screen.queryByTestId("chat-side-panel-browser-webview")).toBeNull();
    expect(native.nativeSurface.mock.calls.some(([r]) => r.action === "navigate")).toBe(false);
  });

  it("refuses an unsafe url for an agent tab", () => {
    const { api } = makeApi();
    render(<Harness api={api} />);
    let tabId: string | null = "unset";
    act(() => {
      tabId = store!.openAgentBrowserTab("javascript:alert(1)", "browser-op-3", true, "s1");
    });
    expect(tabId).toBeNull();
    expect(screen.queryAllByTestId("chat-side-panel-browser-tab-host")).toHaveLength(0);
  });
});
