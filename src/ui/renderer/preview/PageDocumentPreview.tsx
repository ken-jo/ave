import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import { useTranslation } from "../../../i18n/react.js";
import { PAGE_PREVIEW_LIMITS, type PreviewPageDocument } from "../../../shared/preview-page-document.js";
import { PREVIEW_DOCUMENT_LIMITS, type PreviewDocumentError } from "../../../shared/preview-document.js";
import { tableErrorKey } from "./table-document-preview.js";
import { PreviewDocumentHeader, PreviewDocumentFooter, PreviewDocumentLiveStrip, previewFormatLabel } from "./preview-document-chrome.js";
import { previewSupportsExternalOpen } from "../../../shared/preview-external-open.js";

type LoadState = { phase: "loading" } | { phase: "ok"; path: string; document: PreviewPageDocument }
  | { phase: "error"; code: PreviewDocumentError };

export function PageDocumentPreview({ path, sessionId, workspaceRoot, canOpenExternal }: { path: string; sessionId?: string; workspaceRoot?: string; canOpenExternal?: boolean }) {
  const { t } = useTranslation();
  const [index, setIndex] = useState(0);
  const [retryGeneration, setRetryGeneration] = useState(0);
  const [openFailed, setOpenFailed] = useState(false);
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setOpenFailed(false);
    setState({ phase: "loading" });
    const read = (attempt: number): void => {
      const resultPromise = sessionId === undefined ? window.ave.preview.readDocument(path, index)
        : window.ave.preview.readDocument(path, index, sessionId);
      void resultPromise.then((result) => {
        if (cancelled) return;
        if (!result.ok && result.error === "busy") {
          const delay = PREVIEW_DOCUMENT_LIMITS.busyRetryDelaysMs[attempt];
          if (delay !== undefined) { timer = setTimeout(() => read(attempt + 1), delay); return; }
        }
        if (result.ok) setState("page" in result.document
          ? { phase: "ok", path: result.path, document: result.document } : { phase: "error", code: "unsupported-format" });
        else setState({ phase: "error", code: result.error });
      }).catch(() => { if (!cancelled) setState({ phase: "error", code: "read-failed" }); });
    };
    read(0);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [path, sessionId, index, retryGeneration]);
  const shownDocument = state.phase === "ok" ? state.document : null;
  const total = shownDocument ? Math.min(shownDocument.totalPages, PAGE_PREVIEW_LIMITS.maxPages) : 0;
  return (
    <div className="space-y-2" data-testid="chat-side-panel-page-preview">
      <PreviewDocumentHeader path={state.phase === "ok" ? state.path : path} workspaceRoot={workspaceRoot}
        canOpenExternal={Boolean(canOpenExternal) || (state.phase === "ok" && previewSupportsExternalOpen(state.path))}
        onOpenError={() => setOpenFailed(true)}
        onReload={() => setRetryGeneration((current) => current + 1)} refreshing={state.phase === "loading"} />
      <PreviewDocumentLiveStrip error={openFailed ? t("chatPreviewRail.openDefaultAppError") : undefined} />
      {state.phase === "loading" ? <div role="status">{t("chatPreviewRail.filePreviewLoading")}</div>
        : state.phase === "error" ? <div role="alert" className="text-xs text-destructive" data-testid="chat-side-panel-file-error">
          <p>{t(state.code === "superseded" ? "pagePreview.superseded"
            : state.code === "corrupt-document" ? "pagePreview.corrupt" : state.code === "too-large" ? "pagePreview.tooLarge" : tableErrorKey(state.code),
          { mb: PREVIEW_DOCUMENT_LIMITS.maxFileBytes / (1024 * 1024) })}</p>
        </div> : <>
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
      {state.phase === "ok" ? <PreviewDocumentFooter>
        <span>{previewFormatLabel(path)} · {t("pagePreview.count", { index: state.document.page.index + 1, total: state.document.totalPages })}</span>
        <span className="ml-auto flex items-center gap-0.5">
          <Button type="button" size="icon-xs" variant="ghost" aria-label={t("pagePreview.previous")} disabled={index === 0}
            onClick={() => setIndex((current) => Math.max(0, current - 1))}><ChevronLeft aria-hidden="true" className="h-3.5 w-3.5" /></Button>
          <Button type="button" size="icon-xs" variant="ghost" aria-label={t("pagePreview.next")} disabled={index + 1 >= total}
            onClick={() => setIndex((current) => Math.min(total - 1, current + 1))}><ChevronRight aria-hidden="true" className="h-3.5 w-3.5" /></Button>
        </span>
        {state.document.format === "pptx" ? <span>{t("pagePreview.outline")}</span> : null}
        {state.document.pagesTruncated ? <span role="status">{t("pagePreview.pagesTruncated", { shown: PAGE_PREVIEW_LIMITS.maxPages })}</span> : null}
        {state.document.page.textTruncated ? <span role="status">{t("pagePreview.textTruncated")}</span> : null}
      </PreviewDocumentFooter> : null}
    </div>
  );
}
