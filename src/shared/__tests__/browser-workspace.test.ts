import { describe, expect, it } from "vitest";
import { BROWSER_WORKSPACE_LIMITS, browserDialogText, parseBrowserOpenTab, parseBrowserWorkspaceCapture, parseBrowserWorkspacePreview, parseBrowserWorkspaceRequest, parseBrowserWorkspaceState } from "../browser-workspace.js";

const TARGET = { tabId: "browser:one", documentGeneration: 4 };
const STATE = { revision: 1, bookmarks: [], history: [], sitePermissions: [], downloads: [], tabs: [], pages: [], storageStatus: "ready", capabilities: { fullscreen: false } };

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
    // A time a date cannot hold would break every view that shows it as a date.
    for (const at of [1e20, 8.64e15 + 1, 1.5, -1, Number.NaN]) {
      expect(parseBrowserWorkspaceState({ ...STATE, history: [{ url: "https://site.example/", title: "", at, by: "user" }] })).toBeNull();
      expect(parseBrowserWorkspaceState({ ...STATE, bookmarks: [{ url: "https://site.example/", title: "", at }] })).toBeNull();
    }
    const latest = { ...STATE, history: [{ url: "https://site.example/", title: "", at: 8.64e15, by: "user" }] };
    expect(parseBrowserWorkspaceState(latest)).toEqual(latest);
    expect(new Date(8.64e15).toISOString()).toBe("+275760-09-13T00:00:00.000Z");
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
  it("accepts a page status only for a listed tab, with a bounded host-classified failure", () => {
    const tab = { ...TARGET, url: "https://site.example/", title: "Site", zoomFactor: 1 };
    const failure = { reason: "dns", code: -105, detail: "ERR_NAME_NOT_RESOLVED", url: "https://missing.invalid/" };
    const state = { ...STATE, tabs: [tab], pages: [{ tabId: TARGET.tabId, loading: true, loadError: failure, prompts: [] }] };
    expect(parseBrowserWorkspaceState(state)).toEqual(state);
    expect(parseBrowserWorkspaceState({ ...state, pages: [{ tabId: TARGET.tabId, loading: false, loadError: null, prompts: [] }] })).not.toBeNull();
    expect(parseBrowserWorkspaceState({ ...state, pages: [{ tabId: TARGET.tabId, loading: false, loadError: { ...failure, url: "" }, prompts: [] }] })).not.toBeNull();
    for (const pages of [
      undefined, [{ tabId: "browser:other", loading: false, loadError: null, prompts: [] }], [{ tabId: TARGET.tabId, loading: false, prompts: [] }],
      [{ tabId: TARGET.tabId, loadError: null, prompts: [] }], [{ tabId: TARGET.tabId, loading: "yes", loadError: null, prompts: [] }],
      [{ tabId: TARGET.tabId, loading: false, loadError: { ...failure, reason: "page says so" }, prompts: [] }],
      [{ tabId: TARGET.tabId, loading: false, loadError: { ...failure, url: "javascript:alert(1)" }, prompts: [] }],
      [{ tabId: TARGET.tabId, loading: false, loadError: { ...failure, detail: "x".repeat(101) }, prompts: [] }],
      [{ tabId: TARGET.tabId, loading: false, loadError: { ...failure, html: "<b>" }, prompts: [] }],
      [{ tabId: TARGET.tabId, loading: false, loadError: null, prompts: [] }, { tabId: TARGET.tabId, loading: false, loadError: null, prompts: [] }],
    ]) expect(parseBrowserWorkspaceState({ ...state, pages })).toBeNull();
  });
  it("accepts only bounded, well-formed page prompts and answers of the matching kind", () => {
    const tab = { ...TARGET, url: "https://site.example/", title: "Site", zoomFactor: 1 };
    const prompt = { id: "prompt-1", kind: "permission", origin: "https://site.example", permissions: ["camera", "microphone"] };
    const withPrompts = (prompts: unknown) => ({ ...STATE, tabs: [tab], pages: [{ tabId: TARGET.tabId, loading: false, loadError: null, prompts }] });
    expect(parseBrowserWorkspaceState(withPrompts([prompt]))).not.toBeNull();
    for (const prompts of [
      [{ ...prompt, origin: "https://site.example/path" }], [{ ...prompt, permissions: [] }], [{ ...prompt, permissions: ["usb"] }],
      [{ ...prompt, kind: "page-defined" }], [{ ...prompt, html: "<b>" }], [prompt, prompt],
      Array.from({ length: 9 }, (_item, index) => ({ ...prompt, id: `prompt-${index}` })),
    ]) expect(parseBrowserWorkspaceState(withPrompts(prompts))).toBeNull();
    const answer = { tabId: "browser:one", promptId: "prompt-1", answer: { kind: "permission", choice: "always-block" } };
    expect(parseBrowserWorkspaceRequest("answerPrompt", answer)).toEqual(answer);
    for (const bad of [{ ...answer, answer: { kind: "permission", choice: "allow-forever" } }, { ...answer, answer: { kind: "other" } }, { ...answer, promptId: "" }, { ...answer, windowId: 2 }]) {
      expect(parseBrowserWorkspaceRequest("answerPrompt", bad)).toBeNull();
    }
  });
  it("accepts an external-link prompt only with a bare scheme and a bounded plain-text target", () => {
    const tab = { ...TARGET, url: "https://site.example/", title: "Site", zoomFactor: 1 };
    const prompt = { id: "prompt-1", kind: "external", origin: "https://site.example", scheme: "mailto", target: "someone@example.com", openable: true };
    const withPrompt = (value: unknown) => ({ ...STATE, tabs: [tab], pages: [{ tabId: TARGET.tabId, loading: false, loadError: null, prompts: [value] }] });
    expect(parseBrowserWorkspaceState(withPrompt(prompt))).not.toBeNull();
    for (const bad of [{ ...prompt, scheme: "Mailto" }, { ...prompt, scheme: "mailto:" }, { ...prompt, target: "x".repeat(201) }, { ...prompt, target: "a\nb" }, { ...prompt, openable: "yes" }, { ...prompt, url: "mailto:x" }]) {
      expect(parseBrowserWorkspaceState(withPrompt(bad))).toBeNull();
    }
    const answer = { tabId: "browser:one", promptId: "prompt-1", answer: { kind: "external", open: true } };
    expect(parseBrowserWorkspaceRequest("answerPrompt", answer)).toEqual(answer);
    expect(parseBrowserWorkspaceRequest("answerPrompt", { ...answer, answer: { kind: "external", open: "yes" } })).toBeNull();
  });
  it("accepts a sign-in prompt with a bounded plain realm, and an answer that is null or two bounded strings", () => {
    const tab = { ...TARGET, url: "https://site.example/", title: "Site", zoomFactor: 1 };
    const prompt = { id: "prompt-1", kind: "signIn", origin: "https://site.example", realm: "Staff area" };
    const withPrompt = (value: unknown) => ({ ...STATE, tabs: [tab], pages: [{ tabId: TARGET.tabId, loading: false, loadError: null, prompts: [value] }] });
    expect(parseBrowserWorkspaceState(withPrompt(prompt))).not.toBeNull();
    for (const bad of [{ ...prompt, realm: "x".repeat(101) }, { ...prompt, realm: "a\tb" }, { ...prompt, origin: "site.example" }, { ...prompt, username: "ken" }]) expect(parseBrowserWorkspaceState(withPrompt(bad))).toBeNull();
    const answer = (credentials: unknown) => ({ tabId: "browser:one", promptId: "prompt-1", answer: { kind: "signIn", credentials } });
    for (const good of [null, { username: "", password: "" }, { username: "ken", password: "p".repeat(256) }]) expect(parseBrowserWorkspaceRequest("answerPrompt", answer(good))).toEqual(answer(good));
    for (const bad of [undefined, "ken:secret", { username: "ken" }, { username: "ken", password: "p".repeat(257) }, { username: 1, password: "p" }, { username: "ken", password: "p", save: true }]) {
      expect(parseBrowserWorkspaceRequest("answerPrompt", answer(bad))).toBeNull();
    }
  });
  it("accepts a page dialog prompt only with a known type and bounded host-cleaned text", () => {
    const tab = { ...TARGET, url: "https://site.example/", title: "Site", zoomFactor: 1 };
    const prompt = { id: "prompt-1", kind: "dialog", origin: "https://site.example", dialog: "confirm", message: "Sure?\nPlease", canBlock: true };
    const withPrompt = (value: unknown) => ({ ...STATE, tabs: [tab], pages: [{ tabId: TARGET.tabId, loading: false, loadError: null, prompts: [value] }] });
    expect(parseBrowserWorkspaceState(withPrompt(prompt))).not.toBeNull();
    for (const bad of [{ ...prompt, dialog: "beforeunload" }, { ...prompt, dialog: "prompt" }, { ...prompt, message: "a\rb" }, { ...prompt, message: "x".repeat(2_001) }, { ...prompt, message: 1 }, { ...prompt, canBlock: "no" }, { ...prompt, html: "<b>" }]) {
      expect(parseBrowserWorkspaceState(withPrompt(bad))).toBeNull();
    }
    expect(browserDialogText(`a\r\nb\u0000\tc${"x".repeat(3_000)}`)).toBe(`a\nbc${"x".repeat(1_996)}`);
    const answer = (value: object) => ({ tabId: "browser:one", promptId: "prompt-1", answer: { kind: "dialog", accept: true, block: false, ...value } });
    expect(parseBrowserWorkspaceRequest("answerPrompt", answer({}))).toEqual(answer({}));
    for (const bad of [{ value: "typed" }, { accept: "yes" }, { block: 1 }]) expect(parseBrowserWorkspaceRequest("answerPrompt", answer(bad))).toBeNull();
  });
  it("accepts a request to open a link tab only for a web address and a named opener", () => {
    const request = { openerTabId: "browser:one", url: "https://other.example/page", active: true };
    expect(parseBrowserOpenTab(request)).toEqual(request);
    for (const bad of [{ ...request, url: "javascript:alert(1)" }, { ...request, url: "https://user:pw@other.example/" }, { ...request, openerTabId: "" }, { ...request, active: 1 }, { ...request, features: "popup" }]) {
      expect(parseBrowserOpenTab(bad)).toBeNull();
    }
  });
  it("accepts a clear-data request only with three booleans of which one is set, and a site request only with an origin", () => {
    expect(parseBrowserWorkspaceRequest("clearData", { history: true, siteData: false, cache: false })).toEqual({ history: true, siteData: false, cache: false });
    for (const bad of [{ history: false, siteData: false, cache: false }, { history: true, siteData: false }, { history: 1, siteData: false, cache: false }, { history: true, siteData: true, cache: true, passwords: true }]) {
      expect(parseBrowserWorkspaceRequest("clearData", bad)).toBeNull();
    }
    expect(parseBrowserWorkspaceRequest("clearSiteData", { ...TARGET, origin: "https://site.example" })).toEqual({ ...TARGET, origin: "https://site.example" });
    for (const bad of [{ ...TARGET, origin: "https://site.example/path" }, { ...TARGET }, { ...TARGET, origin: "https://site.example", windowId: 2 }]) expect(parseBrowserWorkspaceRequest("clearSiteData", bad)).toBeNull();
  });
  it("requires every history entry to say who visited, and lets the user and the agent each hold one entry per address", () => {
    const entry = { url: "https://site.example/", title: "Site", at: 1 };
    expect(parseBrowserWorkspaceState({ ...STATE, history: [{ ...entry, by: "user" }, { ...entry, by: "agent" }] })).not.toBeNull();
    for (const history of [[entry], [{ ...entry, by: "page" }], [{ ...entry, by: "user" }, { ...entry, by: "user" }]]) expect(parseBrowserWorkspaceState({ ...STATE, history })).toBeNull();
    expect(parseBrowserWorkspaceState({ ...STATE, bookmarks: [{ ...entry, by: "user" }] })).toBeNull();
    expect(parseBrowserWorkspaceRequest("deleteHistory", { url: "https://site.example/", by: "agent" })).toEqual({ url: "https://site.example/", by: "agent" });
    for (const bad of [{ url: "https://site.example/" }, { url: "https://site.example/", by: "page" }, { url: "site.example", by: "user" }]) expect(parseBrowserWorkspaceRequest("deleteHistory", bad)).toBeNull();
  });
});
