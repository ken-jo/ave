/** Persist geometry and last directories or URLs, never processes or scrollback; reject invalid snapshots whole. */

import { isRecord } from "./is-record.js";
import { parseTabId } from "./tab-id.js";
import { parseBrowserSessionActor, type SessionTabBindingMetadata } from "./browser-surface.js";

/** Version 2 stamps every main surface with its project. Version 1 is refused and the window starts fresh; there is no
 * migration. */
export const MAIN_LAYOUT_VERSION = 2;

export type SavedSurfaceKind = "terminal" | "browser" | "plugin" | "folder";

interface SavedSurfaceCommon {
  /** Keep tab ids stable across launches so terminal identity survives restore. */
  tabId: string;
  ordinal: number;
  /** Main-owned facts, never control authority. Empty means cleared. */
  binding?: SessionTabBindingMetadata;
}

/** A terminal or page. Side tabs are always this kind. */
export interface SavedSurface extends SavedSurfaceCommon {
  kind: "terminal" | "browser";
  /** A terminal's last directory (absolute, POSIX or Windows drive), or null. Always null for a page. */
  cwd: string | null;
  /** A page's last http(s) address, or null. Always null for a terminal. */
  url: string | null;
}

/** An extension screen instance; the tab id is the instance id. The title is the one last shown, for the restore. */
interface SavedPluginSurface extends SavedSurfaceCommon {
  kind: "plugin";
  pluginId: string;
  viewId: string;
  title: string;
}

/** A folder view: the folder it shows and the item selected in it, if any. */
interface SavedFolderSurface extends SavedSurfaceCommon {
  kind: "folder";
  path: string;
  selection: string | null;
}

/** A surface in the main area. It belongs to one project, named by its root. Side tabs take the project of their pane's
 * conversation and do not store one. */
export type SavedMainSurface = (SavedSurface | SavedPluginSurface | SavedFolderSurface) & {
  projectRoot: string;
  /** When the surface was last brought into view (epoch ms), for the sidebar's recency order across launches. Absent for a
   * surface never shown, and in layouts saved before it was kept. */
  usedAt?: number;
};

type AnySavedSurface = SavedSurface | SavedPluginSurface | SavedFolderSurface;

/** Terminals and pages are the surfaces with live processes, guests and session bindings. */
export function isSavedTerminalOrPage<T extends { kind: SavedSurfaceKind }>(surface: T): surface is Extract<T, { kind: "terminal" | "browser" }> {
  return surface.kind === "terminal" || surface.kind === "browser";
}

export type SavedPaneNode =
  | { kind: "leaf"; chatGroupId: string }
  | { kind: "split"; axis: "row" | "column"; children: SavedPaneNode[]; sizes: number[] };

export interface MainLayoutSnapshot {
  version: typeof MAIN_LAYOUT_VERSION;
  tree: SavedPaneNode;
  focusedId: string;
  /** Panes showing a main surface, keyed by pane id. A pane not listed shows its conversation. */
  surfaces: Record<string, SavedMainSurface>;
  panelOpenIds: string[];
  /** Panes whose session thumbnails were open. Older layouts restore them closed. */
  thumbnailOpenIds: string[];
  sideTabs: Record<string, SavedSurface[]>;
  /** Every main surface in sidebar order, shown in a pane or not. */
  openSurfaces: SavedMainSurface[];
}

export type MainLayoutParse = { ok: true; layout: MainLayoutSnapshot } | { ok: false; reason: string };

/** Renderer supplies window-specific pane limits; main checks shape only. */
export interface MainLayoutLimits {
  maxPanes: number;
  primaryPaneId: string;
}

const GROUP_ID = /^(main|group-[1-9]\d*)$/;

/** An absolute path on either host family: POSIX absolute or a Windows drive path. Shape only; whether it exists is not
 * checked here. */
export function isAbsoluteHostPath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}

const PLUGIN_SEGMENT = /^[^:]+$/;
const MAX_TITLE_CHARS = 200;

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

function parseBinding(raw: Record<string, unknown>, path: string, kind: SavedSurfaceKind): SessionTabBindingMetadata | undefined {
  if (raw.binding === undefined) return undefined;
  if (!isRecord(raw.binding) || Object.keys(raw.binding).some((key) => key !== "owner" && key !== "paneSessionId")) refuse(`${path}.binding is invalid`);
  const owner = raw.binding.owner === undefined ? undefined : parseBrowserSessionActor(raw.binding.owner);
  if (owner === null || (owner !== undefined && kind !== "browser")) refuse(`${path}.binding.owner is invalid`);
  const paneSessionId = raw.binding.paneSessionId;
  if (paneSessionId !== undefined && (typeof paneSessionId !== "string" || paneSessionId.length === 0)) refuse(`${path}.binding.paneSessionId is invalid`);
  return { ...(owner === undefined ? {} : { owner }), ...(paneSessionId === undefined ? {} : { paneSessionId: paneSessionId as string }) };
}

function absolutePath(value: unknown, what: string): string {
  if (typeof value !== "string" || !isAbsoluteHostPath(value)) refuse(`${what} must be an absolute path`);
  return value;
}

