/** The folder view's file viewer. It routes like the side-panel preview (table, page, then the text registry), shows images
 * with fit and zoom, and gives anything it cannot show to the info card. */
import { forwardRef, useEffect, useMemo, useState, type ReactNode } from "react";
import { Check, ChevronLeft, Copy, ExternalLink, Link2, MessageSquarePlus, Minus, Plus, Scan } from "lucide-react";
import { Button } from "../../../../components/ui/button.js";
import { useTranslation } from "../../../../i18n/react.js";
import { formatBytes } from "../../../../lib/turn-summary-format.js";
import { useCopyFlash } from "../../hooks/use-copy-flash.js";
import { resolveFilePreviewRoute, resolvePreviewRenderer } from "../../preview/preview-renderers.js";
import { FilePreviewContent, MarkdownPreviewToggle } from "../../preview/file-preview-content.js";
import { TableDocumentPreview } from "../../preview/table-document-preview.js";
import { PageDocumentPreview } from "../../preview/PageDocumentPreview.js";
import { previewFormatLabel } from "../../preview/preview-document-chrome.js";
import type { AttachTextResult } from "../../preview/composer-targets.js";
import type { FileInfoReason } from "../../preview/FileInfoCard.js";
import { FileInfoCard, formatFolderTimestamp } from "./FileInfoCard.js";
import { folderEntryIcon } from "./FolderColumn.js";
import { FOLDER_KIND_LABEL_KEYS, folderFileKind, type FolderEntry } from "./folder-columns.js";
import { useOpenInDefaultApp } from "./use-open-in-default-app.js";
import { canOpenInDefaultApp } from "../../../../shared/preview-external-open.js";

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

function readState(result: ReadResult): ViewerState {
  if (!result.ok) {
    if (result.error === "too-large" || result.error === "binary-file") return { phase: "info", reason: result.error };
    return { phase: "error", code: result.error ?? "read-failed" };
  }
  if (result.image) return { phase: "image", dataUrl: result.image.dataUrl };
  const content = result.content ?? "";
  return { phase: "text", content, truncated: result.truncated === true, lineCount: result.lineCount ?? content.split(/\r\n|\r|\n/).length };
}

