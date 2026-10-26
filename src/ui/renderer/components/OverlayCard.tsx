// Only summaries and session ids enter overlay cards; full content stays in conversation sessions. Proposal dispositions
// are stored answers, not timed snoozes.

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Loader2, X } from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../../components/ui/card.js";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../../../components/ui/tooltip.js";
import { useTranslation } from "../../../i18n/react.js";
import { formatMediumDateTime, formatRelativeTime, type RelativeTimeLabels } from "../../../shared/format-time.js";

export interface OverlayCardProps {
  /** Card title — routine name or plugin-supplied title */
  title: string;
  summary: string;
  firedAt: string;
  /** true = LLM session in-flight; false = session complete or plugin proposal */
  running: boolean;
  /** 1-based index within visible queue */
  queueIndex: number;
  /** Total visible queue length */
  queueTotal: number;
  onPrev: () => void;
  onNext: () => void;
  onDismiss: () => void;
  /**
   * Called when the user clicks the primary action button.
   * When undefined, the primary action button is not rendered
   * (e.g. notification-only routine with no conversation session, or a staged
   * card whose origin conversation is no longer open).
   */
  onPrimaryAction?: () => void;

  primaryActionLabel?: string;
  /** A second answer beside the primary one, drawn quieter — an insertion card's "continue in a new conversation". Shown only
   * with a primary action. */
  secondaryAction?: { label: string; onClick: () => void };

  /** Whether the summary is expanded, and how to change it. Controlled by the overlay queue rather than held here: the card
   * unmounts when it moves between tiles, and local state would collapse the summary the user just opened. */
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;

  /** `app` = an MCP App's `ui/message` staged for user confirmation (no turn in flight). */
  kind?: "routine" | "plugin" | "app" | "host";
  /** Host-bound identity and resolved display name for a plugin card. */
  pluginId?: string;
  pluginDisplayName?: string;

  /** Proposal dispositions store one answer; accepting runs the action and refusals differ in whether the question may
   * return. */
  dispositions?: {
    onAccept: () => void;
    onLater: () => void;
    onNever: () => void;
  };
}

function relativeTimeLabels(t: (key: string, vars?: Record<string, string | number>) => string): RelativeTimeLabels {
  return {
    justNow: () => t("overlayCard.justNow"),
    secondsAgo: (count) => t("overlayCard.secondsAgo", { count }),
    minutesAgo: (count) => t("overlayCard.minutesAgo", { count }),
    hoursAgo: (count) => t("overlayCard.hoursAgo", { count }),
    daysAgo: (count) => t("overlayCard.daysAgo", { count }),
  };
}

