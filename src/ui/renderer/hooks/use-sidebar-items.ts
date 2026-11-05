import { useEffect, useReducer, useState } from "react";
import { parseSessionTabBindingsState, type BrowserSessionActor, type BrowserTabsApi, type SessionTabBindingsState } from "../../../shared/browser-surface.js";
import { useBrowserControlState } from "../preview/agent-browser-bridge.js";
import { guestFaviconSource } from "../preview/favicon-source.js";
import { isToolMainSurface, type MainSurface, type ToolMainSurface } from "../preview/main-surfaces.js";
import { subscribeMainLayoutChange } from "../preview/main-layout-restore.js";
import { getSideTabsSink } from "../preview/surface-moves.js";
import { subscribeWebSurfaces, subscribeWebSurfaceLocations, webSurfaceFavicon, webSurfaceLocation } from "../preview/web-surfaces.js";

/** A terminal or web surface in the main area, or a side tab. A side tab has no project of its own: it belongs to its pane's
 * conversation. */
export interface SidebarSurface extends Omit<ToolMainSurface, "projectRoot"> {
  projectRoot?: string;
  title?: string;
  /** Main-owned binding membership, independent of the surface creator. */
  boundSessionIds: readonly string[];
  sessionId?: string;
  faviconDataUrl: string | null;
}

/** Creator ownership, or its listed parent, takes precedence over pane membership. */
function sidebarBoundSessionId(surface: Pick<MainSurface, "kind" | "tabId">, owner: BrowserSessionActor | null | undefined, bindings: SessionTabBindingsState | null, sessionIds: ReadonlySet<string>): string | undefined {
  if (owner?.directParentSessionId && !sessionIds.has(owner.sessionId) && sessionIds.has(owner.directParentSessionId)) return owner.directParentSessionId;
  return owner?.sessionId ?? bindings?.bindings.find((binding) =>
    (surface.kind === "browser" ? binding.browserTabIds : binding.terminalTabIds).includes(surface.tabId))?.sessionId;
}

/** Read the existing surface stores, guest metadata and main-owned session bindings. */
export function useSidebarItems(mainSurfaces: readonly MainSurface[], chatGroupIds: readonly string[], browserTabs: BrowserTabsApi | undefined, sessionIds: ReadonlySet<string>): { surfaces: SidebarSurface[]; bindingsLoaded: boolean } {
  const [, refresh] = useReducer((revision: number) => revision + 1, 0);
  const [bindings, setBindings] = useState<SessionTabBindingsState | null>(null);
  useEffect(() => {
    const unsubscribeLayout = subscribeMainLayoutChange(refresh);
    const unsubscribeLocations = subscribeWebSurfaceLocations(refresh);
    const unsubscribeSurfaces = subscribeWebSurfaces(refresh);
    return () => { unsubscribeLayout(); unsubscribeLocations(); unsubscribeSurfaces(); };
  }, []);
  useEffect(() => {
    setBindings(null);
    if (!browserTabs) return;
    let alive = true;
    let revision = -1;
    const accept = (value: SessionTabBindingsState) => {
      const parsed = parseSessionTabBindingsState(value);
      if (!alive) return;
      if (!parsed) { console.warn("[sidebar] Invalid session tab bindings"); return; }
      if (parsed.revision <= revision) return;
      revision = parsed.revision;
      setBindings(parsed);
    };
    const unsubscribe = browserTabs.onSessionBindingsChanged(accept);
    void browserTabs.getSessionBindings().then(accept).catch((error: unknown) => {
      if (alive) console.warn("[sidebar] Session tab bindings unavailable", error);
    });
    return () => { alive = false; unsubscribe(); };
  }, [browserTabs]);
  const control = useBrowserControlState();
  const surfaces = new Map<string, SidebarSurface>();
  // Folder views have no project-tree row: the rail's folder launcher opens one, and a pane shows it.
  const existing = [...mainSurfaces.filter(isToolMainSurface), ...chatGroupIds.flatMap((id) => getSideTabsSink(id)?.snapshot() ?? [])];
  for (const surface of existing) {
    const browser = surface.kind === "browser" ? control.tabs.find((tab) => tab.rendererTabId === surface.tabId) : undefined;
    const sessionId = sidebarBoundSessionId(surface, browser?.owner, bindings, sessionIds);
    const url = surface.kind === "browser" ? webSurfaceLocation(surface.tabId) ?? browser?.url ?? surface.url : surface.url;
    surfaces.set(surface.tabId, {
      ...surface,
      boundSessionIds: bindings?.bindings.filter((binding) =>
        (surface.kind === "browser" ? binding.browserTabIds : binding.terminalTabIds).includes(surface.tabId))
        .map((binding) => binding.sessionId) ?? [],
      url,
      ...(browser ? { title: browser.title } : {}),
      ...(sessionId ? { sessionId } : {}),
      faviconDataUrl: guestFaviconSource(webSurfaceFavicon(surface.tabId)),
    });
  }
  return { surfaces: [...surfaces.values()], bindingsLoaded: bindings !== null };
}
