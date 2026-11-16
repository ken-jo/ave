/** The folder view's file viewer. It routes like the side-panel preview (table, page, then the text registry), shows images
 * with fit and zoom, and gives anything it cannot show to the info card. */
import { forwardRef, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, Code, Copy, ExternalLink, FileText, FolderOpen, Link2, MessageSquarePlus, Minus, Plus, Scan } from "lucide-react";
import { Button } from "../../../../components/ui/button.js";
import { cn } from "../../../../lib/utils.js";
import { useTranslation } from "../../../../i18n/react.js";
import { formatBytes } from "../../../../lib/turn-summary-format.js";
import { useCopyFlash } from "../../hooks/use-copy-flash.js";
import { CodePreview, PreviewContent, resolveFilePreviewRoute, resolvePreviewRenderer } from "../../preview/preview-renderers.js";
import { TableDocumentPreview } from "../../preview/table-document-preview.js";
import { PageDocumentPreview } from "../../preview/PageDocumentPreview.js";
import { previewFormatLabel } from "../../preview/preview-document-chrome.js";
import type { AttachTextResult } from "../../preview/composer-targets.js";
import { FileInfoCard, formatFolderTimestamp, type FileInfoReason } from "./FileInfoCard.js";
import { revealKey } from "./FolderColumn.js";
import { ViewerHeader, type ViewerAction } from "./ViewerHeader.js";
import { FOLDER_KIND_LABEL_KEYS, folderFileKind, type FolderEntry } from "./folder-columns.js";
import { useOpenInDefaultApp } from "./use-open-in-default-app.js";
import { canOpenInDefaultApp } from "../../../../shared/preview-external-open.js";
import { subscribeWorkspaceFilesChanged } from "../../utils/workspace-files-signal.js";

type ReadResult = Awaited<ReturnType<typeof window.ave.preview.readFile>>;
type ViewerState =
  | { phase: "loading" }
  | { phase: "info"; reason: FileInfoReason }
  | { phase: "error"; code: string }
  | { phase: "image"; dataUrl: string }
  | { phase: "text"; content: string; truncated: boolean; lineCount: number };

export interface FileViewerProps {
  projectRoot: string;
  entry: FolderEntry;
  /** Narrow layout: the viewer replaced the columns and offers a way back (case 37). */
  back?: { label: string; onBack: () => void } | undefined;
  /** Put a reference to this file into the last-used chat composer. */
  onAttachText?: ((text: string) => AttachTextResult) | undefined;
}

/** What the viewer says for each way a read can fail; a code it does not know gets the plain sentence, never the code. */
function readFailureKey(code: string): string {
  switch (code) {
    case "read-failed": return "folderView.readFailedGone";
    case "path-not-allowed": return "folderView.readFailedNotAllowed";
    case "sensitive-path": return "folderView.readFailedProtected";
    case "not-a-file": return "folderView.readFailedNotAFile";
    default: return "folderView.readFailed";
  }
}

function readState(result: ReadResult): ViewerState {
  if (!result.ok) {
    if (result.error === "too-large" || result.error === "binary-file") return { phase: "info", reason: result.error };
    return { phase: "error", code: result.error ?? "read-failed" };
  }
  if (result.image) return { phase: "image", dataUrl: result.image.dataUrl };
  const content = result.content ?? "";
  return { phase: "text", content, truncated: result.truncated === true, lineCount: result.lineCount ?? content.split(/\r\n|\r|\n/).length };
}

/** Keep the previous state object when a re-read found the same thing, so an unchanged file does not re-render. */
function sameViewerState(previous: ViewerState, next: ViewerState): ViewerState {
  if (previous.phase === "text" && next.phase === "text"
    && previous.content === next.content && previous.truncated === next.truncated) return previous;
  if (previous.phase === "image" && next.phase === "image" && previous.dataUrl === next.dataUrl) return previous;
  if (previous.phase === "info" && next.phase === "info" && previous.reason === next.reason) return previous;
  if (previous.phase === "error" && next.phase === "error" && previous.code === next.code) return previous;
  return next;
}

