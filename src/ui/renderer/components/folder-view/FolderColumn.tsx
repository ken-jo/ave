/** One column of the folder view: a folder's listing as tree items, or its empty, loading, locked or gone state. */
import { forwardRef, type KeyboardEvent } from "react";
import {
  ChevronRight, Database, File, FileCode, FileImage, FileSpreadsheet, FileText, Folder, Layers, Link2, Loader2, Lock,
  Presentation, RefreshCw, ScrollText, SquareTerminal,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Button } from "../../../../components/ui/button.js";
import { cn } from "../../../../lib/utils.js";
import { useTranslation } from "../../../../i18n/react.js";
import { formatBytes } from "../../../../lib/turn-summary-format.js";
import { MAX_TEXT_FILE_BYTES } from "../../../../shared/text-file-limits.js";
import { FOLDER_COLUMN_WIDTH, folderFileKind, type FolderColumn as FolderColumnState, type FolderEntry, type FolderFileKind } from "./folder-columns.js";

const KIND_ICONS: Record<FolderFileKind, LucideIcon> = {
  code: FileCode,
  markdown: FileText,
  image: FileImage,
  pdf: FileText,
  page: Presentation,
  table: FileSpreadsheet,
  database: Database,
  design: Layers,
  log: ScrollText,
  text: FileText,
  unknown: File,
};

/** Row and card glyph for an entry. */
export function folderEntryIcon(entry: Pick<FolderEntry, "name" | "type">, locked = false): LucideIcon {
  if (entry.type === "link") return Link2;
  if (entry.type === "directory") return locked ? Lock : Folder;
  return KIND_ICONS[folderFileKind(entry.name)];
}

export interface FolderColumnProps {
  column: FolderColumnState;
  index: number;
  /** The entry chosen in this column, if any. */
  selectedPath: string | undefined;
  /** True for the deepest column that has a selection: its choice is drawn dark, earlier ones grey. */
  isCurrent: boolean;
  focusedPath: string | undefined;
  locked: ReadonlySet<string>;
  onSelect: (entry: FolderEntry) => void;
  onFocusRow: (path: string) => void;
  onKey: (event: KeyboardEvent<HTMLElement>, entry: FolderEntry) => void;
  onRetry: () => void;
  onReveal: () => void;
  onOpenTerminal?: (() => void) | undefined;
  /** Where this column's rows register themselves so keyboard moves can focus them. */
  registerRow: (path: string, node: HTMLElement | null) => void;
}

function ColumnMessage({ icon: Icon, title, body, tone, children, testId }: {
  icon: LucideIcon;
  title: string;
  body?: string | undefined;
  tone?: "warning";
  children?: React.ReactNode;
  testId: string;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-1.5 px-4 py-6 text-center" data-testid={testId}>
      <span className={cn("flex h-9 w-9 items-center justify-center rounded-lg",
        tone === "warning" ? "bg-warning/(--opacity-subtle) text-warning" : "text-muted-foreground")}>
        <Icon aria-hidden="true" className="h-5 w-5" />
      </span>
      <div className="text-xs font-semibold text-foreground">{title}</div>
      {body ? <div className="text-[11px] leading-4 text-muted-foreground">{body}</div> : null}
      {children ? <div className="mt-1 flex flex-wrap justify-center gap-1.5">{children}</div> : null}
    </div>
  );
}

