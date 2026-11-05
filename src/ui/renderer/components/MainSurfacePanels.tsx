/** Terminal views hand over a single mount; web pages remain in the window layer when their panes are hidden. */
import { TerminalFileReviewBadge } from "./TerminalFileReviewBadge.js";
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, ArrowRight, ExternalLink, FileDiff, Globe, MessageSquare, PanelRightClose, PanelRightOpen, RotateCw, X } from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import { Input } from "../../../components/ui/input.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip.js";
import { useTranslation } from "../../../i18n/react.js";
import type { AveApi } from "../types.js";
import { BUILTIN_VIEW_ICONS, BUILTIN_LABEL_KEYS } from "../utils/view-location.js";
import { normalizeBrowserNavigationUrl } from "../preview/url-safety.js";
import { useGuestNavigation, useWebSurfaceGuest, type GuestElement, type GuestNavigation } from "../hooks/use-browser-navigation.js";
import type { MainSurface } from "../preview/main-surfaces.js";
import { HEADER_BUTTON_CLASS, PaneFrame, usePanePanelSlot } from "./PaneFrame.js";
import { DockedPanelColumn, useDockedPanelMotion, WorkPanelCard } from "./DockedWorkPanel.js";
import { TerminalChangesView } from "./TerminalChangesView.js";
import { useTerminalFileReviewState } from "../preview/terminal-file-review.js";
import { usePanelWidth, SIDE_PANEL_WIDTH_PREF } from "../hooks/use-panel-width.js";
import { useContainerNarrow } from "../hooks/use-container-narrow.js";
import { chatColumnsLayout } from "../preview/chat-columns-layout.js";
import { SIDE_PANEL_MIN_RESERVE } from "../../../shared/side-panel.js";
import { SideChatView, type SideChatRuntime } from "./SideChatView.js";
import type { BoundSurface } from "./BoundSurfaceChip.js";
import { PtyTerminalView } from "./PtyTerminalView.js";
import { useTerminalAttention } from "../preview/terminal-attention.js";
import { WebSurfaceSlot } from "./WebSurfaceLayer.js";
import type { AttachTextResult } from "../preview/composer-targets.js";
import { navigateBrowserTabAsUser } from "../preview/agent-browser-bridge.js";
import { BrowserSurfaceTools } from "./BrowserSurfaceTools.js";
import { BrowserObservationLiveStrip } from "../preview/BrowserObservationLiveStrip.js";
import { directoryName } from "./TerminalPaneHeader.js";

/** A web page's name for its pane: its title, else its host, else the kind's label. */
export function webPanelTitle(navigation: GuestNavigation, fallbackUrl: string | null, kindLabel: string): string {
  if (navigation.title) return navigation.title;
  const url = navigation.url ?? fallbackUrl;
  if (url) {
    try {
      return new URL(url).host || url;
    } catch {
      return url;
    }
  }
  return kindLabel;
}

