import type { AttachTextResult } from "../preview/composer-targets.js";
import { createElement, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from "react";
import { cn } from "../../../lib/utils.js";
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ExternalLink,
  FolderPlus,
  Globe,
  RefreshCw,
  RotateCw,
  X,
} from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import { Input } from "../../../components/ui/input.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip.js";
import { useTranslation } from "../../../i18n/react.js";
import { navigateBrowserTabAsUser } from "../preview/agent-browser-bridge.js";
import { BrowserSurfaceTools } from "./BrowserSurfaceTools.js";
import { navigateBrowserSurface, useBrowserSurface, useGuestNavigation } from "../hooks/use-browser-navigation.js";
import type { AveApi } from "../types.js";
import { type ChatPreviewTarget, type WorkspaceFileItem } from "../preview/preview-targets.js";
import { normalizeBrowserNavigationUrl } from "../preview/url-safety.js";
import { formatIpcError } from "../format-ipc-error.js";
import { useFileTreeWidth } from "../hooks/use-file-tree-width.js";
import { useEdgeResize, useMeasuredSize } from "../hooks/use-edge-resize.js";
import { FILE_WORKSPACE_COLUMNS_MIN_WIDTH } from "../../../shared/shell-geometry.js";
import { FILE_TREE_DEFAULT_WIDTH, FILE_TREE_MIN_WIDTH, FILE_TREE_MAX_WIDTH } from "../../../shared/side-panel.js";
import type { FileMentionReference } from "../../../shared/file-mention-reference.js";
import { deriveWorkspaceChanges, workspaceFilePath, type WorkspaceChanges, type FileWorkspaceReveal, type WorkspaceFileFilter } from "../preview/workspace-changes.js";
import { buildWorkspaceTree, normalizeWorkspaceTreePath, type WorkspaceTreeNode } from "../preview/workspace-file-tree.js";
import { TurnChangeDetail } from "./TurnChangeDetail.js";
import { FILE_CHANGE_FOLDER_BADGE_CLASS, FILE_CHANGE_SELECTED_CLASS, SESSION_FILE_BADGE_CLASS } from "./file-change-style.js";
import { FileChangeBadge } from "./FileChangeBadge.js";
import {
  useAddProjectFolder,
  type AddProjectFolderOutcome,
} from "../hooks/use-add-project-folder.js";
import { fileRowActions } from "./files/file-row-actions.js";
import { FileRowMenu, type FileRowMenuState } from "./files/FileRowMenu.js";
import { listWorkspaceDir } from "./files/workspace-listing.js";
import { coalesceRefresh, notifyWorkspaceFilesChanged, subscribeWorkspaceFilesChanged } from "../utils/workspace-files-signal.js";
import { listNavigationTarget, mightProducePrintableCharacter, TypeNavigationController } from "../utils/list-keyboard-navigation.js";
import { requestTerminalAt } from "../utils/app-shell-requests.js";
import { incompleteToolStatusLabelKey } from "../utils/tool-status-label.js";
import { EmptyState } from "../../../components/ui/empty-state.js";
import {
  ListDetailWorkspace,
  SearchInput,
  TargetRows,
} from "./ChatSidePanelLayout.js";
import {
  BrowserDocumentViewer,
  PreviewDetail,
  previewFillsPanel,
  UrlDocumentViewer,
  fileBasename,
  fileIcon,
  isPathWithinRoot,
  matchesQuery,
} from "./ChatSidePanelPreview.js";
import { matchesShortcut } from "../hooks/use-shortcuts.js";


/**
 * The tree's roving row: the active row while it is visible, else the first
 * row. Derived during render so the tree always has a tab stop; an effect
 * would leave one committed render without one after the first listing, a
 * collapse or a reload removes the active row.
 */
export function deriveRovingPath(
  activeItemPath: string | null,
  rows: ReadonlyArray<{ path: string }>,
): string | null {
  if (activeItemPath && rows.some((row) => row.path === activeItemPath)) return activeItemPath;
  return rows[0]?.path ?? null;
}

type WorkspaceDirEntry = { name: string; path: string; type: "file" | "directory" };

/**
 * Project-folder browser (diagnosis ③). Lists the persisted project roots
 * (default workspace + Settings `additionalDirectories`) and lets the user add
 * a new one via the native picker. Folders lazy-expand through
 * `window.ave.workspace.listDir` (scope-revalidated in main); clicking a file
 * routes to `onOpenFile`, which loads its content via the same traversal-guarded
 * preview IPC used everywhere else.
 */
