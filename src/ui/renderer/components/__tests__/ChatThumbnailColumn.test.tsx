// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRef, useEffect } from "react";
import { TooltipProvider } from "../../../../components/ui/tooltip.js";
import type { BrowserWorkspaceApi, BrowserWorkspaceState } from "../../../../shared/browser-workspace.js";
import type { BrowserTabControlState } from "../../../../shared/browser-surface.js";
import type { AveApi } from "../../types.js";
import { OverlayContextProvider, type OverlayContextValue, type OverlayItem } from "../../context/OverlayContext.js";
import { useWorkspaceTabs } from "../../preview/workspace-tabs.js";
import { noteWebSurfaceFavicon } from "../../preview/web-surfaces.js";
import { triggerIntersection } from "../../../../../test/renderer/setup.js";
import { ChatThumbnailColumn } from "../chat-thumbnail-column.js";
import { OverlayCardRegion } from "../OverlayCardRegion.js";

vi.mock("../../../../i18n/react.js", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const TAB = { tabId: "browser:one", documentGeneration: 4, url: "https://site.example/", title: "Session site", zoomFactor: 1 };
const STATE: BrowserWorkspaceState = { revision: 1, bookmarks: [], history: [], sitePermissions: [], downloads: [], tabs: [TAB], storageStatus: "ready", capabilities: { fullscreen: false } };
const CONTROL: BrowserTabControlState = { revision: 1, tabs: [{ tabId: "handle:one", rendererTabId: TAB.tabId, url: TAB.url, title: TAB.title, owner: { sessionId: "session" }, lease: null, generation: 1, kind: "embedded", openerTabId: null, mode: "human-paused" }] };

function setup() {
  const browserWorkspace = {
    getState: vi.fn(async () => ({ ok: true, value: STATE })), onChanged: vi.fn(() => () => {}),
    preview: vi.fn(async () => ({ ok: true, value: { tabId: TAB.tabId, documentGeneration: 4, dataUrl: "data:image/jpeg;base64,YQ==", width: 100, height: 50 } })),
  } as unknown as BrowserWorkspaceApi;
  const api = { browserWorkspace, browserTabs: { getState: vi.fn(async () => CONTROL), onControl: vi.fn(() => () => {}) }, acknowledgeRoutineResult: vi.fn(async () => ({ ok: true })) } as unknown as AveApi;
  const onOpenTab = vi.fn();
  const onCloseTab = vi.fn();
  const onOpenSession = vi.fn(async () => true);
  const addFireRef = createRef<OverlayContextValue["addFire"]>();
  function Harness({ visible = true, sessionId = "session", lane = false, resultColumn = false }: { visible?: boolean; sessionId?: string; lane?: boolean; resultColumn?: boolean }) {
    const tabs = useWorkspaceTabs();
    useEffect(() => { tabs.adoptTab({ id: TAB.tabId, kind: "browser", ordinal: 0 }, TAB.url); }, [tabs.adoptTab]);
    return <TooltipProvider><OverlayContextProvider onOpenSession={onOpenSession} addFireRef={addFireRef}>
      <ChatThumbnailColumn api={api} sessionId={sessionId} workspaceTabs={tabs} visible={visible} onOpenTab={onOpenTab} onCloseTab={onCloseTab} />
      {resultColumn && <ChatThumbnailColumn api={api} sessionId="routine-result" workspaceTabs={tabs} visible={visible} onOpenTab={onOpenTab} onCloseTab={onCloseTab} />}
      {lane && <OverlayCardRegion chatGroupId="main" actionChatGroupId="main" overlayCardTile={() => ({ chatGroupId: "main", orphaned: false })} onPluginPrimaryAction={() => {}} />}
    </OverlayContextProvider></TooltipProvider>;
  }
  return { Harness, api, browserWorkspace, onOpenTab, onCloseTab, onOpenSession, addFireRef };
}

function routine(id: string, session: string, routineSessionId?: string): OverlayItem {
  return { id, source: { kind: "routine", routineId: id, firedAt: "2026-10-22T00:00:00Z" }, title: id, summary: `${id} summary`,
    running: false, originSessionId: session, routineSessionId, createdAt: "2026-10-22T00:00:00Z" };
}

afterEach(() => { noteWebSurfaceFavicon(TAB.tabId, null); vi.useRealTimers(); });

describe("chat thumbnail column", () => {
  it("renders the bound browser card, highlights the active tab and wires open and close separately", async () => {
    const { Harness, onOpenTab, onCloseTab } = setup();
    render(<Harness />);
    await act(async () => { await Promise.resolve(); });
    const card = document.querySelector(`[data-tab-id="${TAB.tabId}"]`)!;
    expect(card).toHaveAttribute("data-active", "true");
    fireEvent.click(within(card as HTMLElement).getByRole("button", { name: TAB.title }));
    expect(onOpenTab).toHaveBeenCalledExactlyOnceWith(TAB.tabId);
    fireEvent.click(screen.getByRole("button", { name: "chatPreviewRail.closeTab" }));
    expect(onCloseTab).toHaveBeenCalledExactlyOnceWith(TAB.tabId);
    expect(onOpenTab).toHaveBeenCalledTimes(1);
    expect(document.querySelector("webview")).toBeNull();
  });
  it("uses existing preview capture while intersecting and stops capture when the column is hidden", async () => {
    const { Harness, browserWorkspace } = setup();
    const { rerender } = render(<Harness />);
    await act(async () => { await Promise.resolve(); });
    vi.useFakeTimers();
    act(() => { triggerIntersection(document.querySelector(`[data-tab-id="${TAB.tabId}"]`)!); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(browserWorkspace.preview).toHaveBeenCalledWith({ tabId: TAB.tabId, documentGeneration: 4 });
    expect(document.querySelector(`img[src="data:image/jpeg;base64,YQ=="]`)).toBeTruthy();
    rerender(<Harness visible={false} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(browserWorkspace.preview).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("chat-thumbnail-content")).toBeNull();
  });
  it.each(["http:", "https:"])("uses the Globe for a remote %s favicon, including after reopening", async (scheme) => {
    const { Harness } = setup();
    const { rerender } = render(<Harness />);
    await act(async () => { await Promise.resolve(); });
    act(() => noteWebSurfaceFavicon(TAB.tabId, `${scheme}//site.example/icon.png`));
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('.lucide-globe')).toBeTruthy();
    rerender(<Harness visible={false} />);
    rerender(<Harness />);
    await act(async () => { await Promise.resolve(); });
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('.lucide-globe')).toBeTruthy();
  });
  it("renders a data favicon and swaps a failed image to the Globe", async () => {
    const { Harness } = setup();
    render(<Harness />);
    await act(async () => { await Promise.resolve(); });
    act(() => noteWebSurfaceFavicon(TAB.tabId, "data:image/png;base64,YQ=="));
    const image = document.querySelector('img')!;
    expect(image.getAttribute("src")).toBe("data:image/png;base64,YQ==");
    fireEvent.error(image);
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('.lucide-globe')).toBeTruthy();
    act(() => noteWebSurfaceFavicon(TAB.tabId, "data:image/png;base64,Yg=="));
    expect(document.querySelector('img')?.getAttribute("src")).toBe("data:image/png;base64,Yg==");
  });
  it("draws a routine once across the origin column, result column and floating lane, returning it to the lane when hidden", () => {
    const { Harness, addFireRef } = setup();
    const { rerender } = render(<Harness lane resultColumn />);
    act(() => { addFireRef.current!(routine("one routine", "session", "routine-result")); });
    expect(screen.getAllByTestId("routine-card")).toHaveLength(1);
    expect(screen.getByTestId("routine-card").closest('[data-testid="chat-thumbnail-content"]')).toBeTruthy();
    rerender(<Harness lane resultColumn visible={false} />);
    expect(screen.getAllByTestId("routine-card")).toHaveLength(1);
    expect(screen.getByTestId("routine-card").closest('[data-testid="overlay-card-region"]')).toBeTruthy();
    rerender(<Harness lane resultColumn />);
    expect(screen.getAllByTestId("routine-card")).toHaveLength(1);
    expect(screen.getByTestId("routine-card").closest('[data-testid="chat-thumbnail-content"]')).toBeTruthy();
  });
  it("renders only this session's routine cards and preserves existing result and dismiss actions", async () => {
    const { Harness, api, addFireRef, onOpenSession } = setup();
    render(<Harness />);
    act(() => {
      addFireRef.current!(routine("own routine", "session", "routine-result"));
      addFireRef.current!(routine("result routine", "suggestions", "session"));
      addFireRef.current!(routine("other routine", "other"));
    });
    expect(screen.getAllByTestId("routine-card")).toHaveLength(2);
    expect(screen.queryByText("other routine")).toBeNull();
    const own = screen.getByText("own routine").closest('[data-testid="routine-card"]')!;
    fireEvent.click(within(own as HTMLElement).getByTestId("overlay-card-primary-action"));
    await act(async () => { await Promise.resolve(); });
    expect(onOpenSession).toHaveBeenCalledWith("routine-result");
    expect(api.acknowledgeRoutineResult).toHaveBeenCalledWith("own routine", "2026-10-22T00:00:00Z");
    expect(screen.queryByText("own routine")).toBeNull();
    const remaining = screen.getByTestId("routine-card");
    fireEvent.click(within(remaining).getByRole("button", { name: "overlayCard.closeAriaLabel" }));
    expect(api.acknowledgeRoutineResult).toHaveBeenCalledWith("result routine", "2026-10-22T00:00:00Z");
    expect(screen.queryByTestId("routine-card")).toBeNull();
  });
  it("retains a routine card when its result cannot be opened", async () => {
    const { Harness, api, addFireRef, onOpenSession } = setup();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    onOpenSession.mockRejectedValueOnce(new Error("Session unavailable"));
    render(<Harness />);
    act(() => { addFireRef.current!(routine("pending routine", "session", "routine-result")); });
    fireEvent.click(screen.getByTestId("overlay-card-primary-action"));
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByTestId("routine-card")).toBeTruthy();
    expect(api.acknowledgeRoutineResult).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalled();
    warning.mockRestore();
  });
  it("dismisses a running routine without acknowledging an unfinished result", () => {
    const { Harness, api, addFireRef } = setup();
    render(<Harness />);
    act(() => { addFireRef.current!({ ...routine("running routine", "session"), running: true }); });
    fireEvent.click(screen.getByRole("button", { name: "overlayCard.closeAriaLabel" }));
    expect(screen.queryByTestId("routine-card")).toBeNull();
    expect(api.acknowledgeRoutineResult).not.toHaveBeenCalled();
  });
});
