/**
 * A terminal pane's identity and block controls, drawn inside the pane's single header row the way a conversation
 * pane's header carries its controls: a compact host chip whose tooltip says what the shell is and what stays private,
 * then the block history and attach-last controls. The directory is the header's own meta, after the title.
 */
import type { ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip.js";
import { useTranslation } from "../../../i18n/react.js";

export function TerminalPaneHeader({ blocks, cwdNote }: {
  blocks: ReactNode;
  /** Where the shell started, while it has not reported a current directory for the header's meta. */
  cwdNote: string | null;
}) {
  const { t } = useTranslation();
  const about = [t("ptyTerminal.hostBadge"), t("ptyTerminal.manualEnvironment"), cwdNote].filter(Boolean).join("\n");
  return (
    <span className="flex min-w-0 shrink-0 items-center gap-(--chrome-gap-tight)" data-testid="terminal-pane-header">
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0} aria-label={about} title={about} data-testid="terminal-pane-host-chip"
            className="shrink-0 rounded bg-primary/(--opacity-subtle) px-1.5 py-0.5 text-[11px] font-medium text-primary outline-none focus-visible:ring-1 focus-visible:ring-ring">
            {t("ptyTerminal.hostChip")}
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-72 whitespace-pre-line">{about}</TooltipContent>
      </Tooltip>
      {blocks}
    </span>
  );
}
