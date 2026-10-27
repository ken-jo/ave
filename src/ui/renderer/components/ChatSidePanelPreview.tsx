import { createElement, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { WorkspaceTabKind } from "../preview/workspace-tabs.js";
import {
  Activity,
  Bot,
  Check,
  Code2,
  Copy,
  ExternalLink,
  File,
  FileCode,
  FileText,
  Folder,
  Globe,
  Image,
  MessageSquare,
  Plug,
  Table,
  Terminal,
  type LucideIcon,
} from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import { Badge } from "../../../components/ui/badge.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip.js";
import { useTranslation } from "../../../i18n/react.js";
import { wrapRenderHtmlInlineFrameDocument } from "../../../shared/render-html-preview.js";
import { AVE_SIDE_BROWSER_PARTITION } from "../../../shared/side-browser.js";
import { isBrowserBlankBootstrap } from "../../../shared/browser-tools.js";
import { validateExternalUrl } from "../../../shared/external-url.js";
import type { AveApi } from "../types.js";
import type { ChatPreviewTarget, WorkspaceFileItem } from "../preview/preview-targets.js";
import { normalizeBrowserNavigationUrl } from "../preview/url-safety.js";
import { useCopyFlash } from "../hooks/use-copy-flash.js";
import { errorMessage } from "../../../shared/error-message.js";
import { PreviewContent, resolveFilePreviewRoute } from "../preview/preview-renderers.js";
import { TableDocumentPreview } from "../preview/table-document-preview.js";
import { PageDocumentPreview } from "../preview/PageDocumentPreview.js";
import { TextDocumentPreview } from "../preview/TextDocumentPreview.js";
import { FileEditDiff } from "./FileEditDiff.js";
import { ToolPayloadBlock } from "./ToolPayloadBlock.js";
import { McpAppView } from "./McpAppView.js";
import { WebSurfaceSlot } from "./WebSurfaceLayer.js";
import { bindGuestToTab } from "../preview/agent-browser-bridge.js";
import { BrowserObservationLiveStrip } from "../preview/BrowserObservationLiveStrip.js";
import { committedWebSurfaceLocation, subscribeWebSurfaceLocations } from "../preview/web-surfaces.js";

export const FILE_TARGET_KINDS = new Set<ChatPreviewTarget["kind"]>(["file", "diff", "image"]);
export const BROWSER_TARGET_KINDS = new Set<ChatPreviewTarget["kind"]>(["html", "url"]);
/** Pointer travel (px) that promotes a tab press into a horizontal pan. */
export const TAB_DRAG_THRESHOLD_PX = 6;

export function targetIcon(kind: ChatPreviewTarget["kind"]) {
  switch (kind) {
    case "image":
      return <Image className="h-3.5 w-3.5" />;
    case "html":
      return <Code2 className="h-3.5 w-3.5" />;
    case "diff":
      return <FileCode className="h-3.5 w-3.5" />;
    case "json":
      return <Table className="h-3.5 w-3.5" />;
    case "url":
      return <Globe className="h-3.5 w-3.5" />;
    case "plugin":
      return <Plug className="h-3.5 w-3.5" />;
    case "paste":
      return <FileText className="h-3.5 w-3.5" />;
    default:
      return <File className="h-3.5 w-3.5" />;
  }
}

export function tabIcon(kind: WorkspaceTabKind): LucideIcon {
  switch (kind) {
    case "file-browser":
      return Folder;
    case "browser":
      return Globe;
    case "terminal":
      return Terminal;
    case "preview":
      return Table;
    case "subagent":
      return Bot;
    case "activity":
      return Activity;
    case "side-chat":
      return MessageSquare;
  }
}

export function statusTone(status: ChatPreviewTarget["status"] | WorkspaceFileItem["status"]): string {
  if (status === "error") return "text-destructive";
  if (status === "running") return "text-warning";
  return "text-muted-foreground";
}

export function matchesQuery(query: string, ...values: Array<string | undefined>): boolean {
  if (!query) return true;
  const lower = query.toLowerCase();
  return values.some((value) => value?.toLowerCase().includes(lower));
}

function pathSegments(path: string): string[] {
  return path.replace(/\\/g, "/").split("/").filter(Boolean);
}

function TextBlock({ text }: { text: string }) {
  return (
    <pre className="max-h-(--preview-block-max-height) overflow-auto whitespace-pre-wrap rounded-md border bg-muted/(--opacity-muted) p-3 font-mono text-[11px] leading-relaxed text-foreground [overflow-wrap:anywhere]">
      {text}
    </pre>
  );
}

function DetailHeader({ target }: { target: ChatPreviewTarget }) {
  return (
    <div className="min-w-0">
      <div className="flex min-w-0 items-center gap-2">
        <span className="text-muted-foreground">{targetIcon(target.kind)}</span>
        <h3 className="min-w-0 flex-1 truncate text-sm font-semibold">{target.title}</h3>
      </div>
      <div className="mt-1 flex flex-wrap gap-1 text-[10.5px] text-muted-foreground">
        <Badge variant="outline" className="px-1 py-0 text-[10px]">{target.kind}</Badge>
        <span className="truncate">{target.subtitle ?? target.sourceLabel}</span>
      </div>
    </div>
  );
}

/**
 * True when the target's body is a table grid, which is its own scroll
 * container and must take the panel's remaining height instead of making the
 * panel scroll around it. Inline text always renders as text. Hosts switch to
 * a flex column only for these targets; every other preview keeps the block
 * layout it had before (its `h-full` viewers depend on it).
 */
export function previewFillsPanel(target: ChatPreviewTarget): boolean {
  return target.kind === "file" && target.startLine === undefined && !target.inlineText && resolveFilePreviewRoute(target.path).kind === "table";
}

/**
 * Header + body of the selected preview target. For a table target the host
 * is a flex column at least as tall as its scroll area (see
 * {@link previewFillsPanel}): the body flexes into the remaining height and
 * the grid alone scrolls, so the host has nothing left to scroll. Any other
 * target renders exactly as before, as a block the host scrolls.
 */
export function PreviewDetail({ api, sessionId, target, visible }: { api: AveApi; sessionId?: string; target: ChatPreviewTarget; visible: boolean }) {
  return (
    <div
      className={previewFillsPanel(target) ? "flex min-h-0 flex-1 flex-col gap-3" : "space-y-3"}
      data-testid="chat-side-panel-preview-detail"
    >
      {target.kind !== "file" ? <DetailHeader target={target} /> : null}
      <PreviewBody api={api} sessionId={sessionId} target={target} observe={visible} />
    </div>
  );
}

export function EmptyState({ children }: { children: string }) {
  return <div className="p-4 text-xs text-muted-foreground">{children}</div>;
}

function CopyButton({ value }: { value: string }) {
  const { t } = useTranslation();
  const { copied, copy } = useCopyFlash();
  if (!value) return null;
  return (
    <Button type="button" size="sm" variant="outline" onClick={() => copy(value)}>
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      <span>{copied ? t("chatPreviewRail.copied") : t("chatPreviewRail.copy")}</span>
    </Button>
  );
}

/**
 * `observe` is the panel's visibility. A hidden panel keeps every body mounted
 * (sheet, scroll and page position survive) while observing views release
 * their subscription; showing it again takes a fresh baseline.
 */
function FilePreviewBody({ target, sessionId, observe }: { target: Extract<ChatPreviewTarget, { kind: "file" }>; sessionId?: string; observe: boolean }) {
  const route = target.startLine !== undefined || target.inlineText !== undefined ? "text" : resolveFilePreviewRoute(target.path).kind;
  if (route === "table") return <TableDocumentPreview key={target.path} path={target.path} sessionId={sessionId}
    workspaceRoot={target.workspaceRoot} canOpenExternal={target.canOpenExternal} observe={observe} />;
  if (route === "page") return <PageDocumentPreview key={target.path} path={target.path} sessionId={sessionId}
    workspaceRoot={target.workspaceRoot} canOpenExternal={target.canOpenExternal} observe={observe} />;
  return <TextDocumentPreview target={target} sessionId={sessionId} observe={observe} />;
}

export function PreviewBody({
  api,
  sessionId,
  target,
  observe,
}: {
  api: AveApi;
  sessionId?: string;
  target: ChatPreviewTarget;
  /** Whether the hosting panel is shown; see {@link FilePreviewBody}. */
  observe: boolean;
}) {
  const { t } = useTranslation();
  const [loadedStub, setLoadedStub] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    setLoadedStub(null);
    setLoadError(null);
    if (target.kind !== "tool-result" || !target.isStub || !sessionId || !target.toolUseId) return;
    let cancelled = false;
    void api.chatGetVerbatimToolResult(sessionId, target.toolUseId)
      .then((result) => {
        if (cancelled) return;
        setLoadedStub(result?.content ?? null);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [api, sessionId, target]);

  const rawText = target.kind === "tool-result"
    ? loadedStub ?? target.raw
    : target.kind === "json"
      ? target.raw
      : target.kind === "paste"
        ? target.text
        : target.kind === "file" || target.kind === "image" || target.kind === "diff"
          ? target.path
          : target.kind === "url"
            ? target.url
            : target.kind === "plugin"
              ? target.resourceUri
              : target.kind === "html"
                ? target.payload.html
                : "";

  if (target.kind === "html") {
    return <BrowserDocumentViewer target={target} />;
  }

  if (target.kind === "diff") {
    return (
      <div className="space-y-3">
        <div className="rounded-md border bg-muted/(--opacity-muted) px-3 py-2 font-mono text-[11px] [overflow-wrap:anywhere]">
          {target.path}
        </div>
        <FileEditDiff data={target.diff} />
        <CopyButton value={rawText} />
      </div>
    );
  }

  if (target.kind === "image") {
    return (
      <div className="space-y-3">
        <div className="overflow-hidden rounded-md border bg-muted/(--opacity-muted)">
          <img src={target.dataUrl} alt={target.title} className="max-h-[28rem] w-full object-contain" />
        </div>
        <div className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{target.path}</div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" onClick={() => void window.ave.attach.openExternal(target.path)}>
            <ExternalLink className="h-3.5 w-3.5" />
            <span>{t("chatPreviewRail.openFile")}</span>
          </Button>
          <CopyButton value={rawText} />
        </div>
      </div>
    );
  }

  if (target.kind === "file") {
    return <FilePreviewBody key={`${target.id}:${target.workspaceRoot}:${target.startLine}:${target.endLine}`} target={target} sessionId={sessionId} observe={observe} />;
  }

  if (target.kind === "url") {
    return <UrlDocumentViewer api={api} target={target} />;
  }

  if (target.kind === "plugin") {
    return (
      <div className="space-y-3 text-xs">
        <McpAppView payload={target.payload} />
        <dl className="space-y-2 rounded-md border bg-muted/(--opacity-muted) p-3">
          <div>
            <dt className="text-muted-foreground">{t("chatPreviewRail.server")}</dt>
            <dd className="font-mono [overflow-wrap:anywhere]">{target.serverId}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t("chatPreviewRail.resource")}</dt>
            <dd className="font-mono [overflow-wrap:anywhere]">{target.resourceUri}</dd>
          </div>
          {target.slot ? (
            <div>
              <dt className="text-muted-foreground">{t("chatPreviewRail.slot")}</dt>
              <dd className="font-mono">{target.slot}</dd>
            </div>
          ) : null}
        </dl>
        <div className="flex flex-wrap gap-2">
          <CopyButton value={rawText} />
        </div>
      </div>
    );
  }

  if (target.kind === "json") {
    return (
      <div className="space-y-3">
        <ToolPayloadBlock value={target.value} />
        <CopyButton value={rawText} />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {loadError ? <div className="text-xs text-destructive">{loadError}</div> : null}
      {target.kind === "tool-result" && target.isStub && loadedStub == null && !loadError ? (
        <div className="text-xs text-muted-foreground">{t("chatPreviewRail.loadingFullResult")}</div>
      ) : null}
      <PreviewContent descriptor={{ text: rawText, filename: target.title }} />
      <CopyButton value={rawText} />
    </div>
  );
}

export function BrowserDocumentViewer({ target }: { target: Extract<ChatPreviewTarget, { kind: "html" }> }) {
  const srcDoc = useMemo(
    () => wrapRenderHtmlInlineFrameDocument(target.payload.html, { allowScripts: true }),
    [target.payload.html],
  );

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background" data-testid="chat-side-panel-browser-viewer">
      <div className="flex min-h-9 shrink-0 items-center gap-2 border-b bg-muted/(--opacity-muted) px-3 text-[11px] text-muted-foreground">
        <Code2 className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 truncate">{target.payload.title ?? target.title}</span>
      </div>
      <iframe
        data-testid="chat-side-panel-browser-frame"
        title={target.payload.title ?? target.title}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        srcDoc={srcDoc}
        className="block min-h-0 w-full flex-1 border-0 bg-background"
      />
    </div>
  );
}


export function UrlDocumentViewer({
  api,
  target,
  showHeader = true,
  surfaceTabId,
  browserTab,
  sessionId,
  observe = true,
}: {
  api: AveApi;
  target: Extract<ChatPreviewTarget, { kind: "url" }>;
  sessionId?: string;
  /** The hosting panel's visibility; a hidden panel never runs the agent's live preview. */
  observe?: boolean;
  /**
   * The browser tab this page belongs to. A tab's page is a web SURFACE: its
   * guest lives in the window's `WebSurfaceLayer` and this viewer renders only
   * the slot it is laid over, so switching tabs or moving the tab never reloads
   * the page. Without a tab (a url previewed inside another workspace) the
   * viewer owns its `<webview>` inline, as before.
   */
  surfaceTabId?: string;
  /**
   * The workspace tab this viewer renders. When set, each guest the webview
   * attaches is bound to the tab in main (`ave:browser:bind-tab`) so the
   * agent browser tools can reach it; `agentRequestId` marks a tab opened for
   * the agent.
   */
  browserTab?: { tabId: string; agentRequestId?: string };
  /**
   * Render the viewer's own URL/open-external header band. Default true. The
   * BrowserWorkspace tab passes false because the tab already owns a single
   * address bar above the webview — rendering the header here too produced the
   * duplicate-address-bar nesting (#11). This toggles ONLY the header <div>; the
   * webview node's key/position is invariant so the Electron guest is never
   * remounted when the flag changes.
   */
  showHeader?: boolean;
}) {
  const { t } = useTranslation();
  const bindTabId = browserTab?.tabId;
  const bindRequestId = browserTab?.agentRequestId;
  const blankBootstrap = isBrowserBlankBootstrap(target.url, bindRequestId);
  // A host-requested tab binds an empty guest before main installs navigation
  // guards. All other URLs retain the ordinary navigation validator.
  const url = useMemo(() => blankBootstrap
    ? target.url
    : normalizeBrowserNavigationUrl(target.url), [target.url, blankBootstrap]);
  const [webviewElement, setWebviewElement] = useState<HTMLElement | null>(null);
  const [observedLocation, setObservedLocation] = useState<{
    element: HTMLElement;
    requestId: string;
    url: string | null;
  } | null>(null);
  // Guest navigation updates disclosure only. The mounted guest's initial src
  // remains stable so displaying its committed URL cannot reload the page.
  // A tab's page lives in the web-surface layer, which records what its main
  // frame committed (and forgets it when the guest attaches again).
  const surfaceCommitted = useSyncExternalStore(
    subscribeWebSurfaceLocations,
    () => (surfaceTabId ? committedWebSurfaceLocation(surfaceTabId) : null),
  );
  const surfaceObservedUrl = useMemo(() => {
    if (surfaceCommitted === null) return null;
    const checked = validateExternalUrl(surfaceCommitted);
    return checked.ok ? checked.url : null;
  }, [surfaceCommitted]);
  const externalUrl = blankBootstrap
    ? surfaceTabId
      ? surfaceObservedUrl
      : observedLocation !== null && observedLocation.element === webviewElement && observedLocation.requestId === bindRequestId ? observedLocation.url : null
    : url;
  const displayedUrl = externalUrl ?? url;
  useEffect(() => {
    if (!blankBootstrap || !webviewElement || bindRequestId === undefined) return;
    const handleNavigation = (event: Event) => {
      const navigation = event as Event & { url?: unknown; isMainFrame?: unknown };
      if (navigation.isMainFrame === false || (event.type === "did-navigate-in-page" && navigation.isMainFrame !== true)) return;
      const checked = validateExternalUrl(navigation.url);
      setObservedLocation({ element: webviewElement, requestId: bindRequestId, url: checked.ok ? checked.url : null });
    };
    const handleAttach = () => setObservedLocation(null);
    webviewElement.addEventListener("did-attach", handleAttach);
    webviewElement.addEventListener("did-navigate", handleNavigation);
    webviewElement.addEventListener("did-navigate-in-page", handleNavigation);
    return () => {
      webviewElement.removeEventListener("did-attach", handleAttach);
      webviewElement.removeEventListener("did-navigate", handleNavigation);
      webviewElement.removeEventListener("did-navigate-in-page", handleNavigation);
    };
  }, [blankBootstrap, webviewElement, bindRequestId]);
  useEffect(() => {
    if (!webviewElement || bindTabId === undefined) return undefined;
    return bindGuestToTab(api, webviewElement, bindTabId, bindRequestId);
  }, [api, webviewElement, bindTabId, bindRequestId]);

  if (!url) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-background">
        <div className="border-b bg-muted/(--opacity-muted) px-3 py-2 text-xs font-medium">{target.title}</div>
        <div className="min-h-0 flex-1 overflow-auto p-3 text-xs">
          <TextBlock text={target.url} />
          <CopyButton value={target.url} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background" data-testid="chat-side-panel-url-viewer">
      {showHeader ? (
        <div className="flex min-h-9 shrink-0 items-center gap-2 border-b bg-muted/(--opacity-muted) px-2 text-[11px] text-muted-foreground">
          <Globe className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{displayedUrl}</span>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="h-7 w-7 shrink-0"
                disabled={externalUrl === null}
                onClick={() => {
                  if (externalUrl !== null) void api.openExternalUrl(externalUrl);
                }}
                aria-label={t("chatPreviewRail.openUrl")}
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("chatPreviewRail.openUrl")}</TooltipContent>
          </Tooltip>
        </div>
      ) : null}
      {surfaceTabId ? <BrowserObservationLiveStrip tabId={surfaceTabId} sessionId={sessionId} /> : null}
      {surfaceTabId ? (
        <WebSurfaceSlot tabId={surfaceTabId} url={url} location="side-panel" {...(bindRequestId === undefined ? {} : { bindRequestId })}
          {...(sessionId === undefined ? {} : { sessionId })} observe={observe} />
      ) : createElement("webview", {
        ref: setWebviewElement,
        "data-testid": "chat-side-panel-browser-webview",
        src: url,
        partition: AVE_SIDE_BROWSER_PARTITION,
        webpreferences: "contextIsolation=yes, sandbox=yes, nodeIntegration=no, javascript=yes",
        // Popups (target=_blank, OAuth sign-in windows) reach main's
        // side-browser window-open handler, which allows http(s) only and
        // hardens every child window (`side-browser-webview.ts`).
        allowpopups: "true",
        className: "block min-h-0 w-full flex-1 border-0 bg-background",
        style: {
          display: "flex",
          width: "100%",
          height: "100%",
          border: 0,
          background: "transparent",
        },
      })}
    </div>
  );
}

