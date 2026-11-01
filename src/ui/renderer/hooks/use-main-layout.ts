import { useEffect, useRef, useState } from "react";
import type { AveApi } from "../types.js";
import { isSecondaryMainWindow } from "../utils/main-window-role.js";
import { parseMainLayout, type MainLayoutLimits, type MainLayoutSnapshot, type SavedSurface } from "../../../shared/main-layout.js";
import { MAIN_CHAT_GROUP_ID, MAX_PANES } from "../../../contract/app-contract.js";
import type { PaneNode } from "../components/pane-tree.js";
import type { ViewLocation } from "../utils/view-location.js";
import { VIEW_OF_SURFACE_KIND, type MainSurface } from "../preview/main-surfaces.js";
import { reserveTabIds } from "../preview/workspace-tabs.js";
import { getSideTabsSink } from "../preview/surface-moves.js";
import { subscribeWebSurfaceLocations, webSurfaceLocation } from "../preview/web-surfaces.js";
import {
  emitMainLayoutChange,
  stageRestoredLayout,
  subscribeMainLayoutChange,
  takeRestoredSideTabs,
  terminalCwd,
} from "../preview/main-layout-restore.js";
import { buildMainLayoutSnapshot, savedSurfaceOf } from "../preview/main-layout-snapshot.js";

/** The window's own limits the stored shape is checked against (see `shared/main-layout.ts`). */
const WINDOW_LAYOUT_LIMITS: MainLayoutLimits = { maxPanes: MAX_PANES, primaryPaneId: MAIN_CHAT_GROUP_ID };

/** How long the layout must hold still before it is written. */
export const MAIN_LAYOUT_SAVE_DELAY_MS = 300;

interface ChatGroupsForLayout {
  tree: PaneNode;
  focusedId: string;
  panelOpenIds: readonly string[];
  thumbnailOpenIds: readonly string[];
  contentById: Readonly<Record<string, ViewLocation>>;
  restore: (layout: {
    tree: PaneNode;
    focusedId: string;
    panelOpenIds: readonly string[];
    thumbnailOpenIds: readonly string[];
    content: Readonly<Record<string, ViewLocation>>;
  }) => void;
}

interface MainSurfacesForLayout {
  surfaces: readonly MainSurface[];
  get: (tabId: string) => MainSurface | undefined;
  adopt: (surface: MainSurface) => void;
}

/** Put a checked layout back: ids reserved, side tabs and terminals staged, panes and surfaces restored. */
function applyLayout(layout: MainLayoutSnapshot, chatGroups: ChatGroupsForLayout, mainSurfaces: MainSurfacesForLayout): void {
  // First-class surfaces in their saved order (older layouts list only the shown ones), then any shown one not listed.
  const shown = Object.values(layout.surfaces);
  const listed = layout.openSurfaces ?? [];
  const main = [...listed, ...shown.filter((surface) => !listed.some((each) => each.tabId === surface.tabId))];
  const all: SavedSurface[] = [...main, ...Object.values(layout.sideTabs).flat()];
  reserveTabIds(all.map((surface) => surface.tabId));
  stageRestoredLayout({ sideTabs: layout.sideTabs, terminals: all.filter((surface) => surface.kind === "terminal") });
  for (const surface of main) {
    mainSurfaces.adopt({ tabId: surface.tabId, kind: surface.kind, ordinal: surface.ordinal, url: surface.url, cwd: surface.cwd });
  }
  const content: Record<string, ViewLocation> = {};
  for (const [paneId, surface] of Object.entries(layout.surfaces)) {
    content[paneId] = { view: VIEW_OF_SURFACE_KIND[surface.kind], surface: surface.tabId };
  }
  // The saved tree's nodes have the pane tree's shape; the parser checked them.
  chatGroups.restore({ tree: layout.tree as PaneNode, focusedId: layout.focusedId, panelOpenIds: layout.panelOpenIds, thumbnailOpenIds: layout.thumbnailOpenIds, content });
  // Panes whose conversation is already mounted (the main one, at least) take their side tabs now; the rest take them when
  // they mount.
  for (const paneId of Object.keys(layout.sideTabs)) {
    const sink = getSideTabsSink(paneId);
    if (!sink) continue;
    for (const tab of takeRestoredSideTabs(paneId)) sink.adopt({ id: tab.tabId, kind: tab.kind, ordinal: tab.ordinal }, tab.url);
  }
}

/** Validate before restore/save and wait for restoration before writing defaults; invalid snapshots are reported without
 * persistence. */
