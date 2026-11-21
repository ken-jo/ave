// @vitest-environment jsdom
/** A dragged file row carries its path twice: as plain text for any text field, and under the mention type a composer turns
 * into an `@file` mention. */
import "../../../../../../test/renderer/setup.js";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FolderColumn } from "../FolderColumn.js";
import type { FolderColumnProps } from "../FolderColumn.js";
import { FILE_MENTION_DRAG_MIME } from "../../../../../shared/file-mention-reference.js";

function renderColumn() {
  const entry = (name: string, type: "file" | "directory") => ({ name, path: `/w/${name}`, type, size: 3, mtimeMs: 0, birthtimeMs: 0 });
  const props: FolderColumnProps = {
    column: { dir: "/w", status: "ok", entries: [entry("notes.md", "file"), entry("docs", "directory")], truncated: false, omitted: 0, hidden: 0 },
    index: 0,
    selectedPath: undefined,
    isCurrent: true,
    focusedPath: undefined,
    locked: new Set<string>(),
    onSelect: vi.fn(),
    onFocusRow: vi.fn(),
    onKey: vi.fn(),
    onRowMenu: vi.fn(),
    onRetry: vi.fn(),
    onReveal: vi.fn(),
    registerRow: vi.fn(),
  };
  render(<FolderColumn {...props} />);
}

function dragStart(name: string): Map<string, string> {
  const data = new Map<string, string>();
  const row = screen.getAllByTestId("folder-row").find((element) => element.getAttribute("data-path") === `/w/${name}`);
  if (!row) throw new Error(`no row for ${name}`);
  fireEvent.dragStart(row, { dataTransfer: { setData: (type: string, value: string) => data.set(type, value) } });
  return data;
}

describe("FolderColumn row drag data", () => {
  it("gives a file row the mention type beside plain text", () => {
    renderColumn();
    expect(Object.fromEntries(dragStart("notes.md"))).toEqual({
      "text/plain": "/w/notes.md",
      [FILE_MENTION_DRAG_MIME]: "/w/notes.md",
    });
  });

  it("keeps a folder row to plain text: a folder is not a file mention", () => {
    renderColumn();
    expect(Object.fromEntries(dragStart("docs"))).toEqual({ "text/plain": "/w/docs" });
  });
});
