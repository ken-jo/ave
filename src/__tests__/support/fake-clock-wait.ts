import { vi } from "vitest";

// Vitest fakes the global timers, `node:timers` and `performance` alike, so the real ones are taken while this module loads.
// A test file imports it before any hook can install a fake clock.
if (vi.isFakeTimers()) throw new Error("fake-clock-wait must be imported before a fake clock is installed");
const realSetTimeout = globalThis.setTimeout;
const realNow = performance.now.bind(performance);

export interface RealClockWaitOptions {
  readonly signal: AbortSignal;
  readonly timeout: number;
  readonly interval?: number;
}

/**
 * Polls on the real clock until `check` stops throwing, then returns its value.
 *
 * `vi.waitFor` advances an installed fake clock on every poll. A body that outlives its test timeout would then move the clock
 * the next test installed. This wait never touches a fake clock, and stops once the test's signal aborts.
 */
export async function waitOnRealClock<T>(check: () => T, { signal, timeout, interval = 50 }: RealClockWaitOptions): Promise<T> {
  const deadline = realNow() + timeout;
  for (;;) {
    signal.throwIfAborted();
    try {
      return check();
    } catch (error) {
      if (realNow() >= deadline) throw error;
    }
    await new Promise((resolve) => realSetTimeout(resolve, interval));
  }
}

/** Advances the installed fake clock, unless the test already timed out and the clock now belongs to a later test. */
export async function advanceFakeClock(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await vi.advanceTimersByTimeAsync(ms);
}

/** Waits on the real clock without polling anything. */
export function realDelay(ms: number): Promise<void> {
  return new Promise((resolve) => realSetTimeout(resolve, ms));
}
