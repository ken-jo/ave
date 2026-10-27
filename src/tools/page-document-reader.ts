import { fileURLToPath } from "node:url";
import { PREVIEW_DOCUMENT_LIMITS } from "../shared/preview-document.js";
import { PAGE_PREVIEW_LIMITS, type PreviewPageDocument, type PreviewPageFormat } from "../shared/preview-page-document.js";
import { TableDocumentError } from "./table-document-error.js";
import { readStructuredPageDocument } from "../observation/structured-document.js";
import { isUnicodeBoundary } from "../shared/bounded-tool-output.js";

function corrupt(): never { throw new TableDocumentError("corrupt-document", "Invalid document package."); }
function limit(): never { throw new TableDocumentError("parse-limit", "Document exceeds the page preview budget."); }

function boundedParagraphs(values: Iterable<string>): { paragraphs: string[]; textTruncated: boolean } {
  const paragraphs: string[] = [];
  let characters = 0;
  let textTruncated = false;
  for (const text of values) {
    if (text.trim().length === 0) continue;
    if (paragraphs.length === PAGE_PREVIEW_LIMITS.maxParagraphs || characters === PAGE_PREVIEW_LIMITS.maxTextChars) {
      textTruncated = true;
      break;
    }
    const limit = Math.min(text.length, PAGE_PREVIEW_LIMITS.maxTextChars - characters);
    const shown = text.slice(0, isUnicodeBoundary(text, limit) ? limit : limit - 1);
    paragraphs.push(shown);
    characters += shown.length;
    if (shown.length !== text.length) { textTruncated = true; break; }
  }
  return { paragraphs, textTruncated };
}

interface PdfStreamHandler {
  sendWithStream(this: PdfStreamHandler, action: string, ...rest: unknown[]): ReadableStream<unknown>;
}

const IMAGE_LIMIT_MESSAGE = "Image exceeded maximum allowed size and was removed.";
/** Worker streams a rendered page must be read through. */
const OBSERVED_PDF_STREAMS = ["GetOperatorList", "GetTextContent"] as const;

function rendererUnavailable(detail: string): never {
  throw new TableDocumentError("renderer-unavailable", detail);
}

/**
 * Record failures of the worker streams behind rendering and text extraction.
 * With `stopAtErrors`, pdf.js marks a failed operator stream as complete before
 * it rejects, so a page can render partially and still resolve. The display
 * transport is not a public API: the exact dependency pin keeps it stable, and
 * the check fails closed when the hook point is missing or was not used for
 * both streams, so a changed transport cannot pass a partial page.
 */
export function observePdfStreamFailures(document: object): { assertComplete(): void } {
  const handler = (document as { _transport?: { messageHandler?: PdfStreamHandler } })._transport?.messageHandler;
  if (!handler || typeof handler.sendWithStream !== "function") rendererUnavailable("PDF stream transport is unavailable.");
  let failure: { reason: unknown } | null = null;
  const streams = new Map<string, number>();
  const send = handler.sendWithStream;
  const record = (reason: unknown): never => {
    failure ??= { reason };
    throw reason;
  };
  handler.sendWithStream = function (action, ...rest) {
    const stream = send.call(this, action, ...rest);
    streams.set(action, (streams.get(action) ?? 0) + 1);
    // Rendering reads through getReader(); text extraction iterates with for-await.
    const getReader = stream.getReader.bind(stream) as () => ReadableStreamDefaultReader<unknown>;
    stream.getReader = (() => {
      const reader = getReader();
      const read = reader.read.bind(reader);
      reader.read = () => read().catch(record);
      return reader;
    }) as typeof stream.getReader;
    const iterate = stream[Symbol.asyncIterator].bind(stream);
    stream[Symbol.asyncIterator] = ((...options: unknown[]) => {
      const iterator = (iterate as (...args: unknown[]) => AsyncIterableIterator<unknown>)(...options);
      const next = iterator.next.bind(iterator);
      iterator.next = () => next().catch(record);
      return iterator;
    }) as typeof stream[typeof Symbol.asyncIterator];
    return stream;
  };
  return {
    assertComplete() {
      if (failure) {
        if (failure.reason instanceof Error && failure.reason.message === IMAGE_LIMIT_MESSAGE) limit();
        corrupt();
      }
      if (OBSERVED_PDF_STREAMS.some((action) => !streams.get(action))) {
        rendererUnavailable("PDF rendering bypassed the observed worker streams.");
      }
    },
  };
}

async function loadPdfRuntime() {
  try {
    const [canvas, library] = await Promise.all([import("@napi-rs/canvas"), import("pdfjs-dist/legacy/build/pdf.mjs")]);
    return { createCanvas: canvas.createCanvas, library };
  } catch {
    return rendererUnavailable("The PDF page renderer or its native canvas module could not be loaded.");
  }
}

