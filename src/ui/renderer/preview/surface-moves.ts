import { createContext, useContext } from "react";
import type { DropTarget } from "../components/pane-drop.js";
import type { WorkspaceTab } from "./workspace-tabs.js";
import type { SavedSurface } from "../../../shared/main-layout.js";

/** Move store records and pane selection in one event so reconciliation sees the tab live throughout; never move its PTY or
 * guest. */
export type MovableTabKind = "terminal" | "browser";

export function isMovableTabKind(kind: WorkspaceTab["kind"]): kind is MovableTabKind {
  return kind === "terminal" || kind === "browser";
}

/** Where a dragged surface comes from. */
type SurfaceOrigin = { side: string } | { pane: string };

export interface SurfaceDragPayload {
  tabId: string;
  kind: MovableTabKind;
  from: SurfaceOrigin;
}

/** The drag type a dragged terminal or web surface carries. */
export const SURFACE_DRAG_TYPE = "application/x-ave-surface";

export function encodeSurfaceDrag(payload: SurfaceDragPayload): string {
  return JSON.stringify(payload);
}

/** Parse a dropped payload; anything malformed is not a surface drag. */
export function decodeSurfaceDrag(raw: string): SurfaceDragPayload | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { tabId, kind, from } = value as Record<string, unknown>;
  if (typeof tabId !== "string" || (kind !== "terminal" && kind !== "browser")) return null;
  if (typeof from !== "object" || from === null) return null;
  const origin = from as Record<string, unknown>;
  if (typeof origin.side === "string") return { tabId, kind, from: { side: origin.side } };
  if (typeof origin.pane === "string") return { tabId, kind, from: { pane: origin.pane } };
  return null;
}

/** A group's side-panel tab store, as the main area reaches it. */
export interface SideTabsSink {
  adopt: (tab: Pick<WorkspaceTab, "id" | "kind" | "ordinal">, url: string | null) => void;
  release: (tabId: string) => WorkspaceTab | undefined;
  /** Open the group's side panel so an adopted tab is seen. */
  open: () => void;
  /** Show `tabId` when this group holds it: select it and open the panel. */
  activate: (tabId: string) => boolean;
  /** This group's terminal and browser tabs, as a saved layout records them. */
  snapshot: () => SavedSurface[];
  /** The selected tab when the panel is visible; absent for sinks without a rendered panel. */
  visibleTabId?: () => string | null;
}

const sinks = new Map<string, SideTabsSink>();

export function registerSideTabsSink(chatGroupId: string, sink: SideTabsSink): () => void {
  sinks.set(chatGroupId, sink);
  return () => {
    if (sinks.get(chatGroupId) === sink) sinks.delete(chatGroupId);
  };
}

export function getSideTabsSink(chatGroupId: string): SideTabsSink | undefined {
  return sinks.get(chatGroupId);
}

/** Select `tabId` in whichever group's side panel holds it; that group's id, or null. */
export function activateSideTab(tabId: string): string | null {
  for (const [chatGroupId, sink] of sinks) if (sink.activate(tabId)) return chatGroupId;
  return null;
}

/** What the window offers the side panels for moving their tabs out. */
export interface SurfaceMoves {
  /** Move a side tab of `fromGroupId` into the main area: into `drop`'s pane (centre) or a new pane on its edge, or — with no
   * drop — a new pane beside the group's own, else the group's own pane. */
  tabToMain: (fromGroupId: string, tabId: string, drop?: { paneId: string; target: DropTarget }) => void;
  /** Move the surface a pane shows into `toGroupId`'s side panel (default: the pane's own group). */
  paneToSide: (paneId: string, toGroupId?: string) => void;
  /** Bring a live surface from any pane or side panel into this group's work panel. */
  tabToSide: (tabId: string, toGroupId: string) => void;
}

export const SurfaceMovesContext = createContext<SurfaceMoves | null>(null);

export function useSurfaceMoves(): SurfaceMoves | null {
  return useContext(SurfaceMovesContext);
}
