import { useEffect, useReducer } from "react";
import { useBrowserControlState } from "../preview/agent-browser-bridge.js";
import type { MainSurface } from "../preview/main-surfaces.js";
import { subscribeMainLayoutChange } from "../preview/main-layout-restore.js";
import { getSideTabsSink } from "../preview/surface-moves.js";
import { subscribeWebSurfaceLocations, webSurfaceLocation } from "../preview/web-surfaces.js";
import { isBrowserFaviconDataUrl } from "../../../shared/browser-surface.js";

export interface SidebarSurface extends MainSurface {
  title?: string;
  sessionId?: string;
  faviconDataUrl: string | null;
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
    const faviconDataUrl = browser && browser.url === url && isBrowserFaviconDataUrl(browser.faviconDataUrl) ? browser.faviconDataUrl : null;
    surfaces.set(surface.tabId, {
      ...surface,
      url,
      ...(browser ? { title: browser.title } : {}),
      ...(sessionId ? { sessionId } : {}),
      faviconDataUrl,
    });
  }

  return [...surfaces.values()];
}
