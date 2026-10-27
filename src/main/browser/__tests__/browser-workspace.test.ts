import { refuseNamespaceFileCreation } from "../../../__tests__/support/feature-namespace.js";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DownloadItem, WebContents } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserWorkspaceService } from "../browser-workspace.js";
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
  const findInPage = vi.fn(() => 42); const stopFindInPage = vi.fn(); const setZoomFactor = vi.fn((next: number) => { factor = next; });
  const guest = Object.assign(events, { id: 7, getURL: () => url, getTitle: () => "Site", isDestroyed: () => false, getZoomFactor: () => factor, setZoomFactor, findInPage, stopFindInPage }) as unknown as WebContents;
  const onError = vi.fn(); const promptPermission = vi.fn(async () => true);
  const service = new BrowserWorkspaceService({ store: new BrowserWorkspaceStore(namespace), liveTab: (windowId, tabId) => live && windowId === 1 && tabId === "browser:one" ? { guest, documentGeneration: generation } : null, listTabs: (windowId) => live && windowId === 1 ? [{ tabId: "browser:one", documentGeneration: generation, url, title: "Site" }] : [], isWindowVisible: () => true, promptPermission, fullscreenAvailable: () => false, onError });
  services.push(service);
  return { service, guest, events, findInPage, stopFindInPage, setZoomFactor, onError, setGeneration: (next: number) => { generation = next; }, setUrl: (next: string) => { url = next; }, setLive: (next: boolean) => { live = next; } };
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
    const replacement = Object.assign(new EventEmitter(), { id: 7, isDestroyed: () => false }) as unknown as WebContents;
    expect(() => service.observeGuest(2, replacement)).not.toThrow();
  });
});
