import { describe, expect, it } from "vitest";
import { editDiffView, type FileEditDiffData } from "../utils/file-diff.js";

const twentyLines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");

function edit(hunks: FileEditDiffData["hunks"]): FileEditDiffData {
  return { path: "/work/a.ts", tool: hunks.length > 1 ? "multi_edit" : "edit_file", hunks };
}

describe("editDiffView", () => {
  it("counts only the lines that changed inside a replaced block", () => {
    const view = editDiffView(edit([{ oldText: twentyLines, newText: twentyLines.replace("line 10", "line ten") }]));
    expect({ added: view.added, removed: view.removed }).toEqual({ added: 1, removed: 1 });
    expect(view.hunks[0].rows.filter(row => row.kind === "context")).toHaveLength(6);
  });

  it("does not count a trailing newline as an extra changed line", () => {
    const view = editDiffView(edit([{ oldText: "a\nb\nc\n", newText: "x\ny\nz\n" }]));
    expect({ added: view.added, removed: view.removed }).toEqual({ added: 3, removed: 3 });
  });

  it("sums every replacement of a multi-edit", () => {
    const view = editDiffView(edit([{ oldText: "a", newText: "b" }, { oldText: "c\nd", newText: "c" }]));
    expect({ added: view.added, removed: view.removed }).toEqual({ added: 1, removed: 2 });
    expect(view.hunks).toHaveLength(2);
  });

  it("prefers the whole-file comparison when the host supplied one", () => {
    const whole = { hunks: [], added: 7, removed: 2, truncated: false };
    expect(editDiffView({ ...edit([{ oldText: "a", newText: "b" }]), view: whole })).toBe(whole);
  });

  it("bounds a very large replacement and says so", () => {
    const big = Array.from({ length: 1_000 }, (_, index) => `new ${index}`).join("\n");
    const view = editDiffView(edit([{ oldText: "", newText: big }]));
    expect(view.truncated).toBe(true);
    expect(view.added).toBe(1_000);
    expect(view.hunks[0].rows).toHaveLength(400);
  });
});
