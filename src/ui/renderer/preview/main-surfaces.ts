import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { InstanceViewKey } from "../../../shared/view-key.js";
import { mintTabId } from "./workspace-tabs.js";
import { terminalOrdinal } from "./terminal-ordinal.js";
import { publishLiveWebTabs, webSurfaceLocation, withdrawLiveWebTabs } from "./web-surfaces.js";

/** Move surface records between stores without moving tab-id-keyed PTYs or guests; pane content independently chooses which
 * surface is shown. */
export type MainSurfaceKind = "terminal" | "browser" | "folder";

export interface MainSurface {
  tabId: string;
  kind: MainSurfaceKind;
  /** "Terminal 3" — kept when the surface moves in from a side panel. */
  ordinal: number;
  /** A browser surface's host-set url; null for a terminal or a blank page. */
  url: string | null;
  /** A terminal's working directory: where the shell last said it was, or — before it has said — where a reopened one is to
   * start. Null when unknown. */
  cwd?: string | null;
  /** The project the surface belongs to, by its root. Every main surface has one; the saved layout keeps it. A folder view
   * lists it as its first column. */
  projectRoot: string;
  /** A folder view's open folder and the item selected in it, as last reported by the view; the saved layout keeps it. */
  folder?: FolderLocation;
}

/** Where a folder view is: the deepest open folder and the selected item in it, if any. */
export interface FolderLocation {
  path: string;
  selection: string | null;
}

/** Terminal and web surfaces: the ones that move to a side panel and stand as an agent tool surface. A folder view is
 * neither; it is a user's view of the project. */
export type ToolMainSurface = MainSurface & { kind: "terminal" | "browser" };

export function isToolMainSurface(surface: MainSurface): surface is ToolMainSurface {
  return surface.kind === "terminal" || surface.kind === "browser";
}

/** What reopening a closed surface brings back: its kind and where it was. */
interface ClosedSurface {
  kind: MainSurfaceKind;
  url: string | null;
  /** A terminal's last directory; its replacement starts there. */
  cwd: string | null;
  /** The project it belonged to; its replacement opens there. */
  projectRoot: string;
}

/** Where a new surface opens and what it starts on. */
interface NewSurfaceOptions {
  url?: string | null;
  cwd?: string | null;
  projectRoot: string;
}

/** How many closed surfaces "reopen closed" remembers. */
const CLOSED_SURFACE_MEMORY = 10;

export const SURFACE_KIND_OF_VIEW: Record<InstanceViewKey, MainSurfaceKind> = {
  terminal: "terminal",
  web: "browser",
  folder: "folder",
};

export const VIEW_OF_SURFACE_KIND: Record<MainSurfaceKind, InstanceViewKey> = {
  terminal: "terminal",
  browser: "web",
  folder: "folder",
};

let nextMainBrowserOrdinal = 1;
let nextMainFolderOrdinal = 1;

export interface MainSurfacesStore {
  surfaces: readonly MainSurface[];
  get: (tabId: string) => MainSurface | undefined;
  /** A new surface of `kind`; returned synchronously so the caller can show it. */
  create: (kind: MainSurfaceKind, options: NewSurfaceOptions) => MainSurface;
  /** Take in a surface that moved here from a side panel. */
  adopt: (surface: MainSurface) => void;
  /** Hand a surface out (moving to a side panel) — it is not destroyed. */
  release: (tabId: string) => MainSurface | undefined;
  /** Close a surface: forget it and remember it for "reopen closed". */
  close: (tabId: string) => MainSurface | undefined;
  /** The most recently closed surface, removed from the memory. */
  takeLastClosed: () => ClosedSurface | undefined;
  setUrl: (tabId: string, url: string) => void;
  setCwd: (tabId: string, cwd: string) => void;
  /** The surface belongs to another project from now on (다른 프로젝트로 이동). Throws for a surface that is not here. */
  setProjectRoot: (tabId: string, projectRoot: string) => void;
  setFolderLocation: (tabId: string, location: FolderLocation) => void;
}

export function useMainSurfaces(): MainSurfacesStore {
  const [surfaces, setSurfaces] = useState<readonly MainSurface[]>([]);
  // Mirrors the committed list so a call in the same event as a create (the create returns before React re-renders) still
  // finds what it made.
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

  const create = useCallback((kind: MainSurfaceKind, { url = null, cwd = null, projectRoot }: NewSurfaceOptions) => {
    const tabId = mintTabId(kind);
    const ordinal = kind === "terminal" ? terminalOrdinal(tabId) : kind === "folder" ? nextMainFolderOrdinal++ : nextMainBrowserOrdinal++;
    const surface: MainSurface = { tabId, kind, ordinal, url, cwd, projectRoot };
    commit([...surfacesRef.current, surface]);
    return surface;
  }, [commit]);

  const adopt = useCallback((surface: MainSurface) => {
    if (surfacesRef.current.some((each) => each.tabId === surface.tabId)) return;
    // A moved tab keeps its number; colliding restored terminal labels are reassigned.
    if (surface.kind === "browser" && nextMainBrowserOrdinal <= surface.ordinal) nextMainBrowserOrdinal = surface.ordinal + 1;
    if (surface.kind === "folder" && nextMainFolderOrdinal <= surface.ordinal) nextMainFolderOrdinal = surface.ordinal + 1;
    commit([...surfacesRef.current, surface.kind === "terminal" ? { ...surface, ordinal: terminalOrdinal(surface.tabId, surface.ordinal) } : surface]);
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
      // Where the page actually was (links and in-page routes move it without the address row), not where it was first pointed.
      const url = surface.kind === "browser" ? webSurfaceLocation(tabId) ?? surface.url : surface.url;
      closedRef.current = [{ kind: surface.kind, url, cwd: surface.cwd ?? null, projectRoot: surface.projectRoot }, ...closedRef.current].slice(0, CLOSED_SURFACE_MEMORY);
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

  const setCwd = useCallback((tabId: string, cwd: string) => {
    const current = surfacesRef.current;
    if (!current.some((each) => each.tabId === tabId && each.cwd !== cwd)) return;
    commit(current.map((each) => (each.tabId === tabId ? { ...each, cwd } : each)));
  }, [commit]);

  const setProjectRoot = useCallback((tabId: string, projectRoot: string) => {
    const current = surfacesRef.current;
    if (!current.some((each) => each.tabId === tabId)) throw new Error(`surface-unknown: ${tabId} is not in the main area`);
    commit(current.map((each) => (each.tabId === tabId ? { ...each, projectRoot } : each)));
  }, [commit]);

  const setFolderLocation = useCallback((tabId: string, location: FolderLocation) => {
    const current = surfacesRef.current;
    if (!current.some((each) => each.tabId === tabId && each.kind === "folder"
      && (each.folder?.path !== location.path || each.folder?.selection !== location.selection))) return;
    commit(current.map((each) => (each.tabId === tabId ? { ...each, folder: location } : each)));
  }, [commit]);

  return useMemo(
    () => ({ surfaces, get, create, adopt, release, close, takeLastClosed, setUrl, setCwd, setProjectRoot, setFolderLocation }),
    [surfaces, get, create, adopt, release, close, takeLastClosed, setUrl, setCwd, setProjectRoot, setFolderLocation],
  );
}
