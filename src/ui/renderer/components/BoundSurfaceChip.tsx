import { Globe, Terminal, X } from "lucide-react";
import { useTranslation } from "../../../i18n/react.js";

/** The pane tab a pane chat is bound to, as its chip names it. */
export interface BoundSurface {
  kind: "browser" | "terminal";
  tabId: string;
  /** A page's title or host; a terminal's label. */
  name: string;
  /** A page's host, a terminal's directory — when it adds to the name. */
  detail: string | null;
  /** The full address or directory behind `detail`. */
  detailTitle: string | null;
}

/**
 * A chat's target chip: the terminal or page its tools act on by default.
 * A pane chat's target is its pane, so its chip offers nothing to change it;
 * the rail's follows the window's active surface and offers `onRemove` (×).
 */
export function BoundSurfaceChip({ surface, onRemove }: { surface: BoundSurface; onRemove?: () => void }) {
  const { t } = useTranslation();
  const Icon = surface.kind === "browser" ? Globe : Terminal;
  return (
    <div className="mb-1.5 flex min-w-0" data-testid="side-chat-target">
      <span
        className={`inline-flex min-w-0 max-w-full items-center gap-1 rounded-full border border-border bg-muted/(--opacity-muted) py-0.5 pl-2 text-[11px] text-foreground ${onRemove ? "pr-0.5" : "pr-2"}`}
        data-surface-kind={surface.kind}
        data-tab-id={surface.tabId}
        title={t("sideChatTarget.label")}
      >
        <Icon className="h-3 w-3 shrink-0" aria-hidden="true" />
        <span className="min-w-0 truncate" data-testid="side-chat-target-name">{surface.name}</span>
        {surface.detail ? (
          <span className="min-w-0 truncate text-muted-foreground" title={surface.detailTitle ?? undefined} data-testid="side-chat-target-detail">
            {surface.detail}
          </span>
        ) : null}
        {onRemove ? (
          <button
            type="button"
            className="ml-0.5 shrink-0 rounded-full p-0.5 text-muted-foreground hover:bg-background/(--opacity-muted) hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
            aria-label={t("sideChatTarget.remove")}
            title={t("sideChatTarget.remove")}
            data-testid="side-chat-target-remove"
            onClick={onRemove}
          >
            <X className="h-3 w-3" />
          </button>
        ) : null}
      </span>
    </div>
  );
}
