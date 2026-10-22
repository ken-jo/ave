import type { QuickJSHandle } from "quickjs-emscripten-core";
import type {
  PreviewDocumentFormat, PreviewDocumentLimits, PreviewTableDocument,
} from "../shared/preview-document.js";
import { PREVIEW_DOCUMENT_LIMITS } from "../shared/preview-document.js";
import { WORKBOOK_DOCUMENT_PROGRAM } from "./workbook-document-parser.js?document-program";
import { DOCUMENT_PARSE_MESSAGES, isDocumentParseError } from "./preview-document-protocol.js";
import { TableDocumentError } from "./table-document-error.js";
import { prepareWorkbookContainer } from "./workbook-container.js";
import { openWorkbookWorkspace, type WorkbookWorkspace } from "./workbook-parser-workspace.js";

const maxParseErrorCodeChars = Math.max(...Object.keys(DOCUMENT_PARSE_MESSAGES).map(code => code.length));

function resourceFailure(): TableDocumentError {
  return new TableDocumentError("parse-limit", "Workbook parsing exceeded its resource budget.");
}

function parserFailure(workspace: WorkbookWorkspace, error: QuickJSHandle): TableDocumentError {
  const { context } = workspace;
  try {
    if (Date.now() >= workspace.deadline) return resourceFailure();
    const code = context.getProp(error, "code");
    try {
      if (context.typeof(code) !== "string") return resourceFailure();
      const length = context.getProp(code, "length");
      try { if (context.getNumber(length) > maxParseErrorCodeChars) return resourceFailure(); }
      finally { length.dispose(); }
      const value = context.getString(code);
      return isDocumentParseError(value)
        ? new TableDocumentError(value, "Workbook parsing was refused.") : resourceFailure();
    } finally { code.dispose(); }
  } catch { return resourceFailure(); }
}

/**
 * Container admission precedes workspace entry. Limits are internal display policy;
 * the process owner and workspace always enforce their shared production ceilings.
 */
export async function readWorkbookDocument(
  bytes: Buffer,
  format: Exclude<PreviewDocumentFormat, "csv" | "tsv">,
  sheetIndex: number,
  limits: Readonly<PreviewDocumentLimits>,
): Promise<Omit<PreviewTableDocument, "format">> {
  const maxInputBytes = Math.min(limits.maxFileBytes, PREVIEW_DOCUMENT_LIMITS.maxFileBytes);
  if (bytes.length > maxInputBytes) throw new TableDocumentError("too-large", "Workbook exceeds the input byte limit.");
  if (!Number.isSafeInteger(sheetIndex) || sheetIndex < 0) {
    throw new TableDocumentError("sheet-not-found", "Invalid workbook sheet index.");
  }
  const checked = prepareWorkbookContainer(bytes, format, limits);
  if (checked.length > maxInputBytes) throw resourceFailure();
  let workspace: WorkbookWorkspace;
  try { workspace = await openWorkbookWorkspace(); }
  catch { throw new TableDocumentError("read-failed", "Workbook runtime could not be initialized."); }
  const { context } = workspace;
  try {
    const initialized = context.evalCode(WORKBOOK_DOCUMENT_PROGRAM);
    if (initialized.error) {
      try { throw parserFailure(workspace, initialized.error); }
      finally { initialized.error.dispose(); }
    }
    initialized.value.dispose();
    const input = context.newArrayBuffer(checked.buffer.slice(checked.byteOffset, checked.byteOffset + checked.byteLength));
    try { context.setProp(context.global, "workbookBytes", input); }
    finally { input.dispose(); }
    const result = context.evalCode(`(() => {
      const text = JSON.stringify(workbookDocumentParser.readWorkbook(new Uint8Array(workbookBytes), ${sheetIndex}, ${JSON.stringify(limits)}));
      if (text.length > ${limits.maxResponseBytes}) throw { code: "parse-limit" };
      return text;
    })()`);
    if (result.error) {
      try { throw parserFailure(workspace, result.error); }
      finally { result.error.dispose(); }
    }
    try {
      const text = context.getString(result.value);
      if (Buffer.byteLength(text) > limits.maxResponseBytes) throw resourceFailure();
      return JSON.parse(text) as Omit<PreviewTableDocument, "format">;
    } finally { result.value.dispose(); }
  } catch (error) {
    if (error instanceof TableDocumentError) throw error;
    throw resourceFailure();
  } finally { workspace.dispose(); }
}