export function fileBasename(path: string): string {
  const segments = pathSegments(path);
  return segments[segments.length - 1] ?? path;
}

/**
 * Is `candidate` `root` itself or a descendant of it? Boundary-safe and
 * platform-agnostic: a bare `startsWith(root)` would let `/foo` falsely match
 * `/foobar`, so the character right after the prefix MUST be a path separator
 * (`/` or `\` — the renderer receives platform-native paths from main).
 */
export function isPathWithinRoot(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  if (!candidate.startsWith(root)) return false;
  // A root that ALREADY ends in a separator has no boundary character left at
  // the split point: `/a/` against `/a/b` lands on `b`, so the segment test
  // would reject a path plainly inside the root. A Windows drive root (`C:\`)
  // is exactly this shape. Same false negative the host-side `isPathWithin`
  // carries a guard for; the renderer cannot import it (no `node:path` here),
  // so the guard is restated rather than shared.
  if (/[/\\]$/.test(root)) return true;
  return /[/\\]/.test(candidate.charAt(root.length));
}

/**
 * Relative path of `full` under `root` (renderer-side string math — no node:path
 * in the renderer). Falls back to the basename for the root itself and to the
 * absolute path when `full` is not a descendant of `root` (boundary-checked, so
 * `/foobar` is NOT treated as being under `/foo`).
 */
export function toRelativePath(root: string | null, full: string): string {
  if (!root) return full;
  if (full === root) return fileBasename(full);
  if (!isPathWithinRoot(root, full)) return full;
  return full.slice(root.length).replace(/^[/\\]+/, "") || full;
}

/**
 * Extension → row icon. `File` is the legitimate domain default for an unknown
 * extension (not a papering-over fallback).
 */
export function fileIcon(name: string): LucideIcon {
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot).toLowerCase() : "";
  switch (ext) {
    case ".md":
    case ".txt":
    case ".rst":
      return FileText;
    case ".ts":
    case ".tsx":
    case ".js":
    case ".jsx":
    case ".py":
    case ".go":
    case ".rs":
      return FileCode;
    case ".json":
    case ".yaml":
    case ".yml":
    case ".toml":
      return Code2;
    case ".png":
    case ".jpg":
    case ".jpeg":
    case ".gif":
    case ".svg":
    case ".webp":
      return Image;
    case ".csv":
    case ".tsv":
    case ".xlsx":
    case ".xls":
    case ".ods":
      return Table;
    case ".html":
    case ".htm":
      return Globe;
    case ".sh":
    case ".zsh":
    case ".bash":
      return Terminal;
    default:
      return File;
  }
}
