import type { SubscriptionRuntimeId } from "../shared/subscription-runtime.js";
import { normalizePlanUsageWindow, type SubscriptionPlanUsage, type SubscriptionPlanUsageWindow } from "../shared/subscription-plan-usage.js";

/** Ephemeral account gauges. Restart and authentication changes discard the samples. */
export class SubscriptionPlanUsageStore {
  private readonly samples = new Map<SubscriptionRuntimeId, SubscriptionPlanUsage>();

  update(provider: SubscriptionRuntimeId, windows: readonly SubscriptionPlanUsageWindow[], observedAt = Date.now()): boolean {
    if (!Number.isSafeInteger(observedAt) || observedAt <= 0) return false;
    const previous = this.samples.get(provider);
    if (previous && previous.observedAt > observedAt) return false;
    if (windows.length === 0) return this.samples.delete(provider);
    const rows = new Map(previous?.windows.map((row) => [row.id, row]));
    let changed = false;
    let visibleChange = false;
    for (const input of windows.slice(0, 32)) {
      const row = normalizePlanUsageWindow(input);
      if (!row || (row.resetsAt !== undefined && row.resetsAt <= observedAt)) continue;
      const before = rows.get(row.id);
      if (before && before.usedPercent === row.usedPercent && before.resetsAt === row.resetsAt
        && before.windowDurationMins === row.windowDurationMins) {
        rows.delete(row.id);
        rows.set(row.id, { ...row, observedAt });
        changed = true;
        visibleChange ||= before.projectedLimitAt !== undefined;
        continue;
      }
      let projectedLimitAt: number | undefined;
      if (before && previous && before.resetsAt === row.resetsAt && row.resetsAt !== undefined
        && before.windowDurationMins === row.windowDurationMins
        && before.usedPercent !== undefined && row.usedPercent !== undefined
        && row.usedPercent > before.usedPercent && row.usedPercent < 100 && observedAt > (before.observedAt ?? previous.observedAt)) {
        const projected = observedAt + (100 - row.usedPercent) * (observedAt - (before.observedAt ?? previous.observedAt))
          / (row.usedPercent - before.usedPercent);
        if (Number.isFinite(projected) && projected < row.resetsAt) projectedLimitAt = Math.round(projected);
      }
      rows.delete(row.id);
      rows.set(row.id, { ...row, observedAt, ...(projectedLimitAt === undefined ? {} : { projectedLimitAt }) });
      changed = true;
      visibleChange = true;
    }
    if (!changed) return false;
    this.samples.set(provider, {
      observedAt,
      windows: [...rows.values()].filter((row) => row.resetsAt === undefined || row.resetsAt > observedAt).slice(-32),
    });
    return visibleChange;
  }

  get(provider: SubscriptionRuntimeId, now = Date.now()): SubscriptionPlanUsage | undefined {
    const sample = this.samples.get(provider);
    if (!sample) return undefined;
    const windows = sample.windows.filter((row) => row.resetsAt === undefined || row.resetsAt > now);
    return windows.length ? { observedAt: sample.observedAt, windows: windows.map((row) => ({ ...row })) } : undefined;
  }

  clear(provider: SubscriptionRuntimeId): void {
    this.samples.delete(provider);
  }
}