export function OverlayCard({
  title,
  summary,
  firedAt,
  running,
  queueIndex,
  queueTotal,
  onPrev,
  onNext,
  onDismiss,
  onPrimaryAction,
  primaryActionLabel,
  secondaryAction,
  expanded,
  onExpandedChange,
  kind = "routine",
  pluginId,
  pluginDisplayName,
  dispositions,
}: OverlayCardProps) {
  const { t } = useTranslation();
  const [isOverflowing, setIsOverflowing] = useState(false);
  const summaryRef = useRef<HTMLParagraphElement | null>(null);
  const relTime = useMemo(() => formatRelativeTime(firedAt, relativeTimeLabels(t)), [firedAt, t]);

  useLayoutEffect(() => {
    const el = summaryRef.current;
    if (!el || expanded) return;
    setIsOverflowing(el.scrollHeight > el.clientHeight + 1);
  }, [summary, expanded]);

  const isoLabel = useMemo(() => {
    try {
      return formatMediumDateTime(firedAt);
    } catch {
      return firedAt;
    }
  }, [firedAt]);

  const showNav = queueTotal >= 2;
  const displayNameLabel = pluginDisplayName && pluginDisplayName !== pluginId
    ? t("alerts.pluginDisplayName", { name: pluginDisplayName })
    : null;

  return (
    <Card
      data-testid="routine-card"
      className="flex flex-col border-action-view/(--opacity-medium) bg-action-view/(--opacity-faint) shadow-md backdrop-blur ave-anim-slide-down"
      role="status"
      aria-live="polite"
      aria-atomic
    >
      <CardHeader className="shrink-0 space-y-0 pb-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <CardTitle className="flex min-w-14 flex-1 items-center gap-1.5 text-sm">
            {running ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-action-view" />
            ) : (
              <span className="text-action-view">●</span>
            )}
            <span className="min-w-0 flex-1 truncate">{title}</span>
          </CardTitle>
          <div className="flex max-w-full shrink-0 flex-wrap items-center justify-end gap-1">
            {showNav && (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 w-7 p-0"
                  data-testid="overlay-card-prev"
                  aria-label={t("overlayCard.prevAriaLabel")}
                  disabled={queueIndex <= 1}
                  onClick={onPrev}
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 w-7 p-0"
                  data-testid="overlay-card-next"
                  aria-label={t("overlayCard.nextAriaLabel")}
                  disabled={queueIndex >= queueTotal}
                  onClick={onNext}
                >
                  <ChevronRight className="h-3.5 w-3.5" />
                </Button>
              </>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="h-7 gap-1 px-2 text-xs"
              data-testid="routine-card-dismiss"
              aria-label={t("overlayCard.closeAriaLabel")}
              onClick={onDismiss}
            >
              <X className="h-3.5 w-3.5" />
              {t("overlayCard.closeButton")}
            </Button>
          </div>
        </div>
        <CardDescription className="mt-0.5 flex min-w-0 flex-wrap items-baseline gap-x-1 text-[11px]">
          {kind === "plugin" && pluginId && (
            <span className="contents" data-testid="plugin-provenance">
              <span
                className="max-w-full flex-none break-all font-medium tracking-tight text-foreground"
                role="group"
                aria-label={t("alerts.pluginIdOnly", { id: pluginId })}
                title={t("alerts.pluginIdOnly", { id: pluginId })}
                data-testid="plugin-provenance-id"
              >
                {t("alerts.pluginIdOnly", { id: pluginId })}
              </span>
              {displayNameLabel && (
                <span
                  className="min-w-14 max-w-full flex-1 truncate text-[10px] opacity-60"
                  role="group"
                  aria-label={displayNameLabel}
                  title={displayNameLabel}
                  data-testid="plugin-provenance-name"
                >
                  {displayNameLabel}
                </span>
              )}
            </span>
          )}
          {!(kind === "plugin" && pluginId) && (
            <span className="min-w-0 truncate">
              {running
                ? t("overlayCard.running")
                : kind === "host"
                  ? t("alerts.builtInNotice")
                  : kind === "app"
                    ? t("overlayCard.appNotice")
                    : t("overlayCard.routineDone")}
            </span>
          )}
          {!running && (
            <>
              {!(kind === "plugin" && pluginId) && <span className="shrink-0">·</span>}
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="cursor-default whitespace-nowrap">{relTime}</span>
                </TooltipTrigger>
                <TooltipContent>{isoLabel}</TooltipContent>
              </Tooltip>
            </>
          )}
          {showNav && (
            <>
              <span>·</span>
              <span data-testid="routine-card-indicator" className="text-action-view">
                {queueIndex}/{queueTotal}
              </span>
            </>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="min-h-0 overflow-hidden pt-0">
        {running ? (
          <p className="text-xs text-muted-foreground/(--opacity-stronger)">{t("overlayCard.runningDescription")}</p>
        ) : summary ? (
          <>
            <p
              ref={summaryRef}
              className={
                expanded
                  ? "max-h-64 overflow-y-auto whitespace-pre-wrap break-words text-xs text-muted-foreground"
                  : "line-clamp-2 break-words text-xs text-muted-foreground"
              }
              data-testid="overlay-card-summary"
              data-expanded={expanded}
            >
              {summary}
            </p>
            {(isOverflowing || expanded) && (
              <Button
                size="sm"
                variant="ghost"
                className="mt-1 h-6 gap-1 px-1 text-[11px] text-muted-foreground hover:text-foreground"
                data-testid="overlay-card-expand-toggle"
                aria-expanded={expanded}
                onClick={() => onExpandedChange(!expanded)}
              >
                {expanded ? (
                  <>
                    <ChevronUp className="h-3 w-3" />
                    {t("overlayCard.collapseButton")}
                  </>
                ) : (
                  <>
                    <ChevronDown className="h-3 w-3" />
                    {t("overlayCard.expandButton")}
                  </>
                )}
              </Button>
            )}
          </>
        ) : (
          <p className="text-xs text-muted-foreground/(--opacity-half)">{t("overlayCard.noSummary")}</p>
        )}
        {!running && dispositions && (
          <div
            className="mt-2 flex flex-wrap items-center justify-end gap-1.5"
            data-testid="overlay-card-dispositions"
          >
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs text-muted-foreground hover:text-foreground"
              data-testid="overlay-card-disposition-never"
              onClick={dispositions.onNever}
            >
              {t("overlayCard.proposalNeverButton")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs text-muted-foreground hover:text-foreground"
              data-testid="overlay-card-disposition-later"
              onClick={dispositions.onLater}
            >
              {t("overlayCard.proposalLaterButton")}
            </Button>
            <Button
              size="sm"
              variant="default"
              className="h-7 text-xs"
              data-testid="overlay-card-disposition-accept"
              onClick={dispositions.onAccept}
            >
              {primaryActionLabel ?? t("overlayCard.pluginPrimaryAction")}
            </Button>
          </div>
        )}
        {!running && !dispositions && onPrimaryAction && (
          <div className="mt-2 flex justify-end gap-1">
            {secondaryAction ? (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs text-muted-foreground hover:text-foreground"
                data-testid="overlay-card-secondary-action"
                onClick={secondaryAction.onClick}
              >
                {secondaryAction.label}
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="default"
              className="h-7 text-xs"
              data-testid="overlay-card-primary-action"
              onClick={onPrimaryAction}
            >
              {primaryActionLabel ?? (kind === "plugin" || kind === "host" ? t("overlayCard.pluginPrimaryAction") : t("overlayCard.routinePrimaryAction"))}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
