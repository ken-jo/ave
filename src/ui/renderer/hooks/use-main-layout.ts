import { useEffect, useRef, useState } from "react";
import type { AveApi } from "../types.js";
import { parseMainLayout, type MainLayoutSnapshot, type SavedSurface } from "../../../shared/main-layout.js";
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

/** How long the layout must hold still before it is written. */
export const MAIN_LAYOUT_SAVE_DELAY_MS = 300;

interface ChatGroupsForLayout {
  tree: PaneNode;
  focusedId: string;
  panelOpenIds: readonly string[];
  contentById: Readonly<Record<string, ViewLocation>>;
  restore: (layout: {
    tree: PaneNode;
    focusedId: string;
    panelOpenIds: readonly string[];
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
  const all: SavedSurface[] = [...Object.values(layout.surfaces), ...Object.values(layout.sideTabs).flat()];
  reserveTabIds(all.map((surface) => surface.tabId));
  stageRestoredLayout({ sideTabs: layout.sideTabs, terminals: all.filter((surface) => surface.kind === "terminal") });
  const content: Record<string, ViewLocation> = {};
  for (const [paneId, surface] of Object.entries(layout.surfaces)) {
    mainSurfaces.adopt({ tabId: surface.tabId, kind: surface.kind, ordinal: surface.ordinal, url: surface.url, cwd: surface.cwd });
    content[paneId] = { view: VIEW_OF_SURFACE_KIND[surface.kind], surface: surface.tabId };
  }
  // The saved tree's nodes have the pane tree's shape; the parser checked them.
  chatGroups.restore({ tree: layout.tree as PaneNode, focusedId: layout.focusedId, panelOpenIds: layout.panelOpenIds, content });
  // Panes whose conversation is already mounted (the main one, at least) take
  // their side tabs now; the rest take them when they mount.
  for (const paneId of Object.keys(layout.sideTabs)) {
    const sink = getSideTabsSink(paneId);
    if (!sink) continue;
    for (const tab of takeRestoredSideTabs(paneId)) sink.adopt({ id: tab.tabId, kind: tab.kind, ordinal: tab.ordinal }, tab.url);
  }
}

/**
 * Save the main window's layout as it changes, and put it back at launch
 * (`shared/main-layout.ts` holds the shape and its rules).
 *
 * Restore: the saved value is checked once more here. A refused one is logged
 * with the rule it broke, and the window stays in the default layout.
 * Save: nothing is written until the restore has run, or the first write would
 * replace the saved layout with the default one before it was read. After
 * that, any change is written once the layout holds still. A snapshot that
 * fails its own rules is a bug here; it is reported and not written.
 */
export function useMainLayout(api: AveApi, chatGroups: ChatGroupsForLayout, mainSurfaces: MainSurfacesForLayout): void {
  const [settled, setSettled] = useState(false);
  const chatGroupsRef = useRef(chatGroups);
  chatGroupsRef.current = chatGroups;
  const mainSurfacesRef = useRef(mainSurfaces);
  mainSurfacesRef.current = mainSurfaces;

  useEffect(() => {
    let cancelled = false;
    void api
      .getSettings()
      .then((settings) => {
        if (cancelled) return;
        const raw = (settings?.system as { mainLayout?: unknown } | undefined)?.mainLayout;
        if (raw === undefined) return;
        const parsed = parseMainLayout(raw);
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
  }, [api]);

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
      });
      return snapshot;
    };
    // What the window holds as the restore settles is what is already saved
    // (or the default, which needs no saving): only a change after it is written.
    if (lastWrittenRef.current === null) lastWrittenRef.current = JSON.stringify(current());
    const write = () => {
      timer = null;
      const snapshot = current();
      const checked = parseMainLayout(snapshot);
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
    const offChange = subscribeMainLayoutChange(schedule);
    const offLocations = subscribeWebSurfaceLocations(schedule);
    return () => {
      if (timer !== null) clearTimeout(timer);
      offChange();
      offLocations();
    };
  }, [settled, api]);

  // The window's own layout state changing is a change to save.
  useEffect(() => {
    if (settled) emitMainLayoutChange();
  }, [settled, chatGroups.tree, chatGroups.focusedId, chatGroups.panelOpenIds, chatGroups.contentById, mainSurfaces.surfaces]);
}
