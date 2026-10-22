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
import { DOCUMENT_PARSE_MESSAGES, DOCUMENT_PARSE_READY, isDocumentParseError, readDocumentResponse } from "./preview-document-protocol.js";

let activeParses = 0;
const requests = new Map<string, ParseRequest>();

interface ParseRequest {
  owner: string;
  controller: AbortController;
  finished: Promise<void>;
  finish: () => void;
  admitted: boolean;
  released: boolean;
  running: boolean;
}

export interface DocumentParseSlot {
  readonly signal: AbortSignal;
  parse(bytes: Buffer, format: PreviewDocumentFormat, sheetIndex: number): Promise<PreviewTableDocument>;
  release(): void;
}

function documentError(code: keyof typeof DOCUMENT_PARSE_MESSAGES): TableDocumentError {
  return new TableDocumentError(code, DOCUMENT_PARSE_MESSAGES[code]);
}

function releaseRequest(request: ParseRequest): void {
  if (request.released) throw documentError("read-failed");
  request.released = true;
  if (request.admitted) activeParses -= 1;
  if (requests.get(request.owner) === request) requests.delete(request.owner);
  request.finish();
}

/** Admit before reading. A replacement waits for the old read and child to finish. */
export async function acquireParseSlot(owner: string, controller = new AbortController()): Promise<DocumentParseSlot> {
  if (typeof owner !== "string" || owner.length === 0) throw documentError("read-failed");
  if (controller.signal.aborted) throw documentError("superseded");
  const previous = requests.get(owner);
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => { finish = resolve; });
  const request: ParseRequest = {
    owner, controller, finished, finish,
    admitted: false, released: false, running: false,
  };
  requests.set(owner, request);
  previous?.controller.abort(documentError("superseded"));
  const signal = request.controller.signal;
  try {
    if (previous) await previous.finished;
    signal.throwIfAborted();
    if (activeParses >= PREVIEW_DOCUMENT_LIMITS.maxConcurrentParses) throw documentError("busy");
    request.admitted = true;
    activeParses += 1;
    return {
      signal,
      async parse(bytes, format, sheetIndex) {
        if (request.released || request.running) throw documentError("read-failed");
        signal.throwIfAborted();
        if (!Buffer.isBuffer(bytes) || previewDocumentFormatOf(`input.${format}`) !== format) throw documentError("read-failed");
        if (bytes.length > PREVIEW_DOCUMENT_LIMITS.maxFileBytes) throw documentError("too-large");
        if (!Number.isSafeInteger(sheetIndex) || sheetIndex < 0) throw documentError("sheet-not-found");
        request.running = true;
        try {
          const document = await runChild(bytes, format, sheetIndex, signal);
          signal.throwIfAborted();
          return document;
        } catch (error) {
          signal.throwIfAborted();
          if (error instanceof TableDocumentError) throw error;
          throw documentError("read-failed");
        } finally {
          request.running = false;
        }
      },
      release() {
        if (request.running) throw documentError("read-failed");
        releaseRequest(request);
      },
    };
  } catch (error) {
    releaseRequest(request);
    throw error;
  }
}

/** Parse admitted bytes in a bounded and killable child; native memory is not capped. */
function runChild(bytes: Buffer, format: PreviewDocumentFormat, sheetIndex: number, signal: AbortSignal): Promise<PreviewTableDocument> {
  // Resolve from the runtime asset root: this module may live in a split chunk.
  const entryPath = join(mainDir, "preview-document-child-main.js");
  if (!statSync(entryPath).isFile()) throw new TableDocumentError("read-failed", DOCUMENT_PARSE_MESSAGES["read-failed"]);
  const child = spawnManaged(process.execPath, [
    `--max-old-space-size=${PREVIEW_DOCUMENT_LIMITS.maxOldSpaceMb}`,
    "--disallow-code-generation-from-strings",
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
    const readyMarker = Buffer.from(DOCUMENT_PARSE_READY);
    let readyBytes = 0;
    let ready = false;
    let parseTimer: ReturnType<typeof setTimeout> | undefined;
    let failure: TableDocumentError | undefined;
    const stop = (code: "parse-limit" | "read-failed" | "superseded"): void => {
      failure ??= documentError(code);
      forceKillManagedChildProcess(child, "document-preview-stop");
    };
    const handleAbort = (): void => stop("superseded");
    const startupTimer = setTimeout(() => stop("read-failed"), PREVIEW_DOCUMENT_LIMITS.startupTimeoutMs);
    signal.addEventListener("abort", handleAbort, { once: true });
    child.stdout!.on("data", (chunk: Buffer) => {
      if (failure) return;
      if (!ready) {
        const count = Math.min(chunk.length, readyMarker.length - readyBytes);
        if (!chunk.subarray(0, count).equals(readyMarker.subarray(readyBytes, readyBytes + count))) {
          stop("read-failed");
          return;
        }
        readyBytes += count;
        chunk = chunk.subarray(count);
        if (readyBytes !== readyMarker.length) return;
        ready = true;
        clearTimeout(startupTimer);
        parseTimer = setTimeout(() => stop("parse-limit"), PREVIEW_DOCUMENT_LIMITS.parseTimeoutMs);
        child.stdin!.end(bytes);
      }
      total += chunk.length;
      if (total > PREVIEW_DOCUMENT_LIMITS.maxResponseBytes) stop("parse-limit");
      else if (chunk.length > 0) chunks.push(chunk);
    });
    // Never retain fatal diagnostics: they can include source text or dump paths.
    child.stderr!.resume();
    child.once("error", () => {
      failure ??= new TableDocumentError("read-failed", DOCUMENT_PARSE_MESSAGES["read-failed"]);
      if (child.pid) stop("read-failed");
    });
    child.stdin!.on("error", () => stop("read-failed"));
    child.once("close", (code, exitSignal) => {
      clearTimeout(startupTimer);
      clearTimeout(parseTimer);
      signal.removeEventListener("abort", handleAbort);
      if (failure) { reject(failure); return; }
      if (!ready || exitSignal || code !== 0) {
        reject(documentError(ready ? "parse-limit" : "read-failed"));
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
    if (signal.aborted) handleAbort();
  });
}