function ImageViewer({ src, alt }: { src: string; alt: string }) {
  const { t } = useTranslation();
  // null = fit to the viewer; a number = that zoom factor.
  const [zoom, setZoom] = useState<number | null>(null);
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const step = (factor: number) => setZoom((current) => Math.min(8, Math.max(0.1, (current ?? 1) * factor)));
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="folder-image-viewer">
      <div className="flex shrink-0 items-center gap-1 border-b px-3 py-1 text-[11px] text-muted-foreground">
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

function ViewerHeader({ entry, subtitle, actions, back }: {
  entry: FolderEntry; subtitle: string; actions?: ReactNode; back?: FileViewerProps["back"];
}) {
  const Icon = folderEntryIcon(entry);
  return (
    <div className="flex min-w-0 shrink-0 items-center gap-2 border-b px-3 py-2" data-testid="folder-viewer-header">
      {back ? (
        <Button type="button" size="sm" variant="outline" onClick={back.onBack} data-testid="folder-viewer-back" className="shrink-0">
          <ChevronLeft aria-hidden="true" className="h-3.5 w-3.5" />{back.label}
        </Button>
      ) : null}
      <Icon aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-semibold" title={entry.name}>{entry.name}</div>
        <div className="truncate text-[11px] text-muted-foreground" data-testid="folder-viewer-subtitle">{subtitle}</div>
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
    </div>
  );
}

export const FileViewer = forwardRef<HTMLDivElement, FileViewerProps>(function FileViewer({ projectRoot, entry, back, onAttachText }, ref) {
  const { t, locale } = useTranslation();
  const { copied, copy } = useCopyFlash();
  const open = useOpenInDefaultApp(projectRoot);
  const [attachNote, setAttachNote] = useState<string | null>(null);
  const [markdownSource, setMarkdownSource] = useState(false);
  const kind = folderFileKind(entry.name);
  const route = useMemo(() => resolveFilePreviewRoute(entry.path), [entry.path]);
  // Formats with no viewer skip the read; table and page documents read through their own components.
  const reads = entry.type === "file" && route.kind === "text" && kind !== "database" && kind !== "design";
  const [state, setState] = useState<ViewerState>(() => (reads ? { phase: "loading" } : { phase: "info", reason: "unsupported" }));
  useEffect(() => {
    setAttachNote(null);
    setMarkdownSource(false);
    if (!reads) { setState({ phase: "info", reason: "unsupported" }); return; }
    let cancelled = false;
    setState({ phase: "loading" });
    void window.ave.preview.readFile(entry.path).then(
      (result) => { if (!cancelled) setState(readState(result)); },
      () => { if (!cancelled) setState({ phase: "error", code: "read-failed" }); },
    );
    return () => { cancelled = true; };
  }, [entry.path, reads]);

  const shell = (children: ReactNode) => (
    <div ref={ref} tabIndex={-1} role="region" aria-label={entry.name} data-testid="folder-viewer" data-path={entry.path}
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
      {children}
    </div>
  );

  if (entry.type === "link") {
    return shell(<>
      <ViewerHeader entry={entry} subtitle={t("folderView.linkSubtitle")} back={back} />
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
    return shell(<>
      {back ? <ViewerHeader entry={entry} subtitle={previewFormatLabel(entry.path)} back={back} /> : null}
      <div className="flex min-h-0 flex-1 flex-col overflow-auto px-3 py-2">
        <Document key={entry.path} path={entry.path} workspaceRoot={projectRoot} observe />
      </div>
    </>);
  }

  if (state.phase === "info") {
    return shell(<>
      <ViewerHeader entry={entry} subtitle={`${t(FOLDER_KIND_LABEL_KEYS[kind])} · ${formatBytes(entry.size)}`} back={back} />
      <FileInfoCard projectRoot={projectRoot} entry={entry} reason={state.reason} />
    </>);
  }

  const modified = formatFolderTimestamp(entry.mtimeMs, locale);
  const subtitleParts = [previewFormatLabel(entry.path)];
  if (state.phase === "text") subtitleParts.push(t("folderView.lineCount", { count: state.lineCount.toLocaleString(locale) }));
  subtitleParts.push(formatBytes(entry.size));
  if (modified) subtitleParts.push(modified);
  const isMarkdown = state.phase === "text" && resolvePreviewRenderer({ text: "", path: entry.path }).kind === "markdown";
  const actions = (
    <>
      {isMarkdown ? <MarkdownPreviewToggle source={markdownSource} onSourceChange={setMarkdownSource} /> : null}
      {state.phase === "text" ? (
        <Button type="button" size="icon-xs" variant="ghost" aria-label={t(copied ? "folderView.copied" : "folderView.copyContent")}
          title={t(copied ? "folderView.copied" : "folderView.copyContent")} onClick={() => copy(state.content)} data-testid="folder-copy-content">
          {copied ? <Check aria-hidden="true" className="h-3.5 w-3.5" /> : <Copy aria-hidden="true" className="h-3.5 w-3.5" />}
        </Button>
      ) : null}
      {onAttachText ? (
        <Button type="button" size="icon-xs" variant="ghost" aria-label={t("folderView.addToContext")} title={t("folderView.addToContext")}
          data-testid="folder-add-context"
          onClick={() => {
            const result = onAttachText(`\`${entry.path}\``);
            setAttachNote(result === true ? null : t(result === false ? "folderView.addToContextFull" : "folderView.addToContextNoComposer"));
          }}>
          <MessageSquarePlus aria-hidden="true" className="h-3.5 w-3.5" />
        </Button>
      ) : null}
      {canOpenInDefaultApp(entry.path) ? (
        <Button type="button" size="sm" variant="outline" disabled={open.pending} onClick={() => void open.run(entry.path)} data-testid="folder-open-external">
          <ExternalLink aria-hidden="true" className="h-3.5 w-3.5" />{t("folderView.openExternal")}
        </Button>
      ) : null}
    </>
  );
  const body = state.phase === "loading" ? (
    <div className="p-4 text-xs text-muted-foreground" data-testid="folder-viewer-loading">{t("folderView.loading")}</div>
  ) : state.phase === "error" ? (
    <div role="alert" className="p-4 text-xs text-destructive" data-testid="folder-viewer-error">{t("folderView.readFailed")}</div>
  ) : state.phase === "image" ? (
    <ImageViewer src={state.dataUrl} alt={entry.name} />
  ) : (
    <div className="min-h-0 flex-1 overflow-auto [&_.markdown-body]:max-h-none [&_.markdown-body]:border-0 [&_pre]:max-h-none">
      <FilePreviewContent descriptor={{ text: state.content, path: entry.path, truncated: state.truncated }} source={markdownSource} prose />
    </div>
  );
  return shell(<>
    <ViewerHeader entry={entry} subtitle={subtitleParts.join(" · ")} actions={actions} back={back} />
    {open.error || attachNote ? (
      <div role="alert" className="shrink-0 border-b px-3 py-1 text-[11px] text-destructive" data-testid="folder-viewer-alert">
        {open.error ? t(open.error) : attachNote}
      </div>
    ) : null}
    {body}
  </>);
});
