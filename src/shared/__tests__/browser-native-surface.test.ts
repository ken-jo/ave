import { describe, expect, it } from "vitest";
import { parseBrowserNativeSurfaceChanged, parseBrowserNativeSurfaceRequest, parseBrowserNativeSurfaceResult } from "../browser-native-surface.js";

const SURFACE = {
  tabId: "browser:agent", webContentsId: 12, epoch: 1, revision: 1,
  url: "about:blank", title: "", favicon: null, loading: false, canGoBack: false, canGoForward: false, visible: false,
};

describe("native browser surface boundary", () => {
  it("preserves creation provenance and refuses extra authority", () => {
    const request = { action: "create", tabId: SURFACE.tabId, requestId: "browser-op-1" };
    expect(parseBrowserNativeSurfaceRequest(request)).toEqual(request);
    expect(parseBrowserNativeSurfaceRequest({ ...request, owner: { sessionId: "other" } })).toBeNull();
    expect(parseBrowserNativeSurfaceRequest({ ...request, requestId: "" })).toBeNull();
  });

  it("preserves presentation identity and clipped native geometry", () => {
    const request = { action: "present", tabId: SURFACE.tabId, webContentsId: 12, epoch: 1, sequence: 2,
      bounds: { x: -20.5, y: 50, width: 800, height: 600 }, clipBounds: { x: 0, y: 50, width: 779.5, height: 600 }, borderRadius: 8 };
    expect(parseBrowserNativeSurfaceRequest(request)).toEqual(request);
    expect(parseBrowserNativeSurfaceRequest({ ...request, bounds: null, clipBounds: undefined })).toMatchObject({ bounds: null });
    expect(parseBrowserNativeSurfaceRequest({ ...request, sequence: 0 })).toBeNull();
    expect(parseBrowserNativeSurfaceRequest({ ...request, epoch: Number.MAX_SAFE_INTEGER + 1 })).toBeNull();
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 0, 32769])("rejects invalid viewport width %s", (width) => {
    expect(parseBrowserNativeSurfaceRequest({ action: "present", tabId: SURFACE.tabId, webContentsId: 12, epoch: 1, sequence: 1,
      bounds: { x: 0, y: 0, width, height: 600 } })).toBeNull();
  });

  it("requires exact native page identity for user commands", () => {
    expect(parseBrowserNativeSurfaceRequest({ action: "focus", tabId: SURFACE.tabId, webContentsId: 12 }))
      .toEqual({ action: "focus", tabId: SURFACE.tabId, webContentsId: 12 });
    expect(parseBrowserNativeSurfaceRequest({ action: "focus", tabId: SURFACE.tabId })).toBeNull();
    expect(parseBrowserNativeSurfaceRequest({ action: "focus", tabId: SURFACE.tabId, webContentsId: 12, allowHidden: true })).toBeNull();
  });

  it("rejects mixed surface identity in state events", () => {
    expect(parseBrowserNativeSurfaceChanged({ tabId: SURFACE.tabId, surface: SURFACE }))
      .toEqual({ tabId: SURFACE.tabId, surface: SURFACE });
    expect(parseBrowserNativeSurfaceChanged({ tabId: "browser:other", surface: SURFACE })).toBeNull();
    expect(parseBrowserNativeSurfaceChanged({ tabId: SURFACE.tabId, surface: null }))
      .toEqual({ tabId: SURFACE.tabId, surface: null });
  });

  it("accepts only typed operation results", () => {
    expect(parseBrowserNativeSurfaceResult({ ok: true, surface: SURFACE })).toEqual({ ok: true, surface: SURFACE });
    expect(parseBrowserNativeSurfaceResult({ ok: true, surface: SURFACE, initialNavigation: false })).toEqual({ ok: true, surface: SURFACE, initialNavigation: false });
    expect(parseBrowserNativeSurfaceResult({ ok: true, surface: SURFACE, initialNavigation: "true" })).toBeNull();
    expect(parseBrowserNativeSurfaceResult({ ok: true, surface: null, initialNavigation: true })).toBeNull();
    expect(parseBrowserNativeSurfaceResult({ ok: false, error: "stale-surface" })).toEqual({ ok: false, error: "stale-surface" });
    expect(parseBrowserNativeSurfaceResult({ ok: true, surface: { ...SURFACE, epoch: -1 } })).toBeNull();
    expect(parseBrowserNativeSurfaceResult({ ok: false, error: "raw native error" })).toBeNull();
  });
});
