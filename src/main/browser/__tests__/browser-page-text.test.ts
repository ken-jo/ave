import { describe, expect, it } from "vitest";
import { readablePageText } from "../browser-page-text.js";
import type { AXNode } from "../browser-snapshot.js";
import { BROWSER_OUTPUT_MAX_CHARS } from "../../../shared/browser-tools.js";

function node(nodeId: string, role: string, name: string, childIds: string[] = [], ignored = false): AXNode {
  return { nodeId, role: { value: role }, name: { value: name }, childIds, ignored };
}

describe("readable page text", () => {
  it("prefers main text, excludes navigation, ignored text and frame contents, and avoids inline duplication", () => {
    const nodes = [node("root", "RootWebArea", "News", ["nav", "main", "frame"]), node("nav", "StaticText", "Subscribe"),
      node("main", "main", "", ["heading", "hidden", "story"]), node("heading", "heading", "Headline", ["text"]),
      node("text", "StaticText", "Headline", ["inline"]), node("inline", "InlineTextBox", "Headline"),
      node("hidden", "StaticText", "Private content", [], true), node("story", "StaticText", "First   story\ncontinues"),
      node("frame", "Iframe", "Ad", ["frame-root"]), node("frame-root", "RootWebArea", "Ad", ["ad"]), node("ad", "StaticText", "Frame text")];
    expect(readablePageText(nodes)).toEqual({ text: "Headline\nFirst story continues", truncated: false });
  });

  it("reads articles without main and retains an exposed consent message without hidden page text", () => {
    expect(readablePageText([node("root", "RootWebArea", "Page", ["nav", "article"]), node("nav", "StaticText", "Menu"),
      node("article", "article", "", ["story"]), node("story", "StaticText", "Article")]).text).toBe("Article");
    expect(readablePageText([node("root", "RootWebArea", "News", ["hidden", "dialog"]),
      node("hidden", "StaticText", "Hidden headline", [], true), node("dialog", "StaticText", "Please choose consent")]).text).toBe("Please choose consent");
  });

  it("bounds huge text without splitting a surrogate pair and accepts an empty tree", () => {
    const text = `${"x".repeat(BROWSER_OUTPUT_MAX_CHARS - 1)}🌍`;
    const result = readablePageText([node("root", "RootWebArea", "", ["text"]), node("text", "StaticText", text)]);
    expect(result).toEqual({ text: text.slice(0, BROWSER_OUTPUT_MAX_CHARS - 1), truncated: true });
    expect(readablePageText([])).toEqual({ text: "", truncated: false });
  });
});
