// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserWorkspacePanel } from "../BrowserWorkspacePanel.js";
import type { BrowserFindResult, BrowserPreview, BrowserWorkspaceApi, BrowserWorkspaceResult, BrowserWorkspaceState } from "../../../../shared/browser-workspace.js";
import type { BrowserTabControlState } from "../../../../shared/browser-surface.js";

vi.mock("../../../../i18n/react.js", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const STATE: BrowserWorkspaceState = { revision: 1, bookmarks: [{ url: "https://saved.example/", title: "Saved site", at: 1 }], history: [], sitePermissions: [], downloads: [], tabs: [{ tabId: "browser:one", documentGeneration: 4, url: "https://site.example/", title: "Current site", zoomFactor: 1 }], pages: [], storageStatus: "ready", capabilities: { fullscreen: false } };
function setup() {
  let stateChanged!: (state: BrowserWorkspaceState) => void;
  let controlChanged!: (state: BrowserTabControlState) => void;
  const unsubscribe = vi.fn();
  let found: (result: BrowserFindResult) => void = () => undefined;
  const unsubscribeFind = vi.fn();
  const api = { onFindResult: vi.fn((handler: (result: BrowserFindResult) => void) => { found = handler; return unsubscribeFind; }), getState: vi.fn(async () => ({ ok: true, value: STATE })), onChanged: vi.fn((handler: (state: BrowserWorkspaceState) => void) => { stateChanged = handler; return unsubscribe; }), setBookmark: vi.fn(async () => ({ ok: true, value: STATE })), clearHistory: vi.fn(async () => ({ ok: true, value: STATE })), setSitePermission: vi.fn(async () => ({ ok: true, value: STATE })), find: vi.fn(async () => ({ ok: true, value: { requestId: 1 } })), stopFind: vi.fn(async () => ({ ok: true, value: null })), zoom: vi.fn(async () => ({ ok: true, value: { factor: 1.5 } })), preview: vi.fn(async () => ({ ok: false, error: "capture-unavailable" })), clearData: vi.fn(async () => ({ ok: true, value: STATE })), clearSiteData: vi.fn(async () => ({ ok: true, value: null })), showDownload: vi.fn(async () => ({ ok: true, value: null })), deleteHistory: vi.fn(async () => ({ ok: true, value: STATE })), cancelDownload: vi.fn(async () => ({ ok: true, value: null })) } as unknown as BrowserWorkspaceApi;
  const control = { revision: 1, tabs: [] } as BrowserTabControlState;
  const browserTabs = { getState: vi.fn(async () => control), onControl: vi.fn((handler: (state: BrowserTabControlState) => void) => { controlChanged = handler; return unsubscribe; }) };
  const onOpenUrl = vi.fn();
  const props = { api, browserTabs, activeTabId: "browser:one", visible: true, onOpenUrl };
  return { found: (result: BrowserFindResult) => found(result), unsubscribeFind, props, api, browserTabs, unsubscribe, onOpenUrl, stateChanged: (state: BrowserWorkspaceState) => stateChanged(state), controlChanged: (state: BrowserTabControlState) => controlChanged(state) };
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
    // Zoom lives in the address row and a site's permissions in its site information, not here.
    expect(screen.queryByLabelText("browserWorkspace.zoom")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "browserWorkspace.library" }));
    expect(screen.queryByLabelText("browserWorkspace.permission.camera")).toBeNull();
    // The library shows one section at a time, open tabs first.
    expect(screen.getByTestId("browser-library").getAttribute("data-section")).toBe("tabs");
    expect(screen.queryByRole("button", { name: "Saved site" })).toBeNull();
    fireEvent.click(screen.getByTestId("browser-library-bookmarks"));
    expect(screen.getByTestId("browser-library-bookmarks").getAttribute("aria-pressed")).toBe("true");
    expect(onOpenUrl).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Saved site" }));
    expect(onOpenUrl).toHaveBeenCalledWith("https://saved.example/");
    expect(document.querySelector("webview")).toBeNull();
  });
  it("subscribes before initial fetch, ignores old snapshots, and removes listeners on unmount", async () => {
    intersection();
    const { props, api, stateChanged, unsubscribe, unsubscribeFind } = setup();
    const { unmount } = render(<BrowserWorkspacePanel {...props} />);
    expect(vi.mocked(api.onChanged).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(api.getState).mock.invocationCallOrder[0]!);
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(screen.getByRole("button", { name: "browserWorkspace.library" }));
    fireEvent.click(screen.getByTestId("browser-library-bookmarks"));
    act(() => stateChanged({ ...STATE, revision: 4, bookmarks: [{ url: "https://new.example/", title: "New site", at: 1 }] }));
    act(() => stateChanged({ ...STATE, revision: 2 }));
    expect(screen.getByRole("button", { name: "New site" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Saved site" })).toBeNull();
    unmount(); expect(unsubscribe).toHaveBeenCalledTimes(2); expect(unsubscribeFind).toHaveBeenCalledTimes(1);
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

it("clears the chosen browsing data", async () => {
  intersection();
  const { props, api } = setup();
  render(<BrowserWorkspacePanel {...props} />);
  await act(async () => { await Promise.resolve(); });
  fireEvent.click(screen.getByText("browserWorkspace.library"));
  fireEvent.click(screen.getByTestId("browser-library-data"));
  // History is preselected; signing out of every site is something the user must choose.
  expect(screen.getByTestId("browser-clear-data-history")).toHaveProperty("checked", true);
  expect(screen.getByTestId("browser-clear-data-siteData")).toHaveProperty("checked", false);
  fireEvent.click(screen.getByTestId("browser-clear-data-siteData"));
  fireEvent.click(screen.getByTestId("browser-clear-data-history"));
  await act(async () => { fireEvent.click(screen.getByTestId("browser-clear-data-submit")); });
  expect(api.clearData).toHaveBeenCalledWith({ history: false, siteData: true, cache: false });
  expect(screen.getByTestId("browser-data-cleared")).toBeTruthy();
  fireEvent.click(screen.getByTestId("browser-clear-data-siteData"));
  expect(screen.getByTestId("browser-clear-data-submit")).toHaveProperty("disabled", true);
});

it("shows how many matches a find has and which is selected, only for the find that is current", async () => {
  const { props, api, found } = setup();
  vi.mocked(api.find).mockResolvedValueOnce({ ok: true, value: { requestId: 7 } }).mockResolvedValueOnce({ ok: true, value: { requestId: 8 } });
  render(<BrowserWorkspacePanel {...props} />);
  await act(async () => { await Promise.resolve(); });
  fireEvent.change(screen.getByTestId("browser-find-input"), { target: { value: "needle" } });
  expect(screen.queryByTestId("browser-find-count")).toBeNull();
  // The count can arrive before the request that started it returns: it is shown once both are known.
  act(() => found({ tabId: "browser:one", requestId: 7, matches: 5, activeMatch: 2 }));
  expect(screen.queryByTestId("browser-find-count")).toBeNull();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "browserWorkspace.find" })); });
  expect(screen.getByTestId("browser-find-count").textContent).toBe("browserWorkspace.findCount");
  expect(screen.getByTestId("browser-find-count").getAttribute("data-matches")).toBe("5");
  // The next find's count replaces it; an older find's or another tab's count is not shown as this one's.
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "browserWorkspace.next" })); });
  expect(screen.queryByTestId("browser-find-count")).toBeNull();
  act(() => found({ tabId: "browser:two", requestId: 8, matches: 3, activeMatch: 1 }));
  expect(screen.queryByTestId("browser-find-count")).toBeNull();
  act(() => found({ tabId: "browser:one", requestId: 8, matches: 0, activeMatch: 0 }));
  expect(screen.getByTestId("browser-find-count").textContent).toBe("browserWorkspace.findNone");
  fireEvent.change(screen.getByTestId("browser-find-input"), { target: { value: "other" } });
  expect(screen.queryByTestId("browser-find-count")).toBeNull();
});

