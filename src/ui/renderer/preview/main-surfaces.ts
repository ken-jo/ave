import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { InstanceViewKey } from "../../../shared/view-key.js";
import { mintTabId } from "./workspace-tabs.js";
import { publishLiveWebTabs, withdrawLiveWebTabs } from "./web-surfaces.js";

/**
 * The terminals and web pages that live in the MAIN area, as panes — the
 * window-level counterpart of a side panel's tab store.
 *
 * A surface is the same thing wherever it sits: a terminal tab is a PTY keyed
 * by its tab id, a browser tab is a guest in the web-surface layer keyed by its
 * tab id. Moving one between a side panel and a pane moves its RECORD between
 * this store and that group's tab store; the PTY and the guest stay where they
 * are. Which pane shows a surface is the pane's content (`ViewLocation`), not
 * this store's business.
 */
export type MainSurfaceKind = "terminal" | "browser";

export interface MainSurface {
  tabId: string;
  kind: MainSurfaceKind;
  /** "Terminal 3" — kept when the surface moves in from a side panel. */
  ordinal: number;
  /** A browser surface's host-set url; null for a terminal or a blank page. */
  url: string | null;
}

/** What reopening a closed surface brings back: its kind and where it was. */
export interface ClosedSurface {
  kind: MainSurfaceKind;
  url: string | null;
}

/** How many closed surfaces "reopen closed" remembers. */
export const CLOSED_SURFACE_MEMORY = 10;

export const SURFACE_KIND_OF_VIEW: Record<InstanceViewKey, MainSurfaceKind> = {
  terminal: "terminal",
  web: "browser",
};

export const VIEW_OF_SURFACE_KIND: Record<MainSurfaceKind, InstanceViewKey> = {
  terminal: "terminal",
  browser: "web",
};

// Window-wide, like tab ids: two main terminals never share a label.
const nextMainOrdinal: Record<MainSurfaceKind, number> = { terminal: 1, browser: 1 };

export interface MainSurfacesStore {
  surfaces: readonly MainSurface[];
  get: (tabId: string) => MainSurface | undefined;
  /** A new surface of `kind`; returned synchronously so the caller can show it. */
  create: (kind: MainSurfaceKind, url?: string | null) => MainSurface;
  /** Take in a surface that moved here from a side panel. */
  adopt: (surface: MainSurface) => void;
  /** Hand a surface out (moving to a side panel) — it is not destroyed. */
  release: (tabId: string) => MainSurface | undefined;
  /** Close a surface: forget it and remember it for "reopen closed". */
  close: (tabId: string) => MainSurface | undefined;
  /** The most recently closed surface, removed from the memory. */
  takeLastClosed: () => ClosedSurface | undefined;
  setUrl: (tabId: string, url: string) => void;
}

export function useMainSurfaces(): MainSurfacesStore {
  const [surfaces, setSurfaces] = useState<readonly MainSurface[]>([]);
  // Mirrors the committed list so a call in the same event as a create (the
  // create returns before React re-renders) still finds what it made.
  const surfacesRef = useRef<readonly MainSurface[]>([]);
  const closedRef = useRef<ClosedSurface[]>([]);

  const commit = useCallback((next: readonly MainSurface[]) => {
    surfacesRef.current = next;
    setSurfaces(next);
  }, []);

  const [liveSource] = useState(() => Symbol("main-surfaces"));
  const liveBrowserKey = surfaces.filter((surface) => surface.kind === "browser").map((surface) => surface.tabId).join("\n");
  useEffect(() => {
    publishLiveWebTabs(liveSource, new Set(liveBrowserKey ? liveBrowserKey.split("\n") : []));
  }, [liveSource, liveBrowserKey]);
  useEffect(() => () => withdrawLiveWebTabs(liveSource), [liveSource]);

  const get = useCallback((tabId: string) => surfacesRef.current.find((surface) => surface.tabId === tabId), []);

  const create = useCallback((kind: MainSurfaceKind, url: string | null = null) => {
    const surface: MainSurface = { tabId: mintTabId(kind), kind, ordinal: nextMainOrdinal[kind]++, url };
    commit([...surfacesRef.current, surface]);
    return surface;
  }, [commit]);

  const adopt = useCallback((surface: MainSurface) => {
    if (surfacesRef.current.some((each) => each.tabId === surface.tabId)) return;
    commit([...surfacesRef.current, surface]);
  }, [commit]);

  const release = useCallback((tabId: string) => {
    const surface = surfacesRef.current.find((each) => each.tabId === tabId);
    if (!surface) return undefined;
    commit(surfacesRef.current.filter((each) => each.tabId !== tabId));
    return surface;
  }, [commit]);

  const close = useCallback((tabId: string) => {
    const surface = release(tabId);
    if (surface) {
      closedRef.current = [{ kind: surface.kind, url: surface.url }, ...closedRef.current].slice(0, CLOSED_SURFACE_MEMORY);
    }
    return surface;
  }, [release]);

  const takeLastClosed = useCallback(() => {
    const [last, ...rest] = closedRef.current;
    closedRef.current = rest;
    return last;
  }, []);

  const setUrl = useCallback((tabId: string, url: string) => {
    const current = surfacesRef.current;
    if (!current.some((each) => each.tabId === tabId && each.url !== url)) return;
    commit(current.map((each) => (each.tabId === tabId ? { ...each, url } : each)));
  }, [commit]);

  return useMemo(
    () => ({ surfaces, get, create, adopt, release, close, takeLastClosed, setUrl }),
    [surfaces, get, create, adopt, release, close, takeLastClosed, setUrl],
  );
}
