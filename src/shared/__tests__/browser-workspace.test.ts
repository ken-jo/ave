import { describe, expect, it } from "vitest";
import { BROWSER_WORKSPACE_LIMITS, parseBrowserWorkspaceCapture, parseBrowserWorkspacePreview, parseBrowserWorkspaceRequest, parseBrowserWorkspaceState } from "../browser-workspace.js";

const TARGET = { tabId: "browser:one", documentGeneration: 4 };
const STATE = { revision: 1, bookmarks: [], history: [], sitePermissions: [], downloads: [], tabs: [], storageStatus: "ready", capabilities: { fullscreen: false } };

describe("browser workspace wire validation", () => {
  it("validates capture mode, viewport clips and strict host target fields", () => {
    expect(parseBrowserWorkspaceRequest("capture", TARGET)).toEqual(TARGET);
    expect(parseBrowserWorkspaceRequest("capture", { ...TARGET, fullPage: true })).not.toBeNull();
    const clip = { x: 5.5, y: 10, width: 200, height: 100 };
    expect(parseBrowserWorkspaceRequest("capture", { ...TARGET, clip })).not.toBeNull();
    for (const fields of [{ fullPage: "true" }, { fullPage: undefined }, { clip: undefined }, { fullPage: true, clip }, { windowId: 2 }, { ref: "e1" }]) {
      expect(parseBrowserWorkspaceRequest("capture", { ...TARGET, ...fields })).toBeNull();
    }
    for (const fields of [{ x: -1 }, { y: NaN }, { width: 0 }, { height: Infinity }, { scale: 1 }]) {
      expect(parseBrowserWorkspaceRequest("capture", { ...TARGET, clip: { ...clip, ...fields } })).toBeNull();
    }
  });
  it("accepts only bounded PNG capture results and explicit scaling metadata", () => {
    const capture = { ...TARGET, dataUrl: "data:image/png;base64,YQ==", width: 200, height: 100, bytes: 1, originalWidth: 400, originalHeight: 200, scale: 0.5, truncated: false };
    expect(parseBrowserWorkspaceCapture(capture)).toEqual(capture);
    expect(parseBrowserWorkspaceCapture({ ...capture, scale: 1, originalHeight: 1000, truncated: true })).not.toBeNull();
    for (const fields of [{ dataUrl: "data:image/svg+xml;base64,YQ==" }, { width: 32_000_001 }, { scale: 0 }, { bytes: 10 * 1024 * 1024 + 1 }, { truncated: "true" }, { path: "/tmp/capture.png" }]) {
      expect(parseBrowserWorkspaceCapture({ ...capture, ...fields })).toBeNull();
    }
  });
  it("requires complete scroll-and-stitch metadata with preserved sticky headers", () => {
    const capture = { ...TARGET, dataUrl: "data:image/png;base64,YQ==", width: 200, height: 100, bytes: 1, originalWidth: 200, originalHeight: 1000, scale: 1, truncated: true };
    const metadata = { captureMethod: "scroll-and-stitch", stickyHeadersDeduplicated: false };
    expect(parseBrowserWorkspaceCapture({ ...capture, ...metadata })).toEqual({ ...capture, ...metadata });
    for (const fields of [
      { captureMethod: "scroll-and-stitch" }, { stickyHeadersDeduplicated: false },
      { ...metadata, captureMethod: "viewport" }, { ...metadata, captureMethod: undefined },
      { ...metadata, stickyHeadersDeduplicated: true }, { ...metadata, stickyHeadersDeduplicated: undefined },
    ]) expect(parseBrowserWorkspaceCapture({ ...capture, ...fields })).toBeNull();
  });
  it("rejects extra operands, agent handles without document proof, invalid generations and path-like URLs", () => {
    expect(parseBrowserWorkspaceRequest("preview", TARGET)).toEqual(TARGET);
    expect(parseBrowserWorkspaceRequest("preview", { ...TARGET, windowId: 2 })).toBeNull();
    expect(parseBrowserWorkspaceRequest("preview", { tabId: "tab-1" })).toBeNull();
    for (const documentGeneration of [0, -1, NaN, 1.5]) expect(parseBrowserWorkspaceRequest("preview", { ...TARGET, documentGeneration })).toBeNull();
    for (const url of ["file:///tmp/document", "https://user:password@site.example/", "javascript:alert(1)"]) expect(parseBrowserWorkspaceRequest("setBookmark", { url, title: "Site", bookmarked: true })).toBeNull();
  });
  it("requires explicit find options and bounded zoom and text", () => {
    expect(parseBrowserWorkspaceRequest("find", { ...TARGET, text: "find", forward: true, findNext: false })).not.toBeNull();
    expect(parseBrowserWorkspaceRequest("find", { ...TARGET, text: "find" })).toBeNull();
    expect(parseBrowserWorkspaceRequest("find", { ...TARGET, text: "x".repeat(BROWSER_WORKSPACE_LIMITS.findLength + 1), forward: true, findNext: true })).toBeNull();
    for (const factor of [0.1, 3.1, Infinity, "1"]) expect(parseBrowserWorkspaceRequest("zoom", { ...TARGET, factor })).toBeNull();
    expect(parseBrowserWorkspaceRequest("getState", {})).toBeNull();
    expect(parseBrowserWorkspaceRequest("getState", undefined)).toBeUndefined();
  });
  it("rejects noncanonical origins and unknown permission decisions", () => {
    const request = { ...TARGET, origin: "https://site.example", permission: "camera", decision: "allow" };
    expect(parseBrowserWorkspaceRequest("setSitePermission", request)).toEqual(request);
    for (const fields of [{ origin: "https://site.example/path" }, { permission: "midi" }, { decision: "yes" }]) expect(parseBrowserWorkspaceRequest("setSitePermission", { ...request, ...fields })).toBeNull();
  });
  it("rejects corrupt, duplicate and over-limit snapshots", () => {
    expect(parseBrowserWorkspaceState(STATE)).toEqual(STATE);
    const rule = { origin: "https://site.example", permission: "camera", decision: "allow" };
    expect(parseBrowserWorkspaceState({ ...STATE, sitePermissions: [rule, { ...rule, decision: "block" }] })).toBeNull();
    expect(parseBrowserWorkspaceState({ ...STATE, sitePermissions: [{ ...rule, permission: "unknown" }] })).toBeNull();
    expect(parseBrowserWorkspaceState({ ...STATE, history: Array.from({ length: BROWSER_WORKSPACE_LIMITS.history + 1 }, (_, i) => ({ url: `https://site.example/${i}`, title: "", at: i })) })).toBeNull();
    expect(parseBrowserWorkspaceState({ ...STATE, revision: -1 })).toBeNull();
    expect(parseBrowserWorkspaceState({ ...STATE, storageStatus: ["ready"] })).toBeNull();
    expect(parseBrowserWorkspaceState({ ...STATE, downloads: [{ id: "download-1", name: "a", receivedBytes: 1, totalBytes: 1, at: 1, state: ["completed"] }] })).toBeNull();
    expect(parseBrowserWorkspaceRequest("setBookmark", { url: `https://site.example/${"가".repeat(1000)}`, title: "", bookmarked: true })).toBeNull();
  });
  it("accepts only bounded image bytes in a generation-matched preview shape", () => {
    const preview = { ...TARGET, dataUrl: "data:image/jpeg;base64,YQ==", width: 320, height: 180 };
    expect(parseBrowserWorkspacePreview(preview)).toEqual(preview);
    expect(parseBrowserWorkspacePreview({ ...preview, width: 321 })).toBeNull();
    expect(parseBrowserWorkspacePreview({ ...preview, dataUrl: "data:text/html;base64,YQ==" })).toBeNull();
    expect(parseBrowserWorkspacePreview({ ...preview, agentTabId: "tab-1" })).toBeNull();
  });
});
