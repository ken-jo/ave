/** The file viewer's header: the file's name and facts, and its actions in a row. */
import type { ReactNode } from "react";
import { ChevronLeft } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Button } from "../../../../components/ui/button.js";
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
}

export function ViewerHeader({ entry, subtitle, actions, wideLead, back }: {
  entry: FolderEntry;
  subtitle: string;
  actions: readonly ViewerAction[];
  /** A control drawn before the action row (the Markdown view switch). */
  wideLead?: ReactNode;
  /** Narrow layout: the viewer replaced the columns and offers a way back. */
  back?: { label: string; onBack: () => void } | undefined;
}) {
  const Icon = folderEntryIcon(entry);
  const actionArea = actions.length > 0 ? (
    <div className="flex shrink-0 items-center gap-1" data-testid="folder-viewer-actions">
      {wideLead}
      {actions.map((action) => action.labelled ? (
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
  ) : null;
  return (
    <div className="flex min-w-0 shrink-0 items-center gap-2 border-b px-3 py-2" data-testid="folder-viewer-header">
      {back ? (
        <Button type="button" size="sm" variant="outline" onClick={back.onBack} data-testid="folder-viewer-back" className="shrink-0">
          <ChevronLeft aria-hidden="true" className="h-3.5 w-3.5" />{back.label}
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
