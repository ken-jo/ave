import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSidebarSurfacePreview } from "../sidebar-preview-data.js";

afterEach(() => { vi.unstubAllGlobals(); });
describe("sidebar display data", () => {
  it("does not load or create a page when no rendered tab exists", async () => {
    const preview = vi.fn();
    const load = vi.fn();
    vi.stubGlobal("aveApi", { browserWorkspace: { getState: async () => ({ok:true,value:{tabs:[]}}), preview }, browserTabs: { create: load, navigate: load } });
    expect(await loadSidebarSurfacePreview({ tabId:"page",kind:"browser",ordinal:1,url:null,boundSessionIds:[],faviconDataUrl:null }, "Page")).toEqual({kind:"browser",title:"Page"});
    expect(preview).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  });
  it("uses only the display endpoint for a host terminal", async () => {
    const preview = vi.fn(async () => ({ok:true,command:"make build"}));
    const read = vi.fn();
    vi.stubGlobal("aveApi", { terminal: {preview, getBlock:read,listBlocks:read}, chatSend:read });
    expect(await loadSidebarSurfacePreview({tabId:"terminal:1",kind:"terminal",ordinal:1,url:null,boundSessionIds:[],faviconDataUrl:null},"Terminal 1")).toEqual({kind:"terminal",title:"Terminal 1",command:"make build"});
    expect(preview).toHaveBeenCalledWith("terminal:1");
    expect(read).not.toHaveBeenCalled();
  });
});

it("keeps thumbnails for consecutive A to B sidebar hovers on the shared queue", async () => {
  vi.useFakeTimers();
  const tabs = ["browser:a", "browser:b"].map((tabId) => ({ tabId, documentGeneration: 1, title: tabId, url: "https://example.test/", zoomFactor: 1 }));
  const preview = vi.fn(async (target: { tabId: string; documentGeneration: number }) => ({ ok: true, value: { ...target, dataUrl: "data:image/jpeg;base64,YQ==", width: 100, height: 50 } }));
  vi.stubGlobal("aveApi", { browserWorkspace: { getState: async () => ({ ok: true, value: { tabs } }), preview } });
  const surface = (tabId: string) => ({ tabId, kind: "browser" as const, ordinal: 1, url: "https://example.test/", boundSessionIds: [], faviconDataUrl: null });
  const first = loadSidebarSurfacePreview(surface("browser:a"), "A");
  await vi.advanceTimersByTimeAsync(0);
  expect(await first).toMatchObject({ imageDataUrl: "data:image/jpeg;base64,YQ==" });
  const second = loadSidebarSurfacePreview(surface("browser:b"), "B");
  await vi.advanceTimersByTimeAsync(1599);
  expect(preview).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(await second).toMatchObject({ imageDataUrl: "data:image/jpeg;base64,YQ==" });
  expect(preview).toHaveBeenCalledTimes(2);
  vi.useRealTimers();
});
