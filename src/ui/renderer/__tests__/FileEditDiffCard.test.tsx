// @vitest-environment jsdom
import "../../../../test/renderer/setup.js";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { FileEditDiff } from "../components/FileEditDiff.js";
import type { FileEditDiffData } from "../utils/file-diff.js";

/** A tool card is a line diff, not a removed block followed by an added block. */
const twentyLines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");

function renderCard(data: FileEditDiffData) {
  render(<FileEditDiff data={data} />);
  return screen.getByTestId("file-edit-diff");
}

const kinds = (card: HTMLElement) => [...card.querySelectorAll("[data-diff-kind]")].map(row => row.getAttribute("data-diff-kind"));

describe("FileEditDiff tool card", () => {
  it("shows one removed and one added line with context for a one-token edit", () => {
    const card = renderCard({ path: "/work/a.ts", tool: "edit_file", hunks: [{ oldText: twentyLines, newText: twentyLines.replace("line 10", "line ten") }] });
    expect(card).toHaveAttribute("data-added", "1");
    expect(card).toHaveAttribute("data-removed", "1");
    expect(kinds(card)).toEqual(["context", "context", "context", "removed", "added", "context", "context", "context"]);
    expect(card).toHaveTextContent("+1");
    expect(card).toHaveTextContent("−1");
  });

  it("shows no line numbers when only the replaced text is known", () => {
    const card = renderCard({ path: "/work/a.ts", tool: "edit_file", hunks: [{ oldText: "a\nb\nc\n", newText: "x\ny\nz\n" }] });
    expect(card).toHaveAttribute("data-added", "3");
    expect(card).toHaveAttribute("data-removed", "3");
    expect(card.querySelectorAll("[data-line-column]")).toHaveLength(0);
  });

  it("numbers both columns from the real file lines when the whole file was compared", () => {
    const card = renderCard({
      path: "/work/a.ts", tool: "edit_file", hunks: [],
      view: {
        added: 1, removed: 1, truncated: false,
        hunks: [{ oldStart: 41, newStart: 43, oldCount: 2, newCount: 2, rows: [
          { kind: "context", text: "keep" }, { kind: "removed", text: "old" }, { kind: "added", text: "new" },
        ] }],
      },
    });
    const columns = (side: string) => [...card.querySelectorAll(`[data-line-column="${side}"]`)].map(cell => cell.textContent);
    expect(columns("old")).toEqual(["41", "42", ""]);
    expect(columns("new")).toEqual(["43", "", "44"]);
    expect(screen.getByTestId("file-diff-hunk-header")).toHaveTextContent("@@ -41,2 +43,2 @@");
  });

  it("says when only line endings changed", () => {
    const card = renderCard({ path: "/work/a.ts", tool: "edit_file", hunks: [{ oldText: "a\r\nb\r\n", newText: "a\nb\n" }] });
    expect(screen.getByTestId("file-diff-empty")).toHaveTextContent(/line endings|줄바꿈/);
    expect(kinds(card)).toEqual([]);
  });
});