function ImageViewer({ src, alt }: { src: string; alt: string }) {
  const { t } = useTranslation();
  // null = fit to the viewer; a number = that zoom factor.
  const [zoom, setZoom] = useState<number | null>(null);
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const step = (factor: number) => setZoom((current) => Math.min(8, Math.max(0.1, (current ?? 1) * factor)));
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="folder-image-viewer">
      <div className="flex shrink-0 items-center gap-1 border-b px-3 py-1 text-dense text-muted-foreground">
        <Button type="button" size="icon-xs" variant="ghost" aria-label={t("folderView.imageFit")} title={t("folderView.imageFit")}
          aria-pressed={zoom === null} onClick={() => setZoom(null)}><Scan aria-hidden="true" className="h-3.5 w-3.5" /></Button>
        <Button type="button" size="icon-xs" variant="ghost" aria-label={t("folderView.imageZoomOut")} title={t("folderView.imageZoomOut")}
          onClick={() => step(1 / 1.25)}><Minus aria-hidden="true" className="h-3.5 w-3.5" /></Button>
        <span className="w-10 text-center tabular-nums" data-testid="folder-image-zoom">{zoom === null ? t("folderView.imageFitShort") : `${Math.round(zoom * 100)}%`}</span>
        <Button type="button" size="icon-xs" variant="ghost" aria-label={t("folderView.imageZoomIn")} title={t("folderView.imageZoomIn")}
          onClick={() => step(1.25)}><Plus aria-hidden="true" className="h-3.5 w-3.5" /></Button>
        {natural ? <span className="ml-auto tabular-nums">{natural.width} × {natural.height}</span> : null}
      </div>
      <div className="ave-checkerboard flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
        <img src={src} alt={alt} referrerPolicy="no-referrer" draggable={false}
          onLoad={(event) => setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
          onDoubleClick={() => setZoom((current) => (current === 1 ? null : 1))}
          title={t("folderView.imageDoubleClick")}
          className={zoom === null ? "max-h-full max-w-full object-contain" : "max-w-none"}
          style={zoom === null || !natural ? undefined : { width: natural.width * zoom, height: natural.height * zoom }} />
      </div>
    </div>
  );
}

