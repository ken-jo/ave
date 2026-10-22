// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserWorkspacePanel } from "../BrowserWorkspacePanel.js";
import type { BrowserPreview, BrowserWorkspaceApi, BrowserWorkspaceResult, BrowserWorkspaceState } from "../../../../shared/browser-workspace.js";
import type { BrowserTabControlState } from "../../../../shared/browser-surface.js";

vi.mock("../../../../i18n/react.js", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const STATE: BrowserWorkspaceState = { revision: 1, bookmarks: [{ url: "https://saved.example/", title: "Saved site", at: 1 }], history: [], sitePermissions: [], downloads: [], tabs: [{ tabId: "browser:one", documentGeneration: 4, url: "https://site.example/", title: "Current site", zoomFactor: 1 }], storageStatus: "ready", capabilities: { fullscreen: false } };
function setup() {
  let stateChanged!: (state: BrowserWorkspaceState) => void;
  let controlChanged!: (state: BrowserTabControlState) => void;
  const unsubscribe = vi.fn();
  const api = { getState: vi.fn(async () => ({ ok: true, value: STATE })), onChanged: vi.fn((handler: (state: BrowserWorkspaceState) => void) => { stateChanged = handler; return unsubscribe; }), setBookmark: vi.fn(async () => ({ ok: true, value: STATE })), clearHistory: vi.fn(async () => ({ ok: true, value: STATE })), setSitePermission: vi.fn(async () => ({ ok: true, value: STATE })), find: vi.fn(async () => ({ ok: true, value: { requestId: 1 } })), stopFind: vi.fn(async () => ({ ok: true, value: null })), zoom: vi.fn(async () => ({ ok: true, value: { factor: 1.5 } })), preview: vi.fn(async () => ({ ok: false, error: "capture-unavailable" })) } as unknown as BrowserWorkspaceApi;
  const control = { revision: 1, tabs: [] } as BrowserTabControlState;
  const browserTabs = { getState: vi.fn(async () => control), onControl: vi.fn((handler: (state: BrowserTabControlState) => void) => { controlChanged = handler; return unsubscribe; }) };
  const onOpenUrl = vi.fn();
  const props = { api, browserTabs, activeTabId: "browser:one", visible: true, onOpenUrl };
  return { props, api, browserTabs, unsubscribe, onOpenUrl, stateChanged: (state: BrowserWorkspaceState) => stateChanged(state), controlChanged: (state: BrowserTabControlState) => controlChanged(state) };
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });
function intersection() {
  const observers: { callback: IntersectionObserverCallback; element: Element | null }[] = [];
  vi.stubGlobal("IntersectionObserver", class {
    private readonly entry: typeof observers[number];
    constructor(callback: IntersectionObserverCallback) { this.entry = { callback, element: null }; observers.push(this.entry); }
    observe(element: Element) { this.entry.element = element; }
    disconnect() { this.entry.element = null; }
  });
  return (intersecting: boolean) => { for (const observer of observers) if (observer.element) observer.callback([{ target: observer.element, isIntersecting: intersecting, intersectionRatio: intersecting ? 1 : 0 } as IntersectionObserverEntry], {} as IntersectionObserver); };
}