it("lists the agent's visits apart from the user's, with a time, a search and a remove button per visit", async () => {
  intersection();
  const { props, api, stateChanged } = setup();
  render(<BrowserWorkspacePanel {...props} />);
  await act(async () => { await Promise.resolve(); });
  fireEvent.click(screen.getByText("browserWorkspace.library"));
  fireEvent.click(screen.getByTestId("browser-library-history"));
  expect(screen.queryByTestId("browser-history-agent")).toBeNull();
  act(() => stateChanged({ ...STATE, revision: 2, history: [
    { url: "https://docs.example/guide", title: "Guide", at: Date.UTC(2026, 10, 16, 9), by: "user" },
    { url: "https://shop.example/cart", title: "Cart", at: Date.UTC(2026, 10, 16, 10), by: "user" },
    { url: "https://docs.example/guide", title: "Guide", at: Date.UTC(2026, 10, 16, 11), by: "agent" },
  ] }));
  const user = screen.getByTestId("browser-history-user");
  expect(user.querySelectorAll('[data-testid="browser-history-row"]')).toHaveLength(2);
  expect(screen.getByTestId("browser-history-agent").querySelectorAll('[data-testid="browser-history-row"]')).toHaveLength(1);
  expect(user.querySelector("time")?.getAttribute("datetime")).toBe("2026-11-16T09:00:00.000Z");
  fireEvent.change(screen.getByTestId("browser-history-search"), { target: { value: "SHOP" } });
  expect(user.querySelectorAll('[data-testid="browser-history-row"]')).toHaveLength(1);
  expect(screen.getByTestId("browser-history-agent").textContent).toContain("browserWorkspace.historyNoMatch");
  await act(async () => { fireEvent.click(user.querySelector('[data-testid="browser-history-delete"]') as HTMLElement); });
  expect(api.deleteHistory).toHaveBeenCalledWith({ url: "https://shop.example/cart", by: "user" });
});
it("history shows the earliest and the latest time the saved state can hold", async () => {
  intersection();
  const { props, stateChanged } = setup();
  render(<BrowserWorkspacePanel {...props} />);
  await act(async () => { await Promise.resolve(); });
  fireEvent.click(screen.getByText("browserWorkspace.library"));
  fireEvent.click(screen.getByTestId("browser-library-history"));
  act(() => stateChanged({ ...STATE, revision: 2, history: [
    { url: "https://late.example/", title: "Late", at: 8.64e15, by: "user" },
    { url: "https://early.example/", title: "Early", at: 0, by: "user" },
  ] }));
  expect([...screen.getByTestId("browser-history-user").querySelectorAll("time")].map((time) => time.getAttribute("datetime")))
    .toEqual(["+275760-09-13T00:00:00.000Z", "1970-01-01T00:00:00.000Z"]);
});
it("names why a download was not saved when its chosen folder's volume cannot replace a file safely or could not be checked", async () => {
  intersection();
  const { props, stateChanged } = setup();
  render(<BrowserWorkspacePanel {...props} />);
  await act(async () => { await Promise.resolve(); });
  fireEvent.click(screen.getByText("browserWorkspace.library"));
  fireEvent.click(screen.getByTestId("browser-library-downloads"));
  act(() => stateChanged({ ...STATE, revision: 2, downloads: [
    { id: "download-1", name: "a.pdf", receivedBytes: 1, totalBytes: 1, state: "interrupted", at: 1, notice: "unsupported-volume" },
    { id: "download-2", name: "b.pdf", receivedBytes: 1, totalBytes: 1, state: "interrupted", at: 2, notice: "volume-unknown" },
    { id: "download-3", name: "c.pdf", receivedBytes: 1, totalBytes: 1, state: "interrupted", at: 3 },
  ] }));
  expect(screen.getAllByTestId("browser-download-notice").map((notice) => [notice.getAttribute("data-notice"), notice.textContent])).toEqual([
    ["unsupported-volume", "browserDownload.unsupportedVolume"],
    ["volume-unknown", "browserDownload.volumeUnknown"],
  ]);
});
