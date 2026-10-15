/**
 * Terminal and web panels in the main area — a pane whose content is a
 * surface (`ViewLocation.view` `terminal` / `web` with its `surface` id).
 *
 * The pane draws the same frame every pane draws; what differs is the body.
 * A terminal body is the PTY view for the surface's tab id (`PtyTerminalView`,
 * single-mounted, so the same tab shown elsewhere hands over rather than
 * duplicating). A web body is an address row over a `WebSurfaceSlot`: the page
 * itself lives in the window's surface layer and is only laid over the slot,
 * so a routed-away or hidden web pane keeps its page.
 */
import { useCallback, useEffect, useState, useSyncExternalStore, type ComponentProps, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, ExternalLink, Globe, RotateCw } from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import { Input } from "../../../components/ui/input.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip.js";
import { useTranslation } from "../../../i18n/react.js";
import type { AveApi } from "../types.js";
import { BUILTIN_VIEW_ICONS, BUILTIN_LABEL_KEYS } from "../utils/view-location.js";
import { normalizeBrowserNavigationUrl } from "../preview/url-safety.js";
import { getWebSurfaceElement, subscribeWebSurfaces } from "../preview/web-surfaces.js";
import type { MainSurface } from "../preview/main-surfaces.js";
import { PaneFrame } from "./PaneFrame.js";
import { PtyTerminalView } from "./PtyTerminalView.js";
import { useTerminalAttention } from "../preview/terminal-attention.js";
import { WebSurfaceSlot } from "./WebSurfaceLayer.js";

/** The subset of a `<webview>` a panel's chrome drives. */
interface GuestElement extends HTMLElement {
  getURL(): string;
  getTitle(): string;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
}

export interface GuestNavigation {
  url: string | null;
  title: string | null;
  canGoBack: boolean;
  canGoForward: boolean;
}

const NO_NAVIGATION: GuestNavigation = { url: null, title: null, canGoBack: false, canGoForward: false };

/** The live `<webview>` of a tab, once the layer has rendered it. */
export function useWebSurfaceGuest(tabId: string): GuestElement | null {
  return useSyncExternalStore(subscribeWebSurfaces, () => getWebSurfaceElement(tabId)) as GuestElement | null;
}

/**
 * Where the tab's page actually is — its live url and title, which a page
 * changes on its own (links, redirects, SPA routes) — read from the guest's
 * navigation events. Before the guest has attached there is nothing to read.
 */
export function useGuestNavigation(guest: GuestElement | null): GuestNavigation {
  const [state, setState] = useState<GuestNavigation>(NO_NAVIGATION);
  useEffect(() => {
    if (!guest) {
      setState(NO_NAVIGATION);
      return undefined;
    }
    const read = () => {
      try {
        setState({
          url: guest.getURL() || null,
          title: guest.getTitle() || null,
          canGoBack: guest.canGoBack(),
          canGoForward: guest.canGoForward(),
        });
      } catch {
        // `getURL` throws until the guest has attached; its dom-ready reads again.
      }
    };
    const events = ["dom-ready", "did-navigate", "did-navigate-in-page", "page-title-updated", "did-stop-loading"];
    for (const name of events) guest.addEventListener(name, read);
    read();
    return () => {
      for (const name of events) guest.removeEventListener(name, read);
    };
  }, [guest]);
  return state;
}

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
    onNavigate(normalized);
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
        {navButton(t("mainPanels.back"), <ArrowLeft className="h-3.5 w-3.5" />, () => guest?.goBack(), !navigation.canGoBack, "web-panel-back")}
        {navButton(t("mainPanels.forward"), <ArrowRight className="h-3.5 w-3.5" />, () => guest?.goForward(), !navigation.canGoForward, "web-panel-forward")}
        {navButton(t("mainPanels.reload"), <RotateCw className="h-3.5 w-3.5" />, () => guest?.reload(), !guest || !shownUrl, "web-panel-reload")}
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

/** The last segment of a directory path — the header has room for a name, not a path. */
export function directoryName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || "/";
}

type FrameProps = Omit<ComponentProps<typeof PaneFrame>, "title" | "icon" | "children" | "description">;

/**
 * A pane showing a terminal or a web page. `frame` carries what every pane is
 * as a tile (focus, split, maximize, close); this component adds the title,
 * glyph and body that the surface decides.
 */
export function SurfacePane({
  api,
  surface,
  paneId,
  frame,
  onNavigate,
  onCwd,
  onAttachText,
}: {
  api: AveApi;
  surface: MainSurface;
  paneId: string;
  frame: FrameProps;
  /** A web surface's address row asked for `url`. */
  onNavigate: (tabId: string, url: string) => void;
  /** A terminal's shell reported its working directory. */
  onCwd: (tabId: string, cwd: string) => void;
  /** Hand a terminal block's text to a chat composer; false when it is full. */
  onAttachText?: (text: string) => boolean;
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
  const reportCwd = useCallback((cwd: string) => onCwd(surface.tabId, cwd), [onCwd, surface.tabId]);
  const meta = surface.kind === "terminal" && surface.cwd ? { text: directoryName(surface.cwd), title: surface.cwd } : null;
  return (
    <PaneFrame
      {...frame}
      title={title}
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
            onCwd={reportCwd}
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
    </PaneFrame>
  );
}
