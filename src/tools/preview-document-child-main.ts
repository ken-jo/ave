import {
  PREVIEW_DOCUMENT_LIMITS,
  previewDocumentFormatOf,
} from "../shared/preview-document.js";
import { parseTableDocument } from "./table-document-reader.js";
import { TableDocumentError } from "./table-document-error.js";
import { DOCUMENT_PARSE_READY, isDocumentParseError, readDocumentResponse } from "./preview-document-protocol.js";

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
  const [formatArg, sheetArg, lengthArg] = process.argv.slice(2);
  const format = previewDocumentFormatOf(`input.${formatArg}`);
  const sheetIndex = Number(sheetArg);
  const length = Number(lengthArg);
  if (!format || format !== formatArg || process.argv.length !== 5
      || !Number.isSafeInteger(sheetIndex) || sheetIndex < 0 || sheetArg !== String(sheetIndex)
      || !Number.isSafeInteger(length) || length < 0 || lengthArg !== String(length)
      || length > PREVIEW_DOCUMENT_LIMITS.maxFileBytes) {
    throw new Error("Invalid document parse request.");
  }
  process.stdout.write(DOCUMENT_PARSE_READY);
  const document = readDocumentResponse(await parseTableDocument(await readInput(length), format, sheetIndex));
  const response = JSON.stringify({ ok: true, document });
  if (Buffer.byteLength(response) > PREVIEW_DOCUMENT_LIMITS.maxResponseBytes) {
    throw new TableDocumentError("parse-limit", "Document result exceeds its byte budget.");
  }
  process.stdout.write(response);
} catch (error) {
  const code = error instanceof TableDocumentError && isDocumentParseError(error.code) ? error.code : "read-failed";
  process.stdout.write(JSON.stringify({ ok: false, error: code }));
}
