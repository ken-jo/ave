export interface ScheduleBreakerState {
  consecutiveBad: number;
  pausedAt?: string;
}

export type ScheduledRunOutcome = "completed" | "failed" | "parked-on-denials" | "skipped-unavailable";

export const SCHEDULE_BREAKER_THRESHOLD = 2;

export function nextScheduleState(prev: ScheduleBreakerState, outcome: ScheduledRunOutcome): ScheduleBreakerState {
  if (prev.pausedAt !== undefined) return prev;
  if (outcome === "completed") return { consecutiveBad: 0 };
  // The routine store stamps the pause atomically with this count.
  return { consecutiveBad: Math.min(prev.consecutiveBad + 1, SCHEDULE_BREAKER_THRESHOLD) };
}

export function mayFire(a: { unsettledRun: boolean; paused: boolean }): { fire: true } | { fire: false; reason: "run-unsettled" | "paused" } {
  if (a.paused) return { fire: false, reason: "paused" };
  if (a.unsettledRun) return { fire: false, reason: "run-unsettled" };
  return { fire: true };
}
