// Browser tools may use only allow-listed CDP methods; uploads require picker approval and privileged page data stays inaccessible.
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = resolve(__dirname, "../../../..");

const MODULES = [
  ...readdirSync(join(REPO, "src/main/browser"))
    .filter((name) => name.endsWith(".ts"))
    .map((name) => `src/main/browser/${name}`),
  "src/tools/browser-tools.ts",
  "src/tools/browser-tools-execute.ts",
];

const ALLOWED_CDP_METHODS = new Set([
  "Accessibility.enable",
  "Accessibility.getFullAXTree",
  "Accessibility.getPartialAXTree",
  "DOM.enable",
  "DOM.getDocument",
  "DOM.performSearch",
  "DOM.discardSearchResults",
  "DOM.describeNode",
  "DOM.focus",
  "DOM.setFileInputFiles",
  "DOM.scrollIntoViewIfNeeded",
  "DOM.getContentQuads",
  "DOM.getBoxModel",
  "DOM.getNodeForLocation",
  "Input.dispatchMouseEvent",
  "Input.dispatchTouchEvent",
  "Input.dispatchKeyEvent",
  "Input.insertText",
  "Input.setInterceptDrags",
  "Input.dragIntercepted",
  "Input.dispatchDragEvent",
  "Input.cancelDragging",
  "Page.enable",
  "Page.captureScreenshot",
  "Emulation.setDeviceMetricsOverride",
  "Emulation.clearDeviceMetricsOverride",
  "Page.getFrameTree",
  "Page.getLayoutMetrics",
  "Page.frameNavigated",
  "Page.frameDetached",
  "Page.frameRequestedNavigation",
  "Page.frameStartedNavigating",
  "DOM.documentUpdated",
]);

