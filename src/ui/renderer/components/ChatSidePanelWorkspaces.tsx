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
  RotateCw,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import { Input } from "../../../components/ui/input.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip.js";
import { useTranslation } from "../../../i18n/react.js";
import { navigateBrowserTabAsUser } from "../preview/agent-browser-bridge.js";
import { BrowserSurfaceTools } from "./BrowserSurfaceTools.js";
import { useGuestNavigation, useWebSurfaceGuest } from "../hooks/use-browser-navigation.js";
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
import { FILE_CHANGE_ADDED_CLASS, FILE_CHANGE_REMOVED_CLASS, FILE_CHANGE_FOLDER_BADGE_CLASS, FILE_CHANGE_SELECTED_CLASS, SESSION_FILE_BADGE_CLASS, fileChangeBadgeClass, fileChangeLetter } from "./file-change-style.js";
import {
  useAddProjectFolder,
  type AddProjectFolderOutcome,
} from "../hooks/use-add-project-folder.js";
import { useNativeContextMenu } from "../hooks/use-native-context-menu.js";
import { incompleteToolStatusLabelKey } from "../utils/tool-status-label.js";
import {
  ListDetailWorkspace,
  SearchInput,
  TargetRows,
} from "./ChatSidePanelLayout.js";
import {
  BrowserDocumentViewer,
  EmptyState,
  PreviewDetail,
  previewFillsPanel,
  UrlDocumentViewer,
  fileBasename,
  fileIcon,
  isPathWithinRoot,
  matchesQuery,
  toRelativePath,
} from "./ChatSidePanelPreview.js";


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
  onOpenFile,
  selectedPath, files, changes, filter, query, revealRequest, focusSelectedToken,
}: {
  onOpenFile: (path: string, file?: WorkspaceFileItem, root?: string) => void;
  selectedPath: string | null;
  files: readonly WorkspaceFileItem[];
  changes: WorkspaceChanges;
  filter: WorkspaceFileFilter;
  query: string;
  revealRequest?: FileWorkspaceReveal | null;
  focusSelectedToken?: number;
}) {
  const { t } = useTranslation();
  const openNativeContextMenu = useNativeContextMenu();
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
  // Directories whose listing hit MAX_DIR_ENTRIES (main returns `truncated`), so
  // the browser can flag that only a prefix of the folder is shown.
  const [truncatedPaths, setTruncatedPaths] = useState<Set<string>>(new Set());
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
  // Type-ahead buffer with a 500ms reset window.
  const typeaheadRef = useRef<{ buffer: string; timer: ReturnType<typeof setTimeout> | null }>({
    buffer: "",
    timer: null,
  });
  // Inline failure surface for the mutating ops (removeRoot / reveal). Cleared
  // when a new op starts or the user dismisses it — a failed op no longer
  // swallows its error result silently.
  const [opError, setOpError] = useState<string | null>(null);
  // #1493 — transient info surface: removeRoot may also prune orphaned
  // path-scoped grants under the removed root. When it does, tell the user so
  // the extra revocation isn't silent. Cleared on the next op or on dismiss.
  const [opInfo, setOpInfo] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const loadDir = useCallback(async (path: string) => {
    setLoadingPaths((prev) => new Set(prev).add(path));
    try {
      const res = await window.ave.workspace.listDir(path);
      if (res.ok && res.entries) {
        setChildrenByPath((prev) => ({ ...prev, [path]: res.entries ?? [] }));
        setTruncatedPaths((prev) => {
          const has = prev.has(path);
          if (res.truncated && !has) return new Set(prev).add(path);
          if (!res.truncated && has) {
            const next = new Set(prev);
            next.delete(path);
            return next;
          }
          return prev;
        });
        setErrorByPath((prev) => {
          if (!(path in prev)) return prev;
          const next = { ...prev };
          delete next[path];
          return next;
        });
      } else {
        // Surface the failure rather than swallowing it silently.
        setErrorByPath((prev) => ({ ...prev, [path]: res.error ?? "read-failed" }));
      }
    } catch {
      setErrorByPath((prev) => ({ ...prev, [path]: "read-failed" }));
    } finally {
      setAttemptedPaths((prev) => new Set(prev).add(path));
      setLoadingPaths((prev) => {
        const next = new Set(prev);
        next.delete(path);
        return next;
      });
    }
  }, []);

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

  // Clear the type-ahead timer on unmount.
  useEffect(
    () => () => {
      if (typeaheadRef.current.timer) clearTimeout(typeaheadRef.current.timer);
    },
    [],
  );

  const focusPath = useCallback((path: string | null) => {
    if (!path) return;
    pendingFocusRef.current = true;
    setActiveItemPath(path);
  }, []);

  const runTypeahead = (char: string, curIdx: number) => {
    const ta = typeaheadRef.current;
    if (ta.timer) clearTimeout(ta.timer);
    ta.buffer += char.toLowerCase();
    ta.timer = setTimeout(() => {
      ta.buffer = "";
      ta.timer = null;
    }, 500);
    const n = flatNodes.length;
    // Single-char buffer starts the search at the NEXT node (cycles repeats);
    // multi-char refines from the current node.
    const startOffset = ta.buffer.length === 1 ? 1 : 0;
    for (let i = 0; i < n; i++) {
      const cand = flatNodes[(curIdx + startOffset + i) % n];
      if (cand.name.toLowerCase().startsWith(ta.buffer)) {
        focusPath(cand.path);
        return;
      }
    }
  };

  const onTreeKeyDown = (e: ReactKeyboardEvent) => {
    if (flatNodes.length === 0) return;
    const idx = flatNodes.findIndex((n) => n.path === rovingPath);
    const i = idx >= 0 ? idx : 0;
    const cur = flatNodes[i];
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        focusPath(flatNodes[Math.min(i + 1, flatNodes.length - 1)].path);
        break;
      case "ArrowUp":
        e.preventDefault();
        focusPath(flatNodes[Math.max(i - 1, 0)].path);
        break;
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
      case "Home":
        e.preventDefault();
        focusPath(flatNodes[0].path);
        break;
      case "End":
        e.preventDefault();
        focusPath(flatNodes[flatNodes.length - 1].path);
        break;
      default:
        if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
          e.preventDefault();
          runTypeahead(e.key, i);
        }
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

  // ⌘O / Ctrl+O opens the folder picker when focus is within the panel (scoped —
  // no global shortcut pollution).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "o" || e.key === "O")) {
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

  // Reveal a file/folder in the OS file manager. Re-validated in main; surfaces
  // any failure inline instead of swallowing the result.
  const revealEntry = async (path: string) => {
    setOpError(null);
    const res = await window.ave.workspace.reveal(path);
    if (!res.ok) setOpError(formatOpError(res.error, res.message));
  };

  const confirmPendingFolder = async () => {
    applyAddOutcome(await confirmPendingFolderShared());
  };

  const activeRootIsDefault = Boolean(
    activeRoot && roots.find((r) => r.path === activeRoot)?.isDefault,
  );

  // Remove the active root from the read allow-list. Non-destructive (files are
  // untouched — only the Layer-1 read scope narrows); main refuses to remove the
  // default root or any path not already in `additionalDirectories`.
  const removeActiveRoot = async () => {
    if (!activeRoot || activeRootIsDefault) return;
    const removedRoot = activeRoot;
    setOpError(null);
    setOpInfo(null);
    const res = await window.ave.workspace.removeRoot(removedRoot);
    if (!res.ok) {
      setOpError(formatOpError(res.error, res.message));
      return;
    }
    // Surface the extra revocation when path-scoped grants under the removed
    // root were pruned, so the widened effect of "Remove folder" is visible.
    if (res.prunedGrants && res.prunedGrants > 0) {
      setOpInfo(t("chatPreviewRail.removeRootPruned", { count: res.prunedGrants }));
    }
    if (!res.roots) return;
    // Drop cached children/expansion for the removed subtree so a re-add reloads.
    // Boundary-safe + cross-platform: `isPathWithinRoot` matches on a full
    // segment (so `/foo` won't purge `/foobar`) and both `/` and `\` separators.
    setChildrenByPath((prev) => {
      const next: Record<string, WorkspaceDirEntry[]> = {};
      for (const [key, value] of Object.entries(prev)) {
        if (isPathWithinRoot(removedRoot, key)) continue;
        next[key] = value;
      }
      return next;
    });
    applyRoots(res.roots, res.roots[0]?.path ?? null);
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
    if (depth > 0 && loadingPaths.has(path) && entries.length === 0) return <div role="presentation" className="flex h-7 items-center text-[11px] text-muted-foreground" style={{ paddingLeft: childPad }} data-testid="chat-side-panel-fs-child-loading">{t("chatPreviewRail.filePreviewLoading")}</div>;
    if (depth > 0 && errorByPath[path]) return <button type="button" className="flex h-7 w-full items-center text-left text-[11px] text-destructive" style={{ paddingLeft: childPad }} data-testid="chat-side-panel-fs-child-error" onClick={() => retryDir(path)}>{t("chatPreviewRail.dirLoadError")} · {t("common.retry")}</button>;
    if (entries.length === 0 && attemptedPaths.has(path) && !loadingPaths.has(path) && !errorByPath[path]) return <div role="presentation" className="flex h-7 items-center text-[11px] italic text-muted-foreground" style={{ paddingLeft: childPad }} data-testid="chat-side-panel-fs-empty">{t("chatPreviewRail.dirEmpty")}</div>;
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
            onContextMenu={(event) => openNativeContextMenu(event, "workspace-entry", {
              "workspace.open": () => isDir ? toggleFolder(entry.path) : onOpenFile(entry.path, entry.file, activeRoot ?? undefined),
              "workspace.reveal": () => void revealEntry(entry.path),
              "workspace.copy-path": () => void navigator.clipboard?.writeText(entry.path),
              "workspace.copy-relative-path": () => void navigator.clipboard?.writeText(toRelativePath(activeRoot, entry.path)),
            })}>
            {isDir ? isOpen ? <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" /> : createElement(fileIcon(entry.name), { className: "h-3 w-3 shrink-0 text-muted-foreground" })}
            <span className={cn("min-w-0 flex-1 truncate", entry.change?.operation === "delete" && "text-muted-foreground line-through")}>{entry.name}</span>
            {entry.session && !isDir ? <span data-testid="chat-side-panel-file-session-badge" className={cn("shrink-0 rounded px-1 text-[10.5px] font-medium", SESSION_FILE_BADGE_CLASS)}>{t("chatPreviewRail.sessionFileBadge")}</span> : null}
            {incompleteStatusKey && !isDir ? <span data-testid="chat-side-panel-file-state" className="shrink-0 text-[10.5px] text-muted-foreground">{t(incompleteStatusKey)}</span> : null}
            {entry.change && !isDir ? <>
              <span className="shrink-0 font-mono text-[11px]" data-testid="chat-side-panel-file-change-counts"><span className={FILE_CHANGE_ADDED_CLASS}>+{entry.change.countsKnown ? entry.change.added : "—"}</span>{" "}<span className={FILE_CHANGE_REMOVED_CLASS}>−{entry.change.countsKnown ? entry.change.removed : "—"}</span></span>
              <span title={t("chatPreviewRail.fileOperation." + entry.change.operation)} data-testid="chat-side-panel-file-change-operation" className={cn("flex size-4 shrink-0 items-center justify-center rounded text-[10px] font-semibold", fileChangeBadgeClass(entry.change.operation))}>{fileChangeLetter(entry.change.operation)}</span>
            </> : null}
            {isDir && entry.changedDescendants > 0 && (filter === "all" || !isOpen) ? <span data-testid="chat-side-panel-folder-changes" aria-label={t("chatPreviewRail.changedDescendants", { count: entry.changedDescendants })} className={cn("min-w-4 shrink-0 rounded-full px-1 text-center text-[10.5px] font-semibold", FILE_CHANGE_FOLDER_BADGE_CLASS)}>{entry.changedDescendants}</span> : null}
          </div>
          {isDir && isOpen ? <div role="group">{renderEntries(entry.path, depth + 1, entry.children)}</div> : null}
        </div>;
      })}
      {truncatedPaths.has(path) ? <div role="presentation" className="flex h-6 items-center text-[11px] italic text-muted-foreground" style={{ paddingLeft: childPad }} data-testid="chat-side-panel-fs-truncated">{t("chatPreviewRail.dirTruncated")}</div> : null}
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
          <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-muted-foreground">
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
        {activeRoot && !activeRootIsDefault ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                data-testid="chat-side-panel-remove-root"
                aria-label={t("chatPreviewRail.removeRoot")}
                onClick={() => void removeActiveRoot()}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t("chatPreviewRail.removeRoot")}</TooltipContent>
          </Tooltip>
        ) : null}
      </div>
      {opError ? (
        <div
          role="alert"
          data-testid="chat-side-panel-op-error"
          className="flex items-start gap-1 rounded-md border border-destructive bg-destructive/(--opacity-muted) px-2 py-1 text-[11px] text-destructive"
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
      {opInfo ? (
        <div
          role="status"
          data-testid="chat-side-panel-op-info"
          className="flex items-start gap-1 rounded-md border bg-muted/(--opacity-muted) px-2 py-1 text-[11px] text-muted-foreground"
        >
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{opInfo}</span>
          <button
            type="button"
            className="shrink-0 rounded p-0.5 hover:bg-muted"
            aria-label={t("common.close")}
            data-testid="chat-side-panel-op-info-dismiss"
            onClick={() => setOpInfo(null)}
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ) : null}
      {pendingWarning ? (
        <div
          data-testid="chat-side-panel-root-warning"
          className="space-y-2 rounded-md border border-destructive bg-destructive/(--opacity-muted) p-2 text-[11px]"
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
      <div role="tree" aria-label={t("chatPreviewRail.projectRoots")} onKeyDown={onTreeKeyDown}>
        {activeRoot ? <>
          {loadingPaths.has(activeRoot) && !childrenByPath[activeRoot] ? <div className="px-2 py-1 text-[11px] text-muted-foreground">{t("chatPreviewRail.filePreviewLoading")}</div> : errorByPath[activeRoot] ? <button type="button" className="flex w-full items-center gap-1 px-2 py-1 text-left text-[11px] text-destructive hover:underline" data-testid="chat-side-panel-fs-error" onClick={() => retryDir(activeRoot)}>{t("chatPreviewRail.dirLoadError")} · {t("common.retry")}</button> : null}
          {renderEntries(activeRoot, 0, tree.nodes)}
        </> : <div className="flex flex-col items-start gap-2 px-2 py-3 text-[11px] text-muted-foreground" data-testid="chat-side-panel-roots-empty">
          <p>{t("chatPreviewRail.projectRootsEmpty")}</p>
          <Button type="button" size="sm" variant="outline" onClick={() => void addFolder()}><FolderPlus className="h-3.5 w-3.5" />{t("chatPreviewRail.addProjectRoot")}</Button>
        </div>}
        {tree.outsideNodes.length > 0 ? <div className="mt-2 border-t border-border pt-2" data-testid="chat-side-panel-outside-project">
          <div role="presentation" className="px-2 pb-1 text-[11px] font-medium text-muted-foreground">{t("chatPreviewRail.outsideProject")}</div>
          {renderEntries("", 0, tree.outsideNodes)}
        </div> : null}
      </div>
    </div>
  );
}

export function FileBrowserWorkspace({
  api, sessionId, files, targetById, selectedId, onSelect,
  changes: providedChanges, revealRequest, onReference, onFileReference,
}: {
  api: AveApi;
  sessionId?: string;
  files: WorkspaceFileItem[];
  targetById: Map<string, ChatPreviewTarget>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  changes?: WorkspaceChanges;
  revealRequest?: FileWorkspaceReveal | null;
  onReference?: (reference: FileMentionReference) => void;
  onFileReference?: (path: string) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<WorkspaceFileFilter>("all");
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
  useEffect(() => { setFsPath(null); setFsRoot(null); setQuery(""); setFilter("all"); setDetailVisible(false); }, [sessionId]);
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
    setDetailVisible(false);
  }, [revealRequest, changes.changedFiles, changes.onRefresh, onSelect]);
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
        <div role="group" aria-label={t("chatPreviewRail.fileFilterLabel")} className="flex gap-0.5 rounded-lg bg-muted p-0.5">
          {(["all", "changed", "session"] as const).map((value) => <button key={value} type="button" aria-pressed={filter === value}
            data-testid={`chat-side-panel-file-filter-${value}`} onClick={() => setFilter(value)}
            className={cn("h-7 min-w-0 flex-1 rounded-md px-1 text-[11px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring", filter === value ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>
            {t(value === "all" ? "chatPreviewRail.fileFilterAll" : value === "changed" ? "chatPreviewRail.fileFilterChanged" : "chatPreviewRail.fileFilterSession")}
            {value !== "all" ? <span className="ml-1 tabular-nums">{value === "changed" ? changes.changedFiles.length : changes.sessionFiles.length}</span> : null}
          </button>)}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-1.5 pb-2" onKeyDown={(event) => {
        if (event.key === "F6" && previewTarget && !narrow) { event.preventDefault(); detailRef.current?.focus(); }
      }}>
        <ProjectRootsBrowser files={files} changes={changes} filter={filter} query={query} selectedPath={selectedPath}
          onOpenFile={openFile} revealRequest={revealRequest} focusSelectedToken={focusSelectedToken} />
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
      {selectedChange?.review && selectedChange.turnId && (selectedChange.review.referenceable || selectedChange.review.hunks.length > 0 || selectedChange.review.operation === "delete") ? <TurnChangeDetail file={selectedChange.review} turnId={selectedChange.turnId} onReference={onReference} onFileReference={onFileReference} />
        : previewTarget ? <div className={cn("min-h-0 flex-1 overflow-auto p-3", previewFillsPanel(previewTarget) && "flex flex-col")}><PreviewDetail api={api} sessionId={sessionId} target={previewTarget} /></div>
          : <EmptyState>{t("chatPreviewRail.emptyState")}</EmptyState>}
    </div>
  </div>;
}


export function PreviewWorkspace({
  api,
  sessionId,
  targets,
  selectedId,
  onSelect,
}: {
  api: AveApi;
  sessionId?: string;
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
        <h3 className="mb-1 px-2 text-[11px] font-semibold uppercase text-muted-foreground">
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
          <EmptyState>{t("chatPreviewRail.noBrowserTargets")}</EmptyState>
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
}: {
  api: AveApi;
  tabId: string;
  targets: ChatPreviewTarget[];
  manualUrl: string | null;
  onManualUrlChange: (tabId: string, url: string | null) => void;
}) {
  const { t } = useTranslation();
  const guest = useWebSurfaceGuest(tabId);
  const navigation = useGuestNavigation(guest);
  const navigate = (action: () => void) => { void navigateBrowserTabAsUser(api, tabId, action); };
  const [addressDraft, setAddressDraft] = useState("");
  const [addressError, setAddressError] = useState<string | null>(null);
  const latestTarget = useMemo(
    () => targets.reduce<ChatPreviewTarget | null>(
      (latest, target) => (latest === null || target.createdOrder > latest.createdOrder ? target : latest),
      null,
    ),
    [targets],
  );

  useEffect(() => {
    setAddressDraft(navigation.url ?? manualUrl ?? (latestTarget?.kind === "url" ? latestTarget.url : ""));
    setAddressError(null);
  }, [navigation.url, manualUrl, latestTarget, tabId]);

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
        className="flex shrink-0 items-center gap-2 border-b px-3 py-2"
        onSubmit={(event) => {
          event.preventDefault();
          submitAddress();
        }}
      >
        <Button type="button" variant="ghost" size="icon" className="h-8 w-8 shrink-0"
          aria-label={t("mainPanels.back")} disabled={!navigation.canGoBack}
          onClick={() => navigate(() => guest?.goBack())} data-testid="browser-back">
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
        <Button type="button" variant="ghost" size="icon" className="h-8 w-8 shrink-0"
          aria-label={t("mainPanels.forward")} disabled={!navigation.canGoForward}
          onClick={() => navigate(() => guest?.goForward())} data-testid="browser-forward">
          <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
        <Button type="button" variant="ghost" size="icon" className="h-8 w-8 shrink-0"
          aria-label={t("mainPanels.reload")} disabled={!guest || !navigation.url}
          onClick={() => navigate(() => guest?.reload())} data-testid="browser-reload">
          <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
        <Globe className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <Input
          data-testid="chat-side-panel-browser-address"
          value={addressDraft}
          onChange={(event) => {
            setAddressDraft(event.target.value);
            if (addressError) setAddressError(null);
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
      <BrowserSurfaceTools api={api} tabId={tabId}
        onOpenUrl={(url) => { void navigateBrowserTabAsUser(api, tabId, () => onManualUrlChange(tabId, url)); }} />
      {addressError ? (
        <div className="shrink-0 border-b px-3 py-1.5 text-[11px] text-destructive" data-testid="chat-side-panel-browser-address-error">
          {addressError}
        </div>
      ) : null}
      <div className="min-h-0 w-full min-w-0 flex-1 overflow-hidden">
        {displayedTarget?.kind === "html" ? (
          <BrowserDocumentViewer target={displayedTarget} />
        ) : displayedTarget?.kind === "url" ? (
          <UrlDocumentViewer api={api} target={displayedTarget} showHeader={false} surfaceTabId={tabId} browserTab={{ tabId }} />
        ) : (
          <div className="p-4 text-xs text-muted-foreground" data-testid="chat-side-panel-browser-blank">{t("mainPanels.webEmpty")}</div>
        )}
      </div>
    </div>
  );
}