export const FileViewer = forwardRef<HTMLDivElement, FileViewerProps>(function FileViewer({ projectRoot, entry, back, onAttachText }, ref) {
  const { t, locale } = useTranslation();
  const contentCopy = useCopyFlash();
  const pathCopy = useCopyFlash();
  const open = useOpenInDefaultApp(projectRoot);
  // One place for what the last action could not do (an i18n key); the next action clears it, whichever it is.
  const [notice, setNotice] = useState<string | null>(null);
  const clearNotices = (): void => { setNotice(null); open.clearError(); };
  const [markdownSource, setMarkdownSource] = useState(false);
  const kind = folderFileKind(entry.name);
  const route = useMemo(() => resolveFilePreviewRoute(entry.path), [entry.path]);
  // Formats with no viewer skip the read; table and page documents read through their own components.
  const reads = entry.type === "file" && route.kind === "text" && kind !== "database" && kind !== "design";
  const [state, setState] = useState<ViewerState>(() => (reads ? { phase: "loading" } : { phase: "info", reason: "unsupported" }));
  const shownPath = useRef<string | null>(null);
  useEffect(() => {
    const anotherFile = shownPath.current !== entry.path;
    shownPath.current = entry.path;
    if (anotherFile) {
      setNotice(null);
      setMarkdownSource(false);
    }
    if (!reads) { setState({ phase: "info", reason: "unsupported" }); return; }
    let cancelled = false;
    let issued = 0;
    const read = (): void => {
      // The newest request wins: an answer to an older one is dropped.
      const request = ++issued;
      void window.ave.preview.readFile(entry.path).then(
        (result) => { if (!cancelled && request === issued) setState((previous) => sameViewerState(previous, readState(result))); },
        () => { if (!cancelled && request === issued) setState({ phase: "error", code: "read-failed" }); },
      );
    };
    // Only another file starts from "loading"; a re-read keeps the current content on screen until the fresh one arrives.
    if (anotherFile) setState({ phase: "loading" });
    read();
    // The shared "files may have changed" signal asks for the file again; the answer replaces what is shown.
    const unsubscribe = subscribeWorkspaceFilesChanged(read);
    return () => { cancelled = true; unsubscribe(); };
  }, [entry.path, reads]);
  // Table and page documents re-read through their own reload when the listing reports a new size or modified time.
  const documentReloadToken = `${entry.size}:${entry.mtimeMs}`;

  const reveal = (): void => {
    clearNotices();
    const failed = (): void => setNotice("folderView.revealFailed");
    void window.ave.workspace.reveal(entry.path).then((result) => { if (!result.ok) failed(); }, failed);
  };
  // Every header carries the two ways out that need no viewer: show the file in the file manager, and copy its path. A link
  // outside the project is not handed to the file manager, which would open where it points.
  const exits: ViewerAction[] = [
    ...(entry.type === "link" && entry.outside ? [] : [{ id: "reveal", label: t(revealKey()), icon: FolderOpen, onSelect: reveal }]),
    { id: "copy-path", label: t(pathCopy.copied ? "folderView.copied" : "folderView.copyPath"), icon: pathCopy.copied ? Check : Link2,
      onSelect: () => { clearNotices(); pathCopy.copy(entry.path); } },
  ];
  const alertKey = open.error ?? notice;
  const alert = alertKey ? t(alertKey) : null;
  const alertStrip = alert ? (
    <div role="alert" className="shrink-0 border-b px-3 py-1 text-dense text-destructive" data-testid="folder-viewer-alert">{alert}</div>
  ) : null;

  const shell = (children: ReactNode) => (
    <div ref={ref} tabIndex={-1} role="region" aria-label={entry.name} data-testid="folder-viewer" data-path={entry.path}
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
      {children}
    </div>
  );

  if (entry.type === "link") {
    return shell(<>
      <ViewerHeader entry={entry} subtitle={t("folderView.linkSubtitle")} actions={exits} back={back} />
      {alertStrip}
      <div className="flex flex-1 items-start justify-center p-6">
        <div role="note" className="flex max-w-sm gap-2 rounded-lg border px-3 py-2 text-xs leading-5" data-testid="folder-link-note">
          <Link2 aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{t(entry.outside ? "folderView.linkOutsideNote" : "folderView.linkInsideNote", { name: entry.name })}</span>
        </div>
      </div>
    </>);
  }

  if (route.kind === "table" || route.kind === "page") {
    const Document = route.kind === "table" ? TableDocumentPreview : PageDocumentPreview;
    // The document draws its own header (name, copy path, reload, default app); the reveal action joins it there. The
    // narrow layout adds this viewer's header for the way back.
    return shell(<>
      {back ? <ViewerHeader entry={entry} subtitle={previewFormatLabel(entry.path)} actions={exits} back={back} /> : null}
      {alertStrip}
      <div className="flex min-h-0 flex-1 flex-col overflow-auto px-3 py-2">
        <Document key={entry.path} path={entry.path} workspaceRoot={projectRoot} observe reloadToken={documentReloadToken}
          onReveal={reveal} revealLabel={t(revealKey())} />
      </div>
    </>);
  }

  if (state.phase === "info") {
    return shell(<>
      <ViewerHeader entry={entry} subtitle={`${t(FOLDER_KIND_LABEL_KEYS[kind])} · ${formatBytes(entry.size)}`} actions={exits} back={back} />
      {alertStrip}
      <FileInfoCard projectRoot={projectRoot} entry={entry} reason={state.reason} open={open} report={setNotice} />
    </>);
  }

  const modified = formatFolderTimestamp(entry.mtimeMs, locale);
  const subtitleParts = [previewFormatLabel(entry.path)];
  if (state.phase === "text") subtitleParts.push(t("folderView.lineCount", { count: state.lineCount.toLocaleString(locale) }));
  subtitleParts.push(formatBytes(entry.size));
  if (modified) subtitleParts.push(modified);
  const isMarkdown = state.phase === "text" && resolvePreviewRenderer({ text: "", path: entry.path }).kind === "markdown";
  const actions: ViewerAction[] = [];
  if (isMarkdown) {
    actions.push({ id: "markdown-mode", label: t(markdownSource ? "folderView.markdownShowView" : "folderView.markdownShowSource"),
      icon: markdownSource ? FileText : Code, onSelect: () => { clearNotices(); setMarkdownSource((source) => !source); }, menuOnly: true });
  }
  if (state.phase === "text") {
    actions.push({ id: "copy-content", label: t(contentCopy.copied ? "folderView.copied" : "folderView.copyContent"),
      icon: contentCopy.copied ? Check : Copy, onSelect: () => { clearNotices(); contentCopy.copy(state.content); } });
  }
  if (onAttachText) {
    actions.push({ id: "add-context", label: t("folderView.addToContext"), icon: MessageSquarePlus, onSelect: () => {
      clearNotices();
      const result = onAttachText(`\`${entry.path}\``);
      if (result !== true) setNotice(result === false ? "folderView.addToContextFull" : "folderView.addToContextNoComposer");
    } });
  }
  actions.push(...exits);
  if (canOpenInDefaultApp(entry.path)) {
    actions.push({ id: "open-external", label: t("folderView.openExternal"), icon: ExternalLink, disabled: open.pending,
      onSelect: () => { setNotice(null); void open.run(entry.path); }, labelled: true });
  }
  const markdownSwitch = isMarkdown ? (
    <div role="group" aria-label={t("folderView.markdownMode")} className="flex rounded-md border p-0.5">
      {([false, true] as const).map((source) => (
        <button key={String(source)} type="button" aria-pressed={markdownSource === source} data-testid={`folder-markdown-${source ? "source" : "view"}`}
          onClick={() => { clearNotices(); setMarkdownSource(source); }}
          className={cn("rounded px-2 py-0.5 text-dense", markdownSource === source ? "bg-muted font-medium" : "text-muted-foreground")}>
          {t(source ? "folderView.markdownSource" : "folderView.markdownView")}
        </button>
      ))}
    </div>
  ) : null;
  const body = state.phase === "loading" ? (
    <div className="p-4 text-xs text-muted-foreground" data-testid="folder-viewer-loading">{t("folderView.loading")}</div>
  ) : state.phase === "error" ? (
    <div role="alert" className="p-4 text-xs text-destructive" data-testid="folder-viewer-error">{t(readFailureKey(state.code))}</div>
  ) : state.phase === "image" ? (
    <ImageViewer src={state.dataUrl} alt={entry.name} />
  ) : (
    <div className="min-h-0 flex-1 overflow-auto [&_.markdown-body]:max-h-none [&_.markdown-body]:border-0 [&_pre]:max-h-none">
      {isMarkdown && markdownSource
        ? <CodePreview descriptor={{ text: state.content, path: entry.path, truncated: state.truncated }} />
        : isMarkdown
          // The reading typography chat answers use, so headings, lists and tables look like a document.
          ? <div className="prose prose-sm ave-prose max-w-none px-4 py-3" data-testid="folder-markdown-rendered">
            <PreviewContent descriptor={{ text: state.content, path: entry.path, truncated: state.truncated }} />
          </div>
          : <PreviewContent descriptor={{ text: state.content, path: entry.path, truncated: state.truncated }} />}
    </div>
  );
  return shell(<>
    <ViewerHeader entry={entry} subtitle={subtitleParts.join(" · ")} actions={actions} wideLead={markdownSwitch} back={back} />
    {alertStrip}
    {body}
  </>);
});
