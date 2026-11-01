/** Persist geometry and last directories or URLs, never processes or scrollback; reject invalid snapshots whole. */

import { isRecord } from "./is-record.js";
import { parseTabId } from "./tab-id.js";
import { parseBrowserSessionActor, type SessionTabBindingMetadata } from "./browser-surface.js";

export const MAIN_LAYOUT_VERSION = 1;

export type SavedSurfaceKind = "terminal" | "browser";

export interface SavedSurface {
  kind: SavedSurfaceKind;
  /** Keep tab ids stable across launches so terminal identity survives restore. */
  tabId: string;
  ordinal: number;
  /** A terminal's last directory (absolute, POSIX or Windows drive), or null. Always null for a page. */
  cwd: string | null;
  /** A page's last http(s) address, or null. Always null for a terminal. */
  url: string | null;
  /** Main-owned facts, never control authority. Empty means cleared; absence is the legacy format. */
  binding?: SessionTabBindingMetadata;
}

export type SavedPaneNode =
  | { kind: "leaf"; chatGroupId: string }
  | { kind: "split"; axis: "row" | "column"; children: SavedPaneNode[]; sizes: number[] };

export interface MainLayoutSnapshot {
  version: typeof MAIN_LAYOUT_VERSION;
  tree: SavedPaneNode;
  focusedId: string;
  /** Panes showing a terminal or page, keyed by pane id. A pane not listed shows its conversation. */
  surfaces: Record<string, SavedSurface>;
  panelOpenIds: string[];
  /** Panes whose session thumbnails were open. Older layouts restore them closed. */
  thumbnailOpenIds: string[];
  sideTabs: Record<string, SavedSurface[]>;
  /** Every first-class terminal and page in sidebar order, shown in a pane or not. Absent in older layouts, which kept only
   * the shown ones. */
  openSurfaces?: SavedSurface[];
}

export type MainLayoutParse = { ok: true; layout: MainLayoutSnapshot } | { ok: false; reason: string };

/** Renderer supplies window-specific pane limits; main checks shape only. */
export interface MainLayoutLimits {
  maxPanes: number;
  primaryPaneId: string;
}

const GROUP_ID = /^(main|group-[1-9]\d*)$/;

/** A directory a restored shell can start in: POSIX absolute or a Windows drive path. */
export function isAbsoluteTerminalCwd(cwd: string): boolean {
  return cwd.startsWith("/") || /^[A-Za-z]:[\\/]/.test(cwd);
}

class Refused extends Error {}

function refuse(reason: string): never {
  throw new Refused(reason);
}

function parseTree(raw: unknown, path: string, leaves: string[]): SavedPaneNode {
  if (!isRecord(raw)) refuse(`${path} is not an object`);
  if (raw.kind === "leaf") {
    const id = raw.chatGroupId;
    if (typeof id !== "string" || !GROUP_ID.test(id)) refuse(`${path}.chatGroupId ${JSON.stringify(id)} is not a pane id`);
    if (leaves.includes(id)) refuse(`pane ${id} appears twice in the tree`);
    leaves.push(id);
    return { kind: "leaf", chatGroupId: id };
  }
  if (raw.kind !== "split") refuse(`${path}.kind ${JSON.stringify(raw.kind)} is neither leaf nor split`);
  const { axis, children, sizes } = raw;
  if (axis !== "row" && axis !== "column") refuse(`${path}.axis ${JSON.stringify(axis)} is not row or column`);
  if (!Array.isArray(children) || children.length < 2) refuse(`${path}.children must hold at least two panes`);
  if (!Array.isArray(sizes) || sizes.length !== children.length) refuse(`${path}.sizes must have one size per child`);
  if (!sizes.every((size) => typeof size === "number" && Number.isFinite(size) && size > 0)) refuse(`${path}.sizes must be positive numbers`);
  const total = (sizes as number[]).reduce((sum, size) => sum + size, 0);
  if (Math.abs(total - 1) > 1e-3) refuse(`${path}.sizes sum to ${total}, not 1`);
  return {
    kind: "split",
    axis,
    children: children.map((child, index) => parseTree(child, `${path}.children[${index}]`, leaves)),
    sizes: [...(sizes as number[])],
  };
}

function parseSurface(raw: unknown, path: string): SavedSurface {
  if (!isRecord(raw)) refuse(`${path} is not an object`);
  const { kind, tabId, ordinal, cwd, url } = raw;
  if (kind !== "terminal" && kind !== "browser") refuse(`${path}.kind ${JSON.stringify(kind)} is not terminal or browser`);
  if (typeof tabId !== "string" || parseTabId(tabId)?.kind !== kind) refuse(`${path}.tabId ${JSON.stringify(tabId)} is not a ${kind} tab id`);
  if (typeof ordinal !== "number" || !Number.isInteger(ordinal) || ordinal < 1) refuse(`${path}.ordinal must be a positive integer`);
  if (cwd !== null && (kind !== "terminal" || typeof cwd !== "string" || !isAbsoluteTerminalCwd(cwd))) refuse(`${path}.cwd must be null or a terminal's absolute path`);
  if (url !== null) {
    if (kind !== "browser" || typeof url !== "string") refuse(`${path}.url must be null or a page's address`);
    let protocol: string;
    try {
      protocol = new URL(url).protocol;
    } catch {
      refuse(`${path}.url ${JSON.stringify(url)} is not a URL`);
    }
    if (protocol !== "http:" && protocol !== "https:") refuse(`${path}.url must be http or https`);
  }
  let binding: SessionTabBindingMetadata | undefined;
  if (raw.binding !== undefined) {
    if (!isRecord(raw.binding) || Object.keys(raw.binding).some((key) => key !== "owner" && key !== "paneSessionId")) refuse(`${path}.binding is invalid`);
    const owner = raw.binding.owner === undefined ? undefined : parseBrowserSessionActor(raw.binding.owner);
    if (owner === null || (owner !== undefined && kind !== "browser")) refuse(`${path}.binding.owner is invalid`);
    const paneSessionId = raw.binding.paneSessionId;
    if (paneSessionId !== undefined && (typeof paneSessionId !== "string" || paneSessionId.length === 0)) refuse(`${path}.binding.paneSessionId is invalid`);
    binding = { ...(owner === undefined ? {} : { owner }), ...(paneSessionId === undefined ? {} : { paneSessionId: paneSessionId as string }) };
  }
  return { kind, tabId: tabId as string, ordinal, cwd: cwd as string | null, url: url as string | null, ...(binding === undefined ? {} : { binding }) };
}

