/**
 * Growth of a function's cost across two input sizes, read as thread CPU time.
 *
 * A complexity guard judges growth, not a wall-clock bound: a fixed millisecond cap
 * passes or fails with the runner's load and speed, and a shared CI runner has run
 * linear analyzers 14 times slower than an idle workstation. The time is the
 * thread's CPU time, which a loaded host does not charge while the thread waits to
 * run: on wall time a long pass is preempted in proportion to the load while a short
 * one fits a time slice, and linear code then read as 270-fold growth at a load of 28.
 */

/**
 * The bound to place between linear and quadratic growth over a `spread`-fold
 * input: their geometric mean, `spread` to the power 1.5, which leaves the same
 * factor of headroom on either side.
 */
export function linearGrowthBound(spread: number): number {
  if (!(spread >= 4)) throw new Error(`linearGrowthBound: spread ${spread} cannot separate linear from quadratic growth`);
  return spread ** 1.5;
}

export interface CpuGrowthOptions {
  /**
   * A large pass under this is fast whatever its growth: a ratio between runs of a
   * few hundred microseconds measures timer and JIT noise.
   */
  readonly fastEnoughMs: number;
  /**
   * Linux charges a thread's CPU time in whole scheduler ticks (4 ms at 250 Hz), so a
   * single short pass reads 0 ms and the ratio becomes Infinity. The small pass is
   * repeated until the sample has spent at least this long and read as a per-pass
   * mean, so a tick is a small fraction of it.
   */
  readonly minSampleMs: number;
  /** Large passes taken; the fastest is kept, so a collection or a core migration landing on one is dropped. */
  readonly largeRuns?: number;
}

export interface CpuGrowth {
  /** Per-pass CPU time of the small input, or NaN when the large pass was already fast enough. */
  readonly smallMs: number;
  readonly largeMs: number;
  /** `largeMs / smallMs`, or undefined when the large pass was fast enough that growth is not judged. */
  readonly growth: number | undefined;
}

function cpuMsPerPass(run: () => unknown, minSampleMs: number): number {
  const started = process.threadCpuUsage();
  let passes = 0;
  let spentMs = 0;
  do {
    run();
    passes += 1;
    const spent = process.threadCpuUsage(started);
    spentMs = (spent.user + spent.system) / 1000;
  } while (spentMs < minSampleMs);
  return spentMs / passes;
}

/** CPU time of `small` and `large`; one large reading under `fastEnoughMs` settles that the case is fast. */
export function measureCpuGrowth(small: () => unknown, large: () => unknown, options: CpuGrowthOptions): CpuGrowth {
  const largeRuns = options.largeRuns ?? 5;
  let largeMs = Number.POSITIVE_INFINITY;
  for (let run = 0; run < largeRuns && largeMs >= options.fastEnoughMs; run++) largeMs = Math.min(largeMs, cpuMsPerPass(large, 0));
  if (largeMs < options.fastEnoughMs) return { smallMs: Number.NaN, largeMs, growth: undefined };
  const smallMs = cpuMsPerPass(small, options.minSampleMs);
  return { smallMs, largeMs, growth: largeMs / smallMs };
}