function ProjectRootsBrowser({
  onOpenFile, onFileReference,
  selectedPath, files, changes, filter, query, revealRequest, focusSelectedToken,
}: {
  onOpenFile: (path: string, file?: WorkspaceFileItem, root?: string) => void;
  /** Put a reference to a row into the chat composer; the row menu offers "add to chat" when the host can. */
  /** Put a file reference into the chat composer and say what happened, so a row action can report a refusal. */
  onFileReference?: ((path: string) => AttachTextResult) | undefined;
  selectedPath: string | null;
  files: readonly WorkspaceFileItem[];
  changes: WorkspaceChanges;
  filter: WorkspaceFileFilter;
  query: string;
  revealRequest?: FileWorkspaceReveal | null;
  focusSelectedToken?: number;
}) {
  const { t, locale } = useTranslation();
  const [roots, setRoots] = useState<Array<{ path: string; isDefault: boolean }>>([]);
  const [activeRoot, setActiveRoot] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [childrenByPath, setChildrenByPath] = useState<Record<string, WorkspaceDirEntry[]>>({});
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());
  // A path is "attempted" once loadDir resolves (success OR failure). The
  // auto-load effect keys off this so a dir whose listDir FAILED is not retried
  // forever: a failed listDir never populates childrenByPath, so without this the
  // effect would refire every render → an infinite render→IPC loop.
  const [attemptedPaths, setAttemptedPaths] = useState<Set<string>>(new Set());
  const [errorByPath, setErrorByPath] = useState<Record<string, string>>({});
  // Directories whose listing hit the cap, with how many entries main left out (it sorts first, then caps), so the
  // browser can say how much of the folder is not shown.
  const [omittedByPath, setOmittedByPath] = useState<Record<string, number>>({});
  // "Add a project folder" (pickRoot + adjacency-warning acknowledgement) is
  // the SAME shared flow the empty-state composer's ComposerProjectSelector
  // uses — see use-add-project-folder.ts. Kept as one implementation so the
  // ack-token state machine cannot drift between the two entry points.
  const {
    pendingWarning,
    addFolder: pickProjectFolder,
    confirmPendingFolder: confirmPendingFolderShared,
    cancelPendingFolder,
    setPendingWarning,
  } = useAddProjectFolder();
  // True while a folder drag hovers the roots panel — drives the drop-zone ring.
  const [dragOver, setDragOver] = useState(false);

  // Roving-tabindex active row (the single treeitem with tabIndex=0). Distinct
  // from `selectedPath` (the OPENED file, drives bg-accent) — this is keyboard
  // focus, not the opened file.
  const [activeItemPath, setActiveItemPath] = useState<string | null>(null);
  // path -> row element, for imperative focus moves (roving tabindex).
  const itemRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  // Set true just before a keyboard-driven setActiveItemPath so the post-render
  // effect calls .focus(); prevents stealing focus on mount / mouse clicks.
  const pendingFocusRef = useRef(false);
  // Typing a name moves to the row that starts with it: the same word rules the folder view's columns use.
  const typeNavigation = useRef<TypeNavigationController | null>(null);
  typeNavigation.current ??= new TypeNavigationController();
  // The row menu (right-click, Shift+F10 or the menu key), built from the row actions the folder view also offers.
  const [rowMenu, setRowMenu] = useState<(FileRowMenuState & { path: string }) | null>(null);
  // Inline failure surface for the mutating ops (add / reveal). Removing a project is the sidebar's 프로젝트 제거, which
  // previews what would be lost first (case 31). Cleared
  // when a new op starts or the user dismisses it — a failed op no longer
  // swallows its error result silently.
  const [opError, setOpError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // One listing replaces what the folder showed: its entries, its omitted count and its failure. Nothing is merged.
  const loadDir = useCallback(async (path: string) => {
    setLoadingPaths((prev) => new Set(prev).add(path));
    const res = await listWorkspaceDir(path);
    const entries = res.ok
      // This tree has no link rows; links stay a folder-view display item, as before they were listed at all.
      ? (res.entries ?? []).flatMap((entry): WorkspaceDirEntry[] =>
        entry.type === "link" ? [] : [{ name: entry.name, path: entry.path, type: entry.type }])
      : null;
    setChildrenByPath((prev) => {
      if (entries !== null) return { ...prev, [path]: entries };
      if (!(path in prev)) return prev;
      // A folder that can no longer be listed shows its failure, not the rows it used to have.
      const next = { ...prev };
      delete next[path];
      return next;
    });
    setOmittedByPath((prev) => {
      const omitted = res.ok && res.truncated ? res.omitted ?? 0 : null;
      if (omitted === null) {
        if (!(path in prev)) return prev;
        const next = { ...prev };
        delete next[path];
        return next;
      }
      return prev[path] === omitted ? prev : { ...prev, [path]: omitted };
    });
    setErrorByPath((prev) => {
      if (!res.ok) return { ...prev, [path]: res.error ?? "read-failed" };
      if (!(path in prev)) return prev;
      const next = { ...prev };
      delete next[path];
      return next;
    });
    setAttemptedPaths((prev) => new Set(prev).add(path));
    setLoadingPaths((prev) => {
      const next = new Set(prev);
      next.delete(path);
      return next;
    });
  }, []);

  // The shared "files may have changed" signal (a finished tool or turn, a code rewind, window focus, the reload button):
  // every folder this tree has listed or tried to list is asked for again, one query per folder at a time.
  const listedPathsRef = useRef<string[]>([]);
  listedPathsRef.current = [...new Set([...Object.keys(childrenByPath), ...Object.keys(errorByPath)])];
  const refreshers = useRef(new Map<string, () => void>());
  const reloadListings = useCallback(() => {
    for (const path of listedPathsRef.current) {
      let request = refreshers.current.get(path);
      if (!request) {
        request = coalesceRefresh(() => loadDir(path));
        refreshers.current.set(path, request);
      }
      request();
    }
  }, [loadDir]);
  useEffect(() => subscribeWorkspaceFilesChanged(reloadListings), [reloadListings]);

  const applyRoots = useCallback(
    (next: Array<{ path: string; isDefault: boolean }>, preferred?: string | null) => {
      setRoots(next);
      setActiveRoot((prev) => {
        const keep = preferred ?? prev;
        if (keep && next.some((r) => r.path === keep)) return keep;
        return next[0]?.path ?? null;
      });
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    void window.ave.workspace.listRoots().then((res) => {
      if (cancelled || !res.ok || !res.roots) return;
      const preferred = changes.workspaceRoot
        ? res.roots.find((root) => workspaceFilePath(root.path) === workspaceFilePath(changes.workspaceRoot!))?.path : undefined;
      applyRoots(res.roots, preferred);
    });
    return () => {
      cancelled = true;
    };
  }, [applyRoots, changes.workspaceRoot]);

  useEffect(() => {
    if (
      activeRoot &&
      !childrenByPath[activeRoot] &&
      !loadingPaths.has(activeRoot) &&
      !attemptedPaths.has(activeRoot)
    ) {
      void loadDir(activeRoot);
    }
  }, [activeRoot, childrenByPath, loadingPaths, attemptedPaths, loadDir]);

  const toggleFolder = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
        // Manual expand is a user gesture (not a render loop): allow a retry of a
        // previously-failed folder by clearing its attempted mark before loading.
        if (!childrenByPath[path] && !loadingPaths.has(path)) {
          setAttemptedPaths((prevAttempted) => {
            if (!prevAttempted.has(path)) return prevAttempted;
            const nextAttempted = new Set(prevAttempted);
            nextAttempted.delete(path);
            return nextAttempted;
          });
          void loadDir(path);
        }
      }
      return next;
    });
  };

  const tree = useMemo(() => buildWorkspaceTree({
    root: activeRoot, roots: [...roots].sort((a, b) => Number(b.isDefault) - Number(a.isDefault)).map((root) => root.path), childrenByPath,
    files, changes: changes.changedFiles, filter, query, workspaceRoot: changes.workspaceRoot,
  }), [activeRoot, roots, childrenByPath, files, changes.changedFiles, changes.workspaceRoot, filter, query]);

  const flatNodes = useMemo(() => {
    const out: Array<{ path: string; name: string; isDir: boolean; depth: number; parentPath: string; file?: WorkspaceFileItem }> = [];
    const walk = (nodes: WorkspaceTreeNode[], parentPath: string, depth: number) => {
      for (const node of nodes) {
        const isDir = node.type === "directory";
        out.push({ path: node.path, name: node.name, isDir, depth, parentPath, file: node.file });
        if (isDir && expanded.has(node.path)) walk(node.children, node.path, depth + 1);
      }
    };
    walk(tree.nodes, activeRoot ?? "", 0);
    walk(tree.outsideNodes, "", 0);
    return out;
  }, [activeRoot, tree, expanded]);

  const appliedRootRevealRef = useRef<FileWorkspaceReveal | null>(null);
  useEffect(() => {
    if (!revealRequest || roots.length === 0 || (appliedRootRevealRef.current?.token === revealRequest.token && appliedRootRevealRef.current.path === revealRequest.path)) return;
    appliedRootRevealRef.current = revealRequest;
    const path = normalizeWorkspaceTreePath(revealRequest.path, changes.workspaceRoot ?? roots.find((root) => root.isDefault)?.path ?? roots[0]!.path);
    const root = roots.find((candidate) => isPathWithinRoot(normalizeWorkspaceTreePath(candidate.path, null), path));
    if (root) {
      setActiveRoot(root.path);
      const rootPath = normalizeWorkspaceTreePath(root.path, null);
      setExpanded((previous) => {
        const next = new Set(previous);
        let parent = path.slice(0, path.lastIndexOf("/"));
        while (parent && parent !== rootPath && isPathWithinRoot(rootPath, parent)) {
          next.add(parent);
          parent = parent.slice(0, parent.lastIndexOf("/"));
        }
        return next;
      });
    }
    setActiveItemPath(path);
  }, [revealRequest, roots, changes.workspaceRoot]);

  useEffect(() => {
    for (const path of expanded) {
      if (!childrenByPath[path] && !loadingPaths.has(path) && !attemptedPaths.has(path)) void loadDir(path);
    }
  }, [expanded, childrenByPath, loadingPaths, attemptedPaths, loadDir]);

  const focusedSelectionTokenRef = useRef(0);
  useEffect(() => {
    if (!focusSelectedToken || focusedSelectionTokenRef.current === focusSelectedToken) return;
    const path = selectedPath ? normalizeWorkspaceTreePath(selectedPath, changes.workspaceRoot ?? roots.find((root) => root.isDefault)?.path ?? roots[0]?.path ?? null) : flatNodes[0]?.path;
    const row = path ? itemRefs.current.get(path) : undefined;
    if (row) { focusedSelectionTokenRef.current = focusSelectedToken; row.focus(); }
  }, [focusSelectedToken, selectedPath, flatNodes, roots, changes.workspaceRoot]);

  const scrolledRevealRef = useRef<FileWorkspaceReveal | null>(null);
  useEffect(() => {
    if (!revealRequest || (scrolledRevealRef.current?.token === revealRequest.token && scrolledRevealRef.current.path === revealRequest.path)) return;
    const path = normalizeWorkspaceTreePath(revealRequest.path, changes.workspaceRoot ?? roots.find((root) => root.isDefault)?.path ?? roots[0]?.path ?? null);
    const row = itemRefs.current.get(path);
    if (row) { scrolledRevealRef.current = revealRequest; row.scrollIntoView?.({ block: "nearest" }); }
  }, [revealRequest, roots, flatNodes, changes.workspaceRoot]);

  const rovingPath = deriveRovingPath(activeItemPath, flatNodes);
  const normalizedSelectedPath = selectedPath ? normalizeWorkspaceTreePath(selectedPath, changes.workspaceRoot ?? roots.find((root) => root.isDefault)?.path ?? roots[0]?.path ?? null) : null;

  // Move DOM focus only for keyboard-driven changes (roving tabindex).
  useEffect(() => {
    if (!pendingFocusRef.current) return;
    pendingFocusRef.current = false;
    if (activeItemPath) itemRefs.current.get(activeItemPath)?.focus();
  }, [activeItemPath]);

  // Forget a half-typed word on unmount.
  useEffect(() => () => typeNavigation.current?.clear(), []);

  const focusPath = useCallback((path: string | null | undefined) => {
    if (!path) return;
    pendingFocusRef.current = true;
    setActiveItemPath(path);
  }, []);

  const openRowMenu = (node: { path: string; name: string; isDir: boolean; parentPath: string; file?: WorkspaceFileItem }, at: { x: number; y: number }) => {
    setActiveItemPath(node.path);
    setRowMenu({
      ...at,
      name: node.name,
      path: node.path,
      actions: fileRowActions(
        { path: node.path, type: node.isDir ? "directory" : "file", parent: node.parentPath || activeRoot || node.path, root: activeRoot },
        {
          open: () => (node.isDir ? toggleFolder(node.path) : onOpenFile(node.path, node.file, activeRoot ?? undefined)),
          addToChat: onFileReference,
          openTerminal: activeRoot ? (dir) => {
            if (!requestTerminalAt({ dir, projectRoot: activeRoot })) setOpError(t("folderView.openTerminalFailed"));
          } : undefined,
          report: (messageKey) => setOpError(messageKey === null ? null : t(messageKey)),
        },
      ),
    });
  };

  const onTreeKeyDown = (e: ReactKeyboardEvent) => {
    if (flatNodes.length === 0) return;
    const idx = flatNodes.findIndex((n) => n.path === rovingPath);
    const i = idx >= 0 ? idx : 0;
    const cur = flatNodes[i];
    if (!cur) return;
    if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
      e.preventDefault();
      const rect = itemRefs.current.get(cur.path)?.getBoundingClientRect();
      openRowMenu(cur, { x: (rect?.left ?? 0) + 24, y: rect?.bottom ?? 0 });
      return;
    }
    if (mightProducePrintableCharacter(e.nativeEvent)) {
      e.preventDefault();
      const match = typeNavigation.current?.input(e.key, flatNodes.map((node) => node.name), i) ?? -1;
      focusPath(flatNodes[match]?.path);
      return;
    }
    // Arrows up and down, Home, End and the page keys move through the visible rows.
    const row = itemRefs.current.get(cur.path);
    const rowHeight = row?.offsetHeight ?? 0;
    const viewHeight = row?.closest<HTMLElement>("[data-file-tree-scroller]")?.clientHeight ?? 0;
    const target = listNavigationTarget(e.key, i, flatNodes.length, rowHeight > 0 ? Math.floor(viewHeight / rowHeight) - 1 : 1);
    if (target !== null) {
      e.preventDefault();
      focusPath(flatNodes[target]?.path);
      return;
    }
    switch (e.key) {
      case "ArrowRight":
        e.preventDefault();
        if (cur.isDir) {
          if (!expanded.has(cur.path)) {
            toggleFolder(cur.path); // collapsed -> expand (also lazy-loads)
          } else {
            const child = flatNodes[i + 1]; // expanded -> first child (if loaded)
            if (child && child.parentPath === cur.path) focusPath(child.path);
          }
        }
        break;
      case "ArrowLeft":
        e.preventDefault();
        if (cur.isDir && expanded.has(cur.path)) {
          toggleFolder(cur.path); // expanded -> collapse
        } else if (cur.parentPath && cur.parentPath !== activeRoot) {
          focusPath(cur.parentPath); // else -> parent (activeRoot isn't a treeitem)
        }
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        if (cur.isDir) toggleFolder(cur.path);
        else onOpenFile(cur.path, cur.file, activeRoot ?? undefined);
        break;
    }
  };

  // Surface a mutating-op IPC failure inline. `path-not-allowed` /
  // `sensitive-path` used to need a local override because the shared IPC map
  // did not know them; it does now (format-ipc-error.ts), so this is a plain
  // pass-through and the mapping lives in exactly one place.
  const formatOpError = useCallback(
    (error: string | undefined, message: string | undefined) => formatIpcError(error, message),
    [],
  );

  // A refused pick lands in the SAME inline error slot the drag-drop add already
  // uses — the picker closing on its own is otherwise indistinguishable from a
  // rejected path. `needs-acknowledgement` is answered by the warning panel and
  // `canceled` is the user's own decision, so neither reports anything.
  const applyAddOutcome = useCallback((outcome: AddProjectFolderOutcome) => {
    if (outcome.status === "failed") {
      setOpError(formatOpError(outcome.error, undefined));
      return;
    }
    if (outcome.status !== "added") return;
    setOpError(null);
    applyRoots(outcome.roots, outcome.added);
  }, [applyRoots, formatOpError]);

  const addFolder = useCallback(async () => {
    applyAddOutcome(await pickProjectFolder());
  }, [applyAddOutcome, pickProjectFolder]);

  // The add-folder key (⌘O / Ctrl+O by default) opens the folder picker when focus is within the panel (scoped — no
  // global shortcut pollution).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (matchesShortcut("workspace.addFolder", e)) {
        const root = rootRef.current;
        if (root && root.contains(document.activeElement)) {
          e.preventDefault();
          void addFolder();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [addFolder]);

  // Drag-drop add-root (#1458). A dropped folder path is renderer-NAMED — the
  // preload webUtils bridge turns the dropped File into a candidate path, which
  // main-side dropPrepare re-validates (Layer-0 hard-deny + is-a-directory)
  // before minting a MAIN-OWNED ack token. A drop ALWAYS routes through the same
  // acknowledgement panel the native warned-pick uses (the OS dialog never
  // vouched for the path, so the explicit user ack is that missing vouch), and
  // confirmPendingFolder echoes the token — never the path — to pickRoot. So the
  // drop can never widen the read scope without the user confirming.
  const handleFolderDrop = useCallback(
    async (files: FileList) => {
      setOpError(null);
      const paths = window.aveDrop.resolveDroppedPaths(files);
      const dropped = paths[0]; // first dropped item only — no multi-add fan-out
      if (!dropped) return; // non-file drag (text/url) or unresolvable — no-op
      const res = await window.ave.workspace.dropPrepare(dropped);
      if (!res.ok) {
        setOpError(formatOpError(res.error, undefined));
        return;
      }
      if (res.pendingPath && res.ackToken) {
        setPendingWarning({
          path: res.pendingPath,
          warnings: res.warnings ?? [],
          ackToken: res.ackToken,
        });
      }
    },
    [formatOpError],
  );

  const confirmPendingFolder = async () => {
    applyAddOutcome(await confirmPendingFolderShared());
  };

  // Re-list a folder whose previous listDir FAILED. A user gesture, so it clears
  // the attempted mark (the render-loop guard) before reloading.
  const retryDir = (path: string) => {
    setAttemptedPaths((prev) => {
      if (!prev.has(path)) return prev;
      const next = new Set(prev);
      next.delete(path);
      return next;
    });
    setErrorByPath((prev) => {
      if (!(path in prev)) return prev;
      const next = { ...prev };
      delete next[path];
      return next;
    });
    void loadDir(path);
  };

  const renderEntries = (path: string, depth: number, entries: WorkspaceTreeNode[]): ReactElement => {
    const childPad = 8 + depth * 12;
    if (depth > 0 && loadingPaths.has(path) && entries.length === 0) return <div role="presentation" className="flex h-7 items-center text-dense text-muted-foreground" style={{ paddingLeft: childPad }} data-testid="chat-side-panel-fs-child-loading">{t("chatPreviewRail.filePreviewLoading")}</div>;
    if (depth > 0 && errorByPath[path]) return <button type="button" className="flex h-7 w-full items-center text-left text-dense text-destructive" style={{ paddingLeft: childPad }} data-testid="chat-side-panel-fs-child-error" onClick={() => retryDir(path)}>{t("chatPreviewRail.dirLoadError")} · {t("common.retry")}</button>;
    if (entries.length === 0 && attemptedPaths.has(path) && !loadingPaths.has(path) && !errorByPath[path]) return <div role="presentation" className="flex h-7 items-center text-dense italic text-muted-foreground" style={{ paddingLeft: childPad }} data-testid="chat-side-panel-fs-empty">{t("chatPreviewRail.dirEmpty")}</div>;
    return <>
      {entries.map((entry, index) => {
        const isDir = entry.type === "directory";
        const isOpen = expanded.has(entry.path);
        const opened = !isDir && entry.path === normalizedSelectedPath;
        const incompleteStatusKey = incompleteToolStatusLabelKey(entry.file?.status);
        return <div key={entry.path}>
          <div ref={(el) => { if (el) itemRefs.current.set(entry.path, el); else itemRefs.current.delete(entry.path); }}
            role="treeitem" aria-expanded={isDir ? isOpen : undefined} aria-selected={opened ? true : undefined}
            aria-level={depth + 1} aria-setsize={entries.length} aria-posinset={index + 1} tabIndex={entry.path === rovingPath ? 0 : -1}
            data-testid={isDir ? "chat-side-panel-fs-folder" : "chat-side-panel-fs-file"}
            className={cn("flex h-7 w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-md pr-2 text-left text-xs outline-none hover:bg-muted/(--opacity-muted) focus-visible:ring-1 focus-visible:ring-ring", opened && FILE_CHANGE_SELECTED_CLASS)}
            style={{ paddingLeft: `min(${childPad}px, 14%)` }}
            onFocus={() => setActiveItemPath(entry.path)}
            onClick={() => { setActiveItemPath(entry.path); if (isDir) toggleFolder(entry.path); else onOpenFile(entry.path, entry.file, activeRoot ?? undefined); }}
            onContextMenu={(event) => {
              event.preventDefault();
              openRowMenu({ path: entry.path, name: entry.name, isDir, parentPath: path, file: entry.file }, { x: event.clientX, y: event.clientY });
            }}>
            {isDir ? isOpen ? <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" /> : createElement(fileIcon(entry.name), { className: "h-3 w-3 shrink-0 text-muted-foreground" })}
            <span className={cn("min-w-0 flex-1 truncate", entry.change?.operation === "delete" && "text-muted-foreground line-through")}>{entry.name}</span>
            {entry.session && !isDir ? <span data-testid="chat-side-panel-file-session-badge" className={cn("shrink-0 rounded px-1 text-dense font-medium", SESSION_FILE_BADGE_CLASS)}>{t("chatPreviewRail.sessionFileBadge")}</span> : null}
            {incompleteStatusKey && !isDir ? <span data-testid="chat-side-panel-file-state" className="shrink-0 text-dense text-muted-foreground">{t(incompleteStatusKey)}</span> : null}
            {entry.change && !isDir ? <FileChangeBadge change={entry.change} operationTitle={t("chatPreviewRail.fileOperation." + entry.change.operation)} /> : null}
            {isDir && entry.changedDescendants > 0 && (filter === "all" || !isOpen) ? <span data-testid="chat-side-panel-folder-changes" aria-label={t("chatPreviewRail.changedDescendants", { count: entry.changedDescendants })} className={cn("min-w-4 shrink-0 rounded-full px-1 text-center text-dense font-semibold", FILE_CHANGE_FOLDER_BADGE_CLASS)}>{entry.changedDescendants}</span> : null}
          </div>
          {isDir && isOpen ? <div role="group">{renderEntries(entry.path, depth + 1, entry.children)}</div> : null}
        </div>;
      })}
      {path in omittedByPath ? <div role="presentation" className="flex h-6 items-center text-dense italic text-muted-foreground" style={{ paddingLeft: childPad }} data-testid="chat-side-panel-fs-truncated">{t("folderView.truncated", { shown: (childrenByPath[path]?.length ?? 0).toLocaleString(locale), omitted: (omittedByPath[path] ?? 0).toLocaleString(locale) })}</div> : null}
    </>;
  };
  return (
    // Drag-drop add-root (#1458): a dropped folder resolves to a renderer-named
    // candidate path (preload webUtils bridge) that main-side dropPrepare
    // hard-validates before an explicit ack — so it rides the #1448 ack tier
    // rather than regressing it. Add-root also stays on the native picker (the
    // FolderPlus button + ⌘/Ctrl+O), which the drop convenience sits on top of.
    <div
      ref={rootRef}
      className={cn(
        "space-y-1 rounded-md transition-colors",
        dragOver && "ring-2 ring-primary/(--opacity-half) bg-primary/(--opacity-faint)",
      )}
      data-testid="chat-side-panel-project-roots"
      onDragOver={(event) => {
        // preventDefault is required or the browser navigates to the file.
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        if (!dragOver) setDragOver(true);
      }}
      onDragLeave={(event) => {
        // Ignore leave events bubbling from children still inside the panel.
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setDragOver(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragOver(false);
        void handleFolderDrop(event.dataTransfer.files);
      }}
    >
      <div className="flex items-center gap-1">
        {roots.length > 1 ? (
          <select
            aria-label={t("chatPreviewRail.rootSelectLabel")}
            data-testid="chat-side-panel-root-select"
            className="h-7 min-w-0 flex-1 rounded-md border bg-background px-1 text-xs"
            value={activeRoot ?? ""}
            onChange={(event) => setActiveRoot(event.target.value)}
          >
            {roots.map((root) => (
              <option key={root.path} value={root.path}>
                {fileBasename(root.path)}
                {root.isDefault ? ` · ${t("chatPreviewRail.rootDefaultBadge")}` : ""}
              </option>
            ))}
          </select>
        ) : (
          <span className="min-w-0 flex-1 truncate text-dense font-medium text-muted-foreground">
            {activeRoot ? fileBasename(activeRoot) : t("chatPreviewRail.projectRoots")}
          </span>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              data-testid="chat-side-panel-add-root"
              aria-label={t("chatPreviewRail.addProjectRoot")}
              onClick={() => void addFolder()}
            >
              <FolderPlus className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t("chatPreviewRail.addProjectRoot")}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              data-testid="chat-side-panel-files-reload"
              aria-label={t("folderView.refresh")}
              onClick={() => notifyWorkspaceFilesChanged("manual")}
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t("folderView.refresh")}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              data-testid="chat-side-panel-collapse-all"
              aria-label={t("chatPreviewRail.collapseAll")}
              disabled={expanded.size === 0}
              onClick={() => setExpanded(new Set())}
            >
              <ChevronsDownUp className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t("chatPreviewRail.collapseAll")}</TooltipContent>
        </Tooltip>
      </div>
      {opError ? (
        <div
          role="alert"
          data-testid="chat-side-panel-op-error"
          className="flex items-start gap-1 rounded-md border border-destructive bg-destructive/(--opacity-muted) px-2 py-1 text-dense text-destructive"
        >
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{opError}</span>
          <button
            type="button"
            className="shrink-0 rounded p-0.5 hover:bg-destructive/(--opacity-muted)"
            aria-label={t("common.close")}
            data-testid="chat-side-panel-op-error-dismiss"
            onClick={() => setOpError(null)}
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ) : null}
      {pendingWarning ? (
        <div
          data-testid="chat-side-panel-root-warning"
          className="space-y-2 rounded-md border border-destructive bg-destructive/(--opacity-muted) p-2 text-dense"
        >
          <div className="font-medium text-destructive">{t("chatPreviewRail.rootWarningTitle")}</div>
          <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground [overflow-wrap:anywhere]">
            {pendingWarning.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="destructive"
              data-testid="chat-side-panel-root-warning-confirm"
              onClick={() => void confirmPendingFolder()}
            >
              {t("chatPreviewRail.rootWarningConfirm")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              data-testid="chat-side-panel-root-warning-cancel"
              onClick={cancelPendingFolder}
            >
              {t("common.cancel")}
            </Button>
          </div>
        </div>
      ) : null}
      {rowMenu ? <FileRowMenu menu={rowMenu} onClose={() => setRowMenu(null)} focusTarget={() => itemRefs.current.get(rowMenu.path)} /> : null}
      <div role="tree" aria-label={t("chatPreviewRail.projectRoots")} onKeyDown={onTreeKeyDown}>
        {activeRoot ? <>
          {loadingPaths.has(activeRoot) && !childrenByPath[activeRoot] ? <div className="px-2 py-1 text-dense text-muted-foreground">{t("chatPreviewRail.filePreviewLoading")}</div> : errorByPath[activeRoot] ? <button type="button" className="flex w-full items-center gap-1 px-2 py-1 text-left text-dense text-destructive hover:underline" data-testid="chat-side-panel-fs-error" onClick={() => retryDir(activeRoot)}>{t("chatPreviewRail.dirLoadError")} · {t("common.retry")}</button> : null}
          {renderEntries(activeRoot, 0, tree.nodes)}
        </> : <EmptyState className="px-2 py-3" data-testid="chat-side-panel-roots-empty" title={t("chatPreviewRail.projectRootsEmpty")}
          action={{ label: t("chatPreviewRail.addProjectRoot"), icon: <FolderPlus className="h-3.5 w-3.5" aria-hidden="true" />, onClick: () => void addFolder() }} />}
        {tree.outsideNodes.length > 0 ? <div className="mt-2 border-t border-border pt-2" data-testid="chat-side-panel-outside-project">
          <div role="presentation" className="px-2 pb-1 text-dense font-medium text-muted-foreground">{t("chatPreviewRail.outsideProject")}</div>
          {renderEntries("", 0, tree.outsideNodes)}
        </div> : null}
      </div>
    </div>
  );
}

/**
 * The files a view's changes list, as the workspace tree's file rows, built from nothing but those changes: no root
 * or directory is listed, so nothing outside the set can appear or be opened from here.
 */
function MatchedFileList({ files, changes, query, selectedPath, onOpenFile }: {
  files: readonly WorkspaceFileItem[];
  changes: WorkspaceChanges;
  query: string;
  selectedPath: string | null;
  onOpenFile: (path: string, file?: WorkspaceFileItem, root?: string) => void;
}) {
  const { t } = useTranslation();
  const root = changes.workspaceRoot ?? null;
  const rows = useMemo(() => {
    const tree = buildWorkspaceTree({ root, roots: root ? [root] : [], childrenByPath: {}, files, changes: changes.changedFiles, filter: "changed", query,
      ...(changes.workspaceRoot ? { workspaceRoot: changes.workspaceRoot } : {}) });
    const flat: WorkspaceTreeNode[] = [];
    const walk = (nodes: readonly WorkspaceTreeNode[]) => { for (const node of nodes) node.type === "file" ? flat.push(node) : walk(node.children); };
    walk(tree.nodes);
    walk(tree.outsideNodes);
    return flat;
  }, [root, files, changes.changedFiles, changes.workspaceRoot, query]);
  const selected = selectedPath ? normalizeWorkspaceTreePath(selectedPath, root) : null;
  if (rows.length === 0) return <EmptyState title={t("chatPreviewRail.emptyState")} />;
  return <div role="list" data-testid="chat-side-panel-matched-files">
    {rows.map((node) => {
      const opened = node.path === selected;
      const label = root && node.path.startsWith(`${root.replace(/\/$/, "")}/`) ? node.path.slice(root.replace(/\/$/, "").length + 1) : node.path;
      return <button key={node.path} type="button" role="listitem" aria-current={opened ? true : undefined} title={node.path}
        data-testid="chat-side-panel-fs-file" onClick={() => onOpenFile(node.path, node.file, root ?? undefined)}
        className={cn("flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md px-2 text-left text-xs outline-none hover:bg-muted/(--opacity-muted) focus-visible:ring-1 focus-visible:ring-ring", opened && FILE_CHANGE_SELECTED_CLASS)}>
        {createElement(fileIcon(node.name), { className: "h-3 w-3 shrink-0 text-muted-foreground" })}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {node.change ? <FileChangeBadge change={node.change} operationTitle={t("chatPreviewRail.fileOperation." + node.change.operation)} /> : null}
      </button>;
    })}
  </div>;
}

export function FileBrowserWorkspace({
  api, sessionId, visible, files, targetById, selectedId, onSelect,
  changes: providedChanges, revealRequest, onReference, onFileReference, matchedOnly = false, emptyDetail, revealOpensDetail = false,
}: {
  api: AveApi;
  sessionId?: string;
  visible: boolean;
  files: WorkspaceFileItem[];
  targetById: Map<string, ChatPreviewTarget>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  changes?: WorkspaceChanges;
  revealRequest?: FileWorkspaceReveal | null;
  onReference?: (reference: FileMentionReference) => void;
  onFileReference?: (path: string) => AttachTextResult;
  /**
   * Show only the files `changes` lists, with no filter, no directory browsing and no workspace listing: a view whose
   * file set is exactly what main delivered (a terminal's matched agent-changed files) never lists anything else.
   */
  matchedOnly?: boolean;
  /** Shown instead of any file preview when a selection has no reviewable change: a view whose files may only be read
   * through its own change review (a terminal's agent-changed files) never falls back to reading the file. */
  emptyDetail?: string;
  /** A reveal opens the file's detail, even where the tree and the detail take turns (a narrow panel). */
  revealOpensDetail?: boolean;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const defaultFilter: WorkspaceFileFilter = matchedOnly ? "changed" : "all";
  const [filter, setFilter] = useState<WorkspaceFileFilter>(defaultFilter);
  const [fsPath, setFsPath] = useState<string | null>(null);
  const [fsRoot, setFsRoot] = useState<string | null>(null);
  const [detailVisible, setDetailVisible] = useState(false);
  const [focusSelectedToken, setFocusSelectedToken] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const detailRef = useRef<HTMLDivElement | null>(null);
  const treeRef = useRef<HTMLDivElement | null>(null);
  const { width } = useMeasuredSize(containerRef);
  const narrow = width < FILE_WORKSPACE_COLUMNS_MIN_WIDTH;
  const { treeWidth, setTreeWidth, commitTreeWidth } = useFileTreeWidth(api);
  const maxTreeWidth = Math.max(FILE_TREE_MIN_WIDTH, Math.min(FILE_TREE_MAX_WIDTH, width - 269));
  const actualTreeWidth = Math.min(treeWidth, maxTreeWidth);
  const resize = useEdgeResize({ width: actualTreeWidth, edge: "end", min: FILE_TREE_MIN_WIDTH, max: maxTreeWidth,
    onWidthChange: setTreeWidth, onWidthCommit: commitTreeWidth });
  const changes = useMemo(() => providedChanges ?? deriveWorkspaceChanges({ files, targets: [...targetById.values()], review: null }), [providedChanges, files, targetById]);
  const selectedFile = files.find((file) => file.previewTargetId === selectedId);
  const selectedPath = fsPath ?? selectedFile?.path ?? null;
  const selectedChange = selectedPath ? changes.changedFiles.find((change) => change.path === selectedPath || change.displayPath === selectedPath) : undefined;
  const selectedTarget = selectedChange?.file?.previewTargetId ? targetById.get(selectedChange.file.previewTargetId) : selectedFile?.previewTargetId ? targetById.get(selectedFile.previewTargetId) : undefined;
  const previewTarget = useMemo<ChatPreviewTarget | null>(() => {
    if (!selectedPath) return selectedTarget ?? null;
    const root = fsRoot ?? changes.workspaceRoot;
    const normalized = workspaceFilePath(selectedPath, root);
    const normalizedRoot = root ? normalizeWorkspaceTreePath(root, null) : undefined;
    const previewRoot = normalizedRoot && isPathWithinRoot(normalizedRoot, normalized) ? normalizedRoot
      : /^(?:\/|[A-Za-z]:\/)/.test(normalized) ? normalized.slice(0, normalized.lastIndexOf("/")) || "/" : undefined;
    if (selectedTarget?.kind === "file"
      && workspaceFilePath(selectedTarget.path, selectedTarget.workspaceRoot ?? root) === normalized) {
      return { ...selectedTarget, path: normalized, ...(previewRoot ? { workspaceRoot: previewRoot } : {}) };
    }
    return { id: `fs:${normalized}`, kind: "file", title: fileBasename(normalized), sourceLabel: "workspace",
      createdOrder: Number.MAX_SAFE_INTEGER, path: normalized, ...(previewRoot ? { workspaceRoot: previewRoot } : {}), canOpenExternal: false };
  }, [selectedPath, selectedTarget, fsRoot, changes.workspaceRoot]);
  const openFile = useCallback((path: string, matchedFile?: WorkspaceFileItem, root?: string) => {
    changes.onRefresh?.();
    setFsPath(path);
    const normalizedRoot = root ? normalizeWorkspaceTreePath(root, null) : null;
    setFsRoot(normalizedRoot && isPathWithinRoot(normalizedRoot, path) ? normalizedRoot : null);
    const sessionFile = matchedFile ?? files.find((file) => workspaceFilePath(file.path) === workspaceFilePath(path));
    if (sessionFile?.previewTargetId) onSelect(sessionFile.previewTargetId);
    setDetailVisible(true);
    requestAnimationFrame(() => detailRef.current?.focus());
  }, [files, onSelect, changes.onRefresh]);
  const appliedRevealRef = useRef<FileWorkspaceReveal | null>(null);
  useEffect(() => {
    if (!revealRequest) providedChanges?.onRefresh?.();
  }, [providedChanges?.onRefresh, sessionId, revealRequest]);
  useEffect(() => { setFsPath(null); setFsRoot(null); setQuery(""); setFilter(defaultFilter); setDetailVisible(false); }, [sessionId, defaultFilter]);
  useEffect(() => {
    if (!revealRequest || (appliedRevealRef.current?.token === revealRequest.token && appliedRevealRef.current.path === revealRequest.path)) return;
    appliedRevealRef.current = revealRequest;
    changes.onRefresh?.();
    setQuery("");
    setFilter("changed");
    const revealed = changes.changedFiles.find((change) => change.path === revealRequest.path || change.displayPath === revealRequest.path);
    setFsPath(revealed?.path ?? revealRequest.path);
    setFsRoot(changes.review?.workspaceRoot ?? null);
    if (revealed?.file?.previewTargetId) onSelect(revealed.file.previewTargetId);
    setDetailVisible(revealOpensDetail);
  }, [revealRequest, changes.changedFiles, changes.onRefresh, onSelect, revealOpensDetail]);
  const goBack = () => { setDetailVisible(false); setFocusSelectedToken((token) => token + 1); };
  const focusTree = () => {
    const row = treeRef.current?.querySelector<HTMLElement>('[role="treeitem"][aria-selected="true"]') ?? treeRef.current?.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]');
    row?.focus();
  };
  return <div ref={containerRef} className="flex h-full min-h-0 w-full min-w-0 overflow-hidden" data-testid="chat-side-panel-file-browser" data-file-layout={narrow ? "single" : "columns"}>
    <div ref={treeRef} className={cn("min-h-0 min-w-0 shrink-0 flex-col overflow-hidden", narrow && detailVisible ? "hidden" : "flex")}
      style={{ width: narrow ? "100%" : actualTreeWidth }} data-testid="chat-side-panel-file-tree">
      <div className="shrink-0 space-y-2 p-2">
        <SearchInput query={query} setQuery={setQuery} placeholder={t("chatPreviewRail.searchPlaceholder")} />
        {matchedOnly ? null : <div role="group" aria-label={t("chatPreviewRail.fileFilterLabel")} className="flex gap-0.5 rounded-lg bg-muted p-0.5">
          {(["all", "changed", "session"] as const).map((value) => <button key={value} type="button" aria-pressed={filter === value}
            data-testid={`chat-side-panel-file-filter-${value}`} onClick={() => setFilter(value)}
            className={cn("h-7 min-w-0 flex-1 rounded-md px-1 text-dense font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring", filter === value ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>
            {t(value === "all" ? "chatPreviewRail.fileFilterAll" : value === "changed" ? "chatPreviewRail.fileFilterChanged" : "chatPreviewRail.fileFilterSession")}
            {value !== "all" ? <span className="ml-1 tabular-nums">{value === "changed" ? changes.changedFiles.length : changes.sessionFiles.length}</span> : null}
          </button>)}
        </div>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-1.5 pb-2" data-file-tree-scroller="" onKeyDown={(event) => {
        if (event.key === "F6" && previewTarget && !narrow) { event.preventDefault(); detailRef.current?.focus(); }
      }}>
        {matchedOnly ? <MatchedFileList files={files} changes={changes} query={query} selectedPath={selectedPath} onOpenFile={openFile} />
          : <ProjectRootsBrowser files={files} changes={changes} filter={filter} query={query} selectedPath={selectedPath}
            onOpenFile={openFile} onFileReference={onFileReference} revealRequest={revealRequest} focusSelectedToken={focusSelectedToken} />}
      </div>
    </div>
    {!narrow ? <div role="separator" aria-orientation="vertical" aria-label={t("chatPreviewRail.resizeFileColumns")} tabIndex={0}
      aria-valuemin={FILE_TREE_MIN_WIDTH} aria-valuemax={Math.round(maxTreeWidth)} aria-valuenow={Math.round(actualTreeWidth)}
      onPointerDown={resize.onPointerDown} onKeyDown={resize.onKeyDown} onDoubleClick={resize.makeResetHandler(FILE_TREE_DEFAULT_WIDTH)}
      className="group flex w-[9px] shrink-0 cursor-col-resize items-stretch justify-center outline-none focus-visible:bg-accent"
      data-testid="chat-side-panel-file-splitter"><div className="w-px bg-border group-hover:bg-ring group-focus-visible:bg-ring" /></div> : null}
    <div ref={detailRef} tabIndex={-1} aria-label={t("chatPreviewRail.fileDetailLabel")}
      className={cn("min-h-0 min-w-0 flex-1 flex-col overflow-hidden outline-none focus-visible:ring-1 focus-visible:ring-ring", narrow && !detailVisible ? "hidden" : "flex")}
      data-testid="chat-side-panel-file-detail" onKeyDown={(event) => {
        if (event.key === "F6") { event.preventDefault(); narrow ? goBack() : focusTree(); }
      }}>
      {narrow ? <button type="button" className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-3 text-left text-xs text-primary" onClick={goBack} data-testid="chat-side-panel-file-back"><ArrowLeft className="h-3.5 w-3.5" />{t("chatPreviewRail.fileTreeBack")}</button> : null}
      {selectedChange?.review && selectedChange.turnId && (selectedChange.review.referenceable || selectedChange.review.hunks.length > 0 || selectedChange.review.operation === "delete") ? <TurnChangeDetail file={selectedChange.review} turnId={selectedChange.turnId} onReference={onReference} onFileReference={onFileReference}
        onDecide={changes.onDecide} deciding={changes.deciding} decisionError={changes.decisionError} />
        : emptyDetail !== undefined ? <EmptyState title={selectedPath ? emptyDetail : t("chatPreviewRail.emptyState")} />
          : previewTarget ? <div className={cn("min-h-0 flex-1 overflow-auto p-3", previewFillsPanel(previewTarget) && "flex flex-col")}><PreviewDetail api={api} sessionId={sessionId} target={previewTarget} visible={visible} /></div>
          : <EmptyState title={t("chatPreviewRail.emptyState")} />}
    </div>
  </div>;
}


export function PreviewWorkspace({
  api,
  sessionId,
  visible,
  targets,
  selectedId,
  onSelect,
}: {
  api: AveApi;
  sessionId?: string;
  visible: boolean;
  targets: ChatPreviewTarget[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const filteredTargets = useMemo(
    () => targets.filter((target) => matchesQuery(query, target.title, target.subtitle, target.sourceLabel, target.toolName)),
    [targets, query],
  );
  const selectedTarget = useMemo(
    () => filteredTargets.find((target) => target.id === selectedId) ?? filteredTargets[0] ?? null,
    [filteredTargets, selectedId],
  );

  useEffect(() => {
    if (selectedTarget && selectedTarget.id !== selectedId) onSelect(selectedTarget.id);
  }, [onSelect, selectedId, selectedTarget]);

  return (
    <ListDetailWorkspace
      api={api}
      sessionId={sessionId}
      visible={visible}
      query={query}
      setQuery={setQuery}
      placeholder={t("chatPreviewRail.searchPlaceholder")}
      rows={filteredTargets}
      selectedTarget={selectedTarget}
      emptyText={t("chatPreviewRail.noPreviewTargets")}
      rowTestId="chat-preview-target-row"
      onSelect={onSelect}
    />
  );
}

/**
 * The pages this conversation went to, latest first, with a search over them.
 *
 * Not part of a browser tab: a browser tab is an address row and its page,
 * nothing else (owner rule). This list is where the conversation's pages are
 * FOUND — the side panel's empty landing — and picking one opens it in a tab.
 */
export function VisitedSites({
  api,
  targets,
  onOpen,
}: {
  api: AveApi;
  targets: ChatPreviewTarget[];
  /** Open the picked page (a url or an html document) in a tab. */
  onOpen: (target: ChatPreviewTarget) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const visitedTargets = useMemo(
    () => targets
      .filter((target) => matchesQuery(query, target.title, target.subtitle, target.sourceLabel, target.kind === "url" ? target.url : undefined))
      // Latest first: the page the conversation went to most recently is the
      // one the viewer most likely wants back.
      .sort((left, right) => right.createdOrder - left.createdOrder),
    [targets, query],
  );
  return (
    <div className="flex min-h-0 flex-col" data-testid="chat-side-panel-browser-visited">
      <SearchInput query={query} setQuery={setQuery} placeholder={t("chatPreviewRail.searchPlaceholder")} />
      <div className="min-h-0 flex-1 overflow-auto p-2">
        <h3 className="mb-1 px-2 text-dense font-semibold uppercase text-muted-foreground">
          {t("chatPreviewRail.browserVisited")}
        </h3>
        {visitedTargets.length > 0 ? (
          <TargetRows
            targets={visitedTargets}
            rowTestId="chat-side-panel-browser-row"
            onSelect={(id) => {
              const target = visitedTargets.find((each) => each.id === id);
              if (target) onOpen(target);
            }}
            onOpenUrlInSystemApp={(url) => {
              const safe = normalizeBrowserNavigationUrl(url);
              if (safe) void api.openExternalUrl(safe);
            }}
          />
        ) : (
          <EmptyState title={t("chatPreviewRail.noBrowserTargets")} />
        )}
      </div>
    </div>
  );
}

/**
 * A browser CONTAINER tab: its address row and its page. The page is the one
 * typed into the address row, else the conversation's latest page; the list
 * of the conversation's pages lives on the panel's landing (`VisitedSites`).
 */
export function BrowserWorkspace({
  api,
  tabId,
  targets,
  manualUrl,
  onManualUrlChange,
  composerGroupId,
}: {
  api: AveApi;
  tabId: string;
  targets: ChatPreviewTarget[];
  manualUrl: string | null;
  onManualUrlChange: (tabId: string, url: string | null) => void;
  composerGroupId?: string | undefined;
}) {
  const { t } = useTranslation();
  const guest = useBrowserSurface(tabId);
  const navigation = useGuestNavigation(guest);
  const [addressDraft, setAddressDraft] = useState("");
  const [addressError, setAddressError] = useState<string | null>(null);
  const latestTarget = useMemo(
    () => targets.reduce<ChatPreviewTarget | null>(
      (latest, target) => (latest === null || target.createdOrder > latest.createdOrder ? target : latest),
      null,
    ),
    [targets],
  );

  // The tab whose address row holds text the user is typing and has not submitted. While the field has focus, a page that
  // reports a new address (its first load finishing or failing, a redirect) must not erase the draft, as in any browser.
  // The draft lives only that long: leaving the field, Escape, and back, forward or reload put the page's real address back,
  // so the row never shows a typed address for a page it is not showing.
  const draftEditedForTab = useRef<string | null>(null);
  const addressInputRef = useRef<HTMLInputElement | null>(null);
  const goButtonRef = useRef<HTMLButtonElement | null>(null);
  const currentAddress = navigation.url ?? manualUrl ?? (latestTarget?.kind === "url" ? latestTarget.url : "");
  const discardDraft = () => {
    draftEditedForTab.current = null;
    setAddressDraft(currentAddress);
    setAddressError(null);
  };
  useEffect(() => {
    if (draftEditedForTab.current === tabId) return;
    draftEditedForTab.current = null;
    setAddressDraft(currentAddress);
    setAddressError(null);
  }, [currentAddress, tabId]);
  const navigate = (action: () => void) => {
    discardDraft();
    void navigateBrowserTabAsUser(api, tabId, action);
  };

  const manualTarget = useMemo<Extract<ChatPreviewTarget, { kind: "url" }> | null>(() => {
    if (!manualUrl) return null;
    let title: string;
    try {
      title = new URL(manualUrl).hostname || manualUrl;
    } catch {
      title = manualUrl;
    }
    return {
      id: `manual-browser:${tabId}`,
      kind: "url",
      title,
      subtitle: t("chatPreviewRail.manualUrlSubtitle"),
      sourceLabel: t("chatPreviewRail.manualUrlSource"),
      createdOrder: Number.MAX_SAFE_INTEGER,
      url: manualUrl,
      origin: "address",
    };
  }, [manualUrl, t, tabId]);
  const displayedTarget = manualTarget ?? latestTarget;
  const shownUrl = navigation.url ?? (displayedTarget?.kind === "url" ? displayedTarget.url : null);

  const submitAddress = () => {
    const normalized = normalizeBrowserNavigationUrl(addressDraft);
    if (!normalized) {
      setAddressError(t("chatPreviewRail.browserInvalidUrl"));
      return;
    }
    draftEditedForTab.current = null;
    setAddressDraft(normalized);
    setAddressError(null);
    void navigateBrowserTabAsUser(api, tabId, () => onManualUrlChange(tabId, normalized));
  };

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden" data-testid="chat-side-panel-browser-workspace">
      {/*
        Single address bar (#11): the browser tab owns ONE address row here and
        the viewer's own header is suppressed (UrlDocumentViewer showHeader=false)
        so there is no duplicate URL band nesting.
      */}
      <form
        data-native-page-chrome="background"
        className="flex shrink-0 items-center gap-2 border-b px-3 py-2"
        onBlur={(event) => {
          // The draft lives while focus stays on the field or the Go button that submits it; focus going anywhere else,
          // from either of them, drops it. Switching away from the whole window is not leaving the edit: focus comes back to
          // the field when the window does, so the draft stays, as in Chrome.
          const left: EventTarget = event.target;
          const next: EventTarget | null = event.relatedTarget;
          if (left !== addressInputRef.current && left !== goButtonRef.current) return;
          if (next === addressInputRef.current || next === goButtonRef.current) return;
          if (next === null && !document.hasFocus()) return;
          discardDraft();
        }}
        onSubmit={(event) => {
          event.preventDefault();
          submitAddress();
        }}
      >
        <Button type="button" variant="ghost" size="icon" className="h-8 w-8 shrink-0"
          aria-label={t("mainPanels.back")} disabled={!navigation.canGoBack}
          onClick={() => navigate(() => navigateBrowserSurface(guest, "back"))} data-testid="browser-back">
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
        <Button type="button" variant="ghost" size="icon" className="h-8 w-8 shrink-0"
          aria-label={t("mainPanels.forward")} disabled={!navigation.canGoForward}
          onClick={() => navigate(() => navigateBrowserSurface(guest, "forward"))} data-testid="browser-forward">
          <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
        <Button type="button" variant="ghost" size="icon" className="h-8 w-8 shrink-0"
          aria-label={t("mainPanels.reload")} disabled={!guest || !navigation.url}
          onClick={() => navigate(() => navigateBrowserSurface(guest, "reload"))} data-testid="browser-reload">
          <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
        <Globe className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <Input
          ref={addressInputRef}
          data-testid="chat-side-panel-browser-address"
          value={addressDraft}
          onChange={(event) => {
            draftEditedForTab.current = tabId;
            setAddressDraft(event.target.value);
            if (addressError) setAddressError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") discardDraft();
          }}
          placeholder={t("chatPreviewRail.browserAddressPlaceholder")}
          className="h-8 min-w-0 flex-1 text-xs"
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="submit"
              size="icon"
              variant="ghost"
              className="h-8 w-8 shrink-0"
              ref={goButtonRef}
              aria-label={t("chatPreviewRail.browserGo")}
              data-testid="chat-side-panel-browser-go"
            >
              <ArrowRight className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("chatPreviewRail.browserGo")}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="h-8 w-8 shrink-0"
              aria-label={t("chatPreviewRail.openUrl")}
              data-testid="chat-side-panel-browser-open-external"
              disabled={!shownUrl}
              onClick={() => {
                const safe = shownUrl ? normalizeBrowserNavigationUrl(shownUrl) : null;
                if (safe) void api.openExternalUrl(safe);
              }}
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("chatPreviewRail.openUrl")}</TooltipContent>
        </Tooltip>
      </form>
      <BrowserSurfaceTools api={api} tabId={tabId} composerGroupId={composerGroupId}
        onOpenUrl={(url) => { void navigateBrowserTabAsUser(api, tabId, () => onManualUrlChange(tabId, url)); }} />
      {addressError ? (
        <div className="shrink-0 border-b px-3 py-1.5 text-dense text-destructive" data-native-page-chrome="background" data-testid="chat-side-panel-browser-address-error">
          {addressError}
        </div>
      ) : null}
      <div className="min-h-0 w-full min-w-0 flex-1 overflow-hidden">
        {displayedTarget?.kind === "html" ? (
          <BrowserDocumentViewer target={displayedTarget} />
        ) : displayedTarget?.kind === "url" ? (
          <UrlDocumentViewer api={api} target={displayedTarget} showHeader={false} surfaceTabId={tabId} browserTab={{ tabId }} />
        ) : (
          <EmptyState data-testid="chat-side-panel-browser-blank" title={t("mainPanels.webEmpty")} />
        )}
      </div>
    </div>
  );
}
