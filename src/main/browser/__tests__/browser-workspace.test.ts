import { refuseNamespaceFileCreation } from "../../../__tests__/support/feature-namespace.js";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DownloadItem, WebContents } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserWorkspaceService, type BrowserPageRequest, type BrowserPageRequestHold } from "../browser-workspace.js";
import { BrowserWorkspaceStore } from "../browser-workspace-store.js";
import type { FeatureNamespaceHandle } from "../../storage/feature-namespace.js";

const directories: string[] = [];
const services: BrowserWorkspaceService[] = [];
afterEach(async () => { for (const service of services.splice(0)) service.dispose(); await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "ave-browser-workspace-")); directories.push(dir);
  const namespace: FeatureNamespaceHandle = { dir, createFile: refuseNamespaceFileCreation, readJson: async (_name, fallback) => fallback, writeJson: async () => undefined, childDir: async () => dir };
  let generation = 1;
  let url = "https://site.example/";
  let factor = 1;
  let live = true;
  const events = new EventEmitter();
  const loadURL = vi.fn(async (_url: string) => {}); const reload = vi.fn(); const stop = vi.fn();
  const findInPage = vi.fn(() => 42); const stopFindInPage = vi.fn(); const setZoomFactor = vi.fn((next: number) => { factor = next; });
  const guest = Object.assign(events, { id: 7, session: {}, getURL: () => url, getTitle: () => "Site", isDestroyed: () => false, getZoomFactor: () => factor, setZoomFactor, findInPage, stopFindInPage, loadURL, reload, stop, isLoadingMainFrame: () => false }) as unknown as WebContents;
  const onError = vi.fn(); const promptPermission = vi.fn(async () => true);
  let requestHold: BrowserPageRequestHold | null = null;
  const holdPageRequests = vi.fn((hold: BrowserPageRequestHold | null) => { requestHold = hold; });
  /** A request reaching the browser profile: how the hold answered it, or "unheld" when nothing holds requests. */
  const pageRequest = (request: BrowserPageRequest) => requestHold === null ? Promise.resolve("unheld" as const) : new Promise<boolean>((resolve) => requestHold?.(request, resolve));
  const service = new BrowserWorkspaceService({ holdPageRequests, store: new BrowserWorkspaceStore(namespace), liveTab: (windowId, tabId) => live && windowId === 1 && tabId === "browser:one" ? { guest, documentGeneration: generation } : null, listTabs: (windowId) => live && windowId === 1 ? [{ tabId: "browser:one", documentGeneration: generation, url, title: "Site" }] : [], isWindowVisible: () => true, promptPermission, fullscreenAvailable: () => false, onError });
  services.push(service);
  return { service, guest, events, holdPageRequests, pageRequest, holding: () => requestHold !== null, promptPermission, loadURL, reload, stop, findInPage, stopFindInPage, setZoomFactor, onError, setGeneration: (next: number) => { generation = next; }, setUrl: (next: string) => { url = next; }, setLive: (next: boolean) => { live = next; } };
}
const TARGET = { tabId: "browser:one", documentGeneration: 1 };

