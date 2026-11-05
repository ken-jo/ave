// @vitest-environment jsdom
import "../../../../../../test/renderer/setup.js";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { continuationGuides, TreeIndentGuides, treeGuides, treeIndentStyle } from "../tree-indent-guides.js";

describe("treeGuides", () => {
  it("gives a row one column per level above it: ancestor lines or blanks, then its own ├ or └", () => {
    // group
    //   ├ terminal
    //   │  ├ chat
    //   │  └ chat
    //   ├ chat
    //   └ terminal
    //      └ chat
    // group
    //   └ chat
    expect(treeGuides([1, 2, 3, 3, 2, 2, 3, 1, 2])).toEqual([
      [],
      ["mid"],
      ["line", "mid"],
      ["line", "last"],
      ["mid"],
      ["last"],
      ["blank", "last"],
      [],
      ["last"],
    ]);
  });

  it("ends every run of siblings at a break, as a time header does", () => {
    // In one project's list: entries are level 1, a terminal's pane chats level 2, and a header between buckets is 0.
    expect(treeGuides([0, 1, 2, 2, 0, 1, 2])).toEqual([[], [], ["mid"], ["last"], [], [], ["last"]]);
  });

  it("carries on, below a row, only the lines that run past it", () => {
    expect(continuationGuides(["line", "blank", "mid"])).toEqual(["line", "blank", "line"]);
    expect(continuationGuides(["line", "last"])).toEqual(["line", "blank"]);
  });

  it("indents by padding from the second level on", () => {
    expect(treeIndentStyle(1)).toBeUndefined();
    expect(treeIndentStyle(2)).toEqual({ paddingLeft: "1rem" });
    expect(treeIndentStyle(3, 0.5)).toEqual({ paddingLeft: "2.5rem" });
  });
});

describe("TreeIndentGuides", () => {
  it("draws nothing at the top level", () => {
    const { container } = render(<TreeIndentGuides guides={[]} />);
    expect(container.innerHTML).toBe("");
  });

  it("draws a vertical line, a blank, ├ and └ as hidden, click-through columns", () => {
    render(
      <div>
        <TreeIndentGuides guides={["line", "blank", "mid"]} />
        <TreeIndentGuides guides={["last"]} />
      </div>,
    );
    const strips = document.querySelectorAll<HTMLElement>('[data-testid="tree-indent-guides"]');
    expect(strips).toHaveLength(2);
    for (const each of strips) {
      expect(each.getAttribute("aria-hidden")).toBe("true");
      expect(each.className).toContain("pointer-events-none");
    }
    const [line, blank, mid] = [...strips[0]!.children] as HTMLElement[];
    expect([line, blank, mid].map((column) => column!.dataset.treeGuide)).toEqual(["line", "blank", "mid"]);
    for (const column of [line, blank, mid]) expect(column!.getAttribute("aria-hidden")).toBe("true");
    // A vertical line: one full-height left border.
    expect(line!.children).toHaveLength(1);
    expect(line!.firstElementChild!.className).toMatch(/\binset-y-0\b.*\bborder-l\b/);
    expect(blank!.children).toHaveLength(0);
    // ├: the full-height line plus an arm at the row's middle.
    expect(mid!.children).toHaveLength(2);
    expect(mid!.children[0]!.className).toContain("inset-y-0");
    expect(mid!.children[1]!.className).toContain("border-b");
    expect(mid!.children[1]!.className).not.toContain("border-l");
    // └: down to the middle and right, one element.
    const last = strips[1]!.firstElementChild as HTMLElement;
    expect(last.dataset.treeGuide).toBe("last");
    expect(last.children).toHaveLength(1);
    expect(last.firstElementChild!.className).toMatch(/border-b.*border-l|border-l.*border-b/);
  });
});