function WebPanelBody({
  api,
  surface,
  paneId,
  guest,
  navigation,
  onNavigate,
}: {
  api: AveApi;
  surface: MainSurface;
  paneId: string;
  guest: GuestElement | null;
  navigation: GuestNavigation;
  onNavigate: (url: string) => void;
}) {
  const { t } = useTranslation();
  const shownUrl = navigation.url ?? surface.url ?? "";
  const navigateAsUser = (navigate: () => void) => void navigateBrowserTabAsUser(api, surface.tabId, navigate);
  const [draft, setDraft] = useState(shownUrl);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setDraft(shownUrl);
    setError(null);
  }, [shownUrl]);

  const submit = () => {
    const normalized = normalizeBrowserNavigationUrl(draft);
    if (!normalized) {
      setError(t("chatPreviewRail.browserInvalidUrl"));
      return;
    }
    setError(null);
    navigateAsUser(() => onNavigate(normalized));
  };

  const navButton = (label: string, icon: ReactNode, onClick: () => void, disabled: boolean, testId: string) => (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type="button" size="icon" variant="ghost" className="h-7 w-7 shrink-0" aria-label={label} disabled={disabled} onClick={onClick} data-testid={testId}>
          {icon}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col" data-testid="web-panel" data-tab-id={surface.tabId}>
      <form
        className="flex shrink-0 items-center gap-1 border-b border-border/(--opacity-half) px-2 py-1"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {navButton(t("mainPanels.back"), <ArrowLeft className="h-3.5 w-3.5" />, () => navigateAsUser(() => guest?.goBack()), !navigation.canGoBack, "web-panel-back")}
        {navButton(t("mainPanels.forward"), <ArrowRight className="h-3.5 w-3.5" />, () => navigateAsUser(() => guest?.goForward()), !navigation.canGoForward, "web-panel-forward")}
        {navButton(t("mainPanels.reload"), <RotateCw className="h-3.5 w-3.5" />, () => navigateAsUser(() => guest?.reload()), !guest || !shownUrl, "web-panel-reload")}
        <Globe className="ml-1 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <Input
          data-testid="web-panel-address"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            if (error) setError(null);
          }}
          placeholder={t("chatPreviewRail.browserAddressPlaceholder")}
          className="h-7 min-w-0 flex-1 text-xs"
        />
        {navButton(
          t("chatPreviewRail.openUrl"),
          <ExternalLink className="h-3.5 w-3.5" />,
          () => {
            const safe = normalizeBrowserNavigationUrl(shownUrl);
            if (safe) void api.openExternalUrl(safe);
          },
          !shownUrl,
          "web-panel-open-external",
        )}
      </form>
      <BrowserSurfaceTools api={api} tabId={surface.tabId} onOpenUrl={(url) => navigateAsUser(() => onNavigate(url))} />
      <BrowserObservationLiveStrip tabId={surface.tabId} />
      {error ? (
        <div className="shrink-0 border-b px-3 py-1.5 text-[11px] text-destructive" data-testid="web-panel-address-error">{error}</div>
      ) : null}
      {surface.url ? (
        <WebSurfaceSlot tabId={surface.tabId} url={surface.url} location={`pane:${paneId}`}
          {...(surface.agentRequestId === undefined ? {} : { bindRequestId: surface.agentRequestId })} />
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center p-4 text-sm text-muted-foreground" data-testid="web-panel-empty">
          {t("mainPanels.webEmpty")}
        </div>
      )}
    </div>
  );
}

/** A url's host, or null when it has none. */
export function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

type FrameProps = Omit<ComponentProps<typeof PaneFrame>, "title" | "icon" | "children" | "description" | "asideSlot">;

type SurfacePanelTab = "chat" | "changes";
const PANEL_TAB_CLASS = "flex h-8 min-w-0 items-center gap-1 rounded-md px-2 text-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary";

/**
 * A surface pane's work panel: the same docked column and raised card a conversation's work panel uses, pushing the
 * page or terminal aside when the tile has room and floating over it when it does not. It holds the side chat bound to
 * this pane's tab and, for a terminal, the terminal's 변경 파일 view.
 */
