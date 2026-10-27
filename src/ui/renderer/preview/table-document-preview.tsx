/**
 * Side-panel preview for table documents (csv/tsv/xlsx/xls/ods).
 *
 * The host reads the file (`window.ave.preview.readDocument`) under the same read
 * guard as text previews and returns one sheet as a bounded grid of display
 * strings; this component shows the sheet tabs, the truncation notices and the
 * lazily-loaded virtualized grid. Every cap the reader applied is stated to the
 * user — nothing is cut silently.
 */
import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Badge } from "../../../components/ui/badge.js";
import { useTranslation } from "../../../i18n/react.js";
import { resolveIpcErrorKey } from "../format-ipc-error.js";
import {
  PREVIEW_DOCUMENT_LIMITS,
  type PreviewDocumentError,
  type PreviewTableDocument,
} from "../../../shared/preview-document.js";
import type { DocumentObservationBinding, DocumentObservationEvent, DocumentObservationStatus } from "../../../shared/agent-observation.js";
import type { ObservedTableCell } from "./table-document-grid.js";
import { columnLetters } from "./table-coordinates.js";
import { PreviewDocumentHeader, PreviewDocumentLiveStrip, PreviewDocumentFooter, previewFormatLabel } from "./preview-document-chrome.js";
import { previewSupportsExternalOpen } from "../../../shared/preview-external-open.js";

const LazyTableDocumentGrid = lazy(() =>
  import(/* webpackChunkName: "table-document-grid" */ "./table-document-grid.js").then((mod) => ({
    default: mod.TableDocumentGrid,
  })),
);

/** Map a read-document error code to its user message key. */
export function tableErrorKey(code: Exclude<PreviewDocumentError, "superseded">): string {
  switch (code) {
    case "path-not-allowed":
    case "sensitive-path":
      return resolveIpcErrorKey(code) ?? "chatPreviewRail.fileErrorGeneric";
    case "not-a-file":
      return "chatPreviewRail.fileErrorGlob";
    case "too-large":
      return "chatPreviewRail.tableErrorTooLarge";
    case "archive-too-large":
      return "chatPreviewRail.tableErrorArchiveTooLarge";
    case "corrupt-document":
      return "chatPreviewRail.tableErrorCorrupt";
    case "parse-limit":
      return "chatPreviewRail.tableErrorParseLimit";
    case "busy":
      return "chatPreviewRail.tableErrorBusy";
    case "encrypted":
      return "chatPreviewRail.tableErrorEncrypted";
    case "unsupported-encoding":
      return "chatPreviewRail.tableErrorEncoding";
    case "invalid-index":
      return "formatIpcError.invalidIndex";
    case "sheet-not-found":
      return "chatPreviewRail.tableErrorSheetNotFound";
    case "page-not-found":
      return "pagePreview.notFound";
    case "renderer-unavailable":
      return "pagePreview.rendererUnavailable";
    case "unsupported-format":
      return "chatPreviewRail.tableErrorUnsupported";
    case "read-failed":
      return "chatPreviewRail.fileErrorNotFound";
    case "unauthorized":
      return "chatPreviewRail.fileErrorGeneric";
  }
}

type LoadState =
  | { phase: "loading" }
  | { phase: "ok"; path: string; document: PreviewTableDocument; observation?: DocumentObservationBinding;
    seq: number; changes: ObservedTableCell[]; status?: DocumentObservationStatus;
    latest?: { row: number; column: number; before: string; after: string; ts: number; advisory: boolean } }
  | { phase: "error"; code: Exclude<PreviewDocumentError, "superseded"> };

