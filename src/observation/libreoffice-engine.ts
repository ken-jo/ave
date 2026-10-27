import type { DocumentObservationEngine, DocumentObservationEngineContext, ObservedDocument } from "../shared/agent-observation.js";
import type { PreviewAnyFormat, PreviewPageDocument } from "../shared/preview-page-document.js";
import { PREVIEW_DOCUMENT_LIMITS } from "../shared/preview-document.js";
import { DocumentEngineInstallError, getVerifiedDocumentEngineInstallation } from "../main/document-engine-installation.js";
import { TableDocumentError } from "../tools/table-document-error.js";
import { readPageDocumentResponse } from "../tools/preview-page-protocol.js";
import { createTableObservationEngine } from "./table-engine.js";
import { LibreOfficeSessionPool } from "./libreoffice-process.js";

type ConversionFormat = "docx" | "odt" | "pptx" | "xlsx" | "ods" | "hwp" | "hwpx";

/**
 * Owner decision (supported formats, not a test skip): HWP/HWPX are not offered on macOS. Registering the pinned
 * importer's Java component makes `unopkg` start the office's `uno` helper, and on macOS 26 the pinned LibreOffice
 * 26.8.1 helper is killed at launch (`CODESIGNING / Launch Constraint Violation`), leaving a crash report each time.
 * Lift this when a pinned TDF build's helper runs on macOS. The engine never receives these formats here.
 */
const IMPORT_UNSUPPORTED_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set(["darwin"]);

export function documentEngineImportSupported(platform: NodeJS.Platform): boolean {
  return !IMPORT_UNSUPPORTED_PLATFORMS.has(platform);
}

function assertFormatSupported(format: PreviewAnyFormat | "text", platform: NodeJS.Platform): void {
  if ((format === "hwp" || format === "hwpx") && !documentEngineImportSupported(platform)) {
    throw new TableDocumentError("engine-format-unsupported-on-platform", "HWP/HWPX documents are not supported on this platform.");
  }
}
interface EngineLifetime { stop(): Promise<void> }
interface EngineParse { controller: AbortController; sessionId?: string; conversion: boolean }
const engineLifetimes = new Set<EngineLifetime>();

function converts(format: PreviewAnyFormat | "text"): format is ConversionFormat {
  return format === "docx" || format === "odt" || format === "pptx" || format === "xlsx"
    || format === "ods" || format === "hwp" || format === "hwpx";
}

function invalidOutput(): never {
  throw new TableDocumentError("engine-failed", "Document engine output violates the preview contract.");
}

