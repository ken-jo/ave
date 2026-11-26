export interface ScheduleBreakerState {
  consecutiveBad: number;
  pausedAt?: string;
}

export type ScheduledRunOutcome = "completed" | "failed" | "parked-on-denials" | "skipped-unavailable";

export function nextScheduleState(prev: ScheduleBreakerState, outcome: ScheduledRunOutcome): ScheduleBreakerState {
  if (prev.pausedAt !== undefined) return prev;
  if (outcome === "completed") return { consecutiveBad: 0 };
  const consecutiveBad = prev.consecutiveBad + 1;
  return consecutiveBad >= 2 ? { consecutiveBad, pausedAt: new Date().toISOString() } : { consecutiveBad };
}

export function mayFire(a: { unsettledRun: boolean; paused: boolean }): { fire: true } | { fire: false; reason: "run-unsettled" | "paused" } {
  if (a.paused) return { fire: false, reason: "paused" };
  if (a.unsettledRun) return { fire: false, reason: "run-unsettled" };
  return { fire: true };
}
