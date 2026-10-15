// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AveApi } from "../../types.js";
import type { BrowserTabControlState } from "../../../../shared/browser-surface.js";
import { TooltipProvider } from "../../../../components/ui/tooltip.js";
import { ApprovalSurfaceProvider } from "../../hooks/use-approval.js";
import { approvalSurfaceStub, emptyToolActivity } from "../../../../../test/renderer/helpers.js";
import { SIDE_PANEL_MIN_WIDTH } from "../../../../shared/side-panel.js";
import { ChatSidePanel } from "../ChatSidePanel.js";
import { useWorkspaceTabs, type WorkspaceTabsStore } from "../../preview/workspace-tabs.js";
import { __resetBrowserTabBridgeForTest, registerBrowserTabHost } from "../../preview/agent-browser-bridge.js";

/**
 * The side panel's half of the agent browser: page tabs stay mounted when
 * hidden, the agent's tabs carry the control badge with a working stop, and
 * the panel reports the tab the user is looking at.
 */
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
      </ApprovalSurfaceProvider>
    </TooltipProvider>
  );
}

afterEach(() => {
  store = null;
  __resetBrowserTabBridgeForTest();
});

describe("ChatSidePanel agent browser", () => {
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
      agentTabId = store!.openAgentBrowserTab("https://a.example/", "browser-op-1");
    });
    act(() => {
      store!.openPinned({ source: "browser", url: "https://b.example/" });
    });
    expect(agentTabId).not.toBeNull();

    // Both page tabs are mounted; only the active one is shown.
    const hosts = screen.getAllByTestId("chat-side-panel-browser-tab-host");
    expect(hosts.map((host) => host.getAttribute("data-tab-id"))).toEqual([agentTabId, expect.any(String)]);
    expect(hosts[0]).toHaveAttribute("aria-hidden", "true");
    expect(hosts[1]).not.toHaveAttribute("aria-hidden");
    expect(screen.getAllByTestId("chat-side-panel-browser-webview")).toHaveLength(2);

    act(() => emitControl({ agentControlledTabIds: [agentTabId!] }));
    const badge = screen.getByTestId("agent-browser-control-badge");
    expect(hosts[0]).toContainElement(badge);
    fireEvent.click(screen.getByTestId("agent-browser-control-stop"));
    expect(api.browserTabs!.stop).toHaveBeenCalledWith(agentTabId);
    unregister();
  });

  it("reports the active browser tab as the window's active surface", async () => {
    const { api } = makeApi();
    render(<Harness api={api} />);
    let tabId: string | null = null;
    act(() => {
      tabId = store!.openAgentBrowserTab("https://a.example/", "browser-op-2");
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
      tabId = store!.openAgentBrowserTab("https://a.example/", "browser-op-3");
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
      tabId = store!.openAgentBrowserTab("javascript:alert(1)", "browser-op-3");
    });
    expect(tabId).toBeNull();
    expect(screen.queryAllByTestId("chat-side-panel-browser-tab-host")).toHaveLength(0);
  });
});