export function pdfAssetDirectory(path: string): string {
  return `${path.replace(/[\\/]+$/, "")}/`;
}

async function pdf(bytes: Buffer, index: number): Promise<PreviewPageDocument> {
  if (!bytes.subarray(0, 1024).includes(Buffer.from("%PDF-"))) corrupt();
  const { createCanvas, library } = await loadPdfRuntime();
  const moduleUrl = import.meta.resolve("pdfjs-dist/legacy/build/pdf.mjs");
  // The minified worker is the packaged one; the display build keeps its type declarations.
  library.GlobalWorkerOptions.workerSrc = import.meta.resolve("pdfjs-dist/legacy/build/pdf.worker.min.mjs");
  let task: ReturnType<typeof library.getDocument> | undefined;
  try {
    // pdf.js 6 has no eval-based paths (the former isEvalSupported option is gone);
    // the child also runs with --disallow-code-generation-from-strings.
    task = library.getDocument({
      data: new Uint8Array(bytes), disableFontFace: true, useSystemFonts: false,
      useWorkerFetch: false, isOffscreenCanvasSupported: false, isImageDecoderSupported: false,
      maxImageSize: PAGE_PREVIEW_LIMITS.maxPixels, canvasMaxAreaInBytes: PAGE_PREVIEW_LIMITS.maxPixels * 4,
      stopAtErrors: true, verbosity: 0,
      standardFontDataUrl: pdfAssetDirectory(fileURLToPath(new URL("../../standard_fonts/", moduleUrl))),
      cMapUrl: pdfAssetDirectory(fileURLToPath(new URL("../../cmaps/", moduleUrl))),
      wasmUrl: pdfAssetDirectory(fileURLToPath(new URL("../../wasm/", moduleUrl))),
      iccUrl: pdfAssetDirectory(fileURLToPath(new URL("../../iccs/", moduleUrl))),
    });
    const document = await task.promise;
    const streams = observePdfStreamFailures(document);
    if (index >= Math.min(document.numPages, PAGE_PREVIEW_LIMITS.maxPages)) {
      throw new TableDocumentError("page-not-found", "Requested page does not exist.");
    }
    const page = await document.getPage(index + 1);
    const original = page.getViewport({ scale: 1 });
    if (!Number.isFinite(original.width * original.height) || original.width <= 0 || original.height <= 0) corrupt();
    const scale = Math.min(PAGE_PREVIEW_LIMITS.maxScale, PAGE_PREVIEW_LIMITS.maxSide / Math.max(original.width, original.height),
      Math.sqrt(PAGE_PREVIEW_LIMITS.maxPixels / (original.width * original.height)));
    const viewport = page.getViewport({ scale });
    const width = Math.max(1, Math.floor(viewport.width));
    const height = Math.max(1, Math.floor(viewport.height));
    const canvas = createCanvas(width, height);
    try {
      await page.render({ canvas: canvas as unknown as HTMLCanvasElement, viewport }).promise;
      const text = await page.getTextContent();
      streams.assertComplete();
      const png = canvas.toBuffer("image/png");
      if (png.length > PAGE_PREVIEW_LIMITS.maxPngBytes) limit();
      return { format: "pdf", totalPages: document.numPages, pagesTruncated: document.numPages > PAGE_PREVIEW_LIMITS.maxPages,
        page: { index, ...boundedParagraphs(text.items.flatMap((item) => "str" in item ? [item.str] : [])),
          png: png.toString("base64"), width, height } };
    } finally { page.cleanup(); canvas.width = 1; canvas.height = 1; }
  } catch (error) {
    if (error instanceof TableDocumentError) throw error;
    if (error instanceof Error && error.name === "PasswordException") {
      throw new TableDocumentError("encrypted", "Encrypted documents cannot be previewed.");
    }
    if (error instanceof Error && error.message === IMAGE_LIMIT_MESSAGE) limit();
    return corrupt();
  } finally { await task?.destroy(); }
}

export async function parsePageDocument(bytes: Buffer, format: PreviewPageFormat, index: number): Promise<PreviewPageDocument> {
  if (bytes.length > PREVIEW_DOCUMENT_LIMITS.maxFileBytes) throw new TableDocumentError("too-large", "Document exceeds the file size limit.");
  if (!Number.isSafeInteger(index) || index < 0) throw new TableDocumentError("invalid-index", "Page index must be a non-negative integer.");
  if (format === "hwp" || format === "hwpx") throw new TableDocumentError("engine-unavailable", "The optional document engine is not installed.");
  if (format === "docx" || format === "odt" || format === "pptx") return readStructuredPageDocument(bytes, format, index);
  if (format === "pdf") return pdf(bytes, index);
  throw new TableDocumentError("unsupported-format", "Unsupported document format.");
}
