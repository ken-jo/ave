import { createCanvas } from "@napi-rs/canvas";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentObservationEngine } from "../../shared/agent-observation.js";
import type { PreviewPageDocument } from "../../shared/preview-page-document.js";
import type { PreviewTableDocument } from "../../shared/preview-document.js";

const mocks = vi.hoisted(() => ({ installation: vi.fn(), read: vi.fn(), prepare: vi.fn(), convert: vi.fn(), release: vi.fn(), dispose: vi.fn() }));
vi.mock("../../main/document-engine-installation.js", () => ({
  getVerifiedDocumentEngineInstallation: mocks.installation,
  DocumentEngineInstallError: class extends Error {},
}));
vi.mock("../table-engine.js", () => ({ createTableObservationEngine: () => ({ id: "bounded-reader", parse: mocks.read }) }));
vi.mock("../libreoffice-process.js", () => ({ LibreOfficeSessionPool: class {
  prepare = mocks.prepare;
  convert = mocks.convert;
  releaseSession = mocks.release;
  dispose = mocks.dispose;
} }));
import { createDocumentObservationEngine, documentEngineImportSupported, stopDocumentEngineSessions } from "../libreoffice-engine.js";

const engines: DocumentObservationEngine[] = [];
const signal = () => new AbortController().signal;
const context = { sessionId: "session-one" };
function engine(platform?: NodeJS.Platform): DocumentObservationEngine {
  const value = createDocumentObservationEngine(platform ? { platform } : {});
  engines.push(value);
  return value;
}
function table(needsRecalculation = false): PreviewTableDocument {
  return { format: "xlsx", needsRecalculation, totalSheets: 1, sheetNames: ["Totals"], sheetsTruncated: false,
    sheet: { index: 0, name: "Totals", rows: [["12"]], firstRow: 0, firstColumn: 0, totalRows: 1, totalColumns: 1,
      rowsTruncated: false, columnsTruncated: false, cellsTruncated: false, clippedCells: [] } };
}
function page(format: PreviewPageDocument["format"], png: string | null = null): PreviewPageDocument {
  return { format, totalPages: 1, pagesTruncated: false,
    page: { index: 0, paragraphs: ["Observed paragraph"], textTruncated: false, png,
      width: png ? 1 : 0, height: png ? 1 : 0 } };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.installation.mockResolvedValue({ executable: "/verified/program" });
  mocks.release.mockResolvedValue(undefined);
  mocks.dispose.mockResolvedValue(undefined);
});
afterEach(async () => { for (const value of engines.splice(0)) await value.dispose?.(); });

