// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreviewBody } from "../../components/ChatSidePanelPreview.js";
import { resolveFilePreviewRoute } from "../preview-renderers.js";
import { horizontalScrollbarBlockPx, tableGridBlockStyle } from "../table-document-grid.js";
import { columnLetters } from "../table-coordinates.js";
import { tableErrorKey } from "../table-document-preview.js";
import type { DocumentObservationEvent } from "../../../../shared/agent-observation.js";
import { en as previewEn, ko as previewKo } from "../../../../i18n/messages/generated/chatPreviewRail.js";
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
let acknowledgeObservation: ReturnType<typeof vi.fn>;
let onAgentObservation: ReturnType<typeof vi.fn>;
let observationHandlers: Set<(events: DocumentObservationEvent[]) => void>;
let previousAve: unknown;

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  previousAve = (window as unknown as { ave?: unknown }).ave;
  readFile = vi.fn(async () => ({ ok: true, content: "# hi", path: "/w/notes.md", truncated: false }));
  readDocument = vi.fn(async (_path: string, sheetIndex: number) => workbookResult(sheetIndex));
  acknowledgeObservation = vi.fn(async () => ({ ok: true }));
  observationHandlers = new Set();
  onAgentObservation = vi.fn((handler: (events: DocumentObservationEvent[]) => void) => {
    observationHandlers.add(handler);
    return () => observationHandlers.delete(handler);
  });
  (window as unknown as { ave: unknown }).ave = {
    preview: { readFile, readDocument, onAgentObservation, acknowledgeObservation },
    attach: { openExternal: vi.fn(async () => ({ ok: true })) },
  };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  (window as unknown as { ave?: unknown }).ave = previousAve;
});