/** Without limits validate shape only; any failed rule rejects the whole layout, except a bad `openSurfaces` entry, which is
 * dropped so one stale tab cannot cost every other tab. */
export function parseMainLayout(raw: unknown, limits?: MainLayoutLimits): MainLayoutParse {
  try {
    if (!isRecord(raw)) refuse("the layout is not an object");
    if (raw.version !== MAIN_LAYOUT_VERSION) refuse(`version ${JSON.stringify(raw.version)} is not ${MAIN_LAYOUT_VERSION}`);
    const leaves: string[] = [];
    const tree = parseTree(raw.tree, "tree", leaves);
    if (limits && leaves.length > limits.maxPanes) refuse(`the tree has ${leaves.length} panes, more than ${limits.maxPanes}`);
    if (limits && !leaves.includes(limits.primaryPaneId)) refuse(`the tree has no ${limits.primaryPaneId} pane`);
    const inTree = (id: string, what: string) => {
      if (!leaves.includes(id)) refuse(`${what} names pane ${JSON.stringify(id)}, which is not in the tree`);
    };
    if (typeof raw.focusedId !== "string") refuse("focusedId is not a string");
    inTree(raw.focusedId, "focusedId");

    const tabIds = new Set<string>();
    const claim = (surface: SavedSurface, path: string) => {
      if (tabIds.has(surface.tabId)) refuse(`${path}.tabId ${surface.tabId} is used twice`);
      tabIds.add(surface.tabId);
    };
    if (!isRecord(raw.surfaces)) refuse("surfaces is not an object");
    const surfaces: Record<string, SavedSurface> = {};
    for (const [paneId, value] of Object.entries(raw.surfaces)) {
      inTree(paneId, "surfaces");
      const surface = parseSurface(value, `surfaces.${paneId}`);
      claim(surface, `surfaces.${paneId}`);
      surfaces[paneId] = surface;
    }
    if (!Array.isArray(raw.panelOpenIds) || !raw.panelOpenIds.every((id) => typeof id === "string")) refuse("panelOpenIds is not a list of pane ids");
    for (const id of raw.panelOpenIds as string[]) inTree(id, "panelOpenIds");
    const thumbnailOpenIds = raw.thumbnailOpenIds === undefined ? [] : raw.thumbnailOpenIds;
    if (!Array.isArray(thumbnailOpenIds) || !thumbnailOpenIds.every((id) => typeof id === "string")) refuse("thumbnailOpenIds is not a list of pane ids");
    for (const id of thumbnailOpenIds as string[]) inTree(id, "thumbnailOpenIds");
    if (!isRecord(raw.sideTabs)) refuse("sideTabs is not an object");
    const sideTabs: Record<string, SavedSurface[]> = {};
    for (const [paneId, value] of Object.entries(raw.sideTabs)) {
      inTree(paneId, "sideTabs");
      if (!Array.isArray(value)) refuse(`sideTabs.${paneId} is not a list`);
      sideTabs[paneId] = value.map((each, index) => {
        const surface = parseSurface(each, `sideTabs.${paneId}[${index}]`);
        claim(surface, `sideTabs.${paneId}[${index}]`);
        return surface;
      });
    }
    let openSurfaces: SavedSurface[] | undefined;
    if (raw.openSurfaces !== undefined) {
      if (!Array.isArray(raw.openSurfaces)) refuse("openSurfaces is not a list");
      openSurfaces = [];
      const shown = new Map(Object.values(surfaces).map((surface) => [surface.tabId, surface]));
      for (const [index, each] of raw.openSurfaces.entries()) {
        let surface: SavedSurface;
        try {
          surface = parseSurface(each, `openSurfaces[${index}]`);
        } catch (err) {
          if (err instanceof Refused) continue;
          throw err;
        }
        // A shown surface is listed here too; it must be the same tab, and no tab is listed twice or also a side tab.
        const pane = shown.get(surface.tabId);
        if (pane ? pane.kind !== surface.kind : tabIds.has(surface.tabId)) continue;
        if (openSurfaces.some((listed) => listed.tabId === surface.tabId)) continue;
        openSurfaces.push(surface);
      }
    }
    return {
      ok: true,
      layout: {
        version: MAIN_LAYOUT_VERSION,
        tree,
        focusedId: raw.focusedId,
        surfaces,
        panelOpenIds: [...new Set(raw.panelOpenIds as string[])],
        thumbnailOpenIds: [...new Set(thumbnailOpenIds as string[])],
        sideTabs,
        ...(openSurfaces === undefined ? {} : { openSurfaces }),
      },
    };
  } catch (err) {
    if (err instanceof Refused) return { ok: false, reason: err.message };
    throw err;
  }
}
