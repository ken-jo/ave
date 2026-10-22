import { useEffect, useReducer, useRef, useState } from "react";
import { useBrowserControlState } from "../preview/agent-browser-bridge.js";
import type { MainSurface } from "../preview/main-surfaces.js";
import { subscribeMainLayoutChange } from "../preview/main-layout-restore.js";
import { getSideTabsSink } from "../preview/surface-moves.js";
import { getWebSurfaceElement, subscribeWebSurfaceLocations, subscribeWebSurfaces, webSurfaceLocation } from "../preview/web-surfaces.js";
import { validateExternalUrl } from "../../../shared/external-url.js";

interface SidebarFavicon {
  pageUrl: string | null;
  url: string | null;
}

export interface SidebarSurface extends MainSurface {
  title?: string;
  sessionId?: string;
  favicon?: SidebarFavicon;
}

/** Resolve the session associated with a surface from its ownership metadata. */
function sidebarBoundSessionId(binding: {
  tabId: string;
  owner?: { sessionId: string } | null;
  sessionId?: string | null;
}): string | undefined {
  return binding.owner?.sessionId ?? binding.sessionId ?? undefined;
}

/** Read the existing surface stores and browser ownership snapshot for the sidebar. */
export function useSidebarItems(mainSurfaces: readonly MainSurface[], chatGroupIds: readonly string[]): SidebarSurface[] {
  const [, refresh] = useReducer((revision: number) => revision + 1, 0);
  useEffect(() => {
    const unsubscribeLayout = subscribeMainLayoutChange(refresh);
    const unsubscribeLocations = subscribeWebSurfaceLocations(refresh);
    return () => { unsubscribeLayout(); unsubscribeLocations(); };
  }, []);
  const control = useBrowserControlState();
  const [favicons, setFavicons] = useState<ReadonlyMap<string, SidebarFavicon>>(() => new Map());
  const surfaces = new Map<string, SidebarSurface>();
  const existing = [
    ...mainSurfaces,
    ...chatGroupIds.flatMap((id) => getSideTabsSink(id)?.snapshot() ?? []),
  ];
  for (const surface of existing) {
    const browser = surface.kind === "browser"
      ? control.tabs.find((tab) => tab.rendererTabId === surface.tabId)
      : undefined;
    const sessionId = (browser && sidebarBoundSessionId(browser)) ?? sidebarBoundSessionId(surface);
    const url = surface.kind === "browser"
      ? webSurfaceLocation(surface.tabId) ?? browser?.url ?? surface.url
      : surface.url;
    const favicon = favicons.get(surface.tabId);
    surfaces.set(surface.tabId, {
      ...surface,
      url,
      ...(browser ? { title: browser.title } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(favicon && favicon.pageUrl === url ? { favicon } : {}),
    });
  }

  const browserSources = [...surfaces.values()]
    .filter((surface) => surface.kind === "browser")
    .map(({ tabId, url }) => ({ tabId, url }));
  const browserSourcesRef = useRef(browserSources);
  browserSourcesRef.current = browserSources;
  const browserKey = JSON.stringify(browserSources);
  // Metadata follows the tab, including while its row moves groups or the rail is collapsed.
  useEffect(() => {
    const sources = browserSourcesRef.current;
    const sourceUrls = new Map(sources.map(({ tabId, url }) => [tabId, url]));
    setFavicons((current) => {
      const next = new Map([...current].filter(([id, icon]) => sourceUrls.has(id) && sourceUrls.get(id) === icon.pageUrl));
      return next.size === current.size ? current : next;
    });
    const attached = new Map<string, { element: HTMLElement; listener: (event: Event) => void }>();
    const attach = () => {
      for (const [id, { element, listener }] of attached) {
        if (getWebSurfaceElement(id) !== element) {
          element.removeEventListener("page-favicon-updated", listener);
          attached.delete(id);
        }
      }
      for (const { tabId, url: pageUrl } of sources) {
        const element = getWebSurfaceElement(tabId);
        if (!element || attached.has(tabId)) continue;
        const listener = (event: Event) => {
          const urls = (event as Event & { favicons?: string[] }).favicons ?? [];
          const url = urls.find((value) => validateExternalUrl(value).ok) ?? null;
          const currentPageUrl = webSurfaceLocation(tabId) ?? pageUrl;
          setFavicons((current) => new Map(current).set(tabId, { pageUrl: currentPageUrl, url }));
        };
        element.addEventListener("page-favicon-updated", listener);
        attached.set(tabId, { element, listener });
      }
    };
    attach();
    const unsubscribe = subscribeWebSurfaces(attach);
    return () => {
      unsubscribe();
      for (const { element, listener } of attached.values()) element.removeEventListener("page-favicon-updated", listener);
    };
  }, [browserKey]);
  return [...surfaces.values()];
}
