/** Folder view: the project's files as Finder columns with a file viewer in the last slot (sidebar cases 15, 23–27, 32–38).
 * Listing goes through `workspace.listDir`, previews through the existing preview readers, and "open in default app"
 * through `workspace.openPath` from a click or key handler only. */
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type KeyboardEvent } from "react";
import { ChevronRight, FileText, MessageSquare, Search } from "lucide-react";
import { Button } from "../../../../components/ui/button.js";
import { Input } from "../../../../components/ui/input.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../../../components/ui/dropdown-menu.js";
import { cn } from "../../../../lib/utils.js";
import { useTranslation } from "../../../../i18n/react.js";
import type { FolderLocation } from "../../preview/main-surfaces.js";
import { isInsideRoot, prefixesUnderRoot } from "../../utils/project-path.js";
import type { AttachTextResult } from "../../preview/composer-targets.js";
import { FileViewer } from "./FileViewer.js";
import { FolderColumn } from "./FolderColumn.js";
import {
  collapseMiddle,
  columnsHiddenLeft,
  currentFolder,
  folderKeyIntent,
  folderReducer,
  initialFolderState,
  pathSegments,
  relativeToRoot,
  viewerEntry,
  viewerReplacesColumns,
  type FolderEntry,
} from "./folder-columns.js";

const SEARCH_DEBOUNCE_MS = 200;
const SEARCH_RESULT_LIMIT = 20;

export interface FolderViewProps {
  /** The project root; the first column lists it and nothing outside it is offered. */
  projectRoot: string;
  /** Open a terminal in a folder (empty-folder action, case 23). */
  onOpenTerminal?: ((dir: string) => void) | undefined;
  /** Hand a file reference to the last-used chat composer. */
  onAttachText?: ((text: string) => AttachTextResult) | undefined;
  /** Open a side chat about `path`, the file being viewed or else the deepest open folder (case 25). */
  onOpenSideChat?: ((path: string) => void) | undefined;
  /** Where a restored view was: its columns reopen on this folder and item. */
  initialLocation?: FolderLocation | undefined;
  /** The deepest open folder and the selected item, reported whenever they change, for the saved layout. */
  onLocationChange?: ((location: FolderLocation) => void) | undefined;
}

/** The folders between the root and `path`, outermost first, then `path` itself, in `path`'s own spelling (listDir's). */
function chainTo(root: string, path: string): string[] {
  return prefixesUnderRoot(root, path) ?? [];
}