export const FolderColumn = forwardRef<HTMLDivElement, FolderColumnProps>(function FolderColumn({
  column, index, selectedPath, isCurrent, focusedPath, locked, onSelect, onFocusRow, onKey, onRetry, onReveal, onOpenTerminal, registerRow,
}, ref) {
  const { t } = useTranslation();
  const name = column.dir.split(/[\\/]/).filter(Boolean).pop() ?? column.dir;
  const body = (() => {
    if (column.status === "loading") {
      return <ColumnMessage icon={Loader2} title={t("folderView.loading")} testId="folder-column-loading" />;
    }
    if (column.status === "error") {
      const lockedOut = column.error === "permission-denied";
      return (
        <ColumnMessage icon={lockedOut ? Lock : File} tone={lockedOut ? "warning" : undefined} testId="folder-column-error"
          title={t(lockedOut ? "folderView.lockedTitle" : column.error === "not-found" ? "folderView.goneTitle" : "folderView.failedTitle")}
          body={lockedOut ? t("folderView.lockedBody") : undefined}>
          <Button type="button" size="sm" variant="outline" onClick={onRetry} data-testid="folder-column-retry">
            <RefreshCw aria-hidden="true" className="h-3.5 w-3.5" />{t("folderView.retry")}
          </Button>
          {column.error !== "not-found" ? (
            <Button type="button" size="sm" variant="outline" onClick={onReveal} data-testid="folder-column-reveal">
              {t(revealKey())}
            </Button>
          ) : null}
        </ColumnMessage>
      );
    }
    if (column.entries.length === 0) {
      return (
        <ColumnMessage icon={Folder} title={t("folderView.emptyTitle")} testId="folder-column-empty"
          body={column.hidden === 0 ? t("folderView.emptyNoHidden") : t("folderView.emptyHidden", { count: column.hidden })}>
          {onOpenTerminal ? (
            <Button type="button" size="sm" variant="outline" onClick={onOpenTerminal} data-testid="folder-column-terminal">
              <SquareTerminal aria-hidden="true" className="h-3.5 w-3.5" />{t("folderView.openTerminalHere")}
            </Button>
          ) : null}
        </ColumnMessage>
      );
    }
    // Exactly one row is tabbable: the focused one, else the chosen one, else the first.
    const tabbable = column.entries.some((entry) => entry.path === focusedPath) ? focusedPath
      : selectedPath ?? column.entries[0]?.path;
    return (
      <>
        {column.entries.map((entry) => {
          const selected = entry.path === selectedPath;
          const isLocked = entry.type === "directory" && locked.has(entry.path);
          const Icon = folderEntryIcon(entry, isLocked);
          const large = entry.type === "file" && entry.size > MAX_TEXT_FILE_BYTES;
          return (
            <div
              key={entry.path}
              ref={(node) => registerRow(entry.path, node)}
              role="treeitem"
              aria-level={index + 1}
              aria-selected={selected}
              aria-expanded={entry.type === "directory" ? selected : undefined}
              aria-disabled={entry.type === "link" ? true : undefined}
              tabIndex={entry.path === tabbable ? 0 : -1}
              data-testid="folder-row"
              data-path={entry.path}
              data-entry-type={entry.type}
              data-state={selected ? (isCurrent ? "selected" : "on-path") : undefined}
              draggable={entry.type !== "link"}
              onDragStart={(event) => event.dataTransfer.setData("text/plain", entry.path)}
              onClick={() => { onFocusRow(entry.path); onSelect(entry); }}
              onFocus={() => onFocusRow(entry.path)}
              onKeyDown={(event) => onKey(event, entry)}
              className={cn(
                "mx-1 flex h-7 cursor-default select-none items-center gap-2 rounded-md px-2 text-[13px] outline-none",
                "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                selected && isCurrent ? "bg-foreground text-background"
                  : selected ? "bg-muted text-foreground" : "hover:bg-muted/(--opacity-muted)",
                entry.type === "link" && "text-muted-foreground",
                isLocked && !(selected && isCurrent) && "text-warning",
              )}
            >
              <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />
              <span className={cn("min-w-0 flex-1 truncate", selected && isCurrent && "font-semibold")} title={entry.name}>{entry.name}</span>
              {entry.type === "link" && entry.outside ? (
                <span className="shrink-0 text-[10px] text-muted-foreground" data-testid="folder-row-outside">{t("folderView.outsideProject")}</span>
              ) : null}
              {large ? <span className="shrink-0 text-[10px] tabular-nums opacity-80">{formatBytes(entry.size)}</span> : null}
              {entry.type === "directory" ? <ChevronRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0 opacity-60" /> : null}
            </div>
          );
        })}
        {column.truncated ? (
          <div className="px-3 py-2 text-[11px] text-muted-foreground" data-testid="folder-column-truncated">{t("folderView.truncated")}</div>
        ) : null}
      </>
    );
  })();
  return (
    <div
      ref={ref}
      role="group"
      aria-label={name}
      data-testid="folder-column"
      data-dir={column.dir}
      className="flex h-full shrink-0 flex-col overflow-y-auto border-r py-1"
      style={{ width: FOLDER_COLUMN_WIDTH }}
    >
      {body}
    </div>
  );
});

/** The file manager the reveal action opens, named for this computer. */
export function revealKey(userAgent: string = globalThis.navigator?.userAgent ?? ""): string {
  if (/Macintosh|Mac OS X/iu.test(userAgent)) return "folderView.revealFinder";
  if (/Windows/iu.test(userAgent)) return "folderView.revealExplorer";
  return "folderView.revealFileManager";
}
