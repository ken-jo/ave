import type { LucideIcon } from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip.js";

/** Lifecycle subjects share one pill shape and height; tones come from semantic theme tokens. */
type ToolbarStatusPillTone = "info" | "muted" | "success" | "warning" | "destructive";

/** Full class strings per tone rather than an interpolated token name: the stylesheet build scans source text for
 * utilities, and a name assembled at runtime is not there to be found. */
const TONE_CLASS: Record<ToolbarStatusPillTone, string> = {
  info: "text-info border-info/(--opacity-medium) bg-info/(--opacity-subtle) hover:bg-info/(--opacity-light)",
  muted: "text-muted-foreground border-border bg-muted/(--opacity-medium)",
  success: "text-success border-success/(--opacity-medium) bg-success/(--opacity-subtle) hover:bg-success/(--opacity-light)",
  warning: "text-warning border-warning/(--opacity-medium) bg-warning/(--opacity-subtle) hover:bg-warning/(--opacity-light)",
  destructive:
    "text-destructive border-destructive/(--opacity-medium) bg-destructive/(--opacity-subtle) hover:bg-destructive/(--opacity-light)",
};

/** Use aria-disabled to keep tooltip progress reachable by pointer and keyboard; explicitly suppress hover tint for inert
 * pills. */
const TONE_INERT_CLASS: Record<ToolbarStatusPillTone, string> = {
  info: "aria-disabled:hover:bg-info/(--opacity-subtle) aria-disabled:hover:text-info",
  muted: "aria-disabled:hover:bg-muted/(--opacity-medium) aria-disabled:hover:text-muted-foreground",
  success: "aria-disabled:hover:bg-success/(--opacity-subtle) aria-disabled:hover:text-success",
  warning: "aria-disabled:hover:bg-warning/(--opacity-subtle) aria-disabled:hover:text-warning",
  destructive:
    "aria-disabled:hover:bg-destructive/(--opacity-subtle) aria-disabled:hover:text-destructive",
};

/** The trailing icon-only control: skip a version, dismiss a report. */
interface ToolbarStatusPillAction {
  icon: LucideIcon;
  title: string;
  ariaLabel: string;
  onClick: () => void;
  testId: string;
  disabled?: boolean;
}

export interface ToolbarStatusPillProps {
  tone: ToolbarStatusPillTone;
  icon: LucideIcon;
  /** The pill's visible text. Short — it shares the band with everything else. */
  label: string;
  /** Hover text and tooltip body. The place the long form goes. */
  title: string;
  ariaLabel: string;
  /** Rendered inside the pill after the label — a keyboard hint, a count. It is decoration on top of `label`, not a second
   * label: `ariaLabel` already carries everything a reader needs, so the pill reads the same without it. */
  trailing?: React.ReactNode;
  /** Work is in flight: the icon spins and the cursor reads as progress. */
  busy?: boolean;
  onClick?: () => void;
  /** Present but not actionable. The pill stays hoverable and focusable so the tooltip — where the long form lives — can
   * still be reached. */
  disabled?: boolean;
  testId: string;
  secondaryAction?: ToolbarStatusPillAction;
}

export function ToolbarStatusPill({
  tone,
  icon: Icon,
  label,
  title,
  ariaLabel,
  trailing,
  busy = false,
  onClick,
  disabled = false,
  testId,
  secondaryAction,
}: ToolbarStatusPillProps) {
  const pill = (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={`h-(--chrome-control-height) gap-1 border px-2 text-[11px] font-medium aria-disabled:opacity-60 ${TONE_CLASS[tone]} ${TONE_INERT_CLASS[tone]}${busy ? " cursor-progress" : ""}`}
          onClick={disabled ? undefined : onClick}
          aria-disabled={disabled}
          title={title}
          aria-label={ariaLabel}
          data-testid={testId}
        >
          <Icon className={busy ? "h-3 w-3 animate-spin" : "h-3 w-3"} />
          <span>{label}</span>
          {trailing}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{title}</TooltipContent>
    </Tooltip>
  );

  if (!secondaryAction) return pill;

  const { icon: ActionIcon } = secondaryAction;
  return (
    <div className="flex items-center gap-1">
      {pill}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-(--chrome-control-height) w-(--chrome-control-height) aspect-square text-muted-foreground hover:text-foreground aria-disabled:opacity-60 aria-disabled:hover:bg-transparent aria-disabled:hover:text-muted-foreground"
            onClick={secondaryAction.disabled ? undefined : secondaryAction.onClick}
            aria-disabled={secondaryAction.disabled}
            title={secondaryAction.title}
            aria-label={secondaryAction.ariaLabel}
            data-testid={secondaryAction.testId}
          >
            <ActionIcon className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{secondaryAction.title}</TooltipContent>
      </Tooltip>
    </div>
  );
}
