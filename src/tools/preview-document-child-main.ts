import {
  PREVIEW_DOCUMENT_LIMITS,
  isPreviewTableWindow,
  previewDocumentFormatOf,
} from "../shared/preview-document.js";
import { parseTableDocument } from "./table-document-reader.js";
import { TableDocumentError } from "./table-document-error.js";
import { DOCUMENT_PARSE_READY, isDocumentParseError, readDocumentResponse } from "./preview-document-protocol.js";
import { previewPageFormatOf } from "../shared/preview-page-document.js";
import { readPageDocumentResponse } from "./preview-page-protocol.js";

async function readInput(length: number): Promise<Buffer> {
  const input = Buffer.allocUnsafe(length);
  let received = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (bytes.length > length - received) throw new Error("Document input length mismatch.");
    bytes.copy(input, received);
    received += bytes.length;
  }
  if (received !== length) throw new Error("Document input length mismatch.");
  return input;
}

try {
  const [formatArg, sheetArg, lengthArg, windowArg] = process.argv.slice(2);
  const tableFormat = previewDocumentFormatOf(`input.${formatArg}`);
  const pageFormat = previewPageFormatOf(`input.${formatArg}`);
  const format = tableFormat ?? pageFormat;
  const sheetIndex = Number(sheetArg);
  const length = Number(lengthArg);
  const window: unknown = windowArg === undefined ? undefined : JSON.parse(windowArg);
  if (!format || format !== formatArg || (process.argv.length !== 5 && process.argv.length !== 6)
      || (windowArg !== undefined && (!tableFormat || !isPreviewTableWindow(window)))
      || !Number.isSafeInteger(sheetIndex) || sheetIndex < 0 || sheetArg !== String(sheetIndex)
      || !Number.isSafeInteger(length) || length < 0 || lengthArg !== String(length)
      || length > PREVIEW_DOCUMENT_LIMITS.maxFileBytes) {
    throw new Error("Invalid document parse request.");
  }
  process.stdout.write(DOCUMENT_PARSE_READY);
  const bytes = await readInput(length);
  const document = tableFormat
    ? readDocumentResponse(await parseTableDocument(bytes, tableFormat, sheetIndex, PREVIEW_DOCUMENT_LIMITS,
      isPreviewTableWindow(window) ? window : undefined), isPreviewTableWindow(window) ? window : undefined)
    : readPageDocumentResponse(await (await import("./page-document-reader.js")).parsePageDocument(bytes, pageFormat!, sheetIndex));
  const response = JSON.stringify({ ok: true, document });
  if (Buffer.byteLength(response) > PREVIEW_DOCUMENT_LIMITS.maxResponseBytes) {
    throw new TableDocumentError("parse-limit", "Document result exceeds its byte budget.");
  }
  process.stdout.write(response);
} catch (error) {
  const code = error instanceof TableDocumentError && isDocumentParseError(error.code) ? error.code : "read-failed";
  process.stdout.write(JSON.stringify({ ok: false, error: code }));
}