function TruncationNotices({ document }: { document: PreviewTableDocument }) {
  const { t } = useTranslation();
  const { sheet } = document;
  const prefixOnly = (document.format === "csv" || document.format === "tsv") && sheet.rowsTruncated;
  const notices: string[] = [];
  if (document.sheetsTruncated) {
    notices.push(t("chatPreviewRail.tableSheetsTruncated", {
      shown: document.sheetNames.length,
      total: document.totalSheets,
    }));
  }
  if (sheet.rowsTruncated) {
    notices.push(t(prefixOnly ? "chatPreviewRail.tablePrefixRowsTruncated" : "chatPreviewRail.tableRowsTruncated", {
      shown: sheet.rows.length, total: sheet.totalRows,
    }));
  }
  if (sheet.columnsTruncated) {
    notices.push(t(prefixOnly ? "chatPreviewRail.tablePrefixColumnsTruncated" : "chatPreviewRail.tableColumnsTruncated", {
      shown: sheet.rows[0]?.length ?? 0,
      total: sheet.totalColumns,
    }));
  }
  if (sheet.cellsTruncated) {
    notices.push(t("chatPreviewRail.tableCellsTruncated", { chars: PREVIEW_DOCUMENT_LIMITS.maxCellChars }));
  }
  if (notices.length === 0) return null;
  return (
    <div
      role="status"
      className="text-[10px] text-warning"
      data-testid="chat-side-panel-table-truncated"
    >
      {notices.join(" · ")}
    </div>
  );
}

