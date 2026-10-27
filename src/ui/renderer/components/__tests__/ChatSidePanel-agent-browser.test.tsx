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
  let controlHandler: ((state: BrowserTabControlState) => void) | null = null;
  const api = {
    openExternalUrl: vi.fn(async () => ({ ok: true })),
    getSettings: vi.fn(async () => ({}) as never),
    updateSettings: vi.fn(async () => ({ ok: true }) as never),
    setActiveSurface: vi.fn(async () => ({ ok: true as const })),
    browserTabs: {
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
  return { api, emitControl: (state: BrowserTabControlState) => controlHandler?.(state) };
}

let store: WorkspaceTabsStore | null = null;
let previousWindowAve: unknown;
beforeEach(() => {
  previousWindowAve = window.ave;
  (window as unknown as { ave: unknown }).ave = makeMockAveNamespace().ns;
});

function Harness({ api }: { api: AveApi }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const workspaceTabs = useWorkspaceTabs();
  store = workspaceTabs;
  return (
    <TooltipProvider>
      <ApprovalSurfaceProvider value={approvalSurfaceStub()}>
        <ChatSidePanel
          api={api}
          sessionId="s1"
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

  it("binds a request-bound blank guest and keeps it mounted after navigation and tab switches", async () => {
    const { api } = makeApi();
    render(<Harness api={api} />);
    let tabId: string | null = null;
    act(() => {
      tabId = store!.openAgentBrowserTab("about:blank", "browser-op-blank", true);
    });
    expect(tabId).not.toBeNull();
    const webview = screen.getByTestId("chat-side-panel-browser-webview") as HTMLElement & { getWebContentsId?: () => number };
    expect(webview).toHaveAttribute("src", "about:blank");
    const viewer = screen.getByTestId("chat-side-panel-url-viewer");
    const openExternal = within(viewer).getByRole("button");
    expect(openExternal).toBeDisabled();
    webview.getWebContentsId = () => 42;
    act(() => webview.dispatchEvent(new Event("did-attach")));
    await waitFor(() => expect(api.browserTabs!.bindTab).toHaveBeenCalledWith({ tabId, webContentsId: 42, requestId: "browser-op-blank" }));
    act(() => {
      webview.dispatchEvent(Object.assign(new Event("did-navigate"), { url: "https://a.example/approved" }));
      store!.openPinned({ source: "browser", url: "https://b.example/" });
    });
    act(() => store!.setActiveTabId(tabId!));
    expect(within(viewer).getByText("https://a.example/approved")).toBeInTheDocument();
    expect(openExternal).toBeEnabled();
    fireEvent.click(openExternal);
    expect(api.openExternalUrl).toHaveBeenCalledWith("https://a.example/approved");
    expect(screen.getAllByTestId("chat-side-panel-browser-webview")[0]).toBe(webview);
    expect(webview).toHaveAttribute("src", "about:blank");
    expect(store!.tabs.find((tab) => tab.id === tabId)?.content).toEqual({ source: "browser", url: "about:blank" });
  });

  it.each(["javascript:alert(1)", "data:text/html,<script>1</script>", "https://user:pass@a.example/", "a.example/no-scheme", "about:blank"])("disables external opening after an invalid committed guest URL (%s)", (url) => {
    const { api } = makeApi();
    render(<Harness api={api} />);
    act(() => {
      store!.openAgentBrowserTab("about:blank", "browser-op-observed", true);
    });
    const viewer = screen.getByTestId("chat-side-panel-url-viewer");
    const webview = screen.getByTestId("chat-side-panel-browser-webview");
    const openExternal = within(viewer).getByRole("button");
    act(() => webview.dispatchEvent(Object.assign(new Event("did-navigate"), { url: "https://a.example/committed" })));
    expect(openExternal).toBeEnabled();
    act(() => webview.dispatchEvent(Object.assign(new Event("did-navigate"), { url })));
    expect(openExternal).toBeDisabled();
    fireEvent.click(openExternal);
    expect(api.openExternalUrl).not.toHaveBeenCalled();
    expect(screen.getByTestId("chat-side-panel-browser-webview")).toBe(webview);
    expect(webview).toHaveAttribute("src", "about:blank");
  });

  it("tracks only main-frame in-page URL changes without reloading the bootstrap guest", () => {
    const { api } = makeApi();
    render(<Harness api={api} />);
    act(() => store!.openAgentBrowserTab("about:blank", "browser-op-in-page", true));
    const viewer = screen.getByTestId("chat-side-panel-url-viewer");
    const webview = screen.getByTestId("chat-side-panel-browser-webview");
    act(() => webview.dispatchEvent(Object.assign(new Event("did-navigate"), { url: "https://a.example/page" })));
    act(() => webview.dispatchEvent(Object.assign(new Event("did-navigate-in-page"), { url: "https://a.example/page#section", isMainFrame: true })));
    expect(within(viewer).getByText("https://a.example/page#section")).toBeInTheDocument();
    act(() => webview.dispatchEvent(Object.assign(new Event("did-navigate-in-page"), { url: "https://frame.example/", isMainFrame: false })));
    expect(within(viewer).getByText("https://a.example/page#section")).toBeInTheDocument();
    fireEvent.click(within(viewer).getByRole("button"));
    expect(api.openExternalUrl).toHaveBeenCalledWith("https://a.example/page#section");
    expect(webview).toHaveAttribute("src", "about:blank");
  });

  it("discards a previously observed URL when the bootstrap guest reattaches", () => {
    const { api } = makeApi();
    render(<Harness api={api} />);
    act(() => store!.openAgentBrowserTab("about:blank", "browser-op-reattach", true));
    const viewer = screen.getByTestId("chat-side-panel-url-viewer");
    const webview = screen.getByTestId("chat-side-panel-browser-webview");
    const openExternal = within(viewer).getByRole("button");
    act(() => webview.dispatchEvent(Object.assign(new Event("did-navigate"), { url: "https://a.example/previous" })));
    expect(openExternal).toBeEnabled();
    act(() => webview.dispatchEvent(new Event("did-attach")));
    expect(openExternal).toBeDisabled();
    expect(within(viewer).getByText("about:blank")).toBeInTheDocument();
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
      agentTabId = store!.openAgentBrowserTab("https://a.example/", "browser-op-1", true);
    });
    act(() => {
      store!.openPinned({ source: "browser", url: "https://b.example/" });
    });
    expect(agentTabId).not.toBeNull();

    const hosts = screen.getAllByTestId("chat-side-panel-browser-tab-host");
    expect(hosts.map((host) => host.getAttribute("data-tab-id"))).toEqual([agentTabId, expect.any(String)]);
    expect(hosts[0]).toHaveAttribute("aria-hidden", "true");
    expect(hosts[1]).not.toHaveAttribute("aria-hidden");
    expect(screen.getAllByTestId("chat-side-panel-browser-webview")).toHaveLength(2);

    act(() => emitControl(browserControlFixture([agentTabId!])));
    const badge = screen.getByTestId("agent-browser-control-badge");
    expect(hosts[0]).toContainElement(badge);
    const marks = screen.getAllByTestId("chat-side-panel-tab-agent-controlled");
    expect(marks).toHaveLength(1);
    expect(marks[0]!.closest("[data-tab-id]")).toHaveAttribute("data-tab-id", agentTabId);
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
      tabId = store!.openAgentBrowserTab("https://a.example/", "browser-op-2", true);
    });
    await waitFor(() => expect(api.setActiveSurface).toHaveBeenLastCalledWith({ kind: "browser", tabId }));
  });

  it("binds an agent tab with its request id, retrying until main has seen the guest attach", async () => {
    const { api } = makeApi();
    const bindTab = api.browserTabs!.bindTab as ReturnType<typeof vi.fn>;
    bindTab
      .mockResolvedValueOnce({ ok: false, error: "guest-not-live" })
      .mockResolvedValueOnce({ ok: false, error: "guest-not-live" })
      .mockResolvedValue({ ok: true });
    render(<Harness api={api} />);
    let tabId: string | null = null;
    act(() => {
      tabId = store!.openAgentBrowserTab("https://a.example/", "browser-op-3", true);
    });
    const webview = screen.getByTestId("chat-side-panel-browser-webview") as HTMLElement & { getWebContentsId?: () => number };
    webview.getWebContentsId = () => 42;
    act(() => {
      webview.dispatchEvent(new Event("did-attach"));
    });
    await waitFor(() => expect(bindTab).toHaveBeenCalledTimes(3));
    expect(bindTab).toHaveBeenLastCalledWith({ tabId, webContentsId: 42, requestId: "browser-op-3" });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(bindTab).toHaveBeenCalledTimes(3);
  });

  it("refuses an unsafe url for an agent tab", () => {
    const { api } = makeApi();
    render(<Harness api={api} />);
    let tabId: string | null = "unset";
    act(() => {
      tabId = store!.openAgentBrowserTab("javascript:alert(1)", "browser-op-3", true);
    });
    expect(tabId).toBeNull();
    expect(screen.queryAllByTestId("chat-side-panel-browser-tab-host")).toHaveLength(0);
  });
});
