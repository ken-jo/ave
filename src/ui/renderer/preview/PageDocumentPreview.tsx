import { useEffect, useState } from "react";
import { Button } from "../../../components/ui/button.js";
import { useTranslation } from "../../../i18n/react.js";
import { PAGE_PREVIEW_LIMITS, type PreviewPageDocument } from "../../../shared/preview-page-document.js";
import { PREVIEW_DOCUMENT_LIMITS, type PreviewDocumentError } from "../../../shared/preview-document.js";
import { tableErrorKey } from "./table-document-preview.js";

type LoadState = { phase: "loading" } | { phase: "ok"; document: PreviewPageDocument }
  | { phase: "error"; code: PreviewDocumentError };

export function PageDocumentPreview({ path }: { path: string }) {
  const { t } = useTranslation();
  const [index, setIndex] = useState(0);
  const [retryGeneration, setRetryGeneration] = useState(0);
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setState({ phase: "loading" });
    const read = (attempt: number): void => {
      void window.ave.preview.readDocument(path, index).then((result) => {
        if (cancelled) return;
        if (!result.ok && result.error === "busy") {
          const delay = PREVIEW_DOCUMENT_LIMITS.busyRetryDelaysMs[attempt];
          if (delay !== undefined) { timer = setTimeout(() => read(attempt + 1), delay); return; }
        }
        if (result.ok) setState("page" in result.document
          ? { phase: "ok", document: result.document } : { phase: "error", code: "unsupported-format" });
        else setState({ phase: "error", code: result.error });
      }).catch(() => { if (!cancelled) setState({ phase: "error", code: "read-failed" }); });
    };
    read(0);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [path, index, retryGeneration]);
  const shownDocument = state.phase === "ok" ? state.document : null;
  const total = shownDocument ? Math.min(shownDocument.totalPages, PAGE_PREVIEW_LIMITS.maxPages) : 0;
  return (
    <div className="space-y-3" data-testid="chat-side-panel-page-preview">
      <div className="flex items-center gap-2">
        <Button type="button" size="sm" variant="outline" disabled={index === 0 || state.phase === "loading"} onClick={() => setIndex((current) => Math.max(0, current - 1))}>
          {t("pagePreview.previous")}
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={index + 1 >= total || state.phase === "loading"} onClick={() => setIndex((current) => Math.min(total - 1, current + 1))}>
          {t("pagePreview.next")}
        </Button>
        {state.phase === "ok" && <span className="text-xs text-muted-foreground">{t("pagePreview.count", { index: state.document.page.index + 1, total: state.document.totalPages })}</span>}
      </div>
      {state.phase === "loading" ? <div role="status">{t("chatPreviewRail.filePreviewLoading")}</div>
        : state.phase === "error" ? <div role="alert" className="text-xs text-destructive" data-testid="chat-side-panel-file-error">
          <p>{t(state.code === "superseded" ? "pagePreview.superseded"
            : state.code === "corrupt-document" ? "pagePreview.corrupt" : state.code === "too-large" ? "pagePreview.tooLarge" : tableErrorKey(state.code),
          { mb: PREVIEW_DOCUMENT_LIMITS.maxFileBytes / (1024 * 1024) })}</p>
          <Button type="button" size="sm" variant="outline" onClick={() => setRetryGeneration((current) => current + 1)}>{t("common.retry")}</Button>
        </div> : <>
          {state.document.format === "pptx" && <p className="text-xs text-muted-foreground">{t("pagePreview.outline")}</p>}
          {state.document.pagesTruncated && <p role="status">{t("pagePreview.pagesTruncated", { shown: PAGE_PREVIEW_LIMITS.maxPages })}</p>}
          {state.document.page.textTruncated && <p role="status">{t("pagePreview.textTruncated")}</p>}
          {state.document.page.png !== null && <img
            src={`data:image/png;base64,${state.document.page.png}`}
            width={state.document.page.width} height={state.document.page.height}
            alt={t("pagePreview.pageImage", { index: state.document.page.index + 1 })}
            onError={() => setState((current) => current.phase === "ok" && current.document === shownDocument
              ? { phase: "error", code: "read-failed" } : current)}
            className="h-auto max-w-full rounded border" data-testid="chat-side-panel-pdf-page"
          />}
          <div className="space-y-2 text-sm [overflow-wrap:anywhere]" data-testid="chat-side-panel-page-text">
            {state.document.page.paragraphs.length === 0 ? <p>{t("pagePreview.noText")}</p>
              : state.document.page.paragraphs.map((paragraph, position) => <p className="whitespace-pre-wrap" key={position}>{paragraph}</p>)}
          </div>
        </>}
    </div>
  );
}
