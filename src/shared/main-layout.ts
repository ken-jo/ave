/**
 * The main window's saved layout — what comes back on the next launch.
 *
 * It holds the pane tree (geometry), which panes show a terminal or web page,
 * which panes had their side panel open, and each pane's terminal and browser
 * side tabs. Each terminal records the directory its shell last reported, and
 * each page its last address. It does NOT hold a terminal's process or
 * scrollback: those end with the app, so a restored terminal is a new shell
 * started in the saved directory, and it says so in its buffer.
 *
 * Both processes call ONE parser. Main checks the value's SHAPE when it is
 * stored or read back; the renderer checks it again with the window's limits
 * (the pane ceiling and the primary pane id, which live in the app contract)
 * before acting on it — the same split as `system.activeView`, whose stored
 * key main checks structurally and the renderer re-checks against what it
 * loaded. Keeping the contract out of this module keeps it out of the
 * settings store's import graph. A snapshot that
 * fails any rule is refused whole with a reason, and the window starts in the
 * default layout. A half-applied layout would point panes at surfaces that do
 * not exist.
 */

import { isRecord } from "./is-record.js";
import { parseTabId } from "./tab-id.js";

export const MAIN_LAYOUT_VERSION = 1;

export type SavedSurfaceKind = "terminal" | "browser";

export interface SavedSurface {
  kind: SavedSurfaceKind;
  /** The tab id ("terminal:3fa91c0e-2", `shared/tab-id.ts`) — kept, so AVE_TERMINAL_ID is stable across launches. */
  tabId: string;
  /** "Terminal 3" — the number in the tab's name. */
  ordinal: number;
  /** A terminal's last directory (absolute), or null. Always null for a page. */
  cwd: string | null;
  /** A page's last http(s) address, or null. Always null for a terminal. */
  url: string | null;
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
  /** Panes whose side panel was open. */
  panelOpenIds: string[];
  /** Each pane's terminal and browser side tabs, in tab order. */
  sideTabs: Record<string, SavedSurface[]>;
}

export type MainLayoutParse = { ok: true; layout: MainLayoutSnapshot } | { ok: false; reason: string };

/** What only the window knows: how many panes it holds and which one is primary. */
export interface MainLayoutLimits {
  maxPanes: number;
  primaryPaneId: string;
}

const GROUP_ID = /^(main|group-[1-9]\d*)$/;

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
  if (cwd !== null && (kind !== "terminal" || typeof cwd !== "string" || !cwd.startsWith("/"))) refuse(`${path}.cwd must be null or a terminal's absolute path`);
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
  return { kind, tabId: tabId as string, ordinal, cwd: cwd as string | null, url: url as string | null };
}

/**
 * Check a stored layout. Every rule is all-or-nothing; the reason names the
 * first broken one. Without `limits` only the shape is checked.
 */
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
    return {
      ok: true,
      layout: {
        version: MAIN_LAYOUT_VERSION,
        tree,
        focusedId: raw.focusedId,
        surfaces,
        panelOpenIds: [...new Set(raw.panelOpenIds as string[])],
        sideTabs,
      },
    };
  } catch (err) {
    if (err instanceof Refused) return { ok: false, reason: err.message };
    throw err;
  }
}
