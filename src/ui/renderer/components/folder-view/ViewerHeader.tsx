/** The file viewer's header: the file's name and facts, and its actions. Actions sit in a row while the header is wide
 * enough for them and the title; below that width they move into one "more" menu, so none is pushed out of view. */
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, Ellipsis } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Button } from "../../../../components/ui/button.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../../../components/ui/dropdown-menu.js";
import { useTranslation } from "../../../../i18n/react.js";
import { folderEntryIcon } from "./FolderColumn.js";
import type { FolderEntry } from "./folder-columns.js";

/** One thing the user can do with the open file. A new action (an editor, for example) is one more entry in the list the
 * viewer passes; the header decides where it is drawn. */
export interface ViewerAction {
  id: string;
  label: string;
  icon: LucideIcon;
  onSelect: () => void;
  disabled?: boolean;
  /** Drawn with its label in the wide row; the others are icon buttons named by `label`. */
  labelled?: boolean;
  /** Offered in the menu only: the wide row draws its own control for it (`wideLead`). */
  menuOnly?: boolean;
}

/** Below this header width the action row and a readable title no longer fit side by side. */
export const VIEWER_HEADER_COMPACT_WIDTH = 560;

export function ViewerHeader({ entry, subtitle, actions, wideLead, back }: {
  entry: FolderEntry;
  subtitle: string;
  actions: readonly ViewerAction[];
  /** A control drawn before the action row while the header is wide (the Markdown view switch). */
  wideLead?: ReactNode;
  /** Narrow layout: the viewer replaced the columns and offers a way back. */
  back?: { label: string; onBack: () => void } | undefined;
}) {
  const { t } = useTranslation();
  const Icon = folderEntryIcon(entry);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState<number | null>(null);
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
  // A header that has not been laid out yet (no width) draws the row; the first measurement settles it before paint.
  const compact = width !== null && width > 0 && width < VIEWER_HEADER_COMPACT_WIDTH;
  let actionArea: ReactNode = null;
  if (actions.length > 0 && compact) {
    actionArea = (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" size="icon-xs" variant="ghost" aria-label={t("folderView.moreActions")} title={t("folderView.moreActions")}
            data-testid="folder-viewer-more" className="shrink-0">
            <Ellipsis aria-hidden="true" className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" data-testid="folder-viewer-more-menu">
          {actions.map((action) => (
            <DropdownMenuItem key={action.id} disabled={action.disabled} onSelect={action.onSelect}
              data-testid={`folder-viewer-action-${action.id}`} className="gap-2">
              <action.icon aria-hidden="true" className="h-3.5 w-3.5" />{action.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  } else if (actions.length > 0) {
    actionArea = (
      <div className="flex shrink-0 items-center gap-1" data-testid="folder-viewer-actions">
        {wideLead}
        {actions.filter((action) => !action.menuOnly).map((action) => action.labelled ? (
          <Button key={action.id} type="button" size="sm" variant="outline" disabled={action.disabled} onClick={action.onSelect}
            data-testid={`folder-viewer-action-${action.id}`}>
            <action.icon aria-hidden="true" className="h-3.5 w-3.5" />{action.label}
          </Button>
        ) : (
          <Button key={action.id} type="button" size="icon-xs" variant="ghost" disabled={action.disabled}
            onClick={action.onSelect} aria-label={action.label} title={action.label}
            data-testid={`folder-viewer-action-${action.id}`}>
            <action.icon aria-hidden="true" className="h-3.5 w-3.5" />
          </Button>
        ))}
      </div>
    );
  }
  return (
    <div ref={rootRef} className="flex min-w-0 shrink-0 items-center gap-2 border-b px-3 py-2" data-testid="folder-viewer-header"
      data-compact={compact ? "true" : undefined}>
      {back ? (
        <Button type="button" size="sm" variant="outline" onClick={back.onBack} data-testid="folder-viewer-back" className="max-w-[40%] shrink-0">
          <ChevronLeft aria-hidden="true" className="h-3.5 w-3.5 shrink-0" /><span className="truncate">{back.label}</span>
        </Button>
      ) : null}
      <Icon aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-body-sm font-semibold" title={entry.name}>{entry.name}</div>
        <div className="truncate text-dense text-muted-foreground" data-testid="folder-viewer-subtitle">{subtitle}</div>
      </div>
      {actionArea}
    </div>
  );
}
