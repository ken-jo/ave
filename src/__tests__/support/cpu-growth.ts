/** Measure thread CPU growth to avoid host-load bias in wall time. */

/** Use the geometric mean of linear and quadratic growth as the separating bound. */
export function linearGrowthBound(spread: number): number {
  if (!(spread >= 4)) throw new Error(`linearGrowthBound: spread ${spread} cannot separate linear from quadratic growth`);
  return spread ** 1.5;
}

export interface CpuGrowthOptions {
  /** Ignore growth ratios for sub-millisecond work dominated by timer and JIT noise. */
  readonly fastEnoughMs: number;
  /** Repeat short samples past scheduler-tick precision before computing per-pass CPU time. */
  readonly minSampleMs: number;
  readonly largeRuns?: number;
}

export interface CpuGrowth {
  readonly smallMs: number;
  readonly largeMs: number;
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

export function measureCpuGrowth(small: () => unknown, large: () => unknown, options: CpuGrowthOptions): CpuGrowth {
  const largeRuns = options.largeRuns ?? 5;
  let largeMs = Number.POSITIVE_INFINITY;
  for (let run = 0; run < largeRuns && largeMs >= options.fastEnoughMs; run++) largeMs = Math.min(largeMs, cpuMsPerPass(large, 0));
  if (largeMs < options.fastEnoughMs) return { smallMs: Number.NaN, largeMs, growth: undefined };
  const smallMs = cpuMsPerPass(small, options.minSampleMs);
  return { smallMs, largeMs, growth: largeMs / smallMs };
}