function parseSurface(raw: unknown, path: string): AnySavedSurface {
  if (!isRecord(raw)) refuse(`${path} is not an object`);
  const { kind, tabId, ordinal } = raw;
  if (kind !== "terminal" && kind !== "browser" && kind !== "plugin" && kind !== "folder") refuse(`${path}.kind ${JSON.stringify(kind)} is not terminal, browser, plugin or folder`);
  if (typeof tabId !== "string" || parseTabId(tabId)?.kind !== kind) refuse(`${path}.tabId ${JSON.stringify(tabId)} is not a ${kind} tab id`);
  if (typeof ordinal !== "number" || !Number.isInteger(ordinal) || ordinal < 1) refuse(`${path}.ordinal must be a positive integer`);
  const binding = parseBinding(raw, path, kind);
  const common = { tabId: tabId as string, ordinal, ...(binding === undefined ? {} : { binding }) };
  if (kind === "plugin") {
    const { pluginId, viewId, title } = raw;
    if (typeof pluginId !== "string" || !PLUGIN_SEGMENT.test(pluginId)) refuse(`${path}.pluginId must be a colon-free name`);
    if (typeof viewId !== "string" || !PLUGIN_SEGMENT.test(viewId)) refuse(`${path}.viewId must be a colon-free name`);
    if (typeof title !== "string" || title.trim().length === 0 || title.length > MAX_TITLE_CHARS) refuse(`${path}.title must be a non-empty name of at most ${MAX_TITLE_CHARS} characters`);
    return { kind, ...common, pluginId, viewId, title };
  }
  if (kind === "folder") {
    const folder = absolutePath(raw.path, `${path}.path`);
    const selection = raw.selection === null ? null : absolutePath(raw.selection, `${path}.selection`);
    return { kind, ...common, path: folder, selection };
  }
  const { cwd, url } = raw;
  if (cwd !== null && (kind !== "terminal" || typeof cwd !== "string" || !isAbsoluteHostPath(cwd))) refuse(`${path}.cwd must be null or a terminal's absolute path`);
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
  return { kind, ...common, cwd: cwd as string | null, url: url as string | null };
}

function parseMainSurface(raw: unknown, path: string): SavedMainSurface {
  const surface = parseSurface(raw, path);
  // The parse above proved `raw` is an object.
  const record = raw as Record<string, unknown>;
  const projectRoot = absolutePath(record.projectRoot, `${path}.projectRoot`);
  const { usedAt } = record;
  if (usedAt === undefined) return { ...surface, projectRoot };
  if (typeof usedAt !== "number" || !Number.isSafeInteger(usedAt) || usedAt < 0) refuse(`${path}.usedAt must be a time in milliseconds`);
  return { ...surface, projectRoot, usedAt };
}

function parseSideTab(raw: unknown, path: string): SavedSurface {
  const surface = parseSurface(raw, path);
  if (surface.kind !== "terminal" && surface.kind !== "browser") refuse(`${path}.kind ${JSON.stringify(surface.kind)} is not terminal or browser`);
  if ((raw as Record<string, unknown>).projectRoot !== undefined) refuse(`${path}.projectRoot is not stored: a side tab belongs to its pane's conversation`);
  return surface;
}

/** Without limits validate shape only; any failed rule rejects the whole layout, naming the path and the rule it broke. */
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
    const claim = (surface: AnySavedSurface, path: string) => {
      if (tabIds.has(surface.tabId)) refuse(`${path}.tabId ${surface.tabId} is used twice`);
      tabIds.add(surface.tabId);
    };
    if (!isRecord(raw.surfaces)) refuse("surfaces is not an object");
    const surfaces: Record<string, SavedMainSurface> = {};
    for (const [paneId, value] of Object.entries(raw.surfaces)) {
      inTree(paneId, "surfaces");
      const surface = parseMainSurface(value, `surfaces.${paneId}`);
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
        const surface = parseSideTab(each, `sideTabs.${paneId}[${index}]`);
        claim(surface, `sideTabs.${paneId}[${index}]`);
        return surface;
      });
    }
    if (!Array.isArray(raw.openSurfaces)) refuse("openSurfaces is not a list");
    const openSurfaces: SavedMainSurface[] = [];
    const shown = new Map(Object.values(surfaces).map((surface) => [surface.tabId, surface]));
    for (const [index, each] of raw.openSurfaces.entries()) {
      const path = `openSurfaces[${index}]`;
      const surface = parseMainSurface(each, path);
      // A shown surface is listed here too, as the same tab in the same project; no tab is listed twice or is also a side tab.
      const pane = shown.get(surface.tabId);
      if (pane && pane.kind !== surface.kind) refuse(`${path}.tabId ${surface.tabId} is shown as a ${pane.kind}, not a ${surface.kind}`);
      if (pane && pane.projectRoot !== surface.projectRoot) refuse(`${path}.projectRoot differs from the pane showing ${surface.tabId}`);
      if (!pane && tabIds.has(surface.tabId)) refuse(`${path}.tabId ${surface.tabId} is also a side tab`);
      if (openSurfaces.some((listed) => listed.tabId === surface.tabId)) refuse(`${path}.tabId ${surface.tabId} is listed twice`);
      openSurfaces.push(surface);
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
        openSurfaces,
      },
    };
  } catch (err) {
    if (err instanceof Refused) return { ok: false, reason: err.message };
    throw err;
  }
}