/** An absent optional installation selects the admitted reader; conversion failures never do. */
export function createDocumentObservationEngine({ platform = process.platform }: { platform?: NodeJS.Platform } = {}): DocumentObservationEngine {
  const reader = createTableObservationEngine();
  let pool: LibreOfficeSessionPool | undefined;
  const shutdown = new AbortController();
  const activeParses = new Map<Promise<unknown>, EngineParse>();
  const sessionDrains = new Map<string, Promise<void>>();
  let stopping: Promise<void> | undefined;
  let disposed = false;
  const lifetime: EngineLifetime = {
    stop() {
      if (stopping) return stopping;
      const stopped = pool;
      pool = undefined;
      const active = [...activeParses].filter(([, parse]) => parse.conversion);
      for (const [, parse] of active) parse.controller.abort(new Error("Document engine sessions were stopped."));
      const cleanup = (async () => {
        await Promise.allSettled(active.map(([pending]) => pending));
        await stopped?.dispose();
        await Promise.all([...sessionDrains.values()]);
      })();
      stopping = cleanup;
      void cleanup.then(() => { if (stopping === cleanup) stopping = undefined; }, () => {});
      return cleanup;
    },
  };
  engineLifetimes.add(lifetime);

  return {
    id: "libreoffice",
    prepare(format, signal, context) {
      return runOwned(format, signal, context, async (ownedSignal, entry) => {
        if (!converts(format)) return;
        assertFormatSupported(format, platform);
        const installation = await readInstallation(ownedSignal);
        ownedSignal.throwIfAborted();
        if (installation === null) {
          entry.conversion = false;
          return;
        }
        const session = requireSession(context);
        pool ??= new LibreOfficeSessionPool();
        await pool.prepare(installation, session.sessionId, format, ownedSignal);
      });
    },
    parse(bytes, format, selectionIndex, signal, context) {
      return runOwned(format, signal, context, (ownedSignal, entry) =>
        parseDocument(bytes, format, selectionIndex, ownedSignal, context, entry));
    },
    releaseSession(sessionId) {
      const prior = sessionDrains.get(sessionId);
      if (prior) return prior;
      const active = [...activeParses].filter(([, parse]) => parse.sessionId === sessionId);
      for (const [, parse] of active) parse.controller.abort(new Error("Document engine session was released."));
      const current = pool;
      const cleanup = (async () => {
        await Promise.allSettled(active.map(([pending]) => pending));
        await current?.releaseSession(sessionId);
      })();
      sessionDrains.set(sessionId, cleanup);
      void cleanup.then(() => { if (sessionDrains.get(sessionId) === cleanup) sessionDrains.delete(sessionId); }, () => {});
      return cleanup;
    },
    async dispose() {
      disposed = true;
      shutdown.abort(new Error("Document observation engine is disposed."));
      engineLifetimes.delete(lifetime);
      await Promise.allSettled([...activeParses.keys()]);
      await lifetime.stop();
    },
  };

  function runOwned<T>(format: PreviewAnyFormat | "text", signal: AbortSignal, context: DocumentObservationEngineContext | undefined,
    run: (signal: AbortSignal, entry: EngineParse) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const ownedSignal = AbortSignal.any([signal, shutdown.signal, controller.signal]);
    const entry: EngineParse = { controller, sessionId: context?.sessionId, conversion: converts(format) };
    const pending = (async () => {
      if (disposed) throw new Error("Document observation engine is disposed.");
      for (;;) {
        ownedSignal.throwIfAborted();
        const gate = entry.conversion ? stopping ?? (entry.sessionId ? sessionDrains.get(entry.sessionId) : undefined) : undefined;
        if (!gate) break;
        await gate;
      }
      ownedSignal.throwIfAborted();
      return run(ownedSignal, entry);
    })();
    activeParses.set(pending, entry);
    void pending.then(() => activeParses.delete(pending), () => activeParses.delete(pending));
    return pending;
  }

  function readInstallation(signal: AbortSignal) {
    return getVerifiedDocumentEngineInstallation(signal).catch((error: unknown) => {
      signal.throwIfAborted();
      if (!(error instanceof DocumentEngineInstallError)) throw error;
      const failure = new TableDocumentError("engine-integrity-failed", "Document engine integrity verification failed.");
      Object.defineProperty(failure, "cause", { value: error });
      throw failure;
    });
  }

  async function parseDocument(bytes: Buffer, format: PreviewAnyFormat | "text", selectionIndex: number, signal: AbortSignal,
    context: DocumentObservationEngineContext | undefined, entry: EngineParse): Promise<ObservedDocument> {
    if (disposed) throw new Error("Document observation engine is disposed.");
    signal.throwIfAborted();
    if (bytes.length > PREVIEW_DOCUMENT_LIMITS.maxFileBytes) {
      throw new TableDocumentError("too-large", "Document exceeds the file size limit.");
    }
    if (!Number.isSafeInteger(selectionIndex) || selectionIndex < 0) {
      throw new TableDocumentError("invalid-index", "Document index must be a non-negative integer.");
    }
    if (!converts(format)) return reader.parse(bytes, format, selectionIndex, signal, context);
    assertFormatSupported(format, platform);
    const installation = await readInstallation(signal);
    signal.throwIfAborted();
    if (installation === null) {
      entry.conversion = false;
      return reader.parse(bytes, format, selectionIndex, signal, context);
    }
    const session = requireSession(context);

    const table = format === "xlsx" || format === "ods";
    const source = table || format === "hwp" || format === "hwpx" ? undefined
      : await readSource(bytes, format, selectionIndex, signal, session);
    signal.throwIfAborted();
    if (disposed) throw new Error("Document observation engine is disposed.");
    pool ??= new LibreOfficeSessionPool();
    const converted = await pool.convert(installation, session.sessionId, bytes, format, signal);
    signal.throwIfAborted();
    if (table) {
      if (!converted.recalculated || converted.recalculated.length === 0) invalidOutput();
      const document = await reader.parse(converted.recalculated, format, selectionIndex, signal, context);
      if (!("sheet" in document) || document.format !== format || document.sheet.index !== selectionIndex
        || document.needsRecalculation) invalidOutput();
      return document;
    }

    if (converted.pdf.length === 0) invalidOutput();
    const rendered = await reader.parse(converted.pdf, "pdf", selectionIndex, signal, context);
    if (!("page" in rendered) || rendered.format !== "pdf" || rendered.page.index !== selectionIndex) invalidOutput();
    const imported = converted.structured && (format === "hwp" || format === "hwpx")
      ? await readSource(converted.structured, "odt", 0, signal, session) : undefined;
    const document = readPageDocumentResponse({ ...rendered, format,
      ...((source ?? imported)?.elements ? { elements: (source ?? imported)!.elements } : {}),
      page: { ...rendered.page,
        textTruncated: rendered.page.textTruncated || source?.page.textTruncated === true || imported?.page.textTruncated === true },
    });
    if (Buffer.byteLength(JSON.stringify(document)) > PREVIEW_DOCUMENT_LIMITS.maxResponseBytes) invalidOutput();
    return document;
  }

  async function readSource(bytes: Buffer, format: "docx" | "odt" | "pptx", selectionIndex: number,
    signal: AbortSignal, context: DocumentObservationEngineContext): Promise<PreviewPageDocument> {
    const source: ObservedDocument = await reader.parse(bytes, format, format === "pptx" ? selectionIndex : 0, signal, context);
    if (!("page" in source) || source.format !== format) invalidOutput();
    return source;
  }

  function requireSession(context: DocumentObservationEngineContext | undefined): DocumentObservationEngineContext {
    if (!context || context.sessionId.length === 0 || context.sessionId.length > 256) {
      throw new Error("Document engine requires a host-owned session.");
    }
    return context;
  }
}

/** Uninstall drains every owned session before removing its verified installation. */
export async function stopDocumentEngineSessions(): Promise<void> {
  await Promise.all([...engineLifetimes].map((engine) => engine.stop()));
}