describe("HWP/HWPX supported-format decision", () => {
  it("refuses HWP/HWPX on macOS with an explicit reason before any installation or engine call", async () => {
    const value = engine("darwin");
    for (const format of ["hwp", "hwpx"] as const) {
      await expect(value.parse(Buffer.from("hangul"), format, 0, signal(), context))
        .rejects.toMatchObject({ code: "engine-format-unsupported-on-platform" });
      await expect(value.prepare!(format, signal(), context)).rejects.toMatchObject({ code: "engine-format-unsupported-on-platform" });
    }
    expect(documentEngineImportSupported("darwin")).toBe(false);
    expect(mocks.installation).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.convert).not.toHaveBeenCalled();
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("keeps other formats on macOS on the engine path", async () => {
    mocks.convert.mockResolvedValue({ pdf: Buffer.alloc(0), recalculated: Buffer.from("derived") });
    mocks.read.mockResolvedValue(table());
    await engine("darwin").parse(Buffer.from("workbook"), "xlsx", 0, signal(), context);
    expect(mocks.convert).toHaveBeenCalledWith(expect.anything(), context.sessionId, expect.any(Buffer), "xlsx", expect.any(AbortSignal));
  });

  it.each(["linux", "win32"] as const)("hands HWP/HWPX to the engine unchanged on %s", async (platform) => {
    expect(documentEngineImportSupported(platform)).toBe(true);
    const value = engine(platform);
    mocks.prepare.mockResolvedValue(undefined);
    await value.prepare!("hwpx", signal(), context);
    expect(mocks.prepare).toHaveBeenCalledWith(expect.anything(), context.sessionId, "hwpx", expect.any(AbortSignal));
    mocks.convert.mockRejectedValue(Object.assign(new Error("engine reached"), { code: "engine-runtime-unavailable" }));
    await expect(value.parse(Buffer.from("hangul"), "hwp", 0, signal(), context)).rejects.toThrow("engine reached");
    expect(mocks.convert).toHaveBeenCalledWith(expect.anything(), context.sessionId, expect.any(Buffer), "hwp", expect.any(AbortSignal));
  });
});

describe("optional document observation engine", () => {
  it("awaits runtime readiness without reading document bytes during preparation", async () => {
    let ready!: () => void;
    mocks.prepare.mockReturnValue(new Promise<void>((resolve) => { ready = resolve; }));
    let prepared = false;
    const preparing = engine().prepare!("docx", signal(), context).then(() => { prepared = true; });
    await vi.waitFor(() => expect(mocks.prepare).toHaveBeenCalledOnce());
    expect(mocks.prepare).toHaveBeenCalledWith(expect.objectContaining({ executable: "/verified/program" }), context.sessionId,
      "docx", expect.any(AbortSignal));
    expect(prepared).toBe(false);
    ready();
    await preparing;
    expect(mocks.installation).toHaveBeenCalledOnce();
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.convert).not.toHaveBeenCalled();
  });
  it("prepares the absent engine deterministically without creating a runtime session", async () => {
    mocks.installation.mockResolvedValue(null);
    await engine().prepare?.("docx", signal(), context);
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it("keeps the existing table reader and its recalculation signal when installation is absent", async () => {
    mocks.installation.mockResolvedValue(null);
    const cached = table(true);
    mocks.read.mockResolvedValue(cached);
    const bytes = Buffer.from("unchanged source");
    expect(await engine().parse(bytes, "xlsx", 0, signal(), context)).toBe(cached);
    expect(mocks.read).toHaveBeenCalledWith(bytes, "xlsx", 0, expect.any(AbortSignal), context);
    expect(mocks.convert).not.toHaveBeenCalled();
  });

  it("uses deterministic page outlines when installation is absent", async () => {
    mocks.installation.mockResolvedValue(null);
    const outline = page("pptx");
    mocks.read.mockResolvedValue(outline);
    expect(await engine().parse(Buffer.from("source"), "pptx", 0, signal(), context)).toBe(outline);
    expect(mocks.convert).not.toHaveBeenCalled();
  });

  it("leaves text and passive formats on the bounded reader without looking up an installation", async () => {
    const text = { format: "text", content: "read only", lines: ["read only"], totalLines: 1, truncated: false };
    mocks.read.mockResolvedValue(text);
    expect(await engine().parse(Buffer.from("read only"), "text", 0, signal())).toBe(text);
    expect(mocks.installation).not.toHaveBeenCalled();
  });

  it("never converts without host session ownership", async () => {
    await expect(engine().parse(Buffer.from("source"), "xlsx", 0, signal())).rejects.toThrow("host-owned session");
    expect(mocks.convert).not.toHaveBeenCalled();
  });

  it("decodes only the recalculated derived workbook and preserves the source bytes", async () => {
    const source = Buffer.from("original workbook");
    const derived = Buffer.from("recalculated workbook");
    mocks.convert.mockResolvedValue({ pdf: Buffer.alloc(0), recalculated: derived });
    mocks.read.mockResolvedValue(table());
    const result = await engine().parse(source, "xlsx", 0, signal(), context);
    expect(result).toMatchObject({ needsRecalculation: false, sheet: { rows: [["12"]] } });
    expect(mocks.convert).toHaveBeenCalledWith(expect.objectContaining({ executable: "/verified/program" }), context.sessionId,
      source, "xlsx", expect.any(AbortSignal));
    expect(mocks.read).toHaveBeenCalledExactlyOnceWith(derived, "xlsx", 0, expect.any(AbortSignal), context);
    expect(source.toString()).toBe("original workbook");
  });

  it("refuses missing output and a derived workbook that still requests recalculation", async () => {
    mocks.convert.mockResolvedValue({ pdf: Buffer.alloc(0) });
    const value = engine();
    await expect(value.parse(Buffer.from("source"), "xlsx", 0, signal(), context)).rejects.toMatchObject({ code: "engine-failed" });
    expect(mocks.read).not.toHaveBeenCalled();
    mocks.convert.mockResolvedValue({ pdf: Buffer.alloc(0), recalculated: Buffer.from("derived") });
    mocks.read.mockResolvedValue(table(true));
    await expect(value.parse(Buffer.from("source"), "xlsx", 0, signal(), context)).rejects.toMatchObject({ code: "engine-failed" });
  });

  it("combines verified rendered pages with bounded paragraph/run source addresses", async () => {
    const source = { ...page("docx"), elements: [{ element: { kind: "paragraph" as const, paragraph: 0, run: 1 }, text: "Observed paragraph" }] };
    const png = createCanvas(1, 1).toBuffer("image/png").toString("base64");
    mocks.read.mockResolvedValueOnce(source).mockResolvedValueOnce(page("pdf", png));
    const pdf = Buffer.from("derived PDF");
    mocks.convert.mockResolvedValue({ pdf });
    const result = await engine().parse(Buffer.from("source"), "docx", 0, signal(), context);
    expect(result).toMatchObject({ format: "docx", elements: source.elements, page: { png, width: 1, height: 1 } });
    expect(mocks.read.mock.calls.map((call) => [call[1], call[2]])).toEqual([["docx", 0], ["pdf", 0]]);
  });

  it("preserves verification and conversion failures without selecting a reader fallback", async () => {
    const integrity = new Error("Signature mismatch");
    mocks.installation.mockRejectedValue(integrity);
    await expect(engine().parse(Buffer.from("source"), "xlsx", 0, signal(), context)).rejects.toBe(integrity);
    expect(mocks.read).not.toHaveBeenCalled();
    mocks.installation.mockResolvedValue({ executable: "/verified/program" });
    const failure = new Error("Conversion failed");
    mocks.convert.mockRejectedValue(failure);
    await expect(engine().parse(Buffer.from("source"), "xlsx", 0, signal(), context)).rejects.toBe(failure);
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("honors cancellation before lookup and after conversion without decoding stale output", async () => {
    const controller = new AbortController();
    controller.abort(new Error("Stopped"));
    await expect(engine().parse(Buffer.from("source"), "xlsx", 0, controller.signal, context)).rejects.toThrow("Stopped");
    expect(mocks.installation).not.toHaveBeenCalled();
    const current = new AbortController();
    mocks.convert.mockImplementation(async () => { current.abort(new Error("Stopped")); return { pdf: Buffer.alloc(0), recalculated: Buffer.from("derived") }; });
    await expect(engine().parse(Buffer.from("source"), "xlsx", 0, current.signal, context)).rejects.toThrow("Stopped");
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("drains session processes before uninstall and releases only the named session", async () => {
    mocks.convert.mockResolvedValue({ pdf: Buffer.alloc(0), recalculated: Buffer.from("derived") });
    mocks.read.mockResolvedValue(table());
    const value = engine();
    await value.parse(Buffer.from("source"), "xlsx", 0, signal(), context);
    await value.releaseSession?.(context.sessionId);
    expect(mocks.release).toHaveBeenCalledWith(context.sessionId);
    await stopDocumentEngineSessions();
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });

  it("waits for the old session to finish closing before a page reload can convert again", async () => {
    mocks.convert.mockResolvedValue({ pdf: Buffer.alloc(0), recalculated: Buffer.from("derived") });
    mocks.read.mockResolvedValue(table());
    const value = engine();
    await value.parse(Buffer.from("source"), "xlsx", 0, signal(), context);
    let finish!: () => void;
    mocks.release.mockReturnValueOnce(new Promise<void>((resolve) => { finish = resolve; }));
    const closing = value.releaseSession?.(context.sessionId);
    const reloading = value.parse(Buffer.from("new source"), "xlsx", 0, signal(), context);
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.convert).toHaveBeenCalledOnce();
    finish();
    await closing;
    await reloading;
    expect(mocks.convert).toHaveBeenCalledTimes(2);
  });

  it("aborts pending installation admission on disposal before any source parse starts", async () => {
    mocks.installation.mockImplementation((signal: AbortSignal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const value = engine();
    const parsing = value.parse(Buffer.from("source"), "docx", 0, signal(), context);
    const stopped = expect(parsing).rejects.toThrow("disposed");
    await value.dispose?.();
    await stopped;
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.convert).not.toHaveBeenCalled();
  });

  it("aborts an owned source parser on disposal and starts no converter afterward", async () => {
    let started!: () => void;
    const sourceStarted = new Promise<void>((resolve) => { started = resolve; });
    mocks.read.mockImplementation((_bytes: Buffer, _format: string, _index: number, signal: AbortSignal) => new Promise((_resolve, reject) => {
      started();
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const value = engine();
    const parsing = value.parse(Buffer.from("source"), "docx", 0, signal(), context);
    const stopped = expect(parsing).rejects.toThrow("disposed");
    await sourceStarted;
    await value.dispose?.();
    await stopped;
    expect(mocks.convert).not.toHaveBeenCalled();
  });

  it.each(["release", "stop"])("drains a pending source parse before %s completes even without a process pool", async (action) => {
    let started!: () => void;
    const sourceStarted = new Promise<void>((resolve) => { started = resolve; });
    mocks.read.mockImplementation((_bytes: Buffer, _format: string, _index: number, signal: AbortSignal) => new Promise((_resolve, reject) => {
      started();
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const value = engine();
    const parsing = value.parse(Buffer.from("source"), "docx", 0, signal(), context);
    const interrupted = expect(parsing).rejects.toThrow(action === "release" ? "released" : "stopped");
    await sourceStarted;
    if (action === "release") await value.releaseSession?.(context.sessionId);
    else await stopDocumentEngineSessions();
    await interrupted;
    expect(mocks.convert).not.toHaveBeenCalled();
    mocks.read.mockResolvedValue(table());
    mocks.convert.mockResolvedValue({ pdf: Buffer.alloc(0), recalculated: Buffer.from("derived") });
    expect(await value.parse(Buffer.from("source"), "xlsx", 0, signal(), context)).toMatchObject({ needsRecalculation: false });
  });

  it("stops a reload that was already waiting for a prior session release", async () => {
    mocks.read.mockResolvedValue(table());
    mocks.convert.mockResolvedValue({ pdf: Buffer.alloc(0), recalculated: Buffer.from("derived") });
    const value = engine();
    await value.parse(Buffer.from("source"), "xlsx", 0, signal(), context);
    let finish!: () => void;
    mocks.release.mockReturnValueOnce(new Promise<void>((resolve) => { finish = resolve; }));
    const closing = value.releaseSession?.(context.sessionId);
    const reload = value.parse(Buffer.from("new source"), "xlsx", 0, signal(), context);
    const interrupted = expect(reload).rejects.toThrow("stopped");
    let stopped = false;
    const stopping = stopDocumentEngineSessions().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    finish();
    await closing;
    await stopping;
    await interrupted;
    expect(mocks.convert).toHaveBeenCalledOnce();
  });

  it("keeps an unrelated passive reader usable while uninstall drains conversion work", async () => {
    let resolvePassive!: (document: PreviewPageDocument) => void;
    let sourceStarted!: () => void;
    const sourcePending = new Promise<void>((resolve) => { sourceStarted = resolve; });
    mocks.read.mockImplementation((_bytes: Buffer, format: string, _index: number, signal: AbortSignal) => {
      if (format === "pdf") return new Promise<PreviewPageDocument>((resolve) => { resolvePassive = resolve; });
      return new Promise((_resolve, reject) => {
        sourceStarted();
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    const value = engine();
    let passiveSettled = false;
    const passive = value.parse(Buffer.from("PDF"), "pdf", 0, signal(), { sessionId: "passive-session" })
      .then((document) => { passiveSettled = true; return document; });
    const conversion = value.parse(Buffer.from("source"), "docx", 0, signal(), context);
    const interrupted = expect(conversion).rejects.toThrow("stopped");
    await sourcePending;
    await stopDocumentEngineSessions();
    await interrupted;
    expect(passiveSettled).toBe(false);
    const rendered = page("pdf", createCanvas(1, 1).toBuffer("image/png").toString("base64"));
    resolvePassive(rendered);
    expect(await passive).toBe(rendered);
  });
});
