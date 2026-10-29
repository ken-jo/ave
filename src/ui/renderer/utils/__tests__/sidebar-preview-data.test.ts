import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSidebarSurfacePreview } from "../sidebar-preview-data.js";

afterEach(() => { vi.unstubAllGlobals(); });
describe("sidebar display data", () => {
  it("does not load or create a page when no rendered tab exists", async () => {
    const preview = vi.fn();
    const load = vi.fn();
    vi.stubGlobal("aveApi", { browserWorkspace: { getState: async () => ({ok:true,value:{tabs:[]}}), preview }, browserTabs: { create: load, navigate: load } });
    expect(await loadSidebarSurfacePreview({ tabId:"page",kind:"browser",ordinal:1,url:null,boundSessionIds:[] }, "Page")).toEqual({kind:"browser",title:"Page"});
    expect(preview).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  });
  it("uses only the display endpoint for a host terminal", async () => {
    const preview = vi.fn(async () => ({ok:true,command:"make build"}));
    const read = vi.fn();
    vi.stubGlobal("aveApi", { terminal: {preview, getBlock:read,listBlocks:read}, chatSend:read });
    expect(await loadSidebarSurfacePreview({tabId:"terminal:1",kind:"terminal",ordinal:1,url:null,boundSessionIds:[]},"Terminal 1")).toEqual({kind:"terminal",title:"Terminal 1",command:"make build"});
    expect(preview).toHaveBeenCalledWith("terminal:1");
    expect(read).not.toHaveBeenCalled();
  });
});