/** Callers key this by path so a new file starts on its first sheet. */
export function TableDocumentPreview({ path, sessionId, workspaceRoot, canOpenExternal }: { path: string; sessionId?: string; workspaceRoot?: string; canOpenExternal?: boolean }) {
  const { t } = useTranslation();
  const [sheetIndex, setSheetIndex] = useState(0);
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  const [revision, setRevision] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [openFailed, setOpenFailed] = useState(false);
  const generation = useRef(0);
  const lastAcknowledgement = useRef("");

  useEffect(() => {
    let cancelled = false;
    let binding: DocumentObservationBinding | undefined;
    let lastSeq = 0;
    let observedPath = path;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    generation.current += 1;
    setOpenFailed(false);
    setRefreshFailed(false);
    setRefreshing(true);
    setState((previous) => previous.phase === "ok" && previous.document.sheet.index === sheetIndex && revision > 0
      ? { ...previous, changes: [], observation: undefined, status: undefined }
      : { phase: "loading" });
    const api = window.ave.preview;
    const release = (value: DocumentObservationBinding) => {
      void api.acknowledgeDocumentObservation({ action: "release", targetId: value.targetId,
        sessionId: value.sessionId, seq: lastSeq }).catch(() => {});
    };
    const handleObservations = (events: DocumentObservationEvent[]): void => {
      if (cancelled || !binding || binding.sessionId !== sessionId) return;
      for (const event of events) {
        if (event.source !== "document" || event.actor !== "agent" || event.sessionId !== binding.sessionId
          || event.target.id !== binding.targetId || event.target.path !== observedPath
          || !Number.isSafeInteger(event.seq) || event.seq <= lastSeq) continue;
        lastSeq = event.seq;
        setState((previous) => {
          if (previous.phase !== "ok" || previous.observation?.targetId !== binding?.targetId) return previous;
          if (event.kind === "snapshot") {
            if (!("sheet" in event.after) || event.after.sheet.index !== sheetIndex || event.after.format !== previous.document.format) {
              return { ...previous, seq: event.seq, changes: [], status: "observation-error" };
            }
            const { sheet } = event.after;
            const changes = previous.changes.flatMap((change) => {
              const value = sheet.rows[change.row - sheet.firstRow]?.[change.column - sheet.firstColumn];
              const before = previous.document.sheet.rows[change.row - previous.document.sheet.firstRow]?.[change.column - previous.document.sheet.firstColumn];
              return value === undefined || (change.advisory && value === before) ? [] : [{ ...change, value, advisory: false }];
            });
            let latest = previous.latest;
            if (latest) {
              const value = sheet.rows[latest.row - sheet.firstRow]?.[latest.column - sheet.firstColumn];
              const before = previous.document.sheet.rows[latest.row - previous.document.sheet.firstRow]?.[latest.column - previous.document.sheet.firstColumn] ?? "";
              latest = value === undefined || (latest.advisory && value === before) ? undefined
                : { ...latest, before: latest.advisory ? before : latest.before, after: value, advisory: false };
            }
            return { ...previous, document: event.after, seq: event.seq, changes, latest, status: "live" };
          }
          if (event.kind === "status") {
            const interrupted = event.after.code !== "live" && event.after.code !== "reconciling";
            return { ...previous, seq: event.seq, status: event.after.code,
              changes: interrupted ? [] : previous.changes };
          }
          const { sheet } = previous.document;
          if (event.element.kind !== "cell" || event.element.sheet !== sheet.name
            || event.element.row < sheet.firstRow || event.element.column < sheet.firstColumn
            || event.element.row >= sheet.firstRow + sheet.rows.length
            || event.element.column >= sheet.firstColumn + (sheet.rows[0]?.length ?? 0)) {
            return { ...previous, seq: event.seq };
          }
          const changed = { row: event.element.row, column: event.element.column,
            value: event.after, advisory: event.advisory, seq: event.seq };
          return { ...previous, seq: event.seq, status: event.advisory ? "reconciling" : "live",
            latest: { row: changed.row, column: changed.column, before: event.before, after: event.after, ts: event.ts, advisory: event.advisory },
            changes: [...previous.changes.filter((cell) => cell.row !== changed.row || cell.column !== changed.column), changed] };
        });
      }
    };
    const stopObserving = api.onDocumentObservation(handleObservations);
    const read = (attempt: number): void => {
      const resultPromise = sessionId === undefined
        ? api.readDocument(path, sheetIndex) : api.readDocument(path, sheetIndex, sessionId);
      void resultPromise.then((result) => {
        if (cancelled) {
          if (result.ok && result.observation) release(result.observation);
          return;
        }
        if (!result.ok && result.error === "busy") {
          const delay = PREVIEW_DOCUMENT_LIMITS.busyRetryDelaysMs[attempt];
          if (delay !== undefined) {
            retryTimer = setTimeout(() => { retryTimer = undefined; read(attempt + 1); }, delay);
            return;
          }
        }
        if (result.ok) {
          observedPath = result.path;
          binding = result.observation?.sessionId === sessionId ? result.observation : undefined;
          lastSeq = binding?.seq ?? 0;
          setState("sheet" in result.document
            ? { phase: "ok", path: result.path, document: result.document, observation: binding, seq: lastSeq, changes: [] }
            : { phase: "error", code: "unsupported-format" });
        } else if (result.error !== "superseded") {
          if (revision > 0) setRefreshFailed(true);
          setState((previous) => previous.phase === "ok" && revision > 0
            ? previous : { phase: "error", code: result.error as Exclude<PreviewDocumentError, "superseded"> });
        }
        setRefreshing(false);
      }).catch(() => {
        if (!cancelled) {
          if (revision > 0) setRefreshFailed(true);
          setState((previous) => previous.phase === "ok" && revision > 0
            ? previous : { phase: "error", code: "read-failed" });
          setRefreshing(false);
        }
      });
    };
    read(0);
    return () => {
      cancelled = true;
      generation.current += 1;
      clearTimeout(retryTimer);
      stopObserving();
      if (binding) release(binding);
    };
  }, [path, sessionId, sheetIndex, revision]);

  const acknowledgeRendered = useCallback(() => {
    if (state.phase !== "ok" || !state.observation) return;
    const { observation, seq } = state;
    const key = observation.targetId + ":" + seq;
    if (lastAcknowledgement.current === key) return;
    lastAcknowledgement.current = key;
    const current = generation.current;
    void window.ave.preview.acknowledgeDocumentObservation({ action: "rendered",
      targetId: observation.targetId, sessionId: observation.sessionId, seq }).then((result) => {
      if (!result.ok && current === generation.current) {
        setState((previous) => previous.phase === "ok"
          ? { ...previous, changes: [], status: "observation-error" } : previous);
      }
    }).catch(() => {
      if (current === generation.current) setState((previous) => previous.phase === "ok"
        ? { ...previous, changes: [], status: "observation-error" } : previous);
    });
  }, [state]);

  useLayoutEffect(() => {
    if (state.phase === "ok" && state.document.sheet.rows.length === 0) acknowledgeRendered();
  }, [state, acknowledgeRendered]);

  const header = <PreviewDocumentHeader path={state.phase === "ok" ? state.path : path} workspaceRoot={workspaceRoot}
    canOpenExternal={Boolean(canOpenExternal) || (state.phase === "ok" && previewSupportsExternalOpen(state.path))}
    onOpenError={() => setOpenFailed(true)}
    onReload={() => setRevision((previous) => previous + 1)} refreshing={refreshing} />;
  if (state.phase === "error") return <div className="space-y-2">{header}
    <PreviewDocumentLiveStrip error={openFailed ? t("chatPreviewRail.openDefaultAppError") : undefined} />
    <div className="text-[11px] text-destructive" data-testid="chat-side-panel-file-error">
      {t(tableErrorKey(state.code), { mb: PREVIEW_DOCUMENT_LIMITS.maxFileBytes / (1024 * 1024) })}
    </div></div>;
  const loading = <div className="text-xs text-muted-foreground" data-testid="chat-side-panel-table-loading">
    {t("chatPreviewRail.tableLoading")}
  </div>;
  if (state.phase === "loading") return <div className="space-y-2">{header}
    <PreviewDocumentLiveStrip error={openFailed ? t("chatPreviewRail.openDefaultAppError") : undefined} />{loading}</div>;

  const { document: table, changes, status, latest } = state;
  const { sheet } = table;
  const prefixOnly = (table.format === "csv" || table.format === "tsv") && sheet.rowsTruncated;
  const latestAddress = latest ? `${columnLetters(latest.column)}${latest.row + 1}` : "";
  const summary = latest ? `${latestAddress}: ${latest.before || t("chatPreviewRail.documentObservationBlank")} → ${latest.after || t("chatPreviewRail.documentObservationBlank")}` : undefined;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2" data-testid="chat-side-panel-table-preview">
      {header}
      <PreviewDocumentLiveStrip status={status} summary={summary} ts={latest?.ts}
        error={openFailed ? t("chatPreviewRail.openDefaultAppError")
          : refreshFailed ? t("chatPreviewRail.documentObservationRefreshFailed") : undefined} />
      {table.sheetNames.length > 1 ? (
        <div role="tablist" aria-label={t("chatPreviewRail.tableSheetsLabel")}
          className="flex min-w-0 shrink-0 gap-1 overflow-x-auto pb-1">
          {table.sheetNames.map((name, index) => (
            <button key={`${index}:${name}`} type="button" role="tab" aria-selected={index === sheet.index}
              disabled={refreshing} onClick={() => setSheetIndex(index)}
              className={index === sheet.index
                ? "shrink-0 rounded-md border bg-accent px-2 py-0.5 text-[11px] font-medium text-foreground"
                : "shrink-0 rounded-md border border-transparent px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-accent/(--opacity-strong) hover:text-foreground"}
              data-testid="chat-side-panel-table-sheet-tab">{name}</button>
          ))}
        </div>
      ) : null}
      {sheet.rows.length === 0 ? <div className="text-xs text-muted-foreground" data-testid="chat-side-panel-table-empty">
        {t("chatPreviewRail.tableEmpty")}
      </div> : <Suspense fallback={loading}>
        <LazyTableDocumentGrid sheet={sheet} label={t("chatPreviewRail.tableGridLabel", { name: sheet.name })} changes={changes} onRendered={acknowledgeRendered} />
      </Suspense>}
      <PreviewDocumentFooter>
        <span>{previewFormatLabel(path)} · {sheet.name} · {t(prefixOnly ? "chatPreviewRail.tablePrefixSummary" : "chatPreviewRail.tableSummary", { rows: sheet.totalRows, columns: sheet.totalColumns })}</span>
        {table.needsRecalculation ? <Badge variant="outline" role="status" title={t("chatPreviewRail.tableRecalculationHint")}
          className="px-1 py-0 text-[10px]" data-testid="chat-side-panel-table-recalculation">{t("chatPreviewRail.tableNeedsRecalculation")}</Badge> : null}
        <TruncationNotices document={table} />
      </PreviewDocumentFooter>
    </div>
  );
}
