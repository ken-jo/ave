import { isRecord } from "../shared/is-record.js";
import { normalizePlanUsageWindow, type SubscriptionPlanUsageUpdate, type SubscriptionPlanUsageWindow } from "../shared/subscription-plan-usage.js";

const MAX_PLAN_USAGE_WINDOWS = 32;

/** Account RPC results and notifications share the same numeric quota projection. */
export function parseCodexPlanUsage(value: unknown): readonly SubscriptionPlanUsageUpdate[] {
  if (!isRecord(value)) return [];
  const buckets = isRecord(value.rateLimitsByLimitId)
    ? Object.entries(value.rateLimitsByLimitId).slice(0, MAX_PLAN_USAGE_WINDOWS)
    : isRecord(value.rateLimits) ? [[value.rateLimits.limitId ?? "codex", value.rateLimits]] : [];
  const windows: SubscriptionPlanUsageUpdate[] = [];
  for (const [key, bucket] of buckets) {
    if (!isRecord(bucket) || typeof key !== "string" || !/^[a-zA-Z0-9_.:-]{1,80}$/.test(key)) continue;
    for (const kind of ["primary", "secondary"] as const) {
      if (windows.length >= MAX_PLAN_USAGE_WINDOWS) return windows;
      const raw = bucket[kind];
      if (raw === null) {
        windows.push({ id: `${key}:${kind}`, removed: true });
        continue;
      }
      if (!isRecord(raw)) continue;
      const window = normalizePlanUsageWindow({
        id: `${key}:${kind}`,
        ...(raw.usedPercent == null ? {} : { usedPercent: raw.usedPercent }),
        ...(raw.resetsAt == null ? {} : {
          resetsAt: typeof raw.resetsAt === "number" ? raw.resetsAt * 1_000 : raw.resetsAt,
        }),
        ...(raw.windowDurationMins == null ? {} : { windowDurationMins: raw.windowDurationMins }),
      });
      if (window) windows.push(window);
    }
  }
  return windows;
}

/** A successful status without a utilization field is not a zero-percent gauge. */
export function parseClaudeCodePlanUsage(value: unknown): readonly SubscriptionPlanUsageWindow[] {
  if (!isRecord(value) || !isRecord(value.rate_limit_info)) return [];
  const info = value.rate_limit_info;
  if (typeof info.rateLimitType !== "string"
    || !["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet", "overage"].includes(info.rateLimitType)) return [];
  const window = normalizePlanUsageWindow({
    id: info.rateLimitType,
    ...(info.utilization == null ? {} : {
      usedPercent: typeof info.utilization === "number" ? info.utilization * 100 : info.utilization,
    }),
    ...(info.resetsAt == null ? {} : {
      resetsAt: typeof info.resetsAt === "number" ? info.resetsAt * 1_000 : info.resetsAt,
    }),
  });
  return window ? [window] : [];
}

/** The billing extension reports a period gauge; monetary fields never become quota percentages. */
export function parseGrokBuildPlanUsage(value: unknown): readonly SubscriptionPlanUsageWindow[] {
  if (!isRecord(value) || !isRecord(value.config)) return [];
  const config = value.config;
  const end = isRecord(config.currentPeriod) ? config.currentPeriod.end : undefined;
  let resetsAt = typeof end === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(end)
    ? Date.parse(end) : undefined;
  if (typeof end === "string" && resetsAt !== undefined && Number.isFinite(resetsAt)) {
    const date = end.slice(0, 10);
    const calendarDate = Date.parse(`${date}T00:00:00Z`);
    if (!Number.isFinite(calendarDate) || new Date(calendarDate).toISOString().slice(0, 10) !== date) resetsAt = undefined;
  }
  const window = normalizePlanUsageWindow({
    id: "current-period",
    ...(config.creditUsagePercent == null ? {} : { usedPercent: config.creditUsagePercent }),
    ...(resetsAt === undefined || !Number.isFinite(resetsAt) ? {} : { resetsAt }),
  });
  return window ? [window] : [];
}
