import { join } from "node:path";
import { statSync } from "node:fs";
import { mainDir } from "../main/main-paths.js";
import { spawnManaged, forceKillManagedChildProcess } from "../main/managed-child-processes.js";
import { buildSafeChildEnv } from "./safe-env.js";
import {
  PREVIEW_DOCUMENT_LIMITS,
  previewDocumentFormatOf,
  type PreviewDocumentFormat,
  type PreviewTableDocument,
} from "../shared/preview-document.js";
import { isRecord } from "../shared/is-record.js";
import { TableDocumentError } from "./table-document-error.js";
import { DOCUMENT_PARSE_MESSAGES, isDocumentParseError, readDocumentResponse } from "./preview-document-protocol.js";

let activeParses = 0;

/** Run only admitted bytes in a disposable, heap-limited child. No in-process path. */
export async function parseTableDocumentIsolated(
  bytes: Buffer,
  format: PreviewDocumentFormat,
  sheetIndex: number,
): Promise<PreviewTableDocument> {
  if (!Buffer.isBuffer(bytes) || previewDocumentFormatOf(`input.${format}`) !== format) {
    throw new TableDocumentError("read-failed", DOCUMENT_PARSE_MESSAGES["read-failed"]);
  }
  if (bytes.length > PREVIEW_DOCUMENT_LIMITS.maxFileBytes) {
    throw new TableDocumentError("too-large", DOCUMENT_PARSE_MESSAGES["too-large"]);
  }
  if (!Number.isSafeInteger(sheetIndex) || sheetIndex < 0) {
    throw new TableDocumentError("sheet-not-found", DOCUMENT_PARSE_MESSAGES["sheet-not-found"]);
  }
  if (activeParses >= PREVIEW_DOCUMENT_LIMITS.maxConcurrentParses) {
    throw new TableDocumentError("parse-limit", DOCUMENT_PARSE_MESSAGES["parse-limit"]);
  }
  activeParses += 1;
  try {
    return await runChild(bytes, format, sheetIndex);
  } catch (error) {
    if (error instanceof TableDocumentError) throw error;
    throw new TableDocumentError("read-failed", DOCUMENT_PARSE_MESSAGES["read-failed"]);
  } finally {
    activeParses -= 1;
  }
}

function runChild(bytes: Buffer, format: PreviewDocumentFormat, sheetIndex: number): Promise<PreviewTableDocument> {
  // Resolve from the runtime asset root: this module may live in a split chunk.
  const entryPath = join(mainDir, "preview-document-child-main.js");
  if (!statSync(entryPath).isFile()) throw new TableDocumentError("read-failed", DOCUMENT_PARSE_MESSAGES["read-failed"]);
  const child = spawnManaged(process.execPath, [
    `--max-old-space-size=${PREVIEW_DOCUMENT_LIMITS.maxOldSpaceMb}`,
    entryPath,
    format, String(sheetIndex), String(bytes.length),
  ], {
    env: buildSafeChildEnv({ ELECTRON_RUN_AS_NODE: "1" }),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  }, { label: "document-preview" });
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let failure: TableDocumentError | undefined;
    const stop = (code: "parse-limit" | "read-failed"): void => {
      failure ??= new TableDocumentError(code, DOCUMENT_PARSE_MESSAGES[code]);
      forceKillManagedChildProcess(child, "document-preview-stop");
    };
    const timer = setTimeout(() => stop("parse-limit"), PREVIEW_DOCUMENT_LIMITS.parseTimeoutMs);
    child.stdout!.on("data", (chunk: Buffer) => {
      if (failure) return;
      total += chunk.length;
      if (total > PREVIEW_DOCUMENT_LIMITS.maxResponseBytes) stop("parse-limit");
      else chunks.push(chunk);
    });
    // Never retain fatal diagnostics: they can include source text or dump paths.
    child.stderr!.resume();
    child.once("error", () => {
      failure ??= new TableDocumentError("read-failed", DOCUMENT_PARSE_MESSAGES["read-failed"]);
      if (child.pid) stop("read-failed");
    });
    child.stdin!.on("error", () => stop("read-failed"));
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (failure) { reject(failure); return; }
      if (signal || code !== 0) {
        reject(new TableDocumentError("parse-limit", DOCUMENT_PARSE_MESSAGES["parse-limit"]));
        return;
      }
      try {
        const response: unknown = JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
        if (!isRecord(response)) throw new Error("Invalid document response.");
        if (response.ok === false && Object.keys(response).length === 2 && isDocumentParseError(response.error)) {
          reject(new TableDocumentError(response.error, DOCUMENT_PARSE_MESSAGES[response.error]));
          return;
        }
        if (response.ok !== true || Object.keys(response).length !== 2) throw new Error("Invalid document response.");
        const document = readDocumentResponse(response.document);
        if (document.format !== format || document.sheet.index !== sheetIndex) throw new Error("Document request mismatch.");
        resolve(document);
      } catch {
        reject(new TableDocumentError("read-failed", DOCUMENT_PARSE_MESSAGES["read-failed"]));
      }
    });
    child.stdin!.end(bytes);
  });
}
