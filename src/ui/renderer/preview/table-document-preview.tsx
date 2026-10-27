/**
 * Side-panel preview for table documents (csv/tsv/xlsx/xls/ods).
 *
 * The host reads the file (`window.ave.preview.readDocument`) under the same read
 * guard as text previews and returns one sheet as a bounded grid of display
 * strings; this component shows the sheet tabs, the truncation notices and the
 * lazily-loaded virtualized grid. Every cap the reader applied is stated to the
 * user — nothing is cut silently.
 */
import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { Badge } from "../../../components/ui/badge.js";
import { useTranslation } from "../../../i18n/react.js";
import { resolveIpcErrorKey } from "../format-ipc-error.js";
import {
  PREVIEW_DOCUMENT_LIMITS,
  type PreviewDocumentError,
  type PreviewTableDocument,
} from "../../../shared/preview-document.js";
import type { XlsxCellValue, XlsxPanelEditError, XlsxPanelEditRequest } from "../../../shared/xlsx-panel-edit.js";
import type { TableCellDraft } from "./table-document-grid.js";

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
  | { phase: "ok"; document: PreviewTableDocument; editToken?: string }
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
      className="space-y-0.5 rounded-md border border-warning/(--opacity-medium) bg-warning/(--opacity-subtle) px-2 py-1.5 text-[11px] text-foreground"
      data-testid="chat-side-panel-table-truncated"
    >
      {notices.map((notice) => <div key={notice}>{notice}</div>)}
    </div>
  );
}

const XLSX_ERROR_KEYS: Record<XlsxPanelEditError, string> = {
  "invalid-request": "chatPreviewRail.xlsxErrorInvalidRequest",
  unauthorized: "chatPreviewRail.xlsxErrorUnauthorized",
  expired: "chatPreviewRail.xlsxErrorExpired",
  "stale-file": "chatPreviewRail.xlsxErrorStaleFile",
  "edit-unavailable": "chatPreviewRail.xlsxErrorUnavailable",
  "unsupported-cell": "chatPreviewRail.xlsxErrorUnsupportedCell",
  "backup-exists": "chatPreviewRail.xlsxErrorBackupExists",
  "edit-failed": "chatPreviewRail.xlsxErrorFailed",
  busy: "chatPreviewRail.xlsxErrorBusy",
};

