// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreviewBody } from "../../components/ChatSidePanelPreview.js";
import { resolveFilePreviewRoute } from "../preview-renderers.js";
import { columnLetters } from "../table-document-grid.js";
import { tableErrorKey } from "../table-document-preview.js";
import type { ChatPreviewTarget } from "../preview-targets.js";
import type { PreviewReadDocumentResult, PreviewTableDocument } from "../../../../shared/preview-document.js";

describe("resolveFilePreviewRoute", () => {
  it.each([
    ["/w/data.csv", "csv"],
    ["/w/data.TSV", "tsv"],
    ["C:\\w\\Budget.xlsx", "xlsx"],
    ["/w/old.xls", "xls"],
    ["report.ods", "ods"],
  ])("routes %s to the table viewer as %s", (path, format) => {
    expect(resolveFilePreviewRoute(path)).toEqual({ kind: "table", format });
  });

  it.each(["/w/notes.md", "/w/flow.mmd", "/w/data.csv.bak", "/w/.csv", "/w/csv", "/w/sheet.xlsm", "/w/deck.pptx", "/w/a.constructor", "/w/a.toString"])(
    "keeps %s on the text path",
    (path) => {
      expect(resolveFilePreviewRoute(path)).toEqual({ kind: "text" });
    },
  );
});

describe("columnLetters", () => {
  it("labels columns like a spreadsheet", () => {
    expect([0, 1, 25, 26, 27, 51, 52, 701, 702].map(columnLetters))
      .toEqual(["A", "B", "Z", "AA", "AB", "AZ", "BA", "ZZ", "AAA"]);
  });
});

describe("tableErrorKey", () => {
  it("gives every refusal its own message", () => {
    expect(tableErrorKey("archive-too-large")).toBe("chatPreviewRail.tableErrorArchiveTooLarge");
    expect(tableErrorKey("corrupt-document")).toBe("chatPreviewRail.tableErrorCorrupt");
    expect(tableErrorKey("too-large")).toBe("chatPreviewRail.tableErrorTooLarge");
    expect(tableErrorKey("unsupported-encoding")).toBe("chatPreviewRail.tableErrorEncoding");
    expect(tableErrorKey("encrypted")).toBe("chatPreviewRail.tableErrorEncrypted");
  });
});

function fileTarget(path: string): ChatPreviewTarget {
  return {
    id: `file:${path}`,
    kind: "file",
    title: path.split("/").pop() ?? path,
    sourceLabel: "read_file",
    createdOrder: 0,
    path,
    canOpenExternal: false,
  };
}

function workbookResult(sheetIndex: number): PreviewReadDocumentResult {
  const sheets: PreviewTableDocument["sheet"][] = [
    {
      index: 0,
      name: "Sales",
      rows: [["Region", "Total"], ["North", "120"]],
      firstRow: 0,
      firstColumn: 0,
      totalRows: 25_000,
      totalColumns: 2,
      rowsTruncated: true,
      columnsTruncated: false,
      cellsTruncated: false,
    },
    {
      index: 1,
      name: "Notes",
      rows: [["<b>not markup</b>"]],
      firstRow: 0,
      firstColumn: 0,
      totalRows: 1,
      totalColumns: 1,
      rowsTruncated: false,
      columnsTruncated: false,
      cellsTruncated: false,
    },
  ];
  return {
    ok: true,
    path: "/w/book.xlsx",
    bytes: 4096,
    document: {
      format: "xlsx",
      sheetNames: ["Sales", "Notes"],
      totalSheets: 2,
      sheetsTruncated: false,
      sheet: sheets[sheetIndex]!,
    },
  };
}

let readFile: ReturnType<typeof vi.fn>;
let readDocument: ReturnType<typeof vi.fn>;
let previousAve: unknown;

beforeEach(() => {
  previousAve = (window as unknown as { ave?: unknown }).ave;
  readFile = vi.fn(async () => ({ ok: true, content: "# hi", path: "/w/notes.md", truncated: false }));
  readDocument = vi.fn(async (_path: string, sheetIndex: number) => workbookResult(sheetIndex));
  (window as unknown as { ave: unknown }).ave = {
    preview: { readFile, readDocument },
    attach: { openExternal: vi.fn() },
  };
});

afterEach(() => {
  (window as unknown as { ave?: unknown }).ave = previousAve;
});

describe("file preview routing", () => {
  it("reads a workbook through readDocument, never readFile, and shows tabs, banner and grid", async () => {
    render(<PreviewBody api={{} as never} target={fileTarget("/w/book.xlsx")} />);
    await screen.findByTestId("chat-side-panel-table-preview");
    expect(readDocument).toHaveBeenCalledWith("/w/book.xlsx", 0);
    expect(readFile).not.toHaveBeenCalled();

    const tabs = screen.getAllByTestId("chat-side-panel-table-sheet-tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Sales", "Notes"]);
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("chat-side-panel-table-truncated").textContent).toMatch(/2.*25,?000|25,?000.*2/);
    const grid = await screen.findByTestId("chat-side-panel-table-grid");
    expect(grid.getAttribute("role")).toBe("grid");
    expect(grid.textContent).toContain("Region");

    await act(async () => {
      fireEvent.click(tabs[1]!);
    });
    await waitFor(() => expect(readDocument).toHaveBeenLastCalledWith("/w/book.xlsx", 1));
    const notesGrid = await screen.findByTestId("chat-side-panel-table-grid");
    await waitFor(() => expect(notesGrid.textContent).toContain("<b>not markup</b>"));
    expect(notesGrid.querySelector("b")).toBeNull();
    expect(screen.queryByTestId("chat-side-panel-table-truncated")).toBeNull();
  });

  it("shows the refusal message for a rejected document", async () => {
    readDocument.mockResolvedValueOnce({ ok: false, error: "archive-too-large", message: "x" });
    render(<PreviewBody api={{} as never} target={fileTarget("/w/bomb.xlsx")} />);
    const error = await screen.findByTestId("chat-side-panel-file-error");
    expect(error.textContent).not.toBe("");
    expect(error.textContent).not.toContain("chatPreviewRail.");
  });

  it("keeps markdown on the text readFile path", async () => {
    render(<PreviewBody api={{} as never} target={fileTarget("/w/notes.md")} />);
    await waitFor(() => expect(readFile).toHaveBeenCalledWith("/w/notes.md"));
    expect(readDocument).not.toHaveBeenCalled();
  });
});
