// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreviewBody } from "../../components/ChatSidePanelPreview.js";
import { resolveFilePreviewRoute } from "../preview-renderers.js";
import { columnLetters, horizontalScrollbarBlockPx, tableGridBlockStyle } from "../table-document-grid.js";
import { tableErrorKey } from "../table-document-preview.js";
import type { ChatPreviewTarget } from "../preview-targets.js";
import type { PreviewReadDocumentResult, PreviewTableDocument } from "../../../../shared/preview-document.js";

describe("resolveFilePreviewRoute", () => {
  it.each([["/w/deck.PPTX", "pptx"], ["C:\\w\\document.pdf", "pdf"]])("routes %s to the page viewer", (path, format) => {
    expect(resolveFilePreviewRoute(path)).toEqual({ kind: "page", format });
  });
  it.each([
    ["/w/data.csv", "csv"],
    ["/w/data.TSV", "tsv"],
    ["C:\\w\\Budget.xlsx", "xlsx"],
    ["/w/old.xls", "xls"],
    ["report.ods", "ods"],
  ])("routes %s to the table viewer as %s", (path, format) => {
    expect(resolveFilePreviewRoute(path)).toEqual({ kind: "table", format });
  });

  it.each(["/w/notes.md", "/w/flow.mmd", "/w/data.csv.bak", "/w/.csv", "/w/csv", "/w/sheet.xlsm", "/w/a.constructor", "/w/a.toString"])(
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

describe("tableGridBlockStyle", () => {
  it("takes the panel's remaining height instead of a fixed viewport share", () => {
    // header 26 + 5000 rows x 24 + 2px border; shrinks down to header + two rows.
    expect(tableGridBlockStyle(5000, 0)).toEqual({ flex: "1 1 0", minBlockSize: "76px", maxBlockSize: "120028px" });
  });

  it("never grows past its rows, so a short sheet shows no scrollbar", () => {
    expect(tableGridBlockStyle(5, 0)).toEqual({ flex: "1 1 0", minBlockSize: "76px", maxBlockSize: "148px" });
    expect(tableGridBlockStyle(1, 0)).toEqual({ flex: "1 1 0", minBlockSize: "52px", maxBlockSize: "52px" });
  });

  it("makes room for a wide sheet's classic horizontal scrollbar on both bounds", () => {
    expect(tableGridBlockStyle(5, 10)).toEqual({ flex: "1 1 0", minBlockSize: "86px", maxBlockSize: "158px" });
    // One row stays visible above the bar instead of hiding behind it.
    expect(tableGridBlockStyle(1, 15)).toEqual({ flex: "1 1 0", minBlockSize: "67px", maxBlockSize: "67px" });
  });
});

describe("horizontalScrollbarBlockPx", () => {
  function box(offsetHeight: number, clientHeight: number, border: string): HTMLElement {
    const element = document.createElement("div");
    element.style.borderTopWidth = border;
    element.style.borderBottomWidth = border;
    element.style.borderStyle = "solid";
    Object.defineProperty(element, "offsetHeight", { value: offsetHeight });
    Object.defineProperty(element, "clientHeight", { value: clientHeight });
    document.body.append(element);
    return element;
  }

  it("is the bar's height when the columns overflow and 0 when they fit", () => {
    expect(horizontalScrollbarBlockPx(box(60, 48, "1px"))).toBe(10);
    expect(horizontalScrollbarBlockPx(box(60, 58, "1px"))).toBe(0);
  });
});

describe("tableErrorKey", () => {
  it("gives every refusal its own message", () => {
    expect(tableErrorKey("archive-too-large")).toBe("chatPreviewRail.tableErrorArchiveTooLarge");
    expect(tableErrorKey("corrupt-document")).toBe("chatPreviewRail.tableErrorCorrupt");
    expect(tableErrorKey("too-large")).toBe("chatPreviewRail.tableErrorTooLarge");
    expect(tableErrorKey("unsupported-encoding")).toBe("chatPreviewRail.tableErrorEncoding");
    expect(tableErrorKey("encrypted")).toBe("chatPreviewRail.tableErrorEncrypted");
    expect(tableErrorKey("parse-limit")).toBe("chatPreviewRail.tableErrorParseLimit");
    expect(tableErrorKey("busy")).toBe("chatPreviewRail.tableErrorBusy");
    expect(tableErrorKey("invalid-index")).toBe("formatIpcError.invalidIndex");
    expect(tableErrorKey("page-not-found")).toBe("pagePreview.notFound");
    expect(tableErrorKey("renderer-unavailable")).toBe("pagePreview.rendererUnavailable");
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
      cellsTruncated: false, clippedCells: [],
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
      cellsTruncated: false, clippedCells: [],
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
      needsRecalculation: false,
      sheet: sheets[sheetIndex]!,
    },
  };
}

function pageResult(path: string, index: number, totalPages = 2): PreviewReadDocumentResult {
  return { ok: true, path, bytes: 1024, document: {
    format: "pptx", totalPages, pagesTruncated: false,
    page: { index, paragraphs: [`Outline ${index + 1}`], textTruncated: false, png: null, width: 0, height: 0 },
  } };
}

let readFile: ReturnType<typeof vi.fn>;
let readDocument: ReturnType<typeof vi.fn>;
let editXlsx: ReturnType<typeof vi.fn>;
let previousAve: unknown;

beforeEach(() => {
  previousAve = (window as unknown as { ave?: unknown }).ave;
  readFile = vi.fn(async () => ({ ok: true, content: "# hi", path: "/w/notes.md", truncated: false }));
  readDocument = vi.fn(async (_path: string, sheetIndex: number) => workbookResult(sheetIndex));
  editXlsx = vi.fn(async (request) => ({ ok: true, action: request.action }));
  (window as unknown as { ave: unknown }).ave = {
    preview: { readFile, readDocument, editXlsx },
    attach: { openExternal: vi.fn() },
  };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  (window as unknown as { ave?: unknown }).ave = previousAve;
});

describe("file preview routing", () => {
  it("renders a recalculation badge for stale workbook caches", async () => {
    const result = workbookResult(0);
    if (result.ok && "sheet" in result.document) result.document.needsRecalculation = true;
    readDocument.mockResolvedValueOnce(result);
    render(<PreviewBody api={{} as never} target={fileTarget("/w/book.xlsx")} />);
    const badge = await screen.findByTestId("chat-side-panel-table-recalculation");
    expect(badge.textContent).toMatch(/^(Needs recalculation|재계산 필요)$/);
    expect(badge.getAttribute("title")).toMatch(/stale|이전 값/);
  });

  it("omits the recalculation badge for an ordinary workbook", async () => {
    render(<PreviewBody api={{} as never} target={fileTarget("/w/book.xlsx")} />);
    await screen.findByTestId("chat-side-panel-table-preview");
    expect(screen.queryByTestId("chat-side-panel-table-recalculation")).toBeNull();
  });

  it("shows a replaced page request as a recoverable error", async () => {
    const path = "/w/slides.pptx";
    readDocument.mockResolvedValueOnce({ ok: false, error: "superseded", message: "private supersession detail" })
      .mockResolvedValueOnce(pageResult(path, 0));
    render(<PreviewBody api={{} as never} target={fileTarget(path)} />);
    const error = await screen.findByTestId("chat-side-panel-file-error");
    expect(error.textContent).toMatch(/replaced|취소/);
    expect(error.textContent).not.toContain("private supersession detail");
    fireEvent.click(screen.getByRole("button", { name: /Retry|다시 시도/ }));
    await screen.findByText("Outline 1");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(readDocument).toHaveBeenCalledTimes(2);
    expect(readFile).not.toHaveBeenCalled();
  });

  it("opens another page document at its first page after navigation", async () => {
    readDocument.mockImplementation(async (path: string, index: number) => pageResult(path, index, path.endsWith("short.pptx") ? 1 : 2));
    const view = render(<PreviewBody api={{} as never} target={fileTarget("/w/slides.pptx")} />);
    await screen.findByText("Outline 1");
    fireEvent.click(screen.getByRole("button", { name: /Next|다음/ }));
    await screen.findByText("Outline 2");
    view.rerender(<PreviewBody api={{} as never} target={fileTarget("/w/short.pptx")} />);
    await screen.findByText("Outline 1");
    expect(readDocument).toHaveBeenLastCalledWith("/w/short.pptx", 0);
    expect(screen.getByRole("button", { name: /Next|다음/ }).hasAttribute("disabled")).toBe(true);
  });

  it("reports a page image decode failure instead of leaving a broken image", async () => {
    const response = pageResult("/w/pages.pdf", 0);
    if (!response.ok || !("page" in response.document)) throw new Error("Expected a page fixture");
    const png = readFileSync(join(process.cwd(), "build", "icon.png"));
    response.document.format = "pdf";
    response.document.page.png = png.toString("base64");
    response.document.page.width = png.readUInt32BE(16);
    response.document.page.height = png.readUInt32BE(20);
    readDocument.mockResolvedValueOnce(response);
    render(<PreviewBody api={{} as never} target={fileTarget("/w/pages.pdf")} />);
    fireEvent.error(await screen.findByTestId("chat-side-panel-pdf-page"));
    const error = await screen.findByTestId("chat-side-panel-file-error");
    expect(error.textContent).not.toContain("chatPreviewRail.");
    expect(screen.queryByTestId("chat-side-panel-pdf-page")).toBeNull();
    expect(screen.getByRole("button", { name: /Retry|다시 시도/ })).toBeTruthy();
  });

  it("shows a PDF page image, its text and truncation notices without the outline caveat", async () => {
    const png = readFileSync(join(process.cwd(), "build", "icon.png"));
    readDocument.mockResolvedValueOnce({ ok: true, path: "/w/pages.pdf", bytes: 2048, document: {
      format: "pdf", totalPages: 250, pagesTruncated: true,
      page: { index: 0, paragraphs: ["Visible PDF text"], textTruncated: true, png: png.toString("base64"),
        width: png.readUInt32BE(16), height: png.readUInt32BE(20) },
    } } satisfies PreviewReadDocumentResult);
    render(<PreviewBody api={{} as never} target={fileTarget("/w/pages.pdf")} />);
    const image = await screen.findByTestId("chat-side-panel-pdf-page");
    expect(image.getAttribute("src")).toMatch(/^data:image\/png;base64,iVBORw0KGgo/);
    expect(image.getAttribute("alt")).toMatch(/1/);
    const preview = screen.getByTestId("chat-side-panel-page-preview");
    expect(preview.textContent).toContain("Visible PDF text");
    expect(preview.textContent).toMatch(/200/);
    expect(preview.textContent).toMatch(/shortened|일부만/);
    expect(preview.textContent).not.toMatch(/Slide text outline|슬라이드 텍스트 개요/);
    expect(preview.textContent).not.toContain("pagePreview.");
    expect(readFile).not.toHaveBeenCalled();
  });

  it("labels a presentation as a text outline and an empty page as having no text", async () => {
    const response = pageResult("/w/slides.pptx", 0, 1);
    if (!response.ok || !("page" in response.document)) throw new Error("Expected a page fixture");
    response.document.page.paragraphs = [];
    readDocument.mockResolvedValueOnce(response);
    render(<PreviewBody api={{} as never} target={fileTarget("/w/slides.pptx")} />);
    const preview = await screen.findByTestId("chat-side-panel-page-text");
    expect(preview.textContent).toMatch(/no extractable text|추출할 수 있는 텍스트가 없는/);
    const panel = screen.getByTestId("chat-side-panel-page-preview");
    expect(panel.textContent).toMatch(/Slide text outline|슬라이드 텍스트 개요/);
    expect(screen.queryByTestId("chat-side-panel-pdf-page")).toBeNull();
    expect(screen.getByRole("button", { name: /Previous|이전/ }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: /Next|다음/ }).hasAttribute("disabled")).toBe(true);
  });

  it.each([
    ["corrupt-document", /damaged|손상/],
    ["encrypted", /ncrypt|암호/],
    ["parse-limit", /./],
    ["page-not-found", /page isn't available|페이지를 찾을 수 없/],
    ["renderer-unavailable", /renderer|렌더러/],
  ] as const)("localizes a %s page refusal with a retry", async (code, text) => {
    readDocument.mockResolvedValueOnce({ ok: false, error: code, message: "raw child detail" });
    render(<PreviewBody api={{} as never} target={fileTarget("/w/pages.pdf")} />);
    const error = await screen.findByTestId("chat-side-panel-file-error");
    expect(error.textContent).toMatch(text);
    expect(error.textContent).not.toContain("raw child detail");
    expect(error.textContent).not.toMatch(/pagePreview\.|chatPreviewRail\./);
    expect(screen.getByRole("button", { name: /Retry|다시 시도/ })).toBeTruthy();
  });

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

  it("labels truncated delimited counts as lower bounds", async () => {
    const response = workbookResult(0);
    if (!response.ok) throw new Error("Expected a document fixture");
    response.document.format = "csv";
    readDocument.mockResolvedValueOnce(response);
    render(<PreviewBody api={{} as never} target={fileTarget("/w/records.csv")} />);
    const summary = await screen.findByTestId("chat-side-panel-table-preview");
    expect(summary.textContent).toMatch(/At least|최소/);
    expect((await screen.findByTestId("chat-side-panel-table-truncated")).textContent)
      .toMatch(/not inspected|검사하지 않았/);
  });

  it("localizes a resource refusal without exposing child diagnostics", async () => {
    readDocument.mockResolvedValueOnce({ ok: false, error: "parse-limit", message: "private parser diagnostic" });
    render(<PreviewBody api={{} as never} target={fileTarget("/w/cyclic.xls")} />);
    const error = await screen.findByTestId("chat-side-panel-file-error");
    expect(error.textContent).toMatch(/time or memory|시간이나 메모리/);
    expect(error.textContent).not.toContain("private parser diagnostic");
  });

  it("retries a busy preview and displays the next successful result", async () => {
    vi.useFakeTimers();
    readDocument.mockResolvedValueOnce({ ok: false, error: "busy", message: "private busy detail" });
    await act(async () => { render(<PreviewBody api={{} as never} target={fileTarget("/w/book.xlsx")} />); });
    expect(screen.queryByTestId("chat-side-panel-file-error")).toBeNull();
    expect(readDocument).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(readDocument).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("chat-side-panel-table-preview")).toBeTruthy();
    expect(screen.queryByTestId("chat-side-panel-file-error")).toBeNull();
  });

  it("shows busy only after all bounded retries are exhausted", async () => {
    vi.useFakeTimers();
    readDocument.mockResolvedValue({ ok: false, error: "busy", message: "private busy detail" });
    await act(async () => { render(<PreviewBody api={{} as never} target={fileTarget("/w/book.xlsx")} />); });
    expect(readDocument).toHaveBeenCalledTimes(1);
    for (const [index, delay] of [250, 500, 1_000].entries()) {
      expect(screen.queryByTestId("chat-side-panel-file-error")).toBeNull();
      await act(async () => { await vi.advanceTimersByTimeAsync(delay - 1); });
      expect(readDocument).toHaveBeenCalledTimes(index + 1);
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(readDocument).toHaveBeenCalledTimes(index + 2);
    }
    const error = screen.getByTestId("chat-side-panel-file-error");
    expect(error.textContent).toMatch(/Try again shortly|잠시 후 다시/);
    expect(error.textContent).not.toMatch(/smaller|더 작은|private busy/);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(readDocument).toHaveBeenCalledTimes(4);
  });

  it("clears a pending busy retry when the preview unmounts", async () => {
    vi.useFakeTimers();
    readDocument.mockResolvedValue({ ok: false, error: "busy", message: "busy" });
    let view!: ReturnType<typeof render>;
    await act(async () => { view = render(<PreviewBody api={{} as never} target={fileTarget("/w/book.xlsx")} />); });
    await act(async () => { view.unmount(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(readDocument).toHaveBeenCalledTimes(1);
  });

  it("discards the old path's busy retry when another file opens", async () => {
    vi.useFakeTimers();
    readDocument.mockResolvedValueOnce({ ok: false, error: "busy", message: "busy" });
    let view!: ReturnType<typeof render>;
    await act(async () => { view = render(<PreviewBody api={{} as never} target={fileTarget("/w/book.xlsx")} />); });
    await act(async () => { view.rerender(<PreviewBody api={{} as never} target={fileTarget("/w/next.xlsx")} />); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(readDocument).toHaveBeenCalledTimes(2);
    expect(readDocument).toHaveBeenLastCalledWith("/w/next.xlsx", 0);
    expect(screen.queryByTestId("chat-side-panel-file-error")).toBeNull();
  });

  it("ignores a superseded response without showing an error", async () => {
    readDocument.mockResolvedValueOnce({ ok: false, error: "superseded", message: "superseded detail" });
    render(<PreviewBody api={{} as never} target={fileTarget("/w/book.xlsx")} />);
    await waitFor(() => expect(readDocument).toHaveResolved());
    expect(screen.queryByTestId("chat-side-panel-file-error")).toBeNull();
  });

  it("keeps markdown on the text readFile path", async () => {
    render(<PreviewBody api={{} as never} target={fileTarget("/w/notes.md")} />);
    await waitFor(() => expect(readFile).toHaveBeenCalledWith("/w/notes.md"));
    expect(readDocument).not.toHaveBeenCalled();
  });
});

function editableWorkbook(token = "a".repeat(64)): PreviewReadDocumentResult {
  const result = workbookResult(0);
  if (!result.ok || !("sheet" in result.document)) throw new Error("Expected workbook fixture");
  result.editToken = token;
  result.document.sheet.firstRow = 10_000;
  return result;
}

async function openCell(value: string | number | boolean | null = 12, formula = false) {
  readDocument.mockResolvedValueOnce(editableWorkbook());
  editXlsx.mockImplementation(async (request) => request.action === "cell"
    ? { ok: true, action: "cell", value, formula } : { ok: true, action: request.action });
  render(<PreviewBody api={{} as never} target={fileTarget("/w/book.xlsx")} />);
  const cell = await screen.findByText("120");
  fireEvent.doubleClick(cell);
  return screen.findByTestId("xlsx-cell-editor");
}

describe("workbook cell editing", () => {
  let widthSpy: ReturnType<typeof vi.spyOn>;
  let heightSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    widthSpy = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(600);
    heightSpy = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(300);
  });
  afterEach(() => { widthSpy.mockRestore(); heightSpy.mockRestore(); });
  it("keeps previews without a host edit identity read only", async () => {
    render(<PreviewBody api={{} as never} target={fileTarget("/w/book.xlsx")} />);
    fireEvent.doubleClick(await screen.findByText("120"));
    expect(screen.queryByTestId("xlsx-enable-editing")).toBeNull();
    expect(screen.queryByTestId("xlsx-cell-editor")).toBeNull();
    expect(editXlsx).not.toHaveBeenCalled();
  });

  it("loads the raw scalar inline, saves exact coordinates on Enter, then rereads the badge", async () => {
    const editor = await openCell();
    expect(editor.closest('[role="gridcell"]')).not.toBeNull();
    expect(editXlsx).toHaveBeenCalledWith({ action: "cell", token: "a".repeat(64), row: 10_001, column: 1 });
    const input = screen.getByRole("textbox", { name: /Cell value|셀 값/ }) as HTMLInputElement;
    expect(input.value).toBe("12");
    expect((screen.getByRole("combobox", { name: /Value type|값 유형/ }) as HTMLSelectElement).value).toBe("number");
    const refreshed = editableWorkbook("b".repeat(64));
    if (refreshed.ok && "sheet" in refreshed.document) {
      refreshed.document.sheet.rows = [["Region", "Total"], ["North", "84"]];
      refreshed.document.needsRecalculation = true;
    }
    readDocument.mockResolvedValueOnce(refreshed);
    fireEvent.change(input, { target: { value: "84" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await screen.findByTestId("xlsx-saved");
    await screen.findByText("84");
    expect(editXlsx).toHaveBeenCalledWith({ action: "save", token: "a".repeat(64), row: 10_001, column: 1, value: 84 });
    expect(readDocument).toHaveBeenCalledTimes(2);
    expect(editXlsx).toHaveBeenCalledWith({ action: "release", token: "a".repeat(64) });
    expect(editXlsx.mock.calls.map(([request]) => request.action)).not.toContain("enable");
    expect(screen.getByTestId("chat-side-panel-table-recalculation")).toBeTruthy();
    expect(screen.queryByTestId("xlsx-enable-editing")).toBeNull();
    fireEvent.doubleClick(screen.getByText("84"));
    await screen.findByTestId("xlsx-cell-editor");
    expect(editXlsx).toHaveBeenCalledWith({ action: "cell", token: "b".repeat(64), row: 10_001, column: 1 });
  });

  it("activates the selected cell with Enter and refuses non-finite numbers", async () => {
    await openCell();
    fireEvent.click(screen.getByRole("button", { name: /^(Cancel|취소)$/ }));
    const cell = screen.getByText("120");
    fireEvent.mouseDown(cell);
    fireEvent.click(cell);
    fireEvent.keyDown(cell, { key: "Enter" });
    const input = await screen.findByRole("textbox", { name: /Cell value|셀 값/ });
    fireEvent.change(input, { target: { value: "Infinity" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect((await screen.findByRole("alert")).textContent).toMatch(/finite|유한/);
    expect(editXlsx.mock.calls.filter(([request]) => request.action === "save")).toEqual([]);
  });

  it.each(["invalid-request", "unauthorized", "expired", "stale-file", "edit-unavailable", "unsupported-cell", "backup-exists", "edit-failed", "busy"] as const)(
    "localizes %s editing refusals", async (error) => {
      readDocument.mockResolvedValueOnce(editableWorkbook());
      editXlsx.mockResolvedValueOnce({ ok: false, error, message: "private diagnostic" });
      render(<PreviewBody api={{} as never} target={fileTarget("/w/book.xlsx")} />);
      fireEvent.doubleClick(await screen.findByText("120"));
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).not.toContain("chatPreviewRail.");
      expect(alert.textContent).not.toContain("private diagnostic");
      expect(alert.textContent!.length).toBeGreaterThan(5);
      expect(screen.queryByTestId("xlsx-cell-editor")).toBeNull();
    },
  );

  it("does not save on blur, composition Enter, or Escape", async () => {
    await openCell("=literal text", true);
    expect(screen.getByRole("note").textContent).toMatch(/formula|수식/);
    const input = screen.getByRole("textbox", { name: /Cell value|셀 값/ });
    fireEvent.change(input, { target: { value: "changed" } });
    fireEvent.blur(input);
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(screen.queryByTestId("xlsx-cell-editor")).not.toBeNull();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByTestId("xlsx-cell-editor")).toBeNull();
    expect(editXlsx.mock.calls.filter(([request]) => request.action === "save")).toEqual([]);
  });

  it.each([
    [true, "boolean", "false", false],
    [null, "empty", "", null],
    ["=plain text", "text", "=another text", "=another text"],
  ] as const)("preserves %s scalar types in write requests", async (original, type, text, expected) => {
    await openCell(original);
    expect((screen.getByRole("combobox", { name: /Value type|값 유형/ }) as HTMLSelectElement).value).toBe(type);
    if (type === "boolean") fireEvent.change(screen.getByRole("combobox", { name: /Cell value|셀 값/ }), { target: { value: text } });
    else if (type === "text") fireEvent.change(screen.getByRole("textbox", { name: /Cell value|셀 값/ }), { target: { value: text } });
    fireEvent.click(screen.getByRole("button", { name: /^(Save|저장)$/ }));
    await waitFor(() => expect(editXlsx).toHaveBeenCalledWith({ action: "save", token: "a".repeat(64), row: 10_001, column: 1, value: expected }));
  });

  it("keeps embedded line breaks when a raw text scalar is edited", async () => {
    await openCell("line one\nline two");
    const input = screen.getByRole("textbox", { name: /Cell value|셀 값/ }) as HTMLTextAreaElement;
    expect(input.tagName).toBe("TEXTAREA");
    expect(input.value).toBe("line one\nline two");
    fireEvent.change(input, { target: { value: "line one!\nline two" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(editXlsx).toHaveBeenCalledWith({
      action: "save", token: "a".repeat(64), row: 10_001, column: 1, value: "line one!\nline two",
    }));
  });

  it.each([
    ["line one\rline two", "line one!\nline two", "line one!\rline two"],
    ["line one\rline two", "line one\nline two!", "line one\rline two!"],
    ["line one\r\nline two", "line one!\nline two", "line one!\r\nline two"],
    ["line one\r\nline two", "line one\nline two!", "line one\r\nline two!"],
    ["left\r\nright", "leftright", "leftright"],
    ["left\rright", "left / right", "left / right"],
    ["leftright", "left\nright", "left\nright"],
    ["left\rright", "left\n\nright", "left\n\nright"],
    ["left\rx\nright", "left\n\nright", "left\n\nright"],
    ["\r\r", "\n\n\n", "\n\n\n"],
    ["first\rsecond\r\nthird\nfourth", "first\nsecond!\nthird\nfourth", "first\rsecond!\r\nthird\nfourth"],
  ])("preserves untouched raw newline spellings through text changes %j", async (raw, visible, expected) => {
    await openCell(raw);
    const input = screen.getByRole("textbox", { name: /Cell value|셀 값/ }) as HTMLTextAreaElement;
    expect(input.value).toBe(raw.replace(/\r\n?/g, "\n"));
    fireEvent.change(input, { target: { value: visible } });
    expect(input.value).toBe(visible);
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(editXlsx).toHaveBeenCalledWith({
      action: "save", token: "a".repeat(64), row: 10_001, column: 1, value: expected,
    }));
  });

  it("keeps the complete descriptor text instead of the bounded display string", async () => {
    const text = "x".repeat(12_000);
    await openCell(text);
    expect((screen.getByRole("textbox", { name: /Cell value|셀 값/ }) as HTMLInputElement).value).toBe(text);
  });

  it("refuses absent cells without creating a draft", async () => {
    await openCell();
    fireEvent.click(screen.getByRole("button", { name: /^(Cancel|취소)$/ }));
    editXlsx.mockResolvedValueOnce({ ok: false, error: "unsupported-cell" });
    fireEvent.doubleClick(screen.getByText("North"));
    expect((await screen.findByRole("alert")).textContent).toMatch(/existing|기존/);
    expect(screen.queryByTestId("xlsx-cell-editor")).toBeNull();
  });

  it("retains a draft when another cell is refused and locks sheet switching until cancellation", async () => {
    await openCell();
    const input = screen.getByRole("textbox", { name: /Cell value|셀 값/ });
    fireEvent.change(input, { target: { value: "84" } });
    expect(screen.getAllByRole("tab").every((tab) => tab.hasAttribute("disabled"))).toBe(true);
    editXlsx.mockResolvedValueOnce({ ok: false, error: "unsupported-cell" });
    fireEvent.doubleClick(screen.getByText("North"));
    await screen.findByRole("alert");
    expect((screen.getByRole("textbox", { name: /Cell value|셀 값/ }) as HTMLInputElement).value).toBe("84");
    fireEvent.click(screen.getByRole("button", { name: /^(Cancel|취소)$/ }));
    expect(screen.getAllByRole("tab").every((tab) => !tab.hasAttribute("disabled"))).toBe(true);
  });

  it("keeps failed-save drafts and does not expose host diagnostics", async () => {
    await openCell();
    editXlsx.mockResolvedValueOnce({ ok: false, error: "edit-failed", message: "private host path" });
    const input = screen.getByRole("textbox", { name: /Cell value|셀 값/ });
    fireEvent.change(input, { target: { value: "84" } });
    fireEvent.keyDown(input, { key: "Enter" });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).not.toContain("private host path");
    expect((input as HTMLInputElement).value).toBe("84");
    expect(readDocument).toHaveBeenCalledTimes(1);
  });

  it("clears stale authority and uses the refreshed token directly after reload", async () => {
    await openCell();
    editXlsx.mockResolvedValueOnce({ ok: false, error: "stale-file" });
    fireEvent.keyDown(screen.getByRole("textbox", { name: /Cell value|셀 값/ }), { key: "Enter" });
    expect((await screen.findByRole("alert")).textContent).toMatch(/changed|변경/);
    expect(screen.queryByTestId("xlsx-cell-editor")).toBeNull();
    readDocument.mockResolvedValueOnce(editableWorkbook("c".repeat(64)));
    fireEvent.click(screen.getByRole("button", { name: /^(Reload|다시 불러오기)$/ }));
    await waitFor(() => expect(readDocument).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getAllByRole("tab").every((tab) => !tab.hasAttribute("disabled"))).toBe(true));
    fireEvent.doubleClick(await screen.findByText("120"));
    await screen.findByTestId("xlsx-cell-editor");
    expect(editXlsx).toHaveBeenCalledWith({ action: "cell", token: "c".repeat(64), row: 10_001, column: 1 });
    expect(editXlsx).toHaveBeenCalledWith({ action: "release", token: "a".repeat(64) });
  });

  it("shows saving and prevents duplicate writes or sheet changes", async () => {
    await openCell();
    let resolveSave!: (value: unknown) => void;
    editXlsx.mockImplementationOnce(() => new Promise((resolve) => { resolveSave = resolve; }));
    const input = screen.getByRole("textbox", { name: /Cell value|셀 값/ });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("button", { name: /^(Save|저장)$/ }).hasAttribute("disabled")).toBe(true);
    expect(screen.getAllByRole("tab").every((tab) => tab.hasAttribute("disabled"))).toBe(true);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(editXlsx.mock.calls.filter(([request]) => request.action === "save")).toHaveLength(1);
    await act(async () => resolveSave({ ok: false, error: "edit-failed" }));
  });

  it("reports a failed post-save refresh separately from the successful write", async () => {
    await openCell();
    readDocument.mockResolvedValueOnce({ ok: false, error: "read-failed", message: "private detail" });
    fireEvent.keyDown(screen.getByRole("textbox", { name: /Cell value|셀 값/ }), { key: "Enter" });
    expect((await screen.findByRole("alert")).textContent).toMatch(/reload|다시/);
    expect(screen.getByTestId("xlsx-saved")).toBeTruthy();
    expect(screen.getByText("120")).toBeTruthy();
    expect(screen.queryByTestId("xlsx-enable-editing")).toBeNull();
  });

  it("releases its token on navigation and ignores a late cell descriptor", async () => {
    readDocument.mockResolvedValueOnce(editableWorkbook());
    const view = render(<PreviewBody api={{} as never} target={fileTarget("/w/book.xlsx")} />);
    let resolveCell!: (value: unknown) => void;
    editXlsx.mockImplementationOnce(() => new Promise((resolve) => { resolveCell = resolve; }));
    fireEvent.doubleClick(await screen.findByText("120"));
    view.rerender(<PreviewBody api={{} as never} target={fileTarget("/w/next.xlsx")} />);
    await act(async () => resolveCell({ ok: true, action: "cell", value: 12, formula: false }));
    expect(screen.queryByTestId("xlsx-cell-editor")).toBeNull();
    expect(editXlsx).toHaveBeenCalledWith({ action: "release", token: "a".repeat(64) });
  });
});