// `"Domain.method"` string literals: every CDP method name these modules spell.
const CDP_LITERAL = /["'`]([A-Z][A-Za-z]+\.[a-z][A-Za-z]+)["'`]/g;

describe("browser tool CDP surface", () => {
  it("covers the expected modules", () => {
    expect(MODULES).toEqual(expect.arrayContaining([
      "src/main/browser/browser-actions.ts",
      "src/main/browser/browser-snapshot.ts",
      "src/main/browser/browser-tab-registry.ts",
    ]));
  });

  it.each(MODULES)("%s names only allow-listed DevTools methods", (path) => {
    const source = readFileSync(join(REPO, path), "utf8");
    const layoutProbe = path === "src/main/browser/browser-layout-probe.ts";
    if (layoutProbe) {
      expect(source.match(/session\.send\(/g)).toHaveLength(1);
      expect(source).toContain(`expression: "({ width: innerWidth, height: innerHeight, visible: document.visibilityState !== 'hidden' })", returnByValue: true`);
      expect(source.match(/expression:/g)).toHaveLength(1);
      expect(source).toContain('browserLayoutReady(session: CdpSession)');
    }
    const named = [...source.matchAll(CDP_LITERAL)].flatMap((match) => match[1] === undefined ? [] : [match[1]]);
    const siteNavigation = path === "src/main/browser/browser-site-navigation.ts";
    const siteMethods = new Set(["Fetch.requestPaused", "Fetch.continueRequest", "Fetch.failRequest", "Fetch.enable"]);
    const selection = path === "src/main/browser/browser-actions.ts" || path === "src/main/browser/browser-action-guard.ts";
    const captureScroll = new Set([
      "src/main/browser/browser-capture-scroll.ts",
      "src/main/browser/browser-capture.ts",
      "src/main/browser/browser-workspace-capture.ts",
    ]);
    const selectionMethods = new Set(["Page.createIsolatedWorld", "DOM.resolveNode", "Runtime.callFunctionOn", "Runtime.releaseObject"]);
    expect(named.filter((method) => !ALLOWED_CDP_METHODS.has(method) && !(siteNavigation && siteMethods.has(method))
      && !(selection && selectionMethods.has(method)) && !(path === "src/main/browser/browser-actions.ts" && method === "Emulation.setFocusEmulationEnabled")
      && !(layoutProbe && method === "Runtime.evaluate")
      && !(captureScroll.has(path) && ["Page.createIsolatedWorld", "Runtime.callFunctionOn"].includes(method)))).toEqual([]);
    for (const forbidden of [
      /\bRuntime\./,
      /\bNetwork\./,
      /\bStorage\./,
      /\bFetch\./,
      /\bsetDownloadBehavior\b/,

      /\bexecuteJavaScript\b/,
      /\.cookies\b/,
    ]) {
      if (layoutProbe && forbidden.source === "\\bRuntime\\.") continue;
      if (siteNavigation && forbidden.source === "\\bFetch\\.") continue;
      let checked = selection ? source.replace(/(["'])Runtime\.(?:callFunctionOn|releaseObject)\1/g, '""') : source;
      if (captureScroll.has(path)) {
        expect(source).toContain("captureScrollParameters(");
        checked = checked.replace(/(["'])Runtime\.callFunctionOn\1/g, '""');
      }
      expect(checked, `${path} must not use ${forbidden}`).not.toMatch(forbidden);
    }
  });

  it("restricts the file effect to broker-produced paths and a live file input", () => {
    const actions = readFileSync(join(REPO, "src/main/browser/browser-actions.ts"), "utf8");
    const guard = readFileSync(join(REPO, "src/main/browser/browser-action-guard.ts"), "utf8");
    const execute = readFileSync(join(REPO, "src/tools/browser-tools-execute.ts"), "utf8");
    expect(actions.match(/send\("DOM\.setFileInputFiles"/g)).toHaveLength(1);
    expect(actions).toContain("selection.dispatch(options");
    expect(guard).toContain('const upload = method === "DOM.setFileInputFiles"');
    expect(guard).toContain('mainDocumentContainsNode(document.root, inputNode)');
    expect(guard).toContain('described.node?.nodeName?.toUpperCase() !== "INPUT"');
    expect(execute).toContain('[BROWSER_TOOL.upload]: ["tabId", "ref"]');
  });

  it("keeps dynamic dispatch confined to the checked session adapter", () => {
    const source = readFileSync(join(REPO, "src/main/browser/browser-actions.ts"), "utf8");
    const sends = [...source.matchAll(/\.send\(\s*([^,)]+)/g)].flatMap((match) => match[1] === undefined ? [] : [match[1].trim()]);
    expect(sends.length).toBeGreaterThan(10);
    // The one pass-through is the session wrapper that forwards to webContents.debugger.
    expect(sends.filter((argument) => !/^"[A-Z][A-Za-z]+\.[a-z][A-Za-z]+"$/.test(argument))).toEqual(["method", "method"]);
    expect(source).toContain("const sent = session.send(method, params);");
  });

  it("limits direct session calls to focus preparation, main-document proof and sequence teardown", () => {
    const source = readFileSync(join(REPO, "src/main/browser/browser-actions.ts"), "utf8");
    const start = source.indexOf("async function targetFor(");
    const body = source.slice(start, source.indexOf("\n}\n", start));
    // Direct focus setup and cleanup route no OS input; all interactive effects still use the checked wrapper.
    expect([...body.matchAll(/session\.send\("[^"]+"[^)]*\)/g)].map((match) => match[0])).toEqual([
      'session.send("Emulation.setFocusEmulationEnabled", { enabled: true })',
      'session.send("Runtime.callFunctionOn", captureScrollParameters(position, false)',
      'session.send("DOM.getDocument", { depth: -1, pierce: true })',
      'session.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] })',
      'session.send("Input.dispatchDragEvent", { type: "dragCancel", ...destination })',
      'session.send("Input.cancelDragging")',
      'session.send("Input.setInterceptDrags", { enabled: false })',
      'session.send("Emulation.setFocusEmulationEnabled", { enabled: false })',
    ]);
  });

  it("keeps capture scrolling in a fixed isolated-world function", () => {
    const scroll = readFileSync(join(REPO, "src/main/browser/browser-capture-scroll.ts"), "utf8");
    const capture = readFileSync(join(REPO, "src/main/browser/browser-capture.ts"), "utf8");
    const workspace = readFileSync(join(REPO, "src/main/browser/browser-workspace-capture.ts"), "utf8");
    const actions = readFileSync(join(REPO, "src/main/browser/browser-actions.ts"), "utf8");
    expect(scroll).toContain('const CAPTURE_SCROLL = "function(x,y,paint)');
    expect(scroll).toContain('cdp.send("Runtime.callFunctionOn", captureScrollParameters(position, true))');
    for (const [source, restore] of [[capture, 'captureScrollParameters(scrollRestore, false)'], [workspace, 'captureScrollParameters(position, false)'], [actions, 'captureScrollParameters(position, false)']] as const) {
      expect(source).toContain(restore);
      expect(source).not.toMatch(/Runtime\.callFunctionOn[^\n]*functionDeclaration:/);
      expect(source).not.toMatch(/Runtime\.callFunctionOn[^\n]*expression:/);
    }
  });
});
