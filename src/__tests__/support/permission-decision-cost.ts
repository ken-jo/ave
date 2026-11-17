// These guards assert bounded work in the complete permission decision: an adversarial input must not
// cost dramatically more than a smaller input of the same shape through the same code path.
//
// Wall time on a shared host measures the host as much as the analyzer: a reference workload and the
// measured one sampled in different windows see different load, so their ratio flaked. These helpers count
// the work a complete decision does at module boundaries instead (calls to each unit and the characters of
// their string inputs). The counts are deterministic, so the same assertion holds on every machine and
// under any load. A spy only sees calls that cross a module boundary, so each unit is one the pipeline
// calls from another module.
import { expect, type MockInstance, vi } from "vitest";
import * as shellParser from "../../shared/shell-parser.js";
import * as shellTokenizer from "../../shared/shell-tokenizer.js";
import * as shellAnalysis from "../../shared/shell-analysis.js";
import * as filesystemPath from "../../shared/shell-filesystem-path.js";
import * as shellPathPolicy from "../../tools/shell-path-policy.js";
import * as sensitivePaths from "../../permissions/sensitive-paths.js";
import * as ruleSpecifier from "../../permissions/rules/rule-specifier.js";
import * as powerShellExfiltration from "../../permissions/rules/powershell-exfiltration.js";

const PARSE_UNITS = [
  ["parseShellSyntax", shellParser],
  ["tokenizeShell", shellTokenizer],
  ["parsePowerShellCommand", powerShellExfiltration],
] as const;
// Per-word proof and per-path checks: their total must stay proportional to the operands.
const OPERAND_UNITS = [
  ["literalWord", shellAnalysis],
  ["literalRuleWord", ruleSpecifier],
  ["verifyLocalFilesystemChain", filesystemPath],
  ["caseFoldForMatch", sensitivePaths],
  ["inspectPosixShellPermissionPaths", shellPathPolicy],
  ["inspectPowerShellPermissionPaths", powerShellExfiltration],
] as const;
// Matcher constructors called across modules: as often for a short input as for a long one.
const DECISION_UNITS = [
  ["createSensitivePathMatcher", sensitivePaths],
  ["createSensitiveLocationMatcher", sensitivePaths],
  ["createPathCanonicalizer", sensitivePaths],
  ["createPermissionPathEvidence", sensitivePaths],
] as const;

export interface DecisionWork { readonly calls: number; readonly chars: number }
export type DecisionWorkCounts = ReadonlyMap<string, DecisionWork>;

/** Count, for one complete decision, the calls to each work unit and the characters of their string inputs. */
export function countDecisionWork<T>(decide: () => T): { result: T; work: DecisionWorkCounts } {
  const spies = new Map<string, MockInstance>();
  for (const [name, namespace] of [...PARSE_UNITS, ...OPERAND_UNITS, ...DECISION_UNITS]) {
    spies.set(name, vi.spyOn(namespace as unknown as Record<string, (...args: never[]) => unknown>, name));
  }
  try {
    const result = decide();
    const work = new Map<string, DecisionWork>();
    for (const [name, spy] of spies) {
      const calls = spy.mock.calls as unknown[][];
      if (calls.length === 0) continue;
      work.set(name, { calls: calls.length, chars: calls.reduce((sum, [first]) => sum + (typeof first === "string" ? first.length : 0), 0) });
    }
    return { result, work };
  } finally {
    for (const spy of spies.values()) spy.mockRestore();
  }
}

const unitNames = (units: readonly (readonly [string, unknown])[]): string[] => units.map(([name]) => name);

/** The geometric mean of linear and quadratic growth over `spread`. Exact counts carry no sampling noise, so a spread of two already separates
 * linear (2x) from quadratic (4x) growth; inputs of one lane often cannot span more (the literal-proof and analysis caps bound them). */
function countGrowthBound(spread: number): number {
  if (!(spread >= 2)) throw new Error(`countGrowthBound: spread ${spread} cannot separate linear from quadratic growth`);
  return spread ** 1.5;
}

/** Every unit grows at most linearly from the small input to the large one, through the same units, with matcher construction unchanged.
 * `operandCalls` is how many per-operand calls the large input must make, so the growth check is not vacuous; a shape with no word
 * records (empty arithmetic, for example) passes 0. */
export function expectLinearDecisionWork(small: DecisionWorkCounts, large: DecisionWorkCounts, spread: number, operandCalls = 100): void {
  const bound = countGrowthBound(spread);
  expect([...large.keys()].sort()).toEqual([...small.keys()].sort());
  for (const [name, before] of small) {
    const after = large.get(name);
    if (after === undefined) throw new Error(`${name} did no work for the large input`);
    expect(after.calls / before.calls, `${name} calls`).toBeLessThan(bound);
    if (before.chars > 0) expect(after.chars / before.chars, `${name} input characters`).toBeLessThan(bound);
  }
  for (const name of unitNames(DECISION_UNITS)) expect(large.get(name)?.calls, name).toBe(small.get(name)?.calls);
  const exercised = unitNames(OPERAND_UNITS).reduce((sum, name) => sum + (large.get(name)?.calls ?? 0), 0);
  expect(exercised, "per-operand calls of the large input").toBeGreaterThanOrEqual(operandCalls);
}

/** A refusal at the analysis cap reads the input once and does no per-operand work. */
export function expectRefusedAtAnalysisCap(work: DecisionWorkCounts, command: string): void {
  for (const name of unitNames(OPERAND_UNITS)) expect(work.get(name), name).toBeUndefined();
  for (const [name, { calls, chars }] of work) {
    expect(calls, `${name} calls`).toBe(1);
    expect(chars, `${name} input characters`).toBeLessThanOrEqual(command.length);
  }
}

export const decisionWorkSummary = (work: DecisionWorkCounts): Record<string, DecisionWork> => Object.fromEntries(work);


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