function SurfaceWorkPanel({
  api, surface, paneId, runtime, onSessionsChanged, open, onClose, tab, onTab, changesTab,
}: {
  api: AveApi;
  surface: BoundSurface;
  paneId: string;
  runtime: SideChatRuntime;
  onSessionsChanged?: (() => void | Promise<void>) | undefined;
  open: boolean;
  onClose: () => void;
  tab: SurfacePanelTab;
  onTab: (tab: SurfacePanelTab) => void;
  /** The 변경 파일 tab's count; absent for a surface that has no changes view. */
  changesTab: number | null;
}) {
  const { t } = useTranslation();
  const slot = usePanePanelSlot();
  const { width: containerWidth, isNarrow } = useContainerNarrow(slot?.tile ?? null);
  const { width: savedWidth, setWidth, commitWidth } = usePanelWidth(api, SIDE_PANEL_WIDTH_PREF);
  const [resizing, setResizing] = useState(false);
  const columns = chatColumnsLayout(containerWidth, false, open, savedWidth, isNarrow);
  const motion = useDockedPanelMotion(open);
  const columnRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { if (!open) setResizing(false); }, [open]);
  const onWidthChange = useCallback((px: number) => { setResizing(true); setWidth(px); }, [setWidth]);
  const onWidthCommit = useCallback((px: number) => { setResizing(false); setWidth(px); commitWidth(Math.max(SIDE_PANEL_MIN_RESERVE, px)); }, [setWidth, commitWidth]);
  if (!slot?.panel || !motion.present) return null;
  const shownTab = changesTab === null ? "chat" : tab;
  const tabButton = (id: SurfacePanelTab, label: ReactNode, icon: ReactNode) => (
    <button type="button" role="tab" aria-selected={shownTab === id} data-testid={`pane-work-panel-tab-${id}`}
      className={`${PANEL_TAB_CLASS} ${shownTab === id ? "bg-primary/(--opacity-subtle) text-primary" : "text-muted-foreground hover:bg-muted/(--opacity-muted) hover:text-foreground"}`}
      onClick={() => onTab(id)}>
      {icon}{label}
    </button>
  );
  return createPortal(
    <DockedPanelColumn ref={columnRef} testId="pane-work-panel-motion" motion={motion} shouldOpen={open}
      width={columns.panelWidth} mode={columns.panelLayout.mode} resizing={resizing}>
      <WorkPanelCard testId="pane-work-panel" className="relative flex shrink-0" width={columns.panelWidth}
        minWidth={columns.panelLayout.min} maxWidth={columns.panelLayout.max} onWidthChange={onWidthChange} onWidthCommit={onWidthCommit}
        resizeElementRef={columnRef} splitterTestId="pane-work-panel-width-splitter">
        <div className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden" data-testid="pane-chat" data-tab-id={surface.tabId}>
          <div className="flex min-w-0 shrink-0 items-center gap-2 border-b px-2 py-1" data-testid="pane-work-panel-tab-strip">
            <div role="tablist" aria-label={t("chatPreviewRail.tabsLabel")} className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
              {tabButton("chat", t("chatTab.title"), <MessageSquare className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />)}
              {changesTab !== null ? tabButton("changes", <>{t("terminalFileReview.tab")}<span className="tabular-nums">{changesTab}</span></>,
                <FileDiff className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />) : null}
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button type="button" size="icon-xs" variant="ghost" data-testid="pane-work-panel-close" aria-label={t("chatPreviewRail.close")} onClick={onClose}>
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{t("chatPreviewRail.close")}</TooltipContent>
            </Tooltip>
          </div>
          {/* The chat stays mounted under the changes view: its draft, transcript and pending cards survive the switch.
              Keyed by the tab: a pane that comes to hold another surface shows that surface's own conversation. */}
          <div className={shownTab === "chat" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
            <SideChatView
              key={surface.tabId}
              api={api}
              boundSurface={surface}
              runtime={runtime}
              chatGroupId={`pane:${paneId}`}
              onSessionsChanged={onSessionsChanged}
            />
          </div>
          {shownTab === "changes" ? <TerminalChangesView api={api} tabId={surface.tabId} visible={open} /> : null}
        </div>
      </WorkPanelCard>
    </DockedPanelColumn>,
    slot.panel,
  );
}

/** A pane showing a terminal or a web page. `frame` carries what every pane is as a tile (focus, split, maximize, close);
 * this component adds the title, glyph and body that the surface decides. */