describe("browser workspace panel", () => {
  it("uses document proof for native find and zoom and opens a bookmark only after an explicit click", async () => {
    intersection();
    const { props, api, onOpenUrl } = setup();
    render(<BrowserWorkspacePanel {...props} />);
    await act(async () => { await Promise.resolve(); });
    fireEvent.change(screen.getByLabelText("browserWorkspace.find"), { target: { value: "needle" } });
    fireEvent.click(screen.getByRole("button", { name: "browserWorkspace.find" }));
    expect(api.find).toHaveBeenNthCalledWith(1, { tabId: "browser:one", documentGeneration: 4, text: "needle", forward: true, findNext: true });
    fireEvent.click(screen.getByRole("button", { name: "browserWorkspace.previous" }));
    expect(api.find).toHaveBeenNthCalledWith(2, { tabId: "browser:one", documentGeneration: 4, text: "needle", forward: false, findNext: false });
    fireEvent.click(screen.getByRole("button", { name: "browserWorkspace.next" }));
    expect(api.find).toHaveBeenNthCalledWith(3, { tabId: "browser:one", documentGeneration: 4, text: "needle", forward: true, findNext: false });
    fireEvent.change(screen.getByLabelText("browserWorkspace.zoom"), { target: { value: "1.5" } });
    expect(api.zoom).toHaveBeenCalledWith({ tabId: "browser:one", documentGeneration: 4, factor: 1.5 });
    fireEvent.click(screen.getByRole("button", { name: "browserWorkspace.library" }));
    expect(screen.getByLabelText("browserWorkspace.permission.fullscreen")).toHaveProperty("disabled", true);
    expect(screen.getByText("browserWorkspace.fullscreenUnavailable")).toBeTruthy();
    expect(onOpenUrl).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Saved site" }));
    expect(onOpenUrl).toHaveBeenCalledWith("https://saved.example/");
    expect(document.querySelector("webview")).toBeNull();
  });
  it("subscribes before initial fetch, ignores old snapshots, and removes listeners on unmount", async () => {
    intersection();
    const { props, api, stateChanged, unsubscribe } = setup();
    const { unmount } = render(<BrowserWorkspacePanel {...props} />);
    expect(vi.mocked(api.onChanged).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(api.getState).mock.invocationCallOrder[0]!);
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(screen.getByRole("button", { name: "browserWorkspace.library" }));
    act(() => stateChanged({ ...STATE, revision: 4, bookmarks: [{ url: "https://new.example/", title: "New site", at: 1 }] }));
    act(() => stateChanged({ ...STATE, revision: 2 }));
    expect(screen.getByRole("button", { name: "New site" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Saved site" })).toBeNull();
    unmount(); expect(unsubscribe).toHaveBeenCalledTimes(2);
  });
  it("captures only intersecting connected cards while shown and stops after hide", async () => {
    const intersect = intersection();
    const { props, api } = setup();
    const { rerender } = render(<BrowserWorkspacePanel {...props} />);
    await act(async () => { await Promise.resolve(); });
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "browserWorkspace.library" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(api.preview).not.toHaveBeenCalled();
    act(() => intersect(true));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(api.preview).toHaveBeenCalledTimes(1);
    rerender(<BrowserWorkspacePanel {...props} visible={false} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(api.preview).toHaveBeenCalledTimes(1);
  });
  it("requests fresh bytes after closing a panel whose preview completes late and reopening within ten seconds", async () => {
    const intersect = intersection();
    const { props, api } = setup();
    let finish!: (result: BrowserWorkspaceResult<BrowserPreview>) => void;
    vi.mocked(api.preview).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const fresh: BrowserPreview = { tabId: "browser:one", documentGeneration: 4, dataUrl: "data:image/jpeg;base64,Yg==", width: 100, height: 50 };
    vi.mocked(api.preview).mockResolvedValue({ ok: true, value: fresh });
    render(<BrowserWorkspacePanel {...props} />);
    await act(async () => { await Promise.resolve(); });
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "browserWorkspace.library" }));
    act(() => intersect(true));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(api.preview).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "browserWorkspace.library" }));
    await act(async () => { finish({ ok: true, value: { ...fresh, dataUrl: "data:image/jpeg;base64,YQ==" } }); await vi.advanceTimersByTimeAsync(1600); });
    fireEvent.click(screen.getByRole("button", { name: "browserWorkspace.library" }));
    act(() => intersect(true));
    expect(document.querySelector("img")).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(api.preview).toHaveBeenCalledTimes(2);
    expect(document.querySelector("img")?.getAttribute("src")).toBe(fresh.dataUrl);
  });
  it("starts a search from Previous before Find is pressed and explicitly restarts on form submit or clear", async () => {
    intersection();
    const { props, api } = setup();
    render(<BrowserWorkspacePanel {...props} />);
    await act(async () => { await Promise.resolve(); });
    fireEvent.change(screen.getByLabelText("browserWorkspace.find"), { target: { value: "needle" } });
    fireEvent.click(screen.getByRole("button", { name: "browserWorkspace.previous" }));
    expect(api.find).toHaveBeenNthCalledWith(1, { tabId: "browser:one", documentGeneration: 4, text: "needle", forward: false, findNext: true });
    fireEvent.click(screen.getByRole("button", { name: "browserWorkspace.next" }));
    expect(api.find).toHaveBeenNthCalledWith(2, expect.objectContaining({ forward: true, findNext: false }));
    fireEvent.click(screen.getByRole("button", { name: "browserWorkspace.find" }));
    expect(api.find).toHaveBeenNthCalledWith(3, expect.objectContaining({ findNext: true }));
    fireEvent.click(screen.getByRole("button", { name: "browserWorkspace.stopFind" }));
    fireEvent.change(screen.getByLabelText("browserWorkspace.find"), { target: { value: "needle" } });
    fireEvent.click(screen.getByRole("button", { name: "browserWorkspace.previous" }));
    expect(api.find).toHaveBeenNthCalledWith(4, expect.objectContaining({ findNext: true }));
  });
  it("starts a new session for a changed query before continuing within that query", async () => {
    intersection();
    const { props, api } = setup();
    render(<BrowserWorkspacePanel {...props} />);
    await act(async () => { await Promise.resolve(); });
    fireEvent.change(screen.getByLabelText("browserWorkspace.find"), { target: { value: "first" } });
    fireEvent.click(screen.getByRole("button", { name: "browserWorkspace.next" }));
    expect(api.find).toHaveBeenNthCalledWith(1, expect.objectContaining({ text: "first", findNext: true }));
    fireEvent.change(screen.getByLabelText("browserWorkspace.find"), { target: { value: "second" } });
    fireEvent.click(screen.getByRole("button", { name: "browserWorkspace.previous" }));
    expect(api.find).toHaveBeenNthCalledWith(2, expect.objectContaining({ text: "second", findNext: true }));
    fireEvent.click(screen.getByRole("button", { name: "browserWorkspace.next" }));
    expect(api.find).toHaveBeenNthCalledWith(3, expect.objectContaining({ text: "second", findNext: false }));
  });
  it("starts a new session after the document or active tab changes", async () => {
    intersection();
    const { props, api, stateChanged } = setup();
    const { rerender } = render(<BrowserWorkspacePanel {...props} />);
    await act(async () => { await Promise.resolve(); });
    fireEvent.change(screen.getByLabelText("browserWorkspace.find"), { target: { value: "needle" } });
    fireEvent.click(screen.getByRole("button", { name: "browserWorkspace.find" }));
    const changed = { ...STATE.tabs[0]!, documentGeneration: 5 };
    act(() => stateChanged({ ...STATE, revision: 2, tabs: [changed] }));
    fireEvent.click(screen.getByRole("button", { name: "browserWorkspace.next" }));
    expect(api.find).toHaveBeenNthCalledWith(2, { tabId: "browser:one", documentGeneration: 5, text: "needle", forward: true, findNext: true });
    fireEvent.click(screen.getByRole("button", { name: "browserWorkspace.previous" }));
    expect(api.find).toHaveBeenNthCalledWith(3, expect.objectContaining({ documentGeneration: 5, findNext: false }));
    act(() => stateChanged({ ...STATE, revision: 3, tabs: [{ ...changed, tabId: "browser:two" }] }));
    rerender(<BrowserWorkspacePanel {...props} activeTabId="browser:two" />);
    fireEvent.click(screen.getByRole("button", { name: "browserWorkspace.previous" }));
    expect(api.find).toHaveBeenNthCalledWith(4, { tabId: "browser:two", documentGeneration: 5, text: "needle", forward: false, findNext: true });
  });
  it("restarts after a typed failure or rejected current request", async () => {
    intersection();
    const { props, api } = setup();
    render(<BrowserWorkspacePanel {...props} />);
    await act(async () => { await Promise.resolve(); });
    fireEvent.change(screen.getByLabelText("browserWorkspace.find"), { target: { value: "needle" } });
    vi.mocked(api.find).mockResolvedValueOnce({ ok: false, error: "stale-document" });
    fireEvent.click(screen.getByRole("button", { name: "browserWorkspace.previous" }));
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(screen.getByRole("button", { name: "browserWorkspace.previous" }));
    expect(api.find).toHaveBeenNthCalledWith(2, expect.objectContaining({ findNext: true }));
    await act(async () => { await Promise.resolve(); });
    vi.mocked(api.find).mockRejectedValueOnce(new Error("Find request failed"));
    fireEvent.click(screen.getByRole("button", { name: "browserWorkspace.previous" }));
    expect(api.find).toHaveBeenNthCalledWith(3, expect.objectContaining({ findNext: false }));
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(screen.getByRole("button", { name: "browserWorkspace.previous" }));
    expect(api.find).toHaveBeenNthCalledWith(4, expect.objectContaining({ findNext: true }));
  });
  it("does not let a late failed request clear a newer search with the same identity", async () => {
    intersection();
    const { props, api } = setup();
    let finish!: (result: BrowserWorkspaceResult<{ readonly requestId: number }>) => void;
    vi.mocked(api.find).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    render(<BrowserWorkspacePanel {...props} />);
    await act(async () => { await Promise.resolve(); });
    fireEvent.change(screen.getByLabelText("browserWorkspace.find"), { target: { value: "needle" } });
    fireEvent.click(screen.getByRole("button", { name: "browserWorkspace.find" }));
    fireEvent.click(screen.getByRole("button", { name: "browserWorkspace.next" }));
    await act(async () => { finish({ ok: false, error: "operation-failed" }); await Promise.resolve(); });
    fireEvent.click(screen.getByRole("button", { name: "browserWorkspace.previous" }));
    expect(api.find).toHaveBeenNthCalledWith(3, expect.objectContaining({ text: "needle", findNext: false }));
  });
});
