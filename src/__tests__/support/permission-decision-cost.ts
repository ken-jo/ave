// These guards assert bounded work in the complete permission decision: an adversarial input
// must not cost dramatically more than a trivial one through the same code path. They are not a
// UX-latency SLA, so a uniform slowdown of the whole analyzer is allowed to pass; the hard
// ceiling below is the backstop against a genuine blow-up.
//
// A fixed millisecond allowance proved to be a flake magnet because hosts differ ~2x and an
// 8-worker local run is noisier still. Instead each test calibrates a machine-relative budget
// right before it measures: the median per-decision cost of a small reference workload run in
// the same process, test file, dialect, lane and manager mode, times K. Because the reference
// scales with the host, the ratio stays stable across machines.

const permissionDecisionCostCeilingMs = 2_000;

// K: how much more the worst-case bounded decision may cost than the small reference, measured
// the same way in the same test. Chosen from the observed spread of (measured median /
// referenceMs). The expensive cases are the under-cap "ask" lanes that run the full bounded
// analysis (~2k chars); the reference is a trivial decision, so the ratio is the bounded-work
// factor, not a latency figure.
//   host (Windows, AVE_VITEST_MAX_WORKERS=8): worst ratio ~14.9 across repeated isolated runs,
//   and ~13.8 in the full 166-file windows-permission-tests run under 8-worker contention. The
//   contention figure is no higher than isolated, confirming the reference scales with load.
// K=30 is ~2x that worst. Hosted CI runners measure ~2x the local cost in absolute ms, but the
// reference scales with them so the ratio is expected to hold; CI ratios are confirmed from the
// first windows-permission-tests run and K tightened if the measured headroom warrants it. The
// absolute ceiling still fails a real blow-up even if the reference itself happened to be slow.
const permissionDecisionCostRatio = 30;

function medianOf(samples: readonly number[]): number {
  if (samples.length === 0) throw new Error("median of empty sample set");
  return [...samples].sort((left, right) => left - right)[samples.length >> 1]!;
}

export interface DecisionCostBudget {
  readonly referenceMs: number;
  readonly budgetMs: number;
}

// Calibrate the per-decision budget from a small reference workload. `reference` runs one
// trivial decision through the same closure the test will measure; it takes an iteration number
// so the caller can vary the command and defeat the reviewer/approval cache. The inner loop
// amortizes performance.now() jitter at sub-millisecond scale, and a warm-up call pays the
// JIT/first-allocation cost outside the measured window.
export function calibratePermissionDecisionBudget(reference: (iteration: number) => void): DecisionCostBudget {
  const innerLoop = 32;
  const referenceSamples = 7;
  reference(-1);
  const perDecision: number[] = [];
  let iteration = 0;
  for (let sample = 0; sample < referenceSamples; sample += 1) {
    const start = performance.now();
    for (let step = 0; step < innerLoop; step += 1) reference(iteration++);
    perDecision.push((performance.now() - start) / innerLoop);
  }
  const referenceMs = medianOf(perDecision);
  return { referenceMs, budgetMs: Math.min(permissionDecisionCostCeilingMs, referenceMs * permissionDecisionCostRatio) };
}