export function SurfacePane({
  api,
  surface,
  paneId,
  frame,
  onNavigate,
  onAttachText,
  chatRuntime,
  chatOpen,
  onChatOpenChange,
  onSessionsChanged,
}: {
  api: AveApi;
  surface: MainSurface;
  paneId: string;
  frame: FrameProps;
  /** The model readiness the pane's own chat composer needs. */
  chatRuntime: SideChatRuntime;
  /** Presentation state belongs to the tab, so pane navigation cannot lose it. */
  chatOpen: boolean;
  onChatOpenChange: (open: boolean) => void;
  /** A pane chat turn lists or moves a side-chat row in the window's list. */
  onSessionsChanged?: () => void | Promise<void>;
  /** A web surface's address row asked for `url`. */
  onNavigate: (tabId: string, url: string) => void;
  /** Hand a terminal block's text to a chat composer; false when it is full. */
  onAttachText?: (text: string) => AttachTextResult;
}) {
  const { t } = useTranslation();
  const view = surface.kind === "terminal" ? "terminal" : "web";
  const Icon = BUILTIN_VIEW_ICONS[view];
  const kindLabel = t(BUILTIN_LABEL_KEYS[view]);
  const guest = useWebSurfaceGuest(surface.tabId);
  const navigation = useGuestNavigation(surface.kind === "browser" ? guest : null);
  const label = `${kindLabel} ${surface.ordinal}`;
  const title = surface.kind === "terminal" ? label : webPanelTitle(navigation, surface.url, label);
  const attention = useTerminalAttention().get(surface.tabId)?.message ?? null;
  // The terminal's identity and block controls render into this header slot; its directory is the header's meta, kept
  // current as the shell reports it.
  const [terminalHeader, setTerminalHeader] = useState<HTMLElement | null>(null);
  const [liveCwd, setLiveCwd] = useState<string | null>(null);
  const cwd = liveCwd ?? surface.cwd ?? null;
  const meta = surface.kind === "terminal" && cwd ? { text: directoryName(cwd), title: cwd } : null;
  // The header toggles the owning tab's panel state.
  const chatLabel = chatOpen
    ? t("mainPanels.closeChat")
    : t(surface.kind === "terminal" ? "mainPanels.chatWithTerminal" : "mainPanels.chatWithPage");
  const [panelTab, setPanelTab] = useState<SurfacePanelTab>("chat");
  const review = useTerminalFileReviewState(surface.tabId);
  // The badge and a warning's [view changes] open this terminal's 변경 파일 tab on the clicked file. A request made
  // before this pane mounted is not this pane's to act on.
  const revealToken = surface.kind === "terminal" ? review?.reveal?.token ?? null : null;
  const handledReveal = useRef(revealToken);
  useEffect(() => {
    if (revealToken === null || handledReveal.current === revealToken) return;
    handledReveal.current = revealToken;
    setPanelTab("changes");
    if (!chatOpen) onChatOpenChange(true);
  }, [revealToken, chatOpen, onChatOpenChange]);
  // The work panel's toggle sits where a conversation pane has its own: at the head of the trailing cluster.
  const trailing = (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" className={HEADER_BUTTON_CLASS} onClick={() => onChatOpenChange(!chatOpen)}
          title={chatLabel} aria-label={chatLabel} aria-pressed={chatOpen} data-testid="pane-action-surface.chat">
          {chatOpen ? <PanelRightClose className="h-4 w-4" /> : <PanelRightOpen className="h-4 w-4" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{chatLabel}</TooltipContent>
    </Tooltip>
  );
  const host = surface.kind === "browser" ? hostOf(navigation.url ?? surface.url) : null;
  const boundSurface = useMemo<BoundSurface>(() => (surface.kind === "terminal"
    ? { kind: "terminal", tabId: surface.tabId, name: label, detail: cwd ? directoryName(cwd) : null, detailTitle: cwd }
    : { kind: "browser", tabId: surface.tabId, name: title, detail: host && host !== title ? host : null, detailTitle: navigation.url ?? surface.url }),
  [surface.kind, surface.tabId, cwd, surface.url, label, title, host, navigation.url]);
  return (
    <PaneFrame
      {...frame}
      trailing={trailing}
      // Always published: the work panel closes with the same transition it opens with.
      asideSlot
      title={title}
      titleAccessory={surface.kind === "terminal" ? <>
        <span ref={setTerminalHeader} className="contents" />
        <TerminalFileReviewBadge tabId={surface.tabId} />
      </> : undefined}
      attention={attention}
      meta={meta}
      {...(surface.kind === "browser" && (navigation.url ?? surface.url) ? { description: navigation.url ?? surface.url ?? "" } : {})}
      icon={<Icon className="h-4 w-4" />}
      bodyInset="none"
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="surface-pane" data-surface-kind={surface.kind} data-tab-id={surface.tabId}>
        {surface.kind === "terminal" ? (
          <PtyTerminalView
            api={api}
            location={`pane:${paneId}`}
            tabId={surface.tabId}
            tabLabel={label}
            initialCwd={surface.cwd ?? null}
            attended={frame.focused ?? false}
            headerSlot={terminalHeader}
            onCwd={setLiveCwd}
            {...(onAttachText ? { onAttachText } : {})}
          />
        ) : (
          <WebPanelBody
            api={api}
            surface={surface}
            paneId={paneId}
            guest={guest}
            navigation={navigation}
            onNavigate={(url) => onNavigate(surface.tabId, url)}
          />
        )}
      </div>
      <SurfaceWorkPanel api={api} surface={boundSurface} paneId={paneId} runtime={chatRuntime} onSessionsChanged={onSessionsChanged}
        open={chatOpen} onClose={() => onChatOpenChange(false)} tab={panelTab} onTab={setPanelTab}
        changesTab={surface.kind === "terminal" ? review?.changed ?? 0 : null} />
    </PaneFrame>
  );
}
