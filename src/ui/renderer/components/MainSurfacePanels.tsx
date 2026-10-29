/** Terminal views hand over a single mount; web pages remain in the window layer when their panes are hidden. */
import { TerminalFileReviewBadge } from "./TerminalFileReviewBadge.js";
import { useEffect, useMemo, useState, type ComponentProps, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, ArrowRight, ExternalLink, Globe, PanelRightClose, PanelRightOpen, RotateCw } from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import { Input } from "../../../components/ui/input.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip.js";
import { useTranslation } from "../../../i18n/react.js";
import type { AveApi } from "../types.js";
import { BUILTIN_VIEW_ICONS, BUILTIN_LABEL_KEYS } from "../utils/view-location.js";
import { normalizeBrowserNavigationUrl } from "../preview/url-safety.js";
import { useGuestNavigation, useWebSurfaceGuest, type GuestElement, type GuestNavigation } from "../hooks/use-browser-navigation.js";
import type { MainSurface } from "../preview/main-surfaces.js";
import { PaneFrame, usePanePanelSlot } from "./PaneFrame.js";
import { SideChatView, type SideChatRuntime } from "./SideChatView.js";
import type { BoundSurface } from "./BoundSurfaceChip.js";
import { PtyTerminalView } from "./PtyTerminalView.js";
import { useTerminalAttention } from "../preview/terminal-attention.js";
import { WebSurfaceSlot } from "./WebSurfaceLayer.js";
import type { AttachTextResult } from "../preview/composer-targets.js";
import { navigateBrowserTabAsUser } from "../preview/agent-browser-bridge.js";
import { BrowserSurfaceTools } from "./BrowserSurfaceTools.js";
import { BrowserObservationLiveStrip } from "../preview/BrowserObservationLiveStrip.js";

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
        <WebSurfaceSlot tabId={surface.tabId} url={surface.url} location={`pane:${paneId}`} />
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

/** The last segment of a directory path — the header has room for a name, not a path. */
export function directoryName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || "/";
}

type FrameProps = Omit<ComponentProps<typeof PaneFrame>, "title" | "icon" | "children" | "description" | "asideSlot">;

/** The pane chat's share of the tile: room for a transcript, never most of the page. */
const PANE_CHAT_WIDTH = "clamp(280px, 38%, 440px)";

/** A surface pane's own chat, docked in the tile's aside slot beside the page or terminal. It is the side chat, bound to
 * this pane's tab. */
function PaneChatPanel({
  api,
  surface,
  paneId,
  runtime,
  onSessionsChanged,
}: {
  api: AveApi;
  surface: BoundSurface;
  paneId: string;
  runtime: SideChatRuntime;
  onSessionsChanged?: (() => void | Promise<void>) | undefined;
}) {
  const slot = usePanePanelSlot();
  if (!slot?.panel) return null;
  return createPortal(
    <aside
      className="flex min-h-0 shrink-0 flex-col border-l border-border/(--opacity-half) bg-card"
      style={{ width: PANE_CHAT_WIDTH }}
      data-testid="pane-chat"
      data-tab-id={surface.tabId}
    >
      {/* Keyed by the tab: a pane that comes to hold another surface shows
          that surface's own conversation, never the last one's transcript. */}
      <SideChatView
        key={surface.tabId}
        api={api}
        boundSurface={surface}
        runtime={runtime}
        chatGroupId={`pane:${paneId}`}
        onSessionsChanged={onSessionsChanged}
      />
    </aside>,
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
  const meta = surface.kind === "terminal" && surface.cwd ? { text: directoryName(surface.cwd), title: surface.cwd } : null;
  // The header toggles the owning tab's panel state.
  const chatLabel = chatOpen
    ? t("mainPanels.closeChat")
    : t(surface.kind === "terminal" ? "mainPanels.chatWithTerminal" : "mainPanels.chatWithPage");
  const actions = useMemo(() => [
    ...(frame.actions ?? []),
    {
      id: "surface.chat",
      label: chatLabel,
      icon: chatOpen ? <PanelRightClose className="h-4 w-4" /> : <PanelRightOpen className="h-4 w-4" />,
      active: chatOpen,
      onSelect: () => onChatOpenChange(!chatOpen),
    },
  ], [frame.actions, chatLabel, chatOpen, onChatOpenChange]);
  const host = surface.kind === "browser" ? hostOf(navigation.url ?? surface.url) : null;
  const boundSurface = useMemo<BoundSurface>(() => (surface.kind === "terminal"
    ? { kind: "terminal", tabId: surface.tabId, name: label, detail: surface.cwd ? directoryName(surface.cwd) : null, detailTitle: surface.cwd ?? null }
    : { kind: "browser", tabId: surface.tabId, name: title, detail: host && host !== title ? host : null, detailTitle: navigation.url ?? surface.url }),
  [surface.kind, surface.tabId, surface.cwd, surface.url, label, title, host, navigation.url]);
  return (
    <PaneFrame
      {...frame}
      actions={actions}
      asideSlot={chatOpen}
      title={title}
      titleAccessory={surface.kind === "terminal" ? <TerminalFileReviewBadge tabId={surface.tabId} /> : undefined}
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
      {chatOpen ? (
        <PaneChatPanel api={api} surface={boundSurface} paneId={paneId} runtime={chatRuntime} onSessionsChanged={onSessionsChanged} />
      ) : null}
    </PaneFrame>
  );
}
