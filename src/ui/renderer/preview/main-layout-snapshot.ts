import { isAbsoluteHostPath, MAIN_LAYOUT_VERSION, type MainLayoutSnapshot, type SavedMainSurface, type SavedPaneNode, type SavedSurface } from "../../../shared/main-layout.js";
import type { PaneNode } from "../components/pane-tree.js";
import { isInsideRoot } from "../utils/project-path.js";
import { leafIds } from "../components/pane-tree.js";
import type { ViewLocation } from "../utils/view-location.js";

/** Build the saved layout from what the window holds now — the pure half of saving, so what gets written is testable
 * without rendering a window. */

/** One terminal or page as saved. Only what the restore can use: an absolute directory, and an http(s) address (a blank
 * page or a data: url has nowhere to go back to). */
export function savedSurfaceOf(
  surface: { tabId: string; kind: SavedSurface["kind"]; ordinal: number },
  cwd: string | null,
  url: string | null,
): SavedSurface {
  const keepUrl = surface.kind === "browser" && url !== null && /^https?:\/\//i.test(url) ? url : null;
  const keepCwd = surface.kind === "terminal" && cwd !== null && isAbsoluteHostPath(cwd) ? cwd : null;
  return { kind: surface.kind, tabId: surface.tabId, ordinal: surface.ordinal, cwd: keepCwd, url: keepUrl };
}

/** Whether `path` is the project root or below it (`utils/project-path.ts`: NFC on both sides, no `..` segment). */
function insideProject(projectRoot: string, path: string): boolean {
  return isAbsoluteHostPath(path) && isInsideRoot(projectRoot, path);
}

/** A folder view as saved: the folder it shows and the selected item, or its project root before the view has reported. A
 * location outside the project (however it got there) is not written: the folder falls back to the root, the selection to
 * none. */
export function savedFolderOf(surface: { tabId: string; ordinal: number; projectRoot: string; folder?: { path: string; selection: string | null } }): SavedMainSurface {
  const path = surface.folder && insideProject(surface.projectRoot, surface.folder.path) ? surface.folder.path : surface.projectRoot;
  const selection = surface.folder?.selection && insideProject(surface.projectRoot, surface.folder.selection) ? surface.folder.selection : null;
  return { kind: "folder", tabId: surface.tabId, ordinal: surface.ordinal, path, selection, projectRoot: surface.projectRoot };
}

function savedTree(node: PaneNode): SavedPaneNode {
  return node.kind === "leaf"
    ? { kind: "leaf", chatGroupId: node.chatGroupId }
    : { kind: "split", axis: node.axis, children: node.children.map(savedTree), sizes: [...node.sizes] };
}

export function buildMainLayoutSnapshot(input: {
  tree: PaneNode;
  focusedId: string;
  panelOpenIds: readonly string[];
  thumbnailOpenIds: readonly string[];
  contentById: Readonly<Record<string, ViewLocation>>;
  /** The main-area surface a pane shows, by its tab id, stamped with its project. */
  surfaceOf: (tabId: string) => SavedMainSurface | null;
  /** A pane's terminal and browser side tabs. */
  sideTabsOf: (paneId: string) => SavedSurface[];
  /** Every first-class surface's tab id in sidebar order, including those no pane shows. */
  openSurfaceIds: readonly string[];
}): MainLayoutSnapshot {
  const panes = leafIds(input.tree);
  const surfaces: Record<string, SavedMainSurface> = {};
  const sideTabs: Record<string, SavedSurface[]> = {};
  for (const paneId of panes) {
    const tabId = input.contentById[paneId]?.surface;
    const surface = tabId ? input.surfaceOf(tabId) : null;
    if (surface) surfaces[paneId] = surface;
    const tabs = input.sideTabsOf(paneId);
    if (tabs.length > 0) sideTabs[paneId] = tabs;
  }
  return {
    version: MAIN_LAYOUT_VERSION,
    tree: savedTree(input.tree),
    focusedId: input.focusedId,
    surfaces,
    panelOpenIds: input.panelOpenIds.filter((id) => panes.includes(id)),
    thumbnailOpenIds: input.thumbnailOpenIds.filter((id) => panes.includes(id)),
    sideTabs,
    openSurfaces: input.openSurfaceIds.flatMap((tabId) => input.surfaceOf(tabId) ?? []),
  };
}
