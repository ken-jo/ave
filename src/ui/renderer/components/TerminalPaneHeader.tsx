/**
 * A host terminal's identity and block controls as one row, the way a conversation pane's header carries its controls:
 * a compact host chip whose tooltip says what the shell is and what stays private, then the block history and
 * attach-last controls. In a pane the row sits inside the pane's header and the directory is the header's own meta; in
 * a conversation's side panel the row is the terminal's only chrome and carries the directory's last segment itself.
 */
import type { ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip.js";

/** The last segment of a directory path — a header has room for a name, not a path. */
export function directoryName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || "/";
}

/** What the agent may do in this terminal: a word for the chip, and the full statement for its tooltip. */
export interface TerminalPaneAccess {
  chip: string;
  about: readonly string[];
}

export function TerminalPaneHeader({ blocks, cwdNote, inline, access }: {
  blocks: ReactNode;
  access: TerminalPaneAccess;
  /** Where the shell started, while it has not reported a current directory. */
  cwdNote: string | null;
  /** The side-panel row: the row shows the shell-reported directory itself. */
  inline?: { cwd: string | null };
}) {
  const about = [...access.about, cwdNote].filter(Boolean).join("\n");
  const chip = (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} aria-label={about} title={about} data-testid="terminal-pane-host-chip"
          className="shrink-0 whitespace-nowrap rounded bg-primary/(--opacity-subtle) px-1.5 py-0.5 text-[11px] font-medium text-primary outline-none focus-visible:ring-1 focus-visible:ring-ring">
          {access.chip}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-72 whitespace-pre-line">{about}</TooltipContent>
    </Tooltip>
  );
  if (!inline) {
    return (
      <span className="flex min-w-0 shrink-0 items-center gap-(--chrome-gap-tight)" data-testid="terminal-pane-header">
        {chip}
        {blocks}
      </span>
    );
  }
  return (
    <div className="flex h-9 min-w-0 shrink-0 items-center gap-(--chrome-gap-tight) border-b border-border px-2 text-xs" data-testid="terminal-pane-header">
      {chip}
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground" title={inline.cwd ?? undefined} data-testid="terminal-pane-cwd">
        {inline.cwd ? directoryName(inline.cwd) : ""}
      </span>
      {blocks}
    </div>
  );
}