/** Callers key this by path so a new file starts on its first sheet. */
export function TableDocumentPreview({ path }: { path: string }) {
  const { t } = useTranslation();
  const [sheetIndex, setSheetIndex] = useState(0);
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  const [revision, setRevision] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [draft, setDraft] = useState<TableCellDraft | null>(null);
  const [operation, setOperation] = useState<"cell" | "save" | null>(null);
  const [saved, setSaved] = useState(false);
  const [editError, setEditError] = useState<XlsxPanelEditError | "invalid-value" | null>(null);
  const generation = useRef(0);
  const operationActive = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let token: string | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    generation.current += 1;
    operationActive.current = false;
    setOperation(null);
    setDraft(null);
    setRefreshFailed(false);
    setRefreshing(true);
    setState((previous) => previous.phase === "ok" && previous.document.sheet.index === sheetIndex && revision > 0
      ? previous : { phase: "loading" });
    const release = (value: string) => {
      void window.ave.preview.editXlsx({ action: "release", token: value }).catch(() => {});
    };
    const read = (attempt: number): void => {
      void window.ave.preview.readDocument(path, sheetIndex).then((result) => {
        if (cancelled) {
          if (result.ok && result.editToken) release(result.editToken);
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
          token = result.editToken;
          setState("sheet" in result.document
            ? { phase: "ok", document: result.document, editToken: token }
            : { phase: "error", code: "unsupported-format" });
        } else if (result.error !== "superseded") {
          if (revision > 0) setRefreshFailed(true);
          setState((previous) => {
            if (previous.phase === "ok" && revision > 0) {
              return { ...previous, editToken: undefined };
            }
            return { phase: "error", code: result.error as Exclude<PreviewDocumentError, "superseded"> };
          });
        }
        setRefreshing(false);
      }).catch(() => {
        if (!cancelled) {
          if (revision > 0) setRefreshFailed(true);
          setState((previous) => {
            if (previous.phase === "ok" && revision > 0) {
              return { ...previous, editToken: undefined };
            }
            return { phase: "error", code: "read-failed" };
          });
          setRefreshing(false);
        }
      });
    };
    read(0);
    return () => {
      cancelled = true;
      generation.current += 1;
      clearTimeout(retryTimer);
      if (token) release(token);
    };
  }, [path, sheetIndex, revision]);

  const requestEdit = async (request: XlsxPanelEditRequest) => {
    if (operationActive.current) return null;
    operationActive.current = true;
    const current = generation.current;
    setOperation(request.action === "release" ? null : request.action);
    setEditError(null);
    try {
      const result = await window.ave.preview.editXlsx(request);
      if (current !== generation.current) return null;
      if (!result.ok) {
        setEditError(result.error);
        if (["expired", "stale-file", "unauthorized"].includes(result.error)) {
          setDraft(null);
          setState((previous) => previous.phase === "ok" ? { ...previous, editToken: undefined } : previous);
        }
      }
      return result;
    } catch {
      if (current === generation.current) setEditError("edit-failed");
      return null;
    } finally {
      if (current === generation.current) {
        operationActive.current = false;
        setOperation(null);
      }
    }
  };
  const token = state.phase === "ok" ? state.editToken : undefined;
  const beginCell = async (row: number, column: number) => {
    if (!token || refreshing || operationActive.current) return;
    setSaved(false);
    const result = await requestEdit({ action: "cell", token, row, column });
    if (result?.ok && result.action === "cell") setDraft({ row, column, formula: result.formula,
      type: result.value === null ? "empty" : typeof result.value === "boolean" ? "boolean"
        : typeof result.value === "number" ? "number" : "text",
      text: result.value === null ? "" : String(result.value) });
  };
  const saveCell = async () => {
    if (!draft || !token || operationActive.current || refreshing) return;
    let value: XlsxCellValue = draft.text;
    if (draft.type === "empty") value = null;
    else if (draft.type === "boolean") value = draft.text === "true";
    else if (draft.type === "number") {
      value = Number(draft.text);
      if (!draft.text.trim() || !Number.isFinite(value)) { setEditError("invalid-value"); return; }
    }
    const result = await requestEdit({ action: "save", token, row: draft.row, column: draft.column, value });
    if (result?.ok) {
      setDraft(null);
      setSaved(true);
      setRevision((previous) => previous + 1);
    }
  };
  const cancelDraft = () => { setDraft(null); setEditError(null); };
  const reload = () => {
    setDraft(null); setEditError(null); setSaved(false);
    setRevision((previous) => previous + 1);
  };
  const locked = operation !== null || refreshing;

  if (state.phase === "error") {
    return (
      <div className="text-[11px] text-destructive" data-testid="chat-side-panel-file-error">
        {t(tableErrorKey(state.code), { mb: PREVIEW_DOCUMENT_LIMITS.maxFileBytes / (1024 * 1024) })}
      </div>
    );
  }

  const loading = (
    <div className="text-xs text-muted-foreground" data-testid="chat-side-panel-table-loading">
      {t("chatPreviewRail.tableLoading")}
    </div>
  );
  if (state.phase === "loading") return loading;

  const { document } = state;
  const { sheet } = document;
  const prefixOnly = (document.format === "csv" || document.format === "tsv") && sheet.rowsTruncated;
  return (
    // Flex column down to the grid: the grid takes the height the panel has
    // left and is the only scroll container (see PreviewDetail).
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2" data-testid="chat-side-panel-table-preview">
      {document.sheetNames.length > 1 ? (
        <div
          role="tablist"
          aria-label={t("chatPreviewRail.tableSheetsLabel")}
          className="flex min-w-0 shrink-0 gap-1 overflow-x-auto pb-1"
        >
          {document.sheetNames.map((name, index) => (
            <button
              key={`${index}:${name}`}
              type="button"
              role="tab"
              aria-selected={index === sheet.index}
              disabled={locked || draft !== null}
              onClick={() => { setEditError(null); setSaved(false); setSheetIndex(index); }}
              className={
                index === sheet.index
                  ? "shrink-0 rounded-md border bg-accent px-2 py-0.5 text-[11px] font-medium text-foreground"
                  : "shrink-0 rounded-md border border-transparent px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-accent/(--opacity-strong) hover:text-foreground"
              }
              data-testid="chat-side-panel-table-sheet-tab"
            >
              {name}
            </button>
          ))}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="px-1 py-0 text-[10px] uppercase">
          {document.format}
        </Badge>
        {document.needsRecalculation ? (
          <Badge variant="outline" role="status" title={t("chatPreviewRail.tableRecalculationHint")}
            data-testid="chat-side-panel-table-recalculation">
            {t("chatPreviewRail.tableNeedsRecalculation")}
          </Badge>
        ) : null}
        <span className="text-[11px] text-muted-foreground">
          {t(prefixOnly ? "chatPreviewRail.tablePrefixSummary" : "chatPreviewRail.tableSummary", {
            rows: sheet.totalRows, columns: sheet.totalColumns,
          })}
        </span>
      </div>
      {document.format === "xlsx" ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2 text-[11px]" data-testid="xlsx-edit-controls">
          {token ? <span>{t("chatPreviewRail.xlsxEditHint")}</span> : null}
          {operation ? <span role="status">{t(operation === "save" ? "chatPreviewRail.xlsxSaving" : "chatPreviewRail.xlsxPreparing")}</span> : null}
          {refreshing ? <span role="status">{t("chatPreviewRail.xlsxReloading")}</span> : null}
          {saved ? <span role="status" data-testid="xlsx-saved">{t("chatPreviewRail.xlsxSaved")}</span> : null}
          {editError ? <span role="alert" className="text-destructive">{t(editError === "invalid-value"
            ? "chatPreviewRail.xlsxErrorInvalidValue" : XLSX_ERROR_KEYS[editError])}</span> : null}
          {refreshFailed ? <span role="alert" className="text-destructive">{t("chatPreviewRail.xlsxRefreshFailed")}</span> : null}
          {editError || refreshFailed ? <button type="button" disabled={locked} onClick={reload}
            className="rounded border px-2 py-1">{t("chatPreviewRail.xlsxReload")}</button> : null}
        </div>
      ) : null}
      {draft ? <div className="flex shrink-0 flex-wrap items-center gap-2 text-[11px]" data-testid="xlsx-edit-actions">
        <span>{t("chatPreviewRail.xlsxCellLabel", { row: draft.row + 1, column: draft.column + 1 })}</span>
        {draft.formula ? <span role="note">{t("chatPreviewRail.xlsxFormulaOverwriteHint")}</span> : null}
        <button type="button" disabled={locked} onClick={() => void saveCell()} className="rounded border px-2 py-1">
          {t("chatPreviewRail.xlsxSave")}</button>
        <button type="button" disabled={locked} onClick={cancelDraft} className="rounded border px-2 py-1">
          {t("chatPreviewRail.xlsxCancel")}</button>
      </div> : null}
      <TruncationNotices document={document} />
      {sheet.rows.length === 0 ? (
        <div className="text-xs text-muted-foreground" data-testid="chat-side-panel-table-empty">
          {t("chatPreviewRail.tableEmpty")}
        </div>
      ) : (
        <Suspense fallback={loading}>
          <LazyTableDocumentGrid sheet={sheet} label={t("chatPreviewRail.tableGridLabel", { name: sheet.name })}
            onEditCell={document.format === "xlsx" && token && !locked ? (row, column) => { void beginCell(row, column); } : undefined}
            draft={draft} editLocked={locked} onDraftChange={setDraft} onSave={() => void saveCell()} onCancel={cancelDraft} />
        </Suspense>
      )}
    </div>
  );
}
