import { dismissedPageDialogs, withDismissedDialogs } from "../browser-page-dialogs.js";
import { BROWSER_DIALOG_DOCUMENT_LIMIT, parseBrowserWorkspaceState } from "../../../shared/browser-workspace.js";
import { refuseNamespaceFileCreation } from "../../../__tests__/support/feature-namespace.js";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebContents } from "electron";
import type { ObservedDownload } from "../browser-download-staging.js";
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
  const runtimeDialog = vi.fn(); events.on("-run-dialog", runtimeDialog);
  let agentDriving = false;
  const loadURL = vi.fn(async (_url: string) => {}); const reload = vi.fn(); const stop = vi.fn();
  const findInPage = vi.fn(() => 42); const stopFindInPage = vi.fn(); const setZoomFactor = vi.fn((next: number) => { factor = next; });
  let hostType = "webview"; let agentSession: string | null = null;
  const guest = Object.assign(events, { id: 7, session: {}, mainFrame: { frameTreeNodeId: 1 }, getType: () => hostType, getURL: () => url, getTitle: () => "Site", isDestroyed: () => false, getZoomFactor: () => factor, setZoomFactor, findInPage, stopFindInPage, loadURL, reload, stop, isLoadingMainFrame: () => false }) as unknown as WebContents;
  const onError = vi.fn(); const clearSiteData = vi.fn(async () => undefined); const clearCache = vi.fn(async () => undefined); const promptPermission = vi.fn(async () => true); const openExternal = vi.fn(async () => undefined); const allowDownloads = vi.fn(); const showItemInFolder = vi.fn();
  let requestHold: BrowserPageRequestHold | null = null;
  const holdPageRequests = vi.fn((hold: BrowserPageRequestHold | null) => { requestHold = hold; });
  /** A request reaching the browser profile: how the hold answered it, or "unheld" when nothing holds requests. */
  const pageRequest = (request: BrowserPageRequest) => requestHold === null ? Promise.resolve("unheld" as const) : new Promise<boolean>((resolve) => requestHold?.(request, resolve));
  const service = new BrowserWorkspaceService({ openExternal, clearSiteData, clearCache, allowDownloads, showItemInFolder, platform: "darwin", agentSessionOf: (windowId, tabId) => windowId === 1 && tabId === "browser:one" ? agentSession : null, agentDrives: () => agentDriving, holdPageRequests, store: new BrowserWorkspaceStore(namespace), liveTab: (windowId, tabId) => live && windowId === 1 && tabId === "browser:one" ? { guest, documentGeneration: generation } : null, listTabs: (windowId) => live && windowId === 1 ? [{ tabId: "browser:one", documentGeneration: generation, url, title: "Site" }] : [], isWindowVisible: () => true, promptPermission, fullscreenAvailable: () => false, onError });
  services.push(service);
  return { service, guest, events, holdPageRequests, pageRequest, holding: () => requestHold !== null, promptPermission, openExternal, clearSiteData, clearCache, allowDownloads, showItemInFolder, runtimeDialog, setAgentDriving: (next: boolean) => { agentDriving = next; }, setAgentSession: (next: string | null) => { agentSession = next; }, setHostType: (next: string) => { hostType = next; }, loadURL, reload, stop, findInPage, stopFindInPage, setZoomFactor, onError, setGeneration: (next: number) => { generation = next; }, setUrl: (next: string) => { url = next; }, setLive: (next: boolean) => { live = next; } };
}
const TARGET = { tabId: "browser:one", documentGeneration: 1 };
const PAGE_FRAME = { origin: "https://site.example", detached: false, top: { frameTreeNodeId: 1 } };

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
    service.observeDownload(1, item as unknown as ObservedDownload);
    item.emit("done", {}, "completed");
    const state = await service.getState(1);
    expect(state.revision).toBeGreaterThan(first.revision);
    expect(state.downloads[0]).toMatchObject({ name: "report.txt", state: "completed", receivedBytes: 50 });
    expect((await service.getState(2)).downloads).toEqual([]);
    // The save location is never preset; where the user saved is read only when a download completes and stays in main.
    expect(item.setSavePath).not.toHaveBeenCalled(); expect(item.getSavePath).toHaveBeenCalledOnce();
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
    service.observeDownload(1, item as unknown as ObservedDownload);
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
    const replacement = Object.assign(new EventEmitter().on("-run-dialog", () => {}), { id: 7, isDestroyed: () => false, isLoadingMainFrame: () => false }) as unknown as WebContents;
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
  it("asks a tab's permission question in its panel, also before the tab is bound, and only a popup window in a native dialog", async () => {
    const { service, guest, events, promptPermission, setLive, setHostType } = await setup();
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

    // A page in a tab that is not bound yet still asks in the panel: the question waits there for the tab.
    setLive(false);
    const unbound = service.requestPermission(7, "notifications", details);
    for (let turn = 0; turn < 3; turn++) await new Promise((resolve) => setImmediate(resolve));
    expect((await service.getState(1)).pages).toEqual([]);
    expect(promptPermission).not.toHaveBeenCalled();
    setLive(true);
    const held = (await service.getState(1)).pages[0]?.prompts[0];
    expect(held).toMatchObject({ kind: "permission", permissions: ["notifications"] });
    service.answerPrompt(1, { tabId: "browser:one", promptId: String(held?.id), answer: { kind: "permission", choice: "allow-once" } });
    await expect(unbound).resolves.toBe(true);
    // Only a popup window, which has no tab at all, asks in a native dialog.
    setLive(false); setHostType("window");
    events.emit("did-navigate", {}, "https://site.example/");
    await expect(service.requestPermission(7, "notifications", details)).resolves.toBe(true);
    expect(promptPermission).toHaveBeenCalledWith({ windowId: 1, guestId: 7, origin: "https://site.example", permissions: ["notifications"] });
  });
  it("keeps a document's dialog Block and open questions through a fragment or history change or a navigation that never commits, and ends them with the next document", async () => {
    const { service, guest, events } = await setup();
    service.observeGuest(1, guest);
    const open = (text: string) => { const respond = vi.fn(); events.emit("-run-dialog", { frame: PAGE_FRAME, dialogType: "alert", messageText: text }, respond); return respond; };
    const answer = async (block: boolean) => service.answerPrompt(1, { tabId: "browser:one", promptId: String((await service.getState(1)).pages[0]?.prompts[0]?.id), answer: { kind: "dialog", accept: false, block } });
    const first = open("one"); await answer(false);
    await vi.waitFor(() => expect(first).toHaveBeenCalled());
    const second = open("two");
    // A fragment change and a history change leave the open question where it is.
    events.emit("did-start-navigation", {}, "https://site.example/#part", true, true);
    events.emit("did-navigate-in-page", {}, "https://site.example/#part", true);
    expect((await service.getState(1)).pages[0]?.prompts).toMatchObject([{ kind: "dialog", message: "two" }]);
    await answer(true);
    await vi.waitFor(() => expect(second).toHaveBeenCalled());
    events.emit("did-navigate-in-page", {}, "https://site.example/other-route", true);
    expect(open("three")).toHaveBeenCalledWith(false, "");
    expect((await service.getState(1)).pages[0]?.prompts).toEqual([]);
    // A navigation that starts but never commits (a download, an empty response) leaves the same document behind.
    events.emit("did-start-navigation", {}, "https://site.example/file.zip", false, true);
    expect(open("still")).toHaveBeenCalledWith(false, "");
    // A new document starts clean.
    events.emit("did-start-navigation", {}, "https://site.example/next", false, true);
    events.emit("did-navigate", {}, "https://site.example/next");
    open("four");
    expect((await service.getState(1)).pages[0]?.prompts).toMatchObject([{ kind: "dialog", message: "four" }]);
  });
  it("keeps a document's permission Block through a fragment or history change or a navigation that never commits, and drops it with the next document", async () => {
    const { service, guest, events, setUrl } = await setup();
    service.observeGuest(1, guest);
    const ask = (url: string) => service.requestPermission(7, "geolocation", { requestingUrl: url, isMainFrame: true });
    const answer = async (choice: "block" | "allow-once") => service.answerPrompt(1, { tabId: "browser:one", promptId: String((await service.getState(1)).pages[0]?.prompts[0]?.id), answer: { kind: "permission", choice } });
    const blocked = ask("https://site.example/");
    await vi.waitFor(async () => expect((await service.getState(1)).pages[0]?.prompts).toHaveLength(1));
    await answer("block");
    await expect(blocked).resolves.toBe(false);
    for (const next of ["https://site.example/#part", "https://site.example/route"]) {
      setUrl(next);
      events.emit("did-start-navigation", {}, next, true, true);
      events.emit("did-navigate-in-page", {}, next, true);
      // Still the same document: no new question, still refused.
      await expect(ask(next)).resolves.toBe(false);
      expect((await service.getState(1)).pages[0]?.prompts).toEqual([]);
      expect(service.checkPermission(7, "geolocation", { requestingUrl: next, isMainFrame: true })).toBe(false);
    }
    // A navigation that starts but never commits leaves the same document, and its Block, behind.
    events.emit("did-start-navigation", {}, "https://site.example/file.zip", false, true);
    await expect(ask("https://site.example/route")).resolves.toBe(false);
    expect((await service.getState(1)).pages[0]?.prompts).toEqual([]);
    setUrl("https://site.example/next");
    events.emit("did-start-navigation", {}, "https://site.example/next", false, true);
    events.emit("did-navigate", {}, "https://site.example/next");
    const fresh = ask("https://site.example/next");
    await vi.waitFor(async () => expect((await service.getState(1)).pages[0]?.prompts).toHaveLength(1));
    await answer("allow-once");
    await expect(fresh).resolves.toBe(true);
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
    // A navigation the user starts from the page's own menu also ends the hold.
    service.userNavigatesGuest(7);
    expect(holding()).toBe(false);
  });
  it("offers a mail link to the system's app only after the user agrees, and only says so for other schemes", async () => {
    const { service, guest, events, openExternal, setLive } = await setup();
    service.observeGuest(1, guest);
    const follow = (url: string, isMainFrame = true) => events.emit("will-navigate", { preventDefault: () => {}, url, isMainFrame });
    const prompt = async () => (await service.getState(1)).pages[0]?.prompts[0];
    const answer = async (open: boolean) => service.answerPrompt(1, { tabId: "browser:one", promptId: String((await prompt())?.id), answer: { kind: "external", open } });
    follow("https://site.example/next"); follow("mailto:sub@example.com", false);
    expect(await prompt()).toBeUndefined();

    follow("MAILTO:someone@example.com?subject=Hello\u0007&body=x"); follow("mailto:second@example.com");
    expect((await service.getState(1)).pages[0]?.prompts).toEqual([{ id: (await prompt())?.id, kind: "external", origin: "https://site.example", scheme: "mailto", target: "someone@example.com", openable: true }]);
    expect(openExternal).not.toHaveBeenCalled();
    await answer(false);
    expect(openExternal).not.toHaveBeenCalled();
    follow("tel:+15550100");
    await answer(true);
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledWith("tel:+15550100"));

    follow("ms-settings:privacy");
    expect(await prompt()).toMatchObject({ kind: "external", scheme: "ms-settings", target: "", openable: false });
    // Agreeing to something that was never offered opens nothing.
    await answer(true);
    follow(`mailto:${"a".repeat(2_100)}@example.com`);
    expect(await prompt()).toMatchObject({ scheme: "mailto", openable: false });
    await answer(true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(openExternal).toHaveBeenCalledOnce();

    setLive(false);
    follow("mailto:popup@example.com");
    setLive(true);
    expect(await prompt()).toBeUndefined();
  });
  it("asks a user's tab for the credentials a server requests and answers only the request that asked", async () => {
    const { service, guest, events, setHostType } = await setup();
    service.observeGuest(1, guest);
    const request = (details: object, auth: object) => {
      const event = { preventDefault: vi.fn() }; const respond = vi.fn();
      events.emit("login", event, details, auth, respond);
      return { event, respond };
    };
    const prompts = async () => (await service.getState(1)).pages[0]?.prompts ?? [];
    const answer = async (credentials: { username: string; password: string } | null) =>
      service.answerPrompt(1, { tabId: "browser:one", promptId: String((await prompts())[0]?.id), answer: { kind: "signIn", credentials } });

    // A proxy, an address that is not a web page, and a page in the agent's own view are left to be cancelled.
    for (const [details, auth] of [[{ url: "https://site.example/" }, { isProxy: true }], [{ url: "file:///etc/passwd" }, {}]] as const) {
      expect(request(details, auth).event.preventDefault).not.toHaveBeenCalled();
    }
    setHostType("window");
    expect(request({ url: "https://site.example/" }, {}).event.preventDefault).not.toHaveBeenCalled();
    setHostType("webview");
    expect(await prompts()).toEqual([]);

    const first = request({ url: "https://files.example:8443/private?token=1" }, { isProxy: false, realm: `Staff\u0007 area ${"x".repeat(200)}` });
    expect(first.event.preventDefault).toHaveBeenCalledOnce();
    const shown = await prompts();
    expect(shown).toEqual([{ id: shown[0]?.id, kind: "signIn", origin: "https://files.example:8443", realm: `Staff area ${"x".repeat(89)}` }]);
    // A second request while one is shown is not queued behind it.
    expect(request({ url: "https://files.example:8443/other" }, {}).event.preventDefault).not.toHaveBeenCalled();
    await answer({ username: "ken", password: "secret" });
    await vi.waitFor(() => expect(first.respond).toHaveBeenCalledWith("ken", "secret"));

    const cancelled = request({ url: "https://files.example:8443/private" }, {});
    await answer(null);
    await vi.waitFor(() => expect(cancelled.respond).toHaveBeenCalledWith());
    const abandoned = request({ url: "https://files.example:8443/private" }, {});
    events.emit("did-start-navigation", {}, "https://site.example/next", false, true);
    await vi.waitFor(() => expect(abandoned.respond).toHaveBeenCalledWith());
    expect(await prompts()).toEqual([]);
  });
  it("publishes a valid snapshot for a tab whose first load has not committed, carrying the server's question", async () => {
    const { service, guest, events, setUrl } = await setup();
    setUrl("");
    service.observeGuest(1, guest);
    events.emit("login", { preventDefault: () => {} }, { url: "https://files.example/private" }, { realm: "Staff" }, () => {});
    const state = await service.getState(1);
    expect(state.tabs[0]?.url).toBe("about:blank");
    expect(state.pages[0]?.prompts).toHaveLength(1);
    expect(parseBrowserWorkspaceState(state)).not.toBeNull();
  });
  it("keeps a sign-in question the server asked before the tab was bound, and shows it as soon as the tab is listed", async () => {
    const { service, guest, events, setLive } = await setup();
    // The guest is held from attach; its tab is not bound yet when the server's challenge arrives.
    setLive(false);
    service.observeGuest(1, guest);
    const answered = vi.fn();
    events.emit("login", { preventDefault: vi.fn() }, { url: "https://site.example/private" }, { isProxy: false, scheme: "basic", host: "site.example", port: 443, realm: "Staff" }, answered);
    expect((await service.getState(1)).pages).toEqual([]);
    expect(answered).not.toHaveBeenCalled();
    setLive(true);
    expect((await service.getState(1)).pages[0]?.prompts).toMatchObject([{ kind: "signIn", realm: "Staff" }]);
  });
  it("answers a user tab's page dialogs in its panel, with the origin, and resumes the page with the answer", async () => {
    const { service, guest, events, runtimeDialog } = await setup();
    service.observeGuest(1, guest);
    const open = (dialogType: string, messageText: string) => { const respond = vi.fn(); events.emit("-run-dialog", { frame: PAGE_FRAME, dialogType, messageText, defaultPromptText: "" }, respond); return respond; };
    const shown = async () => (await service.getState(1)).pages[0]?.prompts ?? [];
    const answer = async (accept: boolean, block = false) =>
      service.answerPrompt(1, { tabId: "browser:one", promptId: String((await shown())[0]?.id), answer: { kind: "dialog", accept, block } });

    const alert = open("alert", "Saved\r\nline two\u0007");
    expect(await shown()).toEqual([{ id: (await shown())[0]?.id, kind: "dialog", origin: "https://site.example", dialog: "alert", message: "Saved\nline two", canBlock: false }]);
    expect(alert).not.toHaveBeenCalled();
    await answer(true);
    await vi.waitFor(() => expect(alert).toHaveBeenCalledWith(true, ""));

    const accepted = open("confirm", "Delete?");
    expect((await shown())[0]).toMatchObject({ dialog: "confirm", canBlock: true });
    await answer(true);
    await vi.waitFor(() => expect(accepted).toHaveBeenCalledWith(true, ""));
    const refused = open("confirm", "Delete?");
    await answer(false);
    await vi.waitFor(() => expect(refused).toHaveBeenCalledWith(false, ""));

    // Leaving the page, or the runtime cancelling its dialogs, resumes the page unanswered.
    const left = open("confirm", "Still there?");
    events.emit("did-start-navigation", {}, "https://site.example/next", false, true);
    await vi.waitFor(() => expect(left).toHaveBeenCalledWith(false, ""));
    const cancelled = open("alert", "Hi");
    events.emit("-cancel-dialogs");
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledWith(false, ""));
    // A kind this host does not draw ends unanswered rather than reaching an unlabelled box.
    for (const kind of ["prompt", "page-defined"]) expect(open(kind, "x")).toHaveBeenCalledWith(false, "");
    expect(runtimeDialog).not.toHaveBeenCalled();
    expect(await shown()).toEqual([]);
  });
  it("titles a frame's dialog with that frame's own site, and refuses one from a frame with no web origin", async () => {
    const { service, guest, events, runtimeDialog } = await setup();
    service.observeGuest(1, guest);
    const open = (frame: unknown) => { const respond = vi.fn(); events.emit("-run-dialog", { frame, dialogType: "alert", messageText: "from a frame" }, respond); return respond; };
    open({ origin: "https://ads.other.example:8443", detached: false, top: { frameTreeNodeId: 1 } });
    expect((await service.getState(1)).pages[0]?.prompts).toMatchObject([{ kind: "dialog", origin: "https://ads.other.example:8443", message: "from a frame" }]);
    events.emit("-cancel-dialogs");
    // An opaque origin, a frame that left the page, a frame of another page, a non-web scheme or no frame at all.
    for (const frame of [
      { origin: "null", detached: false, top: { frameTreeNodeId: 1 } },
      { origin: "https://site.example", detached: true, top: { frameTreeNodeId: 1 } },
      { origin: "https://site.example", detached: false, top: { frameTreeNodeId: 99 } },
      { origin: "file://", detached: false, top: { frameTreeNodeId: 1 } },
      { origin: "https://site.example/path", detached: false, top: { frameTreeNodeId: 1 } },
      undefined,
    ]) expect(open(frame)).toHaveBeenCalledWith(false, "");
    expect((await service.getState(1)).pages[0]?.prompts).toEqual([]);
    expect(runtimeDialog).not.toHaveBeenCalled();
  });
  it("holds a dialog of a tab's page that runs before the tab is bound for its panel, never in the runtime's own box", async () => {
    const { service, guest, events, runtimeDialog, setLive } = await setup();
    setLive(false);
    service.observeGuest(1, guest);
    const respond = vi.fn();
    events.emit("-run-dialog", { frame: PAGE_FRAME, dialogType: "alert", messageText: "first document" }, respond);
    expect(runtimeDialog).not.toHaveBeenCalled();
    expect(respond).not.toHaveBeenCalled();
    setLive(true);
    const held = (await service.getState(1)).pages[0]?.prompts[0];
    expect(held).toMatchObject({ kind: "dialog", origin: "https://site.example", message: "first document" });
    service.answerPrompt(1, { tabId: "browser:one", promptId: String(held?.id), answer: { kind: "dialog", accept: true, block: false } });
    await vi.waitFor(() => expect(respond).toHaveBeenCalledWith(true, ""));
  });
  it("stops a document's dialogs when the user blocks them or the document reaches its limit, until the next document", async () => {
    const { service, guest, events } = await setup();
    service.observeGuest(1, guest);
    const open = () => { const respond = vi.fn(); events.emit("-run-dialog", { frame: PAGE_FRAME, dialogType: "alert", messageText: "again" }, respond); return respond; };
    const answer = async (block: boolean) => service.answerPrompt(1, { tabId: "browser:one", promptId: String((await service.getState(1)).pages[0]?.prompts[0]?.id), answer: { kind: "dialog", accept: false, block } });
    open(); await answer(false);
    const second = open(); await answer(true);
    await vi.waitFor(() => expect(second).toHaveBeenCalled());
    expect(open()).toHaveBeenCalledWith(false, "");
    expect((await service.getState(1)).pages[0]?.prompts).toEqual([]);

    events.emit("did-start-navigation", {}, "https://site.example/next", false, true);
    events.emit("did-navigate", {}, "https://site.example/next");
    for (let count = 0; count < BROWSER_DIALOG_DOCUMENT_LIMIT; count++) { const respond = open(); await answer(false); await vi.waitFor(() => expect(respond).toHaveBeenCalled()); }
    expect(open()).toHaveBeenCalledWith(false, "");
    expect((await service.getState(1)).pages[0]?.prompts).toEqual([]);
  });
  it("dismisses a dialog on a page the agent is driving and reports its type and text with the next tool result", async () => {
    const { service, guest, events, runtimeDialog, setAgentDriving, setHostType, setLive } = await setup();
    service.observeGuest(1, guest);
    setAgentDriving(true);
    for (let count = 0; count < 7; count++) {
      const respond = vi.fn();
      events.emit("-run-dialog", { frame: PAGE_FRAME, dialogType: count === 0 ? "confirm" : "alert", messageText: count === 0 ? `Pay now?${"!".repeat(600)}` : `notice ${count}` }, respond);
      expect(respond).toHaveBeenCalledWith(false, "");
    }
    expect((await service.getState(1)).pages[0]?.prompts).toEqual([]);
    const reported = withDismissedDialogs(7, { tabId: "tab-1", done: "click" });
    expect(reported.dismissedDialogs).toHaveLength(5);
    expect(reported.dismissedDialogs?.[0]).toEqual({ type: "confirm", message: `Pay now?${"!".repeat(492)}` });
    expect(reported).toMatchObject({ tabId: "tab-1", done: "click", dismissedDialogsOmitted: 2 });
    // Reported once; a result for another page, or with nothing dismissed, is unchanged.
    expect(withDismissedDialogs(7, { done: "click" })).toEqual({ done: "click" });
    expect(withDismissedDialogs(undefined, { done: "click" })).toEqual({ done: "click" });

    // A tab the agent opened and the user took over is still a tab: its dialog is asked in its panel.
    setAgentDriving(false); setHostType("window");
    events.emit("-run-dialog", { frame: PAGE_FRAME, dialogType: "alert", messageText: "taken over" }, vi.fn());
    expect((await service.getState(1)).pages[0]?.prompts).toMatchObject([{ kind: "dialog", message: "taken over" }]);
    expect(runtimeDialog).not.toHaveBeenCalled();
    // A window that is no tab has no panel and keeps the runtime's own dialog.
    setLive(false);
    const respond = vi.fn();
    events.emit("-run-dialog", { frame: PAGE_FRAME, dialogType: "alert", messageText: "popup" }, respond);
    expect(runtimeDialog).toHaveBeenCalledWith({ frame: PAGE_FRAME, dialogType: "alert", messageText: "popup" }, respond);
    expect(dismissedPageDialogs.take(7)).toBeNull();
  });
  it("fails loudly when the runtime no longer offers exactly one dialog handler to replace", async () => {
    const { service, guest, events } = await setup();
    events.removeAllListeners("-run-dialog");
    expect(() => service.observeGuest(1, guest)).toThrow("page-dialog-handler-missing");
  });
  it("opens a link that asks for a new tab beside the tab that asked, and declines for anything that is not a listed tab's web link", async () => {
    const { service, guest, setLive } = await setup();
    service.observeGuest(1, guest);
    expect(service.openLinkTab(1, 7, "https://other.example/page", true)).toBe(false);
    const opened = vi.fn();
    service.onOpenTab(opened);
    expect(service.openLinkTab(1, 7, "https://other.example/page", false)).toBe(true);
    expect(opened).toHaveBeenCalledWith(1, { openerTabId: "browser:one", url: "https://other.example/page", active: false });
    for (const [windowId, guestId, url] of [[2, 7, "https://other.example/"], [1, 8, "https://other.example/"], [1, 7, "javascript:alert(1)"], [1, 7, "about:blank"]] as const) {
      expect(service.openLinkTab(windowId, guestId, url, true)).toBe(false);
    }
    setLive(false);
    expect(service.openLinkTab(1, 7, "https://other.example/", true)).toBe(false);
    expect(opened).toHaveBeenCalledOnce();
  });
  it("lists a refused download as blocked, says so in the tab, and lifts the site's limit only when the user asks", async () => {
    const { service, guest, allowDownloads } = await setup();
    service.observeGuest(1, guest);
    service.blockedDownload(1, 7, "report\u0007.pdf", "rate");
    service.blockedDownload(1, 7, "second.pdf", "rate");
    const state = await service.getState(1);
    expect(state.downloads.map((download) => [download.name, download.state])).toEqual([["second.pdf", "blocked"], ["report.pdf", "blocked"]]);
    expect(state.pages[0]?.prompts).toEqual([{ id: state.pages[0]?.prompts[0]?.id, kind: "downloadBlocked", origin: "https://site.example", name: "report.pdf", reason: "rate" }]);
    expect(parseBrowserWorkspaceState(state)).not.toBeNull();
    service.answerPrompt(1, { tabId: "browser:one", promptId: String(state.pages[0]?.prompts[0]?.id), answer: { kind: "downloadBlocked", allow: false } });
    await new Promise((resolve) => setImmediate(resolve));
    expect(allowDownloads).not.toHaveBeenCalled();
    service.blockedDownload(1, 7, "third.pdf", "rate");
    service.answerPrompt(1, { tabId: "browser:one", promptId: String((await service.getState(1)).pages[0]?.prompts[0]?.id), answer: { kind: "downloadBlocked", allow: true } });
    await vi.waitFor(() => expect(allowDownloads).toHaveBeenCalledWith("https://site.example"));
  });
  it("reveals a finished download by its id without the path leaving main, and cancels one in progress", async () => {
    const { service, showItemInFolder } = await setup();
    const item = Object.assign(new EventEmitter(), { getFilename: () => "report.txt", getReceivedBytes: () => 10, getTotalBytes: () => 10, getSavePath: () => "/Users/me/Downloads/report.txt", cancel: vi.fn() });
    service.observeDownload(1, item as never);
    const id = String((await service.getState(1)).downloads[0]?.id);
    expect(() => service.showDownload(1, { id })).toThrow("bad-request");
    service.cancelDownload(1, { id });
    expect(item.cancel).toHaveBeenCalledOnce();
    expect(() => service.cancelDownload(2, { id })).toThrow("bad-request");
    item.emit("done", {}, "completed");
    expect(() => service.cancelDownload(1, { id })).toThrow("bad-request");
    expect(() => service.showDownload(2, { id })).toThrow("bad-request");
    service.showDownload(1, { id });
    expect(showItemInFolder).toHaveBeenCalledWith("/Users/me/Downloads/report.txt");
    expect(JSON.stringify(await service.getState(1))).not.toContain("/Users/me");
  });
  it("clears only what the user chose from the shared profile, and one site's data only for the site the tab shows", async () => {
    const { service, guest, clearSiteData, clearCache } = await setup();
    service.observeGuest(1, guest);
    await service.store.recordVisit("https://site.example/", "Site", "user");
    expect((await service.clearData(1, { history: false, siteData: true, cache: false })).history).toHaveLength(1);
    expect(clearSiteData).toHaveBeenCalledWith(null);
    expect(clearCache).not.toHaveBeenCalled();
    expect((await service.clearData(1, { history: true, siteData: false, cache: true })).history).toEqual([]);
    expect(clearCache).toHaveBeenCalledOnce();
    expect(clearSiteData).toHaveBeenCalledOnce();
    await expect(service.clearData(1, { history: false, siteData: false, cache: false })).rejects.toThrow("bad-request");

    await expect(service.clearSiteData(1, { ...TARGET, origin: "https://other.example" })).rejects.toThrow("origin-mismatch");
    await expect(service.clearSiteData(1, { ...TARGET, documentGeneration: 9, origin: "https://site.example" })).rejects.toThrow("stale-document");
    expect(await service.clearSiteData(1, { ...TARGET, origin: "https://site.example" })).toBeNull();
    expect(clearSiteData).toHaveBeenLastCalledWith("https://site.example");
  });
  it("records a visit as the agent's while the agent drives the page, apart from the user's history, and deletes one entry", async () => {
    const { service, guest, events, setAgentDriving } = await setup();
    service.observeGuest(1, guest);
    events.emit("did-navigate", {}, "https://site.example/");
    await vi.waitFor(async () => expect((await service.getState(1)).history).toHaveLength(1));
    setAgentDriving(true);
    events.emit("did-navigate", {}, "https://site.example/");
    await vi.waitFor(async () => expect((await service.getState(1)).history.map((entry) => entry.by)).toEqual(["agent", "user"]));
    const state = await service.deleteHistory(1, { url: "https://site.example/", by: "user" });
    expect(state.history.map((entry) => entry.by)).toEqual(["agent"]);
  });
  it("names the conversation whose agent owns a tab only for the site that tab is on", async () => {
    const { service, setAgentSession } = await setup();
    expect(service.agentSessionForSite(1, { ...TARGET, origin: "https://site.example" })).toBeNull();
    setAgentSession("session-1");
    expect(service.agentSessionForSite(1, { ...TARGET, origin: "https://site.example" })).toBe("session-1");
    expect(() => service.agentSessionForSite(1, { ...TARGET, origin: "https://other.example" })).toThrow("origin-mismatch");
    expect(() => service.agentSessionForSite(2, { ...TARGET, origin: "https://site.example" })).toThrow();
    expect(() => service.agentSessionForSite(1, { ...TARGET, documentGeneration: 9, origin: "https://site.example" })).toThrow();
  });
  it("reports a find's final count for the tab it ran in, and nothing for a partial count or a window that is no tab", async () => {
    const { service, guest, events, setLive } = await setup();
    const results: unknown[] = [];
    service.onFindResult((windowId, result) => results.push([windowId, result]));
    service.observeGuest(1, guest);
    events.emit("found-in-page", {}, { requestId: 42, matches: 2, activeMatchOrdinal: 1, finalUpdate: false });
    expect(results).toEqual([]);
    events.emit("found-in-page", {}, { requestId: 42, matches: 5, activeMatchOrdinal: 2, finalUpdate: true });
    expect(results).toEqual([[1, { tabId: "browser:one", requestId: 42, matches: 5, activeMatch: 2 }]]);
    setLive(false);
    events.emit("found-in-page", {}, { requestId: 43, matches: 1, activeMatchOrdinal: 1, finalUpdate: true });
    expect(results).toHaveLength(1);
  });
  it("takes a browser key pressed in a user's page for the tab, and leaves every other key and every agent-driven page alone", async () => {
    const { service, guest, events, setAgentDriving, setLive } = await setup();
    const pressed: unknown[] = [];
    service.onPageShortcut((windowId, shortcut) => pressed.push([windowId, shortcut]));
    service.observeGuest(1, guest);
    const press = (key: string, modifiers: Partial<{ meta: boolean; control: boolean; alt: boolean; shift: boolean }> = { meta: true }, type = "keyDown") => {
      const event = { preventDefault: vi.fn() };
      events.emit("before-input-event", event, { type, key, code: `Key${key.toUpperCase()}`, meta: false, control: false, alt: false, shift: false, ...modifiers });
      return event.preventDefault.mock.calls.length > 0;
    };
    // Until the window says which keys are the browser's, the page keeps every key.
    expect(press("r")).toBe(false);
    service.setPageShortcuts(1, { focusAddress: "CommandOrControl+L", find: "CommandOrControl+F", reload: "CommandOrControl+R", back: "CommandOrControl+[", forward: null });
    expect(press("r")).toBe(true);
    expect(press("l")).toBe(true);
    expect(pressed).toEqual([[1, { tabId: "browser:one", action: "reload" }], [1, { tabId: "browser:one", action: "focusAddress" }]]);
    expect(press("r", { meta: true }, "keyUp")).toBe(false);
    expect(press("r", {})).toBe(false);
    expect(press("r", { meta: true, shift: true })).toBe(false);
    expect(press("x")).toBe(false);
    setAgentDriving(true);
    expect(press("r")).toBe(false);
    setAgentDriving(false); setLive(false);
    expect(press("r")).toBe(false);
    expect(pressed).toHaveLength(2);
    expect(() => service.setPageShortcuts(1, { focusAddress: "cmd+l", find: null, reload: null, back: null, forward: null })).toThrow("bad-request");
  });
});
