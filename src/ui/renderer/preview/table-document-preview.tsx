/**
 * Side-panel preview for table documents (csv/tsv/xlsx/xls/ods).
 *
 * The host reads the file (`window.ave.preview.readDocument`) under the same read
 * guard as text previews and returns one sheet as a bounded grid of display
 * strings; this component shows the sheet tabs, the truncation notices and the
 * lazily-loaded virtualized grid. Every cap the reader applied is stated to the
 * user — nothing is cut silently.
 */
import { Suspense, lazy, useEffect, useState } from "react";
import { Badge } from "../../../components/ui/badge.js";
import { useTranslation } from "../../../i18n/react.js";
import { resolveIpcErrorKey } from "../format-ipc-error.js";
import {
  PREVIEW_DOCUMENT_LIMITS,
  type PreviewDocumentError,
  type PreviewTableDocument,
} from "../../../shared/preview-document.js";

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
  | { phase: "ok"; document: PreviewTableDocument }
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

/** Callers key this by `path` so a new file starts on its first sheet. */
export function TableDocumentPreview({ path }: { path: string }) {
  const { t } = useTranslation();
  const [sheetIndex, setSheetIndex] = useState(0);
  const [state, setState] = useState<LoadState>({ phase: "loading" });

  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    setState({ phase: "loading" });
    const read = (attempt: number): void => {
      void window.ave.preview
        .readDocument(path, sheetIndex)
        .then((result) => {
          if (cancelled) return;
          if (!result.ok && result.error === "busy") {
            const delay = PREVIEW_DOCUMENT_LIMITS.busyRetryDelaysMs[attempt];
            if (delay !== undefined) {
              retryTimer = setTimeout(() => { retryTimer = undefined; read(attempt + 1); }, delay);
              return;
            }
          }
          if (result.ok) setState("sheet" in result.document
            ? { phase: "ok", document: result.document } : { phase: "error", code: "unsupported-format" });
          else if (result.error !== "superseded") setState({ phase: "error", code: result.error });
        })
        .catch(() => {
          if (!cancelled) setState({ phase: "error", code: "read-failed" });
        });
    };
    read(0);
    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
    };
  }, [path, sheetIndex]);

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
              onClick={() => setSheetIndex(index)}
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
      <TruncationNotices document={document} />
      {sheet.rows.length === 0 ? (
        <div className="text-xs text-muted-foreground" data-testid="chat-side-panel-table-empty">
          {t("chatPreviewRail.tableEmpty")}
        </div>
      ) : (
        <Suspense fallback={loading}>
          <LazyTableDocumentGrid sheet={sheet} label={t("chatPreviewRail.tableGridLabel", { name: sheet.name })} />
        </Suspense>
      )}
    </div>
  );
}
