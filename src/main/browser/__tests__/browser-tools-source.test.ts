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
    const named = [...source.matchAll(CDP_LITERAL)].map((match) => match[1]!);
    expect(named.filter((method) => !ALLOWED_CDP_METHODS.has(method))).toEqual([]);
    for (const forbidden of [
      /\bRuntime\./,
      /\bNetwork\./,
      /\bStorage\./,
      /\bFetch\./,
      /\bsetDownloadBehavior\b/,

      /\bexecuteJavaScript\b/,
      /\.cookies\b/,
    ]) {
      expect(source, `${path} must not use ${forbidden}`).not.toMatch(forbidden);
    }
  });

  it("restricts the file effect to broker-produced paths and a live file input", () => {
    const actions = readFileSync(join(REPO, "src/main/browser/browser-actions.ts"), "utf8");
    const guard = readFileSync(join(REPO, "src/main/browser/browser-action-guard.ts"), "utf8");
    const execute = readFileSync(join(REPO, "src/tools/browser-tools-execute.ts"), "utf8");
    expect(actions.match(/send\("DOM\.setFileInputFiles"/g)).toHaveLength(1);
    expect(actions).toContain("selection.dispatch(options");
    expect(guard).toContain('const upload = method === "DOM.setFileInputFiles"');
    expect(guard).toContain('containsNode(document.root, inputNode)');
    expect(guard).toContain('described.node?.nodeName?.toUpperCase() !== "INPUT"');
    expect(execute).toContain('[BROWSER_TOOL.upload]: ["tabId", "ref"]');
  });

  it("keeps dynamic dispatch confined to the checked session adapter", () => {
    const source = readFileSync(join(REPO, "src/main/browser/browser-actions.ts"), "utf8");
    const sends = [...source.matchAll(/\.send\(\s*([^,)]+)/g)].map((match) => match[1]!.trim());
    expect(sends.length).toBeGreaterThan(10);
    // The one pass-through is the session wrapper that forwards to webContents.debugger.
    expect(sends.filter((argument) => !/^"[A-Z][A-Za-z]+\.[a-z][A-Za-z]+"$/.test(argument))).toEqual(["method"]);
    expect(source).toContain("const sent = session.send(method, params);");
  });

  it("limits unguarded input to noninteractive sequence teardown", () => {
    const source = readFileSync(join(REPO, "src/main/browser/browser-actions.ts"), "utf8");
    const start = source.indexOf("async function targetFor(");
    const body = source.slice(start, source.indexOf("\n}\n", start));
    // In the adapter every page call goes through the checked wrapper except this one, which presses nothing: it only ends the window's open sequence.
    expect([...body.matchAll(/session\.send\("[^"]+"[^)]*\)/g)].map((match) => match[0])).toEqual([
      'session.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] })',
      'session.send("Input.dispatchDragEvent", { type: "dragCancel", ...destination })',
      'session.send("Input.cancelDragging")',
      'session.send("Input.setInterceptDrags", { enabled: false })',
    ]);
  });
});
