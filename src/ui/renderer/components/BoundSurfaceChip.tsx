import { Globe, Terminal } from "lucide-react";
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
 * A pane chat's target chip: the terminal or page of the pane this chat sits
 * in, which its tools act on by default. The binding is the pane's, so the
 * chip names it and offers nothing to change it.
 */
export function BoundSurfaceChip({ surface }: { surface: BoundSurface }) {
  const { t } = useTranslation();
  const Icon = surface.kind === "browser" ? Globe : Terminal;
  return (
    <div className="mb-1.5 flex min-w-0" data-testid="side-chat-target">
      <span
        className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-full border border-border bg-muted/(--opacity-muted) px-2 py-0.5 text-[11px] text-foreground"
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
      </span>
    </div>
  );
}
