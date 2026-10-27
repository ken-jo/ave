import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import { useTranslation } from "../../../i18n/react.js";
import { cn } from "../../../lib/utils.js";
import { PAGE_PREVIEW_LIMITS, type PreviewPageDocument, type PreviewDocumentElement } from "../../../shared/preview-page-document.js";
import { PREVIEW_DOCUMENT_LIMITS, type PreviewDocumentError } from "../../../shared/preview-document.js";
import type { ObservationBinding, AgentObservationEvent, DocumentObservationStatus } from "../../../shared/agent-observation.js";
import { tableErrorKey } from "./table-document-preview.js";
import { PreviewDocumentHeader, PreviewDocumentFooter, PreviewDocumentLiveStrip, previewFormatLabel } from "./preview-document-chrome.js";
import { previewSupportsExternalOpen } from "../../../shared/preview-external-open.js";

type PageElementAddress = PreviewDocumentElement["element"];
interface PageChange { element: PageElementAddress; before: string; after: string; ts: number; seq: number }
type LoadState = { phase: "loading" } | { phase: "ok"; path: string; document: PreviewPageDocument;
  observation?: ObservationBinding; seq: number; snapshotSeq: number; renderGeneration: number; changes: PageChange[];
  status?: DocumentObservationStatus; latest?: PageChange }
  | { phase: "error"; code: PreviewDocumentError };

function addressKey(element: PageElementAddress): string {
  return element.kind === "shape" ? `shape:${element.slide}:${element.shapeId}`
    : `paragraph:${element.paragraph}:${element.run ?? "all"}`;
}
function sameTextContainer(left: PageElementAddress, right: PageElementAddress): boolean {
  return left.kind === "paragraph" && right.kind === "paragraph" ? left.paragraph === right.paragraph
    : addressKey(left) === addressKey(right);
}

/**
 * `observe` is false while the hosting panel is hidden. A session-bound view then holds no subscription or host
 * binding but stays mounted on its page; observing again re-reads that page as a fresh baseline. A view without a
 * session never observes, so the flag does not touch it.
 */
