/**
 * The agent browser tools reach pages only through an allow-list of DevTools
 * methods: accessibility reads, DOM node lookups, synthesized input and a
 * screenshot. No script evaluation, cookies, storage, network bodies,
 * downloads or file uploads — not as tools, and not as CDP calls a tool
 * could make on the model's behalf.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = resolve(__dirname, "../../../..");

const MODULES = [
  ...readdirSync(join(REPO, "src/main/browser"))
    .filter((name) => name.endsWith(".ts"))
    .map((name) => join("src/main/browser", name)),
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
  "DOM.scrollIntoViewIfNeeded",
  "DOM.getContentQuads",
  "DOM.getNodeForLocation",
  "Input.dispatchMouseEvent",
  "Input.dispatchTouchEvent",
  "Input.dispatchKeyEvent",
  "Input.insertText",
  "Page.enable",
  "Page.captureScreenshot",
  "Page.getFrameTree",
  "Page.getLayoutMetrics",
  "Page.frameNavigated",
  "Page.frameDetached",
  "DOM.documentUpdated",
]);

/** `"Domain.method"` string literals: every CDP method name these modules spell. */
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
      /\bsetFileInputFiles\b/,
      /\bexecuteJavaScript\b/,
      /\.cookies\b/,
    ]) {
      expect(source, `${path} must not use ${forbidden}`).not.toMatch(forbidden);
    }
  });

  it("keeps dynamic dispatch confined to the checked session adapter", () => {
    const source = readFileSync(join(REPO, "src/main/browser/browser-actions.ts"), "utf8");
    const sends = [...source.matchAll(/\.send\(\s*([^,)]+)/g)].map((match) => match[1]!.trim());
    expect(sends.length).toBeGreaterThan(10);
    // The one pass-through is the session wrapper that forwards to webContents.debugger.
    expect(sends.filter((argument) => !/^"[A-Z][A-Za-z]+\.[a-z][A-Za-z]+"$/.test(argument))).toEqual(["method"]);
    expect(source).toContain("await session.send(method, params)");
  });
});
