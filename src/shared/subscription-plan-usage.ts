/** Account quota gauges are independent of token accounting and API billing. Times use epoch milliseconds. */
export interface SubscriptionPlanUsageWindow {
  readonly id: string;
  readonly usedPercent?: number;
  readonly resetsAt?: number;
  readonly windowDurationMins?: number;
}

export interface SubscriptionPlanUsage {
  readonly observedAt: number;
  readonly windows: readonly (SubscriptionPlanUsageWindow & {
    readonly observedAt?: number;
    /** A local projection from two reported samples of the same window, never a provider fact. */
    readonly projectedLimitAt?: number;
  })[];
}

/** Copy only bounded numeric gauges and opaque identifiers across the host boundary. */
export function normalizePlanUsageWindow(value: unknown): SubscriptionPlanUsageWindow | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || !/^[a-zA-Z0-9_.:-]{1,100}$/.test(row.id)) return undefined;
  const usedPercent = row.usedPercent;
  const resetsAt = row.resetsAt;
  const windowDurationMins = row.windowDurationMins;
  if (usedPercent !== undefined && (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)
    || usedPercent < 0 || usedPercent > 100)) return undefined;
  if (resetsAt !== undefined && (typeof resetsAt !== "number" || !Number.isSafeInteger(resetsAt)
    || resetsAt <= 0 || resetsAt > 8_640_000_000_000_000)) return undefined;
  if (windowDurationMins !== undefined && (typeof windowDurationMins !== "number"
    || !Number.isSafeInteger(windowDurationMins) || windowDurationMins <= 0)) return undefined;
  if (usedPercent === undefined && resetsAt === undefined) return undefined;
  return { id: row.id, ...(usedPercent === undefined ? {} : { usedPercent }),
    ...(resetsAt === undefined ? {} : { resetsAt }),
    ...(windowDurationMins === undefined ? {} : { windowDurationMins }) };
}