export function FolderView({ projectRoot, onOpenTerminal, onAttachText, onOpenSideChat, initialLocation, onLocationChange }: FolderViewProps) {
  const { t } = useTranslation();
  const [state, dispatch] = useReducer(folderReducer, projectRoot, initialFolderState);
  const [focusedPath, setFocusedPath] = useState<string | undefined>(undefined);
  const [width, setWidth] = useState<number | null>(null);
  // Narrow layout: the open file replaces the columns until the user goes back to them (case 37).
  const [columnsRequested, setColumnsRequested] = useState(false);
  const [hiddenLeft, setHiddenLeft] = useState(0);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<Array<{ path: string; relativePath: string }> | null>(null);
  // A restored view walks back to where it was, one listing at a time, like a search result.
  const [revealQueue, setRevealQueue] = useState<string[]>(() => {
    const target = initialLocation?.selection ?? initialLocation?.path;
    return target && target !== projectRoot && isInsideRoot(projectRoot, target) ? chainTo(projectRoot, target) : [];
  });
  const rootRef = useRef<HTMLDivElement | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<HTMLDivElement | null>(null);
  const rows = useRef(new Map<string, HTMLElement>());
  const requested = useRef(new Set<string>());
  const pendingFocus = useRef<"first-row-of-last" | null>(null);
  // Focus that must wait for the next commit: a row that remounts with the columns, or the viewer that mounts with a file.
  const deferredFocus = useRef<{ row: string } | "viewer" | null>(null);

  const registerRow = useCallback((path: string, node: HTMLElement | null) => {
    if (node) rows.current.set(path, node);
    else rows.current.delete(path);
  }, []);
  const focusRow = useCallback((path: string | undefined) => {
    if (!path) return;
    setFocusedPath(path);
    rows.current.get(path)?.focus();
  }, []);

  // Load every column still waiting for its listing, once per request.
  useEffect(() => {
    for (const column of state.columns) {
      if (column.status !== "loading" || requested.current.has(column.dir)) continue;
      requested.current.add(column.dir);
      const dir = column.dir;
      void window.ave.workspace.listDir(dir).then(
        (result) => { requested.current.delete(dir); dispatch({ type: "loaded", dir, result }); },
        () => { requested.current.delete(dir); dispatch({ type: "loaded", dir, result: { ok: false, error: "read-failed" } }); },
      );
    }
  }, [state.columns]);

  // The first row of the project root takes focus when the view opens (case 15).
  const rootColumn = state.columns[0];
  const initialFocusDone = useRef(false);
  useEffect(() => {
    if (initialFocusDone.current || rootColumn?.status !== "ok") return;
    initialFocusDone.current = true;
    focusRow(rootColumn.entries[0]?.path);
  }, [rootColumn, focusRow]);

  // After → or Enter opened a folder, its first row takes focus once it is listed.
  const lastColumn = state.columns[state.columns.length - 1];
  useEffect(() => {
    if (pendingFocus.current !== "first-row-of-last" || lastColumn?.status === "loading") return;
    pendingFocus.current = null;
    const first = lastColumn?.entries[0]?.path;
    if (first) focusRow(first);
  }, [lastColumn, focusRow]);

  // A search result opens its folders one listing at a time, choosing the real entry from each.
  useEffect(() => {
    const [next, ...rest] = revealQueue;
    if (!next) return;
    const index = state.columns.findIndex((column) => column.status === "ok" && column.entries.some((entry) => entry.path === next));
    if (index < 0) {
      // The parent listing is still loading; a failed or finished listing without the entry ends the reveal.
      if (state.columns.some((column) => column.status === "loading")) return;
      setRevealQueue([]);
      return;
    }
    const entry = state.columns[index]!.entries.find((each) => each.path === next)!;
    dispatch({ type: "select", column: index, entry });
    setRevealQueue(rest);
    if (rest.length === 0) setFocusedPath(entry.path);
  }, [revealQueue, state.columns]);

  useEffect(() => {
    const target = deferredFocus.current;
    if (target === null) return;
    if (target === "viewer") {
      if (!viewerRef.current) return;
      viewerRef.current.focus();
    } else {
      const node = rows.current.get(target.row);
      if (!node) return;
      setFocusedPath(target.row);
      node.focus();
    }
    deferredFocus.current = null;
  });

  useLayoutEffect(() => {
    const node = rootRef.current;
    if (!node) return;
    const measure = () => setWidth(node.getBoundingClientRect().width);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const viewing = viewerEntry(state);
  const narrow = width !== null && viewerReplacesColumns(width);
  const showViewerOnly = narrow && viewing !== null && !columnsRequested;
  // Each newly chosen file takes the narrow view again.
  useEffect(() => { setColumnsRequested(false); }, [viewing?.path]);

  // Keep the deepest column in view and count the ones scrolled away (case 24).
  const updateHiddenLeft = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) { setHiddenLeft(0); return; }
    const left = scroller.getBoundingClientRect().left;
    const rights = [...scroller.querySelectorAll<HTMLElement>("[data-testid='folder-column']")]
      .map((column) => column.getBoundingClientRect().right - left + scroller.scrollLeft);
    setHiddenLeft(columnsHiddenLeft(rights, scroller.scrollLeft));
  }, []);
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || showViewerOnly) return;
    scroller.scrollLeft = scroller.scrollWidth;
    updateHiddenLeft();
  }, [state.columns.length, showViewerOnly, width, viewing?.path, updateHiddenLeft]);

  const select = useCallback((column: number, entry: FolderEntry) => {
    dispatch({ type: "select", column, entry });
    // Choosing a file again after going back to the columns shows it again.
    if (entry.type !== "directory") setColumnsRequested(false);
  }, []);

  const backToColumns = useCallback(() => {
    setColumnsRequested(true);
    if (viewing) deferredFocus.current = { row: viewing.path };
  }, [viewing]);

  const onRowKey = useCallback((event: KeyboardEvent<HTMLElement>, columnIndex: number, entry: FolderEntry) => {
    const intent = folderKeyIntent(event.key);
    if (!intent) return;
    event.preventDefault();
    const column = state.columns[columnIndex];
    if (!column) return;
    const at = column.entries.findIndex((each) => each.path === entry.path);
    if (intent === "up" || intent === "down") {
      const next = column.entries[at + (intent === "up" ? -1 : 1)];
      if (next) focusRow(next.path);
      return;
    }
    if (intent === "back") {
      const parent = state.selected[columnIndex - 1];
      if (parent) focusRow(parent.path);
      return;
    }
    if (intent === "open") {
      if (entry.type === "directory") pendingFocus.current = "first-row-of-last";
      select(columnIndex, entry);
      return;
    }
    // Space: preview the row and put focus in the viewer; Esc there comes back here.
    if (entry.type === "directory") { select(columnIndex, entry); return; }
    select(columnIndex, entry);
    deferredFocus.current = "viewer";
  }, [state.columns, state.selected, focusRow, select]);

  const onViewerKey = useCallback((event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape" || (showViewerOnly && event.key === "ArrowLeft" && event.target === viewerRef.current)) {
      event.preventDefault();
      if (showViewerOnly) { backToColumns(); return; }
      focusRow(viewing?.path);
    }
  }, [showViewerOnly, backToColumns, focusRow, viewing]);

  // "Find in this folder": the workspace search, kept to the deepest open folder.
  const folder = currentFolder(state);
  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) { setMatches(null); return; }
    let cancelled = false;
    const timer = setTimeout(() => {
      void window.ave.workspace.searchFiles(trimmed).then((result) => {
        if (cancelled) return;
        setMatches(result.ok ? result.matches.filter((match) => isInsideRoot(folder, match.path)).slice(0, SEARCH_RESULT_LIMIT) : []);
      }, () => { if (!cancelled) setMatches([]); });
    }, SEARCH_DEBOUNCE_MS);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query, folder]);
  // Report where the view is once it has settled; a restore in progress has not got there yet.
  const onLocationChangeRef = useRef(onLocationChange);
  onLocationChangeRef.current = onLocationChange;
  const selectionPath = state.selected[state.selected.length - 1]?.path ?? null;
  const settled = revealQueue.length === 0;
  useEffect(() => {
    if (settled) onLocationChangeRef.current?.({ path: folder, selection: selectionPath });
  }, [folder, selectionPath, settled]);

  const reveal = useCallback((path: string) => {
    setQuery("");
    setMatches(null);
    dispatch({ type: "truncate", column: 0 });
    setRevealQueue(chainTo(projectRoot, path));
  }, [projectRoot]);

  // A path crumb makes that folder the deepest open column again.
  const goToDir = useCallback((dir: string) => {
    const index = state.columns.findIndex((column) => column.dir === dir);
    if (index < 0) return;
    dispatch({ type: "truncate", column: index });
    focusRow(state.columns[index]?.entries[0]?.path);
  }, [state.columns, focusRow]);

  const crumbDirs = useMemo(() => {
    const dirs = [projectRoot, ...chainTo(projectRoot, folder)];
    return dirs.map((dir) => ({ dir, name: pathSegments(projectRoot, dir).pop() ?? dir }));
  }, [projectRoot, folder]);
  const crumbs = collapseMiddle(crumbDirs);
  const deepestSelected = state.selected.length - 1;
  const counts = lastColumn?.status === "ok"
    ? { folders: lastColumn.entries.filter((entry) => entry.type === "directory").length,
      files: lastColumn.entries.filter((entry) => entry.type !== "directory").length } : null;
  const statusLeft = viewing
    ? relativeToRoot(projectRoot, viewing.path)
    : `${relativeToRoot(projectRoot, folder) || pathSegments(projectRoot, projectRoot)[0]}${lastColumn?.status === "error"
      ? ` · ${t("folderView.statusUnreadable")}`
      : counts ? ` · ${t("folderView.statusCounts", { folders: counts.folders, files: counts.files })}` : ""}`;
  const parentName = viewing ? (pathSegments(projectRoot, viewing.path).slice(-2, -1)[0] ?? "") : "";

  const crumb = (each: { dir: string; name: string }, last: boolean) => (
    <button key={each.dir} type="button" onClick={() => goToDir(each.dir)} title={each.dir}
      className={cn("max-w-40 truncate rounded px-1 text-xs hover:bg-muted", last ? "font-semibold text-foreground" : "text-muted-foreground")}>
      {each.name}
    </button>
  );
  const separator = (key: string) => <ChevronRight key={key} aria-hidden="true" className="h-3 w-3 shrink-0 text-muted-foreground" />;

  return (
    <div ref={rootRef} className="flex h-full min-h-0 min-w-0 flex-1 flex-col" data-testid="folder-view" data-narrow={narrow ? "true" : undefined}>
      <div className="flex min-w-0 shrink-0 items-center gap-2 border-b px-3 py-1.5">
        <nav aria-label={t("folderView.pathLabel")} className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden" data-testid="folder-path">
          {crumbs.head.flatMap((each, index) => [
            ...(index > 0 ? [separator(`s-${each.dir}`)] : []),
            crumb(each, crumbs.tail.length === 0 && index === crumbs.head.length - 1),
          ])}
          {crumbs.hidden.length > 0 ? (
            <>
              {separator("s-hidden")}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button type="button" className="rounded border px-1 text-xs text-muted-foreground" aria-label={t("folderView.pathHidden")}
                    data-testid="folder-path-ellipsis">…</button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  {crumbs.hidden.map((each) => (
                    <DropdownMenuItem key={each.dir} onSelect={() => goToDir(each.dir)}>{each.name}</DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          ) : null}
          {crumbs.tail.flatMap((each, index) => [separator(`s-${each.dir}`), crumb(each, index === crumbs.tail.length - 1)])}
        </nav>
        <div className="relative w-48 shrink-0">
          <Search aria-hidden="true" className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("folderView.searchPlaceholder")}
            aria-label={t("folderView.searchPlaceholder")} className="h-7 pl-7 text-xs" data-testid="folder-search"
            onKeyDown={(event) => { if (event.key === "Escape") { setQuery(""); setMatches(null); } }} />
          {matches !== null ? (
            <div role="listbox" aria-label={t("folderView.searchResults")} data-testid="folder-search-results"
              className="absolute right-0 top-8 z-20 max-h-72 w-72 overflow-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md">
              {matches.length === 0 ? <div className="px-2 py-1.5 text-xs text-muted-foreground">{t("folderView.searchNone")}</div>
                : matches.map((match) => (
                  <button key={match.path} type="button" role="option" aria-selected={false} onClick={() => reveal(match.path)}
                    className="flex w-full min-w-0 items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-muted">
                    <FileText aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate" title={match.path}>{relativeToRoot(folder, match.path)}</span>
                  </button>
                ))}
            </div>
          ) : null}
        </div>
        {onOpenSideChat ? (
          <Button type="button" size="sm" variant="outline" onClick={() => onOpenSideChat(viewing?.path ?? folder)} data-testid="folder-side-chat">
            <MessageSquare aria-hidden="true" className="h-3.5 w-3.5" />{t("folderView.sideChat")}
          </Button>
        ) : null}
      </div>

      <div role="tree" aria-label={t("folderView.treeLabel")} className="flex min-h-0 flex-1" data-testid="folder-body">
        {showViewerOnly ? null : (
          <div ref={scrollerRef} onScroll={updateHiddenLeft} data-testid="folder-columns"
            className={cn("flex min-h-0 min-w-0 shrink overflow-x-auto overflow-y-hidden", viewing && !narrow ? "max-w-[calc(100%-380px)]" : "max-w-full")}>
            {state.columns.map((column, index) => (
              <FolderColumn
                key={column.dir}
                column={column}
                index={index}
                selectedPath={state.selected[index]?.path}
                isCurrent={index === deepestSelected}
                focusedPath={focusedPath}
                locked={state.locked}
                onSelect={(entry) => select(index, entry)}
                onFocusRow={setFocusedPath}
                onKey={(event, entry) => onRowKey(event, index, entry)}
                onRetry={() => dispatch({ type: "retry", dir: column.dir })}
                onReveal={() => void window.ave.workspace.reveal(column.dir)}
                onOpenTerminal={onOpenTerminal ? () => onOpenTerminal(column.dir) : undefined}
                registerRow={registerRow}
              />
            ))}
          </div>
        )}
        {viewing && (!narrow || showViewerOnly) ? (
          <div className="flex min-h-0 min-w-0 flex-1" onKeyDown={onViewerKey}>
            <FileViewer
              key={viewing.path}
              ref={viewerRef}
              projectRoot={projectRoot}
              entry={viewing}
              onAttachText={onAttachText}
              back={showViewerOnly ? { label: parentName, onBack: backToColumns } : undefined}
            />
          </div>
        ) : !viewing && state.columns.length === 1 && rootColumn?.status === "ok" && rootColumn.entries.length > 0 ? (
          <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-2 text-xs text-muted-foreground" data-testid="folder-hint">
            <FileText aria-hidden="true" className="h-6 w-6" />
            <div className="text-[13px] text-foreground">{t("folderView.hintTitle")}</div>
            <div>{t("folderView.hintKeys")}</div>
          </div>
        ) : showViewerOnly ? null : <div aria-hidden="true" className="min-w-0 flex-1" />}
      </div>

      <div className="flex min-w-0 shrink-0 items-center gap-3 border-t px-3 py-1 text-[11px] text-muted-foreground" data-testid="folder-status">
        <span className="min-w-0 flex-1 truncate" title={viewing?.path ?? folder}>{statusLeft}</span>
        <span className="shrink-0" data-testid="folder-status-right">
          {showViewerOnly ? t("folderView.statusBackToColumns")
            : hiddenLeft > 0 ? t("folderView.statusHiddenLeft", { count: hiddenLeft }) : t("folderView.statusScope")}
        </span>
      </div>
    </div>
  );
}