describe("file preview routing", () => {
  it("opens the host-returned workbook path after a successful read without a picker grant", async () => {
    const response = workbookResult(0);
    if (!response.ok) throw new Error("Expected workbook fixture");
    response.path = "/w/canonical-book.xlsx";
    readDocument.mockResolvedValueOnce(response);
    render(<PreviewBody observe api={{} as never} sessionId="reader-session" target={fileTarget("/w/book.xlsx")} />);
    fireEvent.click(await screen.findByRole("button", { name: "기본 앱으로 열기" }));
    expect(window.ave.attach.openExternal).toHaveBeenCalledWith("/w/canonical-book.xlsx");
    expect(screen.getByTestId("preview-document-path").title).toBe("/w/canonical-book.xlsx");
    expect(readDocument).toHaveBeenCalledWith("/w/book.xlsx", 0, "reader-session");
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("binds page reads to the viewer session and opens only the returned canonical path", async () => {
    readDocument.mockResolvedValueOnce(pageResult("/w/canonical-slides.pptx", 0));
    render(<PreviewBody observe api={{} as never} sessionId="page-session" target={fileTarget("/w/slides.pptx")} />);
    fireEvent.click(await screen.findByRole("button", { name: "기본 앱으로 열기" }));
    expect(window.ave.attach.openExternal).toHaveBeenCalledWith("/w/canonical-slides.pptx");
    expect(readDocument).toHaveBeenCalledWith("/w/slides.pptx", 0, "page-session");
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("renders a recalculation badge for stale workbook caches", async () => {
    const result = workbookResult(0);
    if (result.ok && "sheet" in result.document) result.document.needsRecalculation = true;
    readDocument.mockResolvedValueOnce(result);
    render(<PreviewBody observe api={{} as never} target={fileTarget("/w/book.xlsx")} />);
    const badge = await screen.findByTestId("chat-side-panel-table-recalculation");
    expect(badge.textContent).toMatch(/^(Needs recalculation|재계산 필요)$/);
    expect(badge.getAttribute("title")).toMatch(/stale|이전 값/);
  });

  it("omits the recalculation badge for an ordinary workbook", async () => {
    render(<PreviewBody observe api={{} as never} target={fileTarget("/w/book.xlsx")} />);
    await screen.findByTestId("chat-side-panel-table-preview");
    expect(screen.queryByTestId("chat-side-panel-table-recalculation")).toBeNull();
  });

  it("shows a replaced page request as a recoverable error", async () => {
    const path = "/w/slides.pptx";
    readDocument.mockResolvedValueOnce({ ok: false, error: "superseded", message: "private supersession detail" })
      .mockResolvedValueOnce(pageResult(path, 0));
    render(<PreviewBody observe api={{} as never} target={fileTarget(path)} />);
    const error = await screen.findByTestId("chat-side-panel-file-error");
    expect(error.textContent).toMatch(/replaced|취소/);
    expect(error.textContent).not.toContain("private supersession detail");
    fireEvent.click(screen.getByRole("button", { name: /Reload|다시 불러오기/ }));
    await screen.findByText("Outline 1");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(readDocument).toHaveBeenCalledTimes(2);
    expect(readFile).not.toHaveBeenCalled();
  });

  it("opens another page document at its first page after navigation", async () => {
    readDocument.mockImplementation(async (path: string, index: number) => pageResult(path, index, path.endsWith("short.pptx") ? 1 : 2));
    const view = render(<PreviewBody observe api={{} as never} target={fileTarget("/w/slides.pptx")} />);
    await screen.findByText("Outline 1");
    fireEvent.click(screen.getByRole("button", { name: /Next|다음/ }));
    await screen.findByText("Outline 2");
    view.rerender(<PreviewBody observe api={{} as never} target={fileTarget("/w/short.pptx")} />);
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
    render(<PreviewBody observe api={{} as never} target={fileTarget("/w/pages.pdf")} />);
    fireEvent.error(await screen.findByTestId("chat-side-panel-pdf-page"));
    const error = await screen.findByTestId("chat-side-panel-file-error");
    expect(error.textContent).not.toContain("chatPreviewRail.");
    expect(screen.queryByTestId("chat-side-panel-pdf-page")).toBeNull();
    expect(screen.getByRole("button", { name: /Reload|다시 불러오기/ })).toBeTruthy();
  });

  it("shows a PDF page image, its text and truncation notices without the outline caveat", async () => {
    const png = readFileSync(join(process.cwd(), "build", "icon.png"));
    readDocument.mockResolvedValueOnce({ ok: true, path: "/w/pages.pdf", bytes: 2048, document: {
      format: "pdf", totalPages: 250, pagesTruncated: true,
      page: { index: 0, paragraphs: ["Visible PDF text"], textTruncated: true, png: png.toString("base64"),
        width: png.readUInt32BE(16), height: png.readUInt32BE(20) },
    } } satisfies PreviewReadDocumentResult);
    render(<PreviewBody observe api={{} as never} target={fileTarget("/w/pages.pdf")} />);
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
    render(<PreviewBody observe api={{} as never} target={fileTarget("/w/slides.pptx")} />);
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
    render(<PreviewBody observe api={{} as never} target={fileTarget("/w/pages.pdf")} />);
    const error = await screen.findByTestId("chat-side-panel-file-error");
    expect(error.textContent).toMatch(text);
    expect(error.textContent).not.toContain("raw child detail");
    expect(error.textContent).not.toMatch(/pagePreview\.|chatPreviewRail\./);
    expect(screen.getByRole("button", { name: /Reload|다시 불러오기/ })).toBeTruthy();
  });

  it("reads a workbook through readDocument, never readFile, and shows tabs, banner and grid", async () => {
    render(<PreviewBody observe api={{} as never} target={fileTarget("/w/book.xlsx")} />);
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
    render(<PreviewBody observe api={{} as never} target={fileTarget("/w/bomb.xlsx")} />);
    const error = await screen.findByTestId("chat-side-panel-file-error");
    expect(error.textContent).not.toBe("");
    expect(error.textContent).not.toContain("chatPreviewRail.");
  });

  it("labels truncated delimited counts as lower bounds", async () => {
    const response = workbookResult(0);
    if (!response.ok) throw new Error("Expected a document fixture");
    response.document.format = "csv";
    readDocument.mockResolvedValueOnce(response);
    render(<PreviewBody observe api={{} as never} target={fileTarget("/w/records.csv")} />);
    const summary = await screen.findByTestId("chat-side-panel-table-preview");
    expect(summary.textContent).toMatch(/At least|최소/);
    expect((await screen.findByTestId("chat-side-panel-table-truncated")).textContent)
      .toMatch(/not inspected|검사하지 않았/);
  });

  it("localizes a resource refusal without exposing child diagnostics", async () => {
    readDocument.mockResolvedValueOnce({ ok: false, error: "parse-limit", message: "private parser diagnostic" });
    render(<PreviewBody observe api={{} as never} target={fileTarget("/w/cyclic.xls")} />);
    const error = await screen.findByTestId("chat-side-panel-file-error");
    expect(error.textContent).toMatch(/time or memory|시간이나 메모리/);
    expect(error.textContent).not.toContain("private parser diagnostic");
  });

  it("retries a busy preview and displays the next successful result", async () => {
    vi.useFakeTimers();
    readDocument.mockResolvedValueOnce({ ok: false, error: "busy", message: "private busy detail" });
    await act(async () => { render(<PreviewBody observe api={{} as never} target={fileTarget("/w/book.xlsx")} />); });
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
    await act(async () => { render(<PreviewBody observe api={{} as never} target={fileTarget("/w/book.xlsx")} />); });
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
    await act(async () => { view = render(<PreviewBody observe api={{} as never} target={fileTarget("/w/book.xlsx")} />); });
    await act(async () => { view.unmount(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(readDocument).toHaveBeenCalledTimes(1);
  });

  it("discards the old path's busy retry when another file opens", async () => {
    vi.useFakeTimers();
    readDocument.mockResolvedValueOnce({ ok: false, error: "busy", message: "busy" });
    let view!: ReturnType<typeof render>;
    await act(async () => { view = render(<PreviewBody observe api={{} as never} target={fileTarget("/w/book.xlsx")} />); });
    await act(async () => { view.rerender(<PreviewBody observe api={{} as never} target={fileTarget("/w/next.xlsx")} />); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(readDocument).toHaveBeenCalledTimes(2);
    expect(readDocument).toHaveBeenLastCalledWith("/w/next.xlsx", 0);
    expect(screen.queryByTestId("chat-side-panel-file-error")).toBeNull();
  });

  it("ignores a superseded response without showing an error", async () => {
    readDocument.mockResolvedValueOnce({ ok: false, error: "superseded", message: "superseded detail" });
    render(<PreviewBody observe api={{} as never} target={fileTarget("/w/book.xlsx")} />);
    await waitFor(() => expect(readDocument).toHaveResolved());
    expect(screen.queryByTestId("chat-side-panel-file-error")).toBeNull();
  });

  it("keeps markdown on the text readFile path", async () => {
    render(<PreviewBody observe api={{} as never} target={fileTarget("/w/notes.md")} />);
    await waitFor(() => expect(readFile).toHaveBeenCalledWith("/w/notes.md"));
    expect(readDocument).not.toHaveBeenCalled();
  });
});

const OBSERVATION_SESSION = "agent-document-session";
const OBSERVATION_TARGET = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function observedWorkbook(): Extract<PreviewReadDocumentResult, { ok: true }> {
  const result = workbookResult(0);
  if (!result.ok || !("sheet" in result.document)) throw new Error("Expected workbook fixture");
  result.observation = { targetId: OBSERVATION_TARGET, sessionId: OBSERVATION_SESSION, seq: 0 };
  result.document.sheet.firstRow = 10_000;
  return result;
}

function observedCell(seq: number, column: number, after: string): DocumentObservationEvent {
  return { source: "document", actor: "agent", sessionId: OBSERVATION_SESSION,
    target: { id: OBSERVATION_TARGET, path: "/w/book.xlsx" }, seq, ts: 1_700_000_000_000,
    kind: "element", element: { kind: "cell", sheet: "Sales", row: 10_001, column },
    before: column === 0 ? "North" : "120", after, advisory: true };
}

function observedStatus(seq: number, code: "engine-unavailable" | "reload-required" | "observation-error"): DocumentObservationEvent {
  return { source: "document", actor: "agent", sessionId: OBSERVATION_SESSION,
    target: { id: OBSERVATION_TARGET, path: "/w/book.xlsx" }, seq, ts: 1_700_000_000_000,
    kind: "status", before: null, after: { code } };
}

async function emitObservations(...events: DocumentObservationEvent[]): Promise<void> {
  await act(async () => { observationHandlers.forEach((handler) => handler(events)); });
}

async function openObservedWorkbook() {
  readDocument.mockResolvedValueOnce(observedWorkbook());
  const view = render(<PreviewBody observe api={{} as never} sessionId={OBSERVATION_SESSION} target={fileTarget("/w/book.xlsx")} />);
  await screen.findByTestId("chat-side-panel-table-grid");
  return view;
}

describe("agent document live view", () => {
  it("keeps cells read-only after double-click and Enter", async () => {
    await openObservedWorkbook();
    const cell = screen.getByRole("gridcell", { name: "120" });
    fireEvent.doubleClick(cell);
    fireEvent.keyDown(cell, { key: "Enter" });
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByTestId("xlsx-cell-editor")).toBeNull();
    expect(screen.queryByTestId("xlsx-edit-controls")).toBeNull();
    expect(screen.queryByRole("button", { name: /^(Save|저장)$/ })).toBeNull();
    expect(readDocument).toHaveBeenCalledWith("/w/book.xlsx", 0, OBSERVATION_SESSION);
    expect(acknowledgeObservation).toHaveBeenCalledWith({ action: "rendered",
      targetId: OBSERVATION_TARGET, sessionId: OBSERVATION_SESSION, seq: 0 });
  });

  it("acknowledges after the displayed cells commit", async () => {
    const displayedAtAck: string[] = [];
    acknowledgeObservation.mockImplementation(async () => {
      displayedAtAck.push(screen.getByTestId("chat-side-panel-table-grid").textContent ?? "");
      return { ok: true };
    });
    await openObservedWorkbook();
    expect(displayedAtAck[0]).toContain("North");
    await emitObservations(observedCell(1, 0, "South"));
    expect(displayedAtAck.at(-1)).toContain("South");
  });

  it("matches updates to the canonical read path when the opened path is an alias", async () => {
    const response = observedWorkbook();
    response.path = "/w/canonical.xlsx";
    readDocument.mockResolvedValueOnce(response);
    render(<PreviewBody observe api={{} as never} sessionId={OBSERVATION_SESSION} target={fileTarget("/w/alias.xlsx")} />);
    await screen.findByTestId("chat-side-panel-table-grid");
    const event = observedCell(1, 1, "84");
    await emitObservations({ ...event, target: { ...event.target, path: "/w/canonical.xlsx" } });
    expect(screen.getByTestId("document-cell-value").textContent).toBe("84");
  });

  it("streams two cell changes before a save and replaces advisory values with the actual snapshot", async () => {
    await openObservedWorkbook();
    await emitObservations(observedCell(1, 0, "South"));
    expect(screen.getByTestId("chat-side-panel-table-grid").textContent).toContain("South");
    expect(screen.getByTestId("document-cell-change").dataset.row).toBe("10001");
    expect(screen.getByTestId("document-cell-change").dataset.advisory).toBe("true");
    await emitObservations(observedCell(2, 1, "84"));
    expect(screen.getAllByTestId("document-cell-value").map((cell) => cell.textContent)).toEqual(["South", "84"]);
    expect(readDocument).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("chat-side-panel-table-recalculation")).toBeNull();
    expect(acknowledgeObservation).toHaveBeenLastCalledWith({ action: "rendered",
      targetId: OBSERVATION_TARGET, sessionId: OBSERVATION_SESSION, seq: 2 });
    const result = observedWorkbook();
    if (!("sheet" in result.document)) throw new Error("Expected table fixture");
    result.document.sheet.rows = [["Region", "Total"], ["East", "84"]];
    result.document.needsRecalculation = true;
    await emitObservations({ source: "document", actor: "agent", sessionId: OBSERVATION_SESSION,
      target: { id: OBSERVATION_TARGET, path: "/w/book.xlsx" }, seq: 3, ts: 1_700_000_000_001,
      kind: "snapshot", before: null, after: result.document });
    const grid = screen.getByTestId("chat-side-panel-table-grid");
    expect(grid.textContent).toContain("East");
    expect(grid.textContent).not.toContain("South");
    expect(screen.getAllByTestId("document-cell-change").every((cell) => cell.dataset.advisory === "false")).toBe(true);
    expect(screen.getByTestId("chat-side-panel-table-recalculation").textContent).toBe("재계산 필요");
    expect(acknowledgeObservation).toHaveBeenLastCalledWith({ action: "rendered",
      targetId: OBSERVATION_TARGET, sessionId: OBSERVATION_SESSION, seq: 3 });
  });

  it("rejects events from another session, target, path or actor and old sequences", async () => {
    await openObservedWorkbook();
    const change = observedCell(1, 1, "84");
    await emitObservations({ ...change, sessionId: "other-session" },
      { ...change, target: { ...change.target, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" } },
      { ...change, target: { ...change.target, path: "/w/other.xlsx" } },
      { ...change, actor: "user" } as never);
    expect(screen.getByTestId("chat-side-panel-table-grid").textContent).toContain("120");
    expect(screen.queryByTestId("document-cell-change")).toBeNull();
    await emitObservations(change);
    await emitObservations(observedCell(1, 1, "95"));
    expect(screen.getByTestId("document-cell-value").textContent).toBe("84");
  });

  it("removes a journal-only summary when the saved cell did not change", async () => {
    await openObservedWorkbook();
    await emitObservations(observedCell(1, 1, "draft"));
    expect(screen.getByTestId("document-observation-summary").textContent).toBe("B10002: 120 → draft");
    const result = observedWorkbook();
    if (!("sheet" in result.document)) throw new Error("Expected table fixture");
    await emitObservations({ source: "document", actor: "agent", sessionId: OBSERVATION_SESSION,
      target: { id: OBSERVATION_TARGET, path: "/w/book.xlsx" }, seq: 2, ts: 1_700_000_000_001,
      kind: "snapshot", before: null, after: result.document });
    expect(screen.queryByTestId("document-observation-summary")).toBeNull();
    expect(screen.queryByTestId("document-cell-change")).toBeNull();
    expect(screen.getByRole("gridcell", { name: "120" })).toBeTruthy();
    expect(screen.getByTestId("document-observation-status").textContent).toBe("에이전트가 수정함");
  });

  it("corrects the summary as well as the grid when the saved value differs from the journal", async () => {
    await openObservedWorkbook();
    await emitObservations(observedCell(1, 1, "draft"));
    const result = observedWorkbook();
    if (!("sheet" in result.document)) throw new Error("Expected table fixture");
    result.document.sheet.rows[1][1] = "14";
    await emitObservations({ source: "document", actor: "agent", sessionId: OBSERVATION_SESSION,
      target: { id: OBSERVATION_TARGET, path: "/w/book.xlsx" }, seq: 2, ts: 1_700_000_000_001,
      kind: "snapshot", before: null, after: result.document });
    expect(screen.getByTestId("document-observation-summary").textContent).toBe("B10002: 120 → 14");
    expect(screen.getByTestId("document-cell-value").textContent).toBe("14");
    expect(screen.getByTestId("chat-side-panel-table-preview").textContent).not.toContain("draft");
  });

  it("clears advisory changes for an unverifiable revision and offers reload", async () => {
    await openObservedWorkbook();
    await emitObservations(observedCell(1, 1, "84"));
    await emitObservations(observedStatus(2, "reload-required"));
    expect(screen.queryByTestId("document-cell-change")).toBeNull();
    expect(screen.getByTestId("chat-side-panel-table-grid").textContent).toContain("120");
    expect(screen.getByRole("alert").textContent).toBe("변경 주체를 안전하게 확인할 수 없습니다. 파일을 다시 불러오세요.");
    expect(screen.getByRole("button", { name: "다시 불러오기" })).toBeTruthy();
  });

  it("uses the existing document preview deterministically when the live engine is absent", async () => {
    await openObservedWorkbook();
    await emitObservations(observedStatus(1, "engine-unavailable"));
    expect(screen.getByTestId("document-observation-status").textContent)
      .toBe("실시간 렌더링을 사용할 수 없어 기존 문서 미리보기를 표시합니다.");
    expect(screen.getByTestId("chat-side-panel-table-grid").textContent).toContain("120");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(readDocument).toHaveBeenCalledTimes(1);
  });

  it("releases a view and removes its event listener when its session changes", async () => {
    const view = await openObservedWorkbook();
    view.rerender(<PreviewBody observe api={{} as never} sessionId="other-session" target={fileTarget("/w/book.xlsx")} />);
    await waitFor(() => expect(readDocument).toHaveBeenLastCalledWith("/w/book.xlsx", 0, "other-session"));
    expect(acknowledgeObservation).toHaveBeenCalledWith({ action: "release",
      targetId: OBSERVATION_TARGET, sessionId: OBSERVATION_SESSION, seq: 0 });
    await emitObservations(observedCell(1, 1, "84"));
    expect(screen.getByTestId("chat-side-panel-table-grid").textContent).toContain("120");
    view.unmount();
    expect(observationHandlers.size).toBe(0);
  });

  it("releases a late read binding after the panel unmounts", async () => {
    let finish!: (result: PreviewReadDocumentResult) => void;
    readDocument.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const view = render(<PreviewBody observe api={{} as never} sessionId={OBSERVATION_SESSION} target={fileTarget("/w/book.xlsx")} />);
    view.unmount();
    await act(async () => { finish(observedWorkbook()); });
    expect(acknowledgeObservation).toHaveBeenCalledWith({ action: "release",
      targetId: OBSERVATION_TARGET, sessionId: OBSERVATION_SESSION, seq: 0 });
    expect(observationHandlers.size).toBe(0);
  });

  it("keeps journal-looking markup inert and localizes both live-view catalogs", async () => {
    await openObservedWorkbook();
    await emitObservations(observedCell(1, 1, "<img src=x onerror=alert(1)>"));
    expect(screen.getByTestId("document-cell-value").textContent).toBe("<img src=x onerror=alert(1)>");
    expect(screen.getByTestId("chat-side-panel-table-grid").querySelector("img")).toBeNull();
    expect(previewEn["chatPreviewRail.documentObservationLive"]).toBe("Agent edited");
    expect(previewKo["chatPreviewRail.documentObservationLive"]).toBe("에이전트가 수정함");
    expect(previewEn["chatPreviewRail.documentObservationReconciling"]).toBe("Agent editing");
    expect(previewKo["chatPreviewRail.documentObservationReconciling"]).toBe("에이전트 편집 중");
    expect(previewEn["chatPreviewRail.documentObservationFallback"])
      .toBe("Live rendering is unavailable. Showing the document preview.");
  });
});

describe("hidden panel keeps previews mounted", () => {
  const targets = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222",
    "33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444"];

  function bindEveryRead(missing?: (sheetIndex: number) => boolean): void {
    let reads = 0;
    readDocument.mockImplementation(async (_path: string, sheetIndex: number) => {
      if (missing?.(sheetIndex)) return { ok: false, error: "sheet-not-found" };
      const result = workbookResult(sheetIndex);
      if (!result.ok) throw new Error("Expected workbook fixture");
      result.observation = { targetId: targets[reads++]!, sessionId: OBSERVATION_SESSION, seq: 0 };
      return result;
    });
  }

  function workbookBody(observe: boolean) {
    return <PreviewBody observe={observe} api={{} as never} sessionId={OBSERVATION_SESSION} target={fileTarget("/w/book.xlsx")} />;
  }

  async function openSecondSheetThenHide() {
    const view = render(workbookBody(true));
    await screen.findByTestId("chat-side-panel-table-grid");
    fireEvent.click(screen.getAllByTestId("chat-side-panel-table-sheet-tab")[1]!);
    await screen.findByText("<b>not markup</b>");
    await waitFor(() => expect(acknowledgeObservation).toHaveBeenCalledWith({ action: "rendered",
      targetId: targets[1], sessionId: OBSERVATION_SESSION, seq: 0 }));
    const grid = screen.getByTestId("chat-side-panel-table-grid");
    view.rerender(workbookBody(false));
    expect(acknowledgeObservation).toHaveBeenCalledWith({ action: "release",
      targetId: targets[1], sessionId: OBSERVATION_SESSION, seq: 0 });
    expect(observationHandlers.size).toBe(0);
    expect(grid.isConnected).toBe(true);
    expect(readDocument).toHaveBeenCalledTimes(2);
    return { view, grid };
  }

  it("keeps the selected sheet across a hide and show and re-reads it as a fresh baseline", async () => {
    bindEveryRead();
    const { view, grid } = await openSecondSheetThenHide();
    expect(screen.getAllByTestId("chat-side-panel-table-sheet-tab")[1]!.getAttribute("aria-selected")).toBe("true");
    view.rerender(workbookBody(true));
    expect(screen.queryByTestId("chat-side-panel-table-loading")).toBeNull();
    expect(grid.isConnected).toBe(true);
    expect(readDocument).toHaveBeenLastCalledWith("/w/book.xlsx", 1, OBSERVATION_SESSION);
    await waitFor(() => expect(acknowledgeObservation).toHaveBeenCalledWith({ action: "rendered",
      targetId: targets[2], sessionId: OBSERVATION_SESSION, seq: 0 }));
    expect(readDocument).toHaveBeenCalledTimes(3);
    expect(observationHandlers.size).toBe(1);
    expect(screen.getByText("<b>not markup</b>")).toBeTruthy();
    expect(screen.getAllByTestId("chat-side-panel-table-sheet-tab")[1]!.getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByText(previewKo["chatPreviewRail.tableSheetFallback"])).toBeNull();
  });

  it("says so and shows the first sheet when the selected sheet is gone on reopen", async () => {
    let hidden = false;
    bindEveryRead((sheetIndex) => hidden && sheetIndex === 1);
    const { view } = await openSecondSheetThenHide();
    hidden = true;
    view.rerender(workbookBody(true));
    await waitFor(() => expect(readDocument).toHaveBeenLastCalledWith("/w/book.xlsx", 0, OBSERVATION_SESSION));
    await screen.findByText("North");
    expect(screen.getByText(previewKo["chatPreviewRail.tableSheetFallback"])).toBeTruthy();
    expect(screen.getAllByTestId("chat-side-panel-table-sheet-tab")[0]!.getAttribute("aria-selected")).toBe("true");
    await waitFor(() => expect(acknowledgeObservation).toHaveBeenCalledWith({ action: "rendered",
      targetId: targets[2], sessionId: OBSERVATION_SESSION, seq: 0 }));
    expect(observationHandlers.size).toBe(1);
    // Choosing a sheet again clears the notice.
    hidden = false;
    fireEvent.click(screen.getAllByTestId("chat-side-panel-table-sheet-tab")[1]!);
    await screen.findByText("<b>not markup</b>");
    expect(screen.queryByText(previewKo["chatPreviewRail.tableSheetFallback"])).toBeNull();
  });

  it("keeps a page preview mounted on its page across a hide and show, re-reading that page as a fresh baseline", async () => {
    readDocument.mockImplementation(async (path: string, index: number) => pageResult(path, index));
    const body = (observe: boolean) => <PreviewBody observe={observe} api={{} as never} sessionId={OBSERVATION_SESSION} target={fileTarget("/w/slides.pptx")} />;
    const view = render(body(true));
    await screen.findByText("Outline 1");
    fireEvent.click(screen.getByRole("button", { name: /Next|다음/ }));
    const page = await screen.findByText("Outline 2");
    const reads = readDocument.mock.calls.length;
    view.rerender(body(false));
    expect(readDocument).toHaveBeenCalledTimes(reads);
    view.rerender(body(true));
    expect(page.isConnected).toBe(true);
    expect(screen.getByText("Outline 2")).toBe(page);
    // The page viewer observes agent edits, so showing it again reads the same page for a fresh baseline.
    await waitFor(() => expect(readDocument).toHaveBeenCalledTimes(reads + 1));
    expect(readDocument.mock.calls.at(-1)).toEqual(["/w/slides.pptx", 1, OBSERVATION_SESSION]);
    expect(screen.getByText("Outline 2").isConnected).toBe(true);
  });
});