describe("browser workspace service", () => {
  it("resolves only live renderer tabs in their window and proves the document before native operations", async () => {
    const { service, findInPage, stopFindInPage, setZoomFactor, setGeneration } = await setup();
    expect(service.find(1, { ...TARGET, text: "needle", forward: false, findNext: true })).toEqual({ requestId: 42 });
    expect(findInPage).toHaveBeenCalledWith("needle", { forward: false, findNext: true });
    service.stopFind(1, TARGET);
    expect(stopFindInPage).toHaveBeenCalledWith("clearSelection");
    expect(service.zoom(1, { ...TARGET, factor: 1.25 })).toEqual({ factor: 1.25 });
    expect(() => service.zoom(2, { ...TARGET, factor: 2 })).toThrow("no-such-tab");
    setGeneration(2);
    expect(() => service.find(1, { ...TARGET, text: "needle", forward: true, findNext: false })).toThrow("stale-document");
    expect(setZoomFactor).toHaveBeenCalledTimes(1);
  });
  it("publishes revisioned state with renderer document proof and window-local download metadata", async () => {
    const { service } = await setup();
    const first = await service.getState(1);
    expect(first.tabs[0]).toMatchObject({ ...TARGET, url: "https://site.example/", zoomFactor: 1 });
    const item = Object.assign(new EventEmitter(), { getFilename: () => "report.txt", getReceivedBytes: () => 50, getTotalBytes: () => 100, setSavePath: vi.fn(), getSavePath: vi.fn() });
    service.observeDownload(1, item as unknown as DownloadItem);
    item.emit("done", {}, "completed");
    const state = await service.getState(1);
    expect(state.revision).toBeGreaterThan(first.revision);
    expect(state.downloads[0]).toMatchObject({ name: "report.txt", state: "completed", receivedBytes: 50 });
    expect((await service.getState(2)).downloads).toEqual([]);
    expect(item.setSavePath).not.toHaveBeenCalled(); expect(item.getSavePath).not.toHaveBeenCalled();
    expect(JSON.stringify(state.downloads)).not.toMatch(/savePath|hostPath|file:\/\//);
  });
  it("denies an unrelated site decision and observes guest lifecycle without replacing existing listeners", async () => {
    const { service, guest, events, setUrl } = await setup();
    const existing = vi.fn(); events.on("did-navigate", existing);
    service.observeGuest(1, guest);
    await expect(service.setSitePermission(1, { ...TARGET, origin: "https://other.example", permission: "camera", decision: "allow" })).rejects.toThrow("origin-mismatch");
    await service.setSitePermission(1, { ...TARGET, origin: "https://site.example", permission: "camera", decision: "allow" });
    expect(service.checkPermission(7, "media", { requestingUrl: "https://site.example/", isMainFrame: true, mediaType: "video" })).toBe(true);
    setUrl("https://other.example/");
    events.emit("did-start-navigation", {}, "https://other.example/", false, true);
    events.emit("did-navigate");
    expect(existing).toHaveBeenCalledOnce();
    expect(service.checkPermission(7, "media", { requestingUrl: "https://site.example/", isMainFrame: true, mediaType: "video" })).toBe(false);
    events.emit("destroyed");
    expect(events.listenerCount("did-navigate")).toBe(1);
  });
  it("removes download and guest observers at window disposal", async () => {
    const { service, guest, events } = await setup();
    service.observeGuest(1, guest);
    const item = Object.assign(new EventEmitter(), { getFilename: () => "report.txt", getReceivedBytes: () => 0, getTotalBytes: () => 0 });
    service.observeDownload(1, item as unknown as DownloadItem);
    service.disposeWindow(1);
    expect(events.listenerCount("did-start-navigation")).toBe(0);
    expect(item.listenerCount("updated")).toBe(0); expect(item.listenerCount("done")).toBe(0);
    expect((await service.getState(1)).downloads).toEqual([]);
  });
  it("removes a destroyed guest using its registered identity", async () => {
    const { service, guest, events } = await setup();
    service.observeGuest(1, guest);
    Object.defineProperty(guest, "id", { get: () => { throw new TypeError("Object has been destroyed"); } });
    expect(() => events.emit("destroyed")).not.toThrow();
    expect(events.listenerCount("did-start-navigation")).toBe(0);
    const replacement = Object.assign(new EventEmitter(), { id: 7, isDestroyed: () => false, isLoadingMainFrame: () => false }) as unknown as WebContents;
    expect(() => service.observeGuest(2, replacement)).not.toThrow();
  });
  it("reports a main-frame load failure for the tab until the user navigates away from it", async () => {
    const { service, guest, events } = await setup();
    service.observeGuest(1, guest);
    expect((await service.getState(1)).pages).toEqual([{ tabId: "browser:one", loading: false, loadError: null, prompts: [] }]);
    events.emit("did-fail-load", {}, -102, "ERR_CONNECTION_REFUSED", "http://127.0.0.1:1/", true);
    expect((await service.getState(1)).pages[0]?.loadError).toEqual({ reason: "connection", code: -102, detail: "ERR_CONNECTION_REFUSED", url: "http://127.0.0.1:1/" });
    // The browser's own error document commits after the failure; it is not a navigation away.
    events.emit("did-start-navigation", {}, "chrome-error://chromewebdata/", false, true);
    expect((await service.getState(1)).pages[0]?.loadError?.reason).toBe("connection");
    events.emit("did-start-navigation", {}, "https://site.example/next", false, true);
    expect((await service.getState(1)).pages[0]?.loadError).toBeNull();
  });
  it("ignores an aborted load and a frame that is not the page's own", async () => {
    const { service, guest, events } = await setup();
    service.observeGuest(1, guest);
    events.emit("did-fail-load", {}, -3, "ERR_ABORTED", "https://site.example/", true);
    events.emit("did-fail-load", {}, -105, "ERR_NAME_NOT_RESOLVED", "https://frame.invalid/", false);
    expect((await service.getState(1)).pages[0]?.loadError).toBeNull();
  });
  it("loads the failed address again on retry, and reloads a crashed page", async () => {
    const { service, guest, events, loadURL, reload, onError } = await setup();
    service.observeGuest(1, guest);
    expect(() => service.retryLoad(1, TARGET)).toThrow("operation-failed");
    events.emit("did-fail-load", {}, -105, "ERR_NAME_NOT_RESOLVED", "https://missing.invalid/page", true);
    loadURL.mockRejectedValueOnce(new Error("ERR_NAME_NOT_RESOLVED"));
    expect(service.retryLoad(1, TARGET)).toBeNull();
    expect(loadURL).toHaveBeenCalledWith("https://missing.invalid/page");
    await Promise.resolve(); await Promise.resolve();
    expect(onError).toHaveBeenCalledOnce();
    events.emit("render-process-gone", {}, { reason: "crashed" });
    expect((await service.getState(1)).pages[0]?.loadError).toMatchObject({ reason: "crashed", detail: "crashed", url: "https://site.example/" });
    service.retryLoad(1, TARGET);
    expect(reload).toHaveBeenCalledOnce();
    events.emit("render-process-gone", {}, { reason: "clean-exit" });
    expect(() => service.retryLoad(2, TARGET)).toThrow("no-such-tab");
  });
  it("publishes a failure that happened before the guest was bound to its tab, once the tab is listed", async () => {
    const { service, guest, events, setLive } = await setup();
    setLive(false);
    service.observeGuest(1, guest);
    const published: (readonly unknown[])[] = [];
    service.onChanged((_windowId, state) => published.push(state.pages));
    expect((await service.getState(1)).pages).toEqual([]);
    events.emit("did-fail-load", {}, -102, "ERR_CONNECTION_REFUSED", "http://127.0.0.1:9/", true);
    await vi.waitFor(() => expect(published.length).toBeGreaterThan(0));
    expect(published.at(-1)).toEqual([]);
    const before = published.length;
    service.tabsChanged(1);
    await new Promise((resolve) => setImmediate(resolve));
    expect(published).toHaveLength(before);

    setLive(true);
    service.tabsChanged(1);
    await vi.waitFor(() => expect(published.at(-1)).toEqual([{ tabId: "browser:one", loading: false, loadError: expect.objectContaining({ reason: "connection" }), prompts: [] }]));
    const settled = published.length;
    service.tabsChanged(1);
    service.tabsChanged(2);
    await new Promise((resolve) => setImmediate(resolve));
    expect(published).toHaveLength(settled);
  });
  it("reports the page as loading between the guest's load events and stops the load on request", async () => {
    const { service, guest, events, stop } = await setup();
    service.observeGuest(1, guest);
    const published: boolean[] = [];
    service.onChanged((_windowId, state) => { const page = state.pages[0]; if (page) published.push(page.loading); });
    await service.getState(1);
    events.emit("did-start-loading");
    await vi.waitFor(() => expect(published.at(-1)).toBe(true));
    events.emit("did-start-loading");
    expect(service.stopLoad(1, TARGET)).toBeNull();
    expect(stop).toHaveBeenCalledOnce();
    events.emit("did-stop-loading");
    await vi.waitFor(() => expect(published.at(-1)).toBe(false));
    expect(() => service.stopLoad(1, { ...TARGET, documentGeneration: 9 })).toThrow("stale-document");
  });
  it("loads a validated address in the tab's existing page and refuses anything else", async () => {
    const { service, loadURL } = await setup();
    expect(service.load(1, { ...TARGET, url: "https://site.example/again" })).toBeNull();
    expect(loadURL).toHaveBeenCalledWith("https://site.example/again");
    expect(() => service.load(1, { ...TARGET, url: "javascript:alert(1)" })).toThrow("bad-request");
    expect(() => service.load(1, { ...TARGET, url: "https://user:pw@site.example/" })).toThrow("bad-request");
    expect(() => service.load(2, { ...TARGET, url: "https://site.example/" })).toThrow("no-such-tab");
    expect(loadURL).toHaveBeenCalledOnce();
  });
  it("asks a tab's permission question in its panel, and a guest without a tab in a native dialog", async () => {
    const { service, guest, events, promptPermission, setLive } = await setup();
    service.observeGuest(1, guest);
    const details = { requestingUrl: "https://site.example/", isMainFrame: true };
    const asked = service.requestPermission(7, "geolocation", details);
    await vi.waitFor(async () => expect((await service.getState(1)).pages[0]?.prompts).toHaveLength(1));
    const prompt = (await service.getState(1)).pages[0]?.prompts[0];
    expect(prompt).toEqual({ id: prompt?.id, kind: "permission", origin: "https://site.example", permissions: ["geolocation"] });
    expect(promptPermission).not.toHaveBeenCalled();
    expect(() => service.answerPrompt(1, { tabId: "browser:one", promptId: "prompt-missing", answer: { kind: "permission", choice: "allow-once" } })).toThrow("stale-document");
    expect(() => service.answerPrompt(2, { tabId: "browser:one", promptId: String(prompt?.id), answer: { kind: "permission", choice: "allow-once" } })).toThrow("no-such-tab");
    service.answerPrompt(1, { tabId: "browser:one", promptId: String(prompt?.id), answer: { kind: "permission", choice: "always-block" } });
    await expect(asked).resolves.toBe(false);
    const state = await service.getState(1);
    expect(state.pages[0]?.prompts).toEqual([]);
    expect(state.sitePermissions).toEqual([{ origin: "https://site.example", permission: "geolocation", decision: "block" }]);

    // A question whose document navigates away ends unanswered and is no longer shown.
    const pending = service.requestPermission(7, "notifications", details);
    await vi.waitFor(async () => expect((await service.getState(1)).pages[0]?.prompts).toHaveLength(1));
    events.emit("did-start-navigation", {}, "https://site.example/next", false, true);
    await expect(pending).resolves.toBe(false);
    expect((await service.getState(1)).pages[0]?.prompts).toEqual([]);

    setLive(false);
    await expect(service.requestPermission(7, "notifications", details)).resolves.toBe(true);
    expect(promptPermission).toHaveBeenCalledWith({ windowId: 1, guestId: 7, origin: "https://site.example", permissions: ["notifications"] });
  });
  it("lets the user's own navigation unload a page that asks to stay, without a question", async () => {
    const { service, guest, events } = await setup();
    service.observeGuest(1, guest);
    expect(service.userNavigation(1, TARGET)).toBeNull();
    const unload = { preventDefault: vi.fn() };
    const navigation = { preventDefault: vi.fn(), url: "https://site.example/away", isMainFrame: true };
    events.emit("will-prevent-unload", unload);
    events.emit("will-navigate", navigation);
    expect(unload.preventDefault).toHaveBeenCalledOnce();
    expect(navigation.preventDefault).not.toHaveBeenCalled();
    expect((await service.getState(1)).pages[0]?.prompts).toEqual([]);
    expect(() => service.userNavigation(1, { ...TARGET, documentGeneration: 5 })).toThrow("stale-document");
  });
  it("holds the request of a navigation the page started unsent, asks once in the tab, and sends exactly that request on Leave", async () => {
    const { service, guest, events, loadURL, pageRequest, holding } = await setup();
    service.observeGuest(1, guest);
    const unload = { preventDefault: vi.fn() };
    const navigation = { preventDefault: vi.fn(), url: "https://site.example/away", isMainFrame: true };
    const away = { webContentsId: 7, resourceType: "mainFrame", url: "https://site.example/away" };
    // A navigation that met no unload question is none of this guard's business, and nothing holds requests.
    events.emit("will-navigate", navigation);
    expect(navigation.preventDefault).not.toHaveBeenCalled();
    await expect(pageRequest(away)).resolves.toBe("unheld");
    for (let attempt = 0; attempt < 2; attempt++) { events.emit("will-prevent-unload", unload); events.emit("will-navigate", navigation); }
    // The navigation itself goes on to its request: cancelling it here and repeating its address would lose a form's
    // method and body.
    expect(navigation.preventDefault).not.toHaveBeenCalled();
    expect(holding()).toBe(true);
    expect((await service.getState(1)).pages[0]?.prompts).toEqual([]);
    // Other requests, of this page or another, pass.
    await expect(pageRequest({ ...away, resourceType: "image" })).resolves.toBe(true);
    await expect(pageRequest({ ...away, webContentsId: 8 })).resolves.toBe(true);
    await expect(pageRequest({ ...away, url: "https://site.example/elsewhere" })).resolves.toBe(true);
    const sent = pageRequest(away);
    await vi.waitFor(async () => expect((await service.getState(1)).pages[0]?.prompts).toHaveLength(1));
    const page = (await service.getState(1)).pages[0];
    expect(page?.prompts).toEqual([{ id: page?.prompts[0]?.id, kind: "leave", origin: "https://site.example" }]);
    service.answerPrompt(1, { tabId: "browser:one", promptId: String(page?.prompts[0]?.id), answer: { kind: "leave", leave: true } });
    await expect(sent).resolves.toBe(true);
    expect(loadURL).not.toHaveBeenCalled();
    expect(guest.stop).not.toHaveBeenCalled();
    // Once answered, nothing holds requests any more.
    expect(holding()).toBe(false);
  });
  it("stops the navigation unsent on Stay, cancels without stopping when the question ends unanswered, and never holds a subframe or a non-web address", async () => {
    const { service, guest, events, loadURL, stop, pageRequest, holding } = await setup();
    service.observeGuest(1, guest);
    const unload = { preventDefault: vi.fn() };
    const navigation = { preventDefault: vi.fn(), url: "https://site.example/away", isMainFrame: true };
    const away = { webContentsId: 7, resourceType: "mainFrame", url: "https://site.example/away" };
    events.emit("will-prevent-unload", unload);
    events.emit("will-navigate", { ...navigation, isMainFrame: false });
    expect(holding()).toBe(false);
    events.emit("will-navigate", navigation);
    const stayed = pageRequest(away);
    await vi.waitFor(async () => expect((await service.getState(1)).pages[0]?.prompts).toHaveLength(1));
    const prompt = (await service.getState(1)).pages[0]?.prompts[0];
    service.answerPrompt(1, { tabId: "browser:one", promptId: String(prompt?.id), answer: { kind: "leave", leave: false } });
    await expect(stayed).resolves.toBe(false);
    expect(stop).toHaveBeenCalledOnce();
    expect(loadURL).not.toHaveBeenCalled();
    expect(holding()).toBe(false);

    // The user's own navigation ends the question; the held request is cancelled, and the user's load is not stopped.
    events.emit("will-prevent-unload", unload);
    events.emit("will-navigate", navigation);
    const superseded = pageRequest(away);
    await vi.waitFor(async () => expect((await service.getState(1)).pages[0]?.prompts).toHaveLength(1));
    events.emit("did-start-navigation", {}, "https://site.example/typed", false, true);
    await expect(superseded).resolves.toBe(false);
    expect(stop).toHaveBeenCalledOnce();

    // A held navigation that commits or fails before its request arrives holds nothing afterwards.
    events.emit("will-prevent-unload", unload); events.emit("will-navigate", navigation);
    events.emit("did-navigate", {}, "https://site.example/other");
    expect(holding()).toBe(false);
    events.emit("will-prevent-unload", unload); events.emit("will-navigate", navigation);
    events.emit("did-fail-load", {}, -3, "ERR_ABORTED", "https://site.example/away", true);
    expect(holding()).toBe(false);

    events.emit("will-prevent-unload", unload);
    const script = { ...navigation, url: "javascript:alert(1)", preventDefault: vi.fn() };
    events.emit("will-navigate", script);
    expect(script.preventDefault).toHaveBeenCalledOnce();
    expect(holding()).toBe(false);
    expect((await service.getState(1)).pages[0]?.prompts.filter((item) => item.kind === "leave")).toEqual([]);
  });
  it("keeps the user's mark through the end of a load that was already running, and ends it with its own load", async () => {
    const { service, guest, events, holding } = await setup();
    service.observeGuest(1, guest);
    const navigation = { preventDefault: vi.fn(), url: "https://site.example/away", isMainFrame: true };
    const attempt = () => { events.emit("will-prevent-unload", { preventDefault: () => {} }); events.emit("will-navigate", navigation); };
    service.userNavigation(1, TARGET);
    events.emit("did-stop-loading");
    attempt();
    expect(holding()).toBe(false);

    service.userNavigation(1, TARGET);
    events.emit("did-start-loading");
    events.emit("did-stop-loading");
    attempt();
    expect(holding()).toBe(true);

    service.userNavigation(1, TARGET);
    expect(holding()).toBe(false);
    events.emit("did-navigate");
    attempt();
    expect(holding()).toBe(true);
    expect(navigation.preventDefault).not.toHaveBeenCalled();
  });
});
