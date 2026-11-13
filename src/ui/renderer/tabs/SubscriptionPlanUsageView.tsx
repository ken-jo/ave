import { useEffect, useState } from "react";
import { useTranslation } from "../../../i18n/react.js";
import type { SubscriptionPlanUsage } from "../../../shared/subscription-plan-usage.js";

const WINDOW_LABEL_KEYS: Readonly<Record<string, string>> = Object.freeze({
  five_hour: "subscriptionPlanUsage.fiveHour",
  seven_day: "subscriptionPlanUsage.sevenDay",
  seven_day_opus: "subscriptionPlanUsage.sevenDayOpus",
  seven_day_sonnet: "subscriptionPlanUsage.sevenDaySonnet",
  "current-period": "subscriptionPlanUsage.currentPeriod",
});

export function SubscriptionPlanUsageView({ usage }: { usage?: SubscriptionPlanUsage }) {
  const { t, locale } = useTranslation();
  const [now, setNow] = useState(Date.now);
  useEffect(() => { if (usage) setNow(Date.now()); }, [usage]);
  useEffect(() => {
    const nextChange = usage?.windows.reduce((next, window) => {
      for (const boundary of [window.resetsAt, window.projectedLimitAt]) {
        if (boundary !== undefined && boundary > now) next = Math.min(next, boundary);
      }
      return next;
    }, Number.POSITIVE_INFINITY);
    if (nextChange === undefined || !Number.isFinite(nextChange)) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(2_147_483_647, Math.max(1, nextChange - Date.now() + 1)));
    return () => clearTimeout(timer);
  }, [usage, now]);
  const windows = usage?.windows.filter((window) => window.resetsAt === undefined || window.resetsAt > now) ?? [];
  if (!usage || windows.length === 0) return null;
  const formatTime = (timestamp: number) => new Intl.DateTimeFormat(locale, {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  }).format(timestamp);
  return (
    <div className="space-y-2 rounded-md border px-3 py-2 text-xs" data-testid="subscription-plan-usage">
      <p className="font-medium">{t("subscriptionPlanUsage.title")}</p>
      {windows.map((window) => {
        const duration = window.windowDurationMins !== undefined
          ? t("subscriptionPlanUsage.window", { minutes: window.windowDurationMins }) : undefined;
        const labelKey = window.id.endsWith(":primary") ? "subscriptionPlanUsage.primary"
          : window.id.endsWith(":secondary") ? "subscriptionPlanUsage.secondary" : WINDOW_LABEL_KEYS[window.id];
        const kind = labelKey ? t(labelKey) : window.id;
        const bucket = window.id.replace(/:(primary|secondary)$/, "");
        const label = [bucket !== window.id && bucket !== "codex" ? bucket : undefined, kind, duration].filter(Boolean).join(" · ");
        const projected = window.projectedLimitAt !== undefined && window.resetsAt !== undefined
          && window.usedPercent !== undefined && window.usedPercent < 100
          && window.projectedLimitAt > now && window.projectedLimitAt < window.resetsAt;
        return (
          <div key={window.id} className="space-y-1" data-testid={`subscription-plan-usage:${window.id}`}>
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <span>{label}</span>
              {window.usedPercent !== undefined ? (
                <span className="font-medium tabular-nums">{t("subscriptionPlanUsage.used", {
                  percent: new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(window.usedPercent),
                })}</span>
              ) : null}
            </div>
            {window.usedPercent !== undefined ? (
              <progress className="block h-1.5 w-full accent-primary" max={100} value={window.usedPercent} aria-label={label} />
            ) : null}
            <div className="flex flex-wrap justify-between gap-x-3 gap-y-1 text-muted-foreground">
              {window.resetsAt !== undefined ? (
                <span>{t("subscriptionPlanUsage.resets", { time: formatTime(window.resetsAt) })}</span>
              ) : null}
              <span>{t("subscriptionPlanUsage.reported", { time: formatTime(window.observedAt ?? usage.observedAt) })}</span>
            </div>
            {projected && window.projectedLimitAt !== undefined ? (
              <p role="status" className="text-warning" data-testid="subscription-plan-usage:warning">
                {t("subscriptionPlanUsage.projected", { time: formatTime(window.projectedLimitAt) })}
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
