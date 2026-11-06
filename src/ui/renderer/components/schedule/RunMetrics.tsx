import { cn } from "../../../../lib/utils.js";
import { t } from "../../../../i18n/runtime.js";
import { formatDuration } from "../../../../lib/turn-summary-format.js";
import { formatTokens } from "../../../../lib/cost-format.js";
import type { RoutineRunMetrics } from "../../../../shared/routines-types.js";

export function RunMetrics({ metrics, className }: { metrics?: RoutineRunMetrics; className?: string }) {
  if (metrics === undefined) return null;
  const duration = formatDuration(metrics.durationMs, {
    hour: t("schedulePanel.durationHour"), minute: t("schedulePanel.durationMinute"), second: t("schedulePanel.durationSecond"),
  });
  const text = metrics.tokens === undefined ? duration
    : t("schedulePanel.runMetrics", { duration, tokens: formatTokens(metrics.tokens.total) });
  return <span className={cn("block truncate text-xs tabular-nums text-muted-foreground", className)} title={text} data-testid="routine-run-metrics">{text}</span>;
}