export function useMainLayout(api: AveApi, chatGroups: ChatGroupsForLayout, mainSurfaces: MainSurfacesForLayout): void {
  // The saved layout is the primary window's (`shared/main-window-role.ts`):
  // two windows restoring one layout would both claim its terminal ids, and
  // both saving it would overwrite each other. A secondary window starts in
  // the default layout and keeps its own unsaved.
  const [ownsLayout] = useState(() => !isSecondaryMainWindow());
  const [settled, setSettled] = useState(false);
  const chatGroupsRef = useRef(chatGroups);
  chatGroupsRef.current = chatGroups;
  const mainSurfacesRef = useRef(mainSurfaces);
  mainSurfacesRef.current = mainSurfaces;

  useEffect(() => {
    if (!ownsLayout) return undefined;
    let cancelled = false;
    void api
      .getSettings()
      .then((settings) => {
        if (cancelled) return;
        const raw = (settings?.system as { mainLayout?: unknown } | undefined)?.mainLayout;
        if (raw === undefined) return;
        const parsed = parseMainLayout(raw, WINDOW_LAYOUT_LIMITS);
        if (!parsed.ok) {
          console.warn(`[main-layout] saved layout refused: ${parsed.reason}; starting in the default layout`);
          return;
        }
        applyLayout(parsed.layout, chatGroupsRef.current, mainSurfacesRef.current);
      })
      .catch((err: unknown) => {
        console.warn("[main-layout] the saved layout could not be read; starting in the default layout", err);
      })
      .finally(() => {
        if (!cancelled) setSettled(true);
      });
    return () => {
      cancelled = true;
    };
  }, [api, ownsLayout]);

  const lastWrittenRef = useRef<string | null>(null);
  useEffect(() => {
    if (!settled) return undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const current = (): MainLayoutSnapshot => {
      const groups = chatGroupsRef.current;
      const surfaces = mainSurfacesRef.current;
      const snapshot = buildMainLayoutSnapshot({
        tree: groups.tree,
        focusedId: groups.focusedId,
        panelOpenIds: groups.panelOpenIds,
        thumbnailOpenIds: groups.thumbnailOpenIds,
        contentById: groups.contentById,
        surfaceOf: (tabId) => {
          const surface = surfaces.get(tabId);
          if (!surface) return null;
          return savedSurfaceOf(
            surface,
            surface.kind === "terminal" ? terminalCwd(tabId) ?? surface.cwd ?? null : null,
            surface.kind === "browser" ? webSurfaceLocation(tabId) ?? surface.url : null,
          );
        },
        sideTabsOf: (paneId) => getSideTabsSink(paneId)?.snapshot() ?? [],
        openSurfaceIds: surfaces.surfaces.map((surface) => surface.tabId),
      });
      return snapshot;
    };
    // What the window holds as the restore settles is what is already saved (or the default, which needs no saving): only a
    // change after it is written.
    if (lastWrittenRef.current === null) lastWrittenRef.current = JSON.stringify(current());
    const write = () => {
      timer = null;
      const snapshot = current();
      const checked = parseMainLayout(snapshot, WINDOW_LAYOUT_LIMITS);
      if (!checked.ok) {
        console.error(`[main-layout] not saving a layout that breaks its own rules: ${checked.reason}`);
        return;
      }
      const json = JSON.stringify(snapshot);
      if (json === lastWrittenRef.current) return;
      lastWrittenRef.current = json;
      void api.updateSettings({ system: { mainLayout: snapshot } });
    };
    const schedule = () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(write, MAIN_LAYOUT_SAVE_DELAY_MS);
    };
    // A change still waiting out the delay is written as the window goes away
    // (quit, close, reload) rather than dropped. The settings write is an IPC
    // send, so it leaves before the page does; a process killed outright can
    // still lose the last change inside the delay.
    const flush = () => {
      if (timer === null) return;
      clearTimeout(timer);
      write();
    };
    const offChange = subscribeMainLayoutChange(schedule);
    const offLocations = subscribeWebSurfaceLocations(schedule);
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      if (timer !== null) clearTimeout(timer);
      offChange();
      offLocations();
    };
  }, [settled, api]);

  // The window's own layout state changing is a change to save.
  useEffect(() => {
    if (settled) emitMainLayoutChange();
  }, [settled, chatGroups.tree, chatGroups.focusedId, chatGroups.panelOpenIds, chatGroups.thumbnailOpenIds, chatGroups.contentById, mainSurfaces.surfaces]);
}