export function PageDocumentPreview({ path, sessionId, workspaceRoot, canOpenExternal, observe }: {
  path: string; sessionId?: string; workspaceRoot?: string; canOpenExternal?: boolean; observe: boolean;
}) {
  const { t } = useTranslation();
  const [index, setIndex] = useState(0);
  const [retryGeneration, setRetryGeneration] = useState(0);
  const [openFailed, setOpenFailed] = useState(false);
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  const [renderedImage, setRenderedImage] = useState<PreviewPageDocument | null>(null);
  const generation = useRef(0);
  const lastAcknowledgement = useRef("");
  const releaseObservation = useRef<(() => void) | undefined>(undefined);
  const active = sessionId === undefined || observe;
  const resumed = useRef(false);

  useEffect(() => {
    if (!active) {
      // The previous run's cleanup already released its binding; the page stays without agent marks.
      resumed.current = true;
      setState((previous) => previous.phase === "ok"
        ? { ...previous, observation: undefined, changes: [], status: undefined, latest: undefined } : previous);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let binding: ObservationBinding | undefined;
    let lastSeq = 0;
    const releasedTargets = new Set<string>();
    let observedPath = path;
    let observationReleased = false;
    const requestGeneration = ++generation.current;
    const api = window.ave.preview;
    // Showing a hidden panel again keeps the current page on screen while it reads the fresh baseline.
    const refresh = resumed.current;
    resumed.current = false;
    setOpenFailed(false);
    if (!refresh) {
      setRenderedImage(null);
      setState({ phase: "loading" });
    }
    const release = (value: ObservationBinding): void => {
      if (releasedTargets.has(value.targetId)) return;
      releasedTargets.add(value.targetId);
      void api.acknowledgeObservation({ action: "release", targetId: value.targetId,
        sessionId: value.sessionId, seq: lastSeq }).then((result) => {
        if (!result.ok && result.error !== "unauthorized") console.error("Document observation release was refused.");
      }).catch(() => { console.error("Document observation release failed."); });
    };
    const stop = api.onAgentObservation((events: AgentObservationEvent[]) => {
      if (cancelled || observationReleased || !binding || binding.sessionId !== sessionId || releasedTargets.has(binding.targetId)) return;
      for (const event of events) {
        if (event.source !== "document" || event.actor !== "agent" || event.sessionId !== binding.sessionId
          || event.target.id !== binding.targetId || event.target.path !== observedPath
          || !Number.isSafeInteger(event.seq) || event.seq <= lastSeq) continue;
        lastSeq = event.seq;
        setState((previous) => {
          if (previous.phase !== "ok" || previous.observation?.targetId !== binding?.targetId) return previous;
          if (event.kind === "snapshot") {
            if (!("page" in event.after) || event.after.format !== previous.document.format || event.after.page.index !== index) {
              return { ...previous, seq: event.seq, changes: [], status: "observation-error" };
            }
            return { ...previous, document: event.after, seq: event.seq, snapshotSeq: event.seq, status: "live" };
          }
          if (event.kind === "status") {
            const interrupted = event.after.code !== "live" && event.after.code !== "reconciling";
            return { ...previous, seq: event.seq, status: event.after.code,
              changes: interrupted ? [] : previous.changes, latest: interrupted ? undefined : previous.latest };
          }
          if (event.element.kind !== "paragraph" && event.element.kind !== "shape") return { ...previous, seq: event.seq };
          const change: PageChange = { element: event.element, before: event.before, after: event.after, ts: event.ts, seq: event.seq };
          return { ...previous, seq: event.seq, status: "live", latest: change,
            changes: [...previous.changes.filter((entry) => addressKey(entry.element) !== addressKey(change.element)), change]
              .slice(-PAGE_PREVIEW_LIMITS.maxParagraphs) };
        });
      }
    });
    const releaseBoundObservation = (): void => {
      if (observationReleased) return;
      observationReleased = true;
      stop();
      if (binding) release(binding);
    };
    releaseObservation.current = releaseBoundObservation;
    const read = (attempt: number): void => {
      const promise = sessionId === undefined ? api.readDocument(path, index) : api.readDocument(path, index, sessionId);
      void promise.then((result) => {
        if (cancelled) {
          if (result.ok && result.observation) release(result.observation);
          return;
        }
        if (!result.ok && result.error === "busy") {
          const delay = PREVIEW_DOCUMENT_LIMITS.busyRetryDelaysMs[attempt];
          if (delay !== undefined) { timer = setTimeout(() => read(attempt + 1), delay); return; }
        }
        if (result.ok && "page" in result.document) {
          binding = result.observation?.sessionId === sessionId ? result.observation : undefined;
          lastSeq = binding?.seq ?? 0;
          observedPath = result.path;
          setState({ phase: "ok", path: result.path, document: result.document, observation: binding,
            seq: lastSeq, snapshotSeq: lastSeq, renderGeneration: requestGeneration, changes: [] });
        } else setState({ phase: "error", code: result.ok ? "unsupported-format" : result.error });
      }).catch(() => {
        if (!cancelled && requestGeneration === generation.current) setState({ phase: "error", code: "read-failed" });
      });
    };
    read(0);
    return () => {
      cancelled = true;
      generation.current += 1;
      clearTimeout(timer);
      releaseBoundObservation();
      if (releaseObservation.current === releaseBoundObservation) releaseObservation.current = undefined;
    };
  }, [path, sessionId, index, retryGeneration, active]);

  useLayoutEffect(() => {
    if (state.phase !== "ok" || !state.observation
      || (state.document.page.png !== null && renderedImage !== state.document)) return;
    const { observation, seq } = state;
    const key = `${observation.targetId}:${seq}`;
    if (lastAcknowledgement.current === key) return;
    lastAcknowledgement.current = key;
    const current = generation.current;
    void window.ave.preview.acknowledgeObservation({ action: "rendered", targetId: observation.targetId,
      sessionId: observation.sessionId, seq }).then((result) => {
      if (!result.ok && current === generation.current) {
        releaseObservation.current?.();
        setState((previous) => previous.phase === "ok"
          ? { ...previous, observation: undefined, changes: [], latest: undefined, status: "observation-error" } : previous);
      }
    }).catch(() => {
      if (current === generation.current) {
        releaseObservation.current?.();
        setState((previous) => previous.phase === "ok"
          ? { ...previous, observation: undefined, changes: [], latest: undefined, status: "observation-error" } : previous);
      }
    });
  }, [state, renderedImage]);

  const shownDocument = state.phase === "ok" ? state.document : null;
  const total = shownDocument ? Math.min(shownDocument.totalPages, PAGE_PREVIEW_LIMITS.maxPages) : 0;
  const latest = state.phase === "ok" ? state.latest : undefined;
  const summary = !latest ? undefined : latest.element.kind === "shape"
    ? t("documentEngine.shapeChange", { slide: latest.element.slide + 1, shape: latest.element.shapeId,
      before: latest.before, after: latest.after })
    : t("documentEngine.paragraphChange", { paragraph: latest.element.paragraph + 1,
      run: latest.element.run === undefined ? "" : t("documentEngine.runSuffix", { run: latest.element.run + 1 }),
      before: latest.before, after: latest.after });
  const elements = shownDocument?.elements?.filter(({ element }) => element.kind !== "paragraph" || element.run === undefined);

  return <div className="space-y-2" data-testid="chat-side-panel-page-preview">
    <PreviewDocumentHeader path={state.phase === "ok" ? state.path : path} workspaceRoot={workspaceRoot}
      canOpenExternal={Boolean(canOpenExternal) || (state.phase === "ok" && previewSupportsExternalOpen(state.path))}
      onOpenError={() => setOpenFailed(true)} onReload={() => setRetryGeneration((current) => current + 1)}
      refreshing={state.phase === "loading"} />
    <PreviewDocumentLiveStrip status={state.phase === "ok" ? state.status : undefined} summary={summary} ts={latest?.ts}
      error={openFailed ? t("chatPreviewRail.openDefaultAppError") : undefined} />
    {state.phase === "loading" ? <div role="status">{t("chatPreviewRail.filePreviewLoading")}</div>
      : state.phase === "error" ? <div role="alert" className="text-xs text-destructive" data-testid="chat-side-panel-file-error">
        <p>{t(state.code === "superseded" ? "pagePreview.superseded"
          : state.code === "corrupt-document" ? "pagePreview.corrupt" : state.code === "too-large" ? "pagePreview.tooLarge" : tableErrorKey(state.code),
        { mb: PREVIEW_DOCUMENT_LIMITS.maxFileBytes / (1024 * 1024) })}</p>
      </div> : <>
        {state.document.page.png !== null && <img key={`${state.observation?.targetId ?? retryGeneration}:${state.snapshotSeq}`}
          src={`data:image/png;base64,${state.document.page.png}`} width={state.document.page.width} height={state.document.page.height}
          alt={t("pagePreview.pageImage", { index: state.document.page.index + 1 })}
          onLoad={() => { if (state.renderGeneration === generation.current) setRenderedImage(state.document); }}
          onError={() => {
            if (state.renderGeneration !== generation.current) return;
            releaseObservation.current?.();
            setState((current) => current.phase === "ok" && current.document === shownDocument
              ? { phase: "error", code: "read-failed" } : current);
          }}
          className="h-auto max-w-full rounded border" data-testid="chat-side-panel-pdf-page" />}
        <div className="space-y-2 text-sm [overflow-wrap:anywhere]" data-testid="chat-side-panel-page-text">
          {elements?.length ? elements.map((entry) => {
            const changed = state.changes.some((change) => sameTextContainer(change.element, entry.element));
            const current = Boolean(latest && sameTextContainer(latest.element, entry.element));
            return <p key={addressKey(entry.element)} data-document-element={addressKey(entry.element)}
              data-observation-current={current || undefined}
              className={cn("whitespace-pre-wrap rounded px-1", changed && "bg-agent/(--opacity-subtle)",
                current && "outline outline-1 outline-agent")}>
              {current && <span className="mr-1 rounded bg-agent/(--opacity-subtle) px-1 text-[9px] text-agent">Ave</span>}{entry.text}
            </p>;
          }) : state.document.page.paragraphs.length === 0 ? <p>{t("pagePreview.noText")}</p>
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
      {state.document.page.png === null ? <span>{t(state.document.format === "pptx" ? "pagePreview.outline" : "documentEngine.documentOutline")}</span> : null}
      {state.document.pagesTruncated ? <span role="status">{t("pagePreview.pagesTruncated", { shown: PAGE_PREVIEW_LIMITS.maxPages })}</span> : null}
      {state.document.page.textTruncated ? <span role="status">{t("pagePreview.textTruncated")}</span> : null}
    </PreviewDocumentFooter> : null}
  </div>;
}
