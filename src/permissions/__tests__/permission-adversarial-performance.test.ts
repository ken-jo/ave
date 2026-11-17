import "../../__tests__/support/trusted-powershell.js";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionManager } from "../permission-manager.js";
import { checkShellPermission } from "../../__tests__/support/permission-lane.js";
import { linearGrowthBound } from "../../__tests__/support/cpu-growth.js";
import { __resetSessionStoreForTest } from "../user-approval-store.js";
import { MAX_SHELL_ANALYSIS_TOKENS } from "../../shared/shell-analysis-limits.js";
import * as shellParser from "../../shared/shell-parser.js";
import * as shellTokenizer from "../../shared/shell-tokenizer.js";
import * as shellAnalysis from "../../shared/shell-analysis.js";
import * as filesystemPath from "../../shared/shell-filesystem-path.js";
import * as shellPathPolicy from "../../tools/shell-path-policy.js";
import * as sensitivePaths from "../sensitive-paths.js";
import * as ruleSpecifier from "../rules/rule-specifier.js";
import * as powerShellExfiltration from "../rules/powershell-exfiltration.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
let cwd: string;
let stateRoot: string;
let manager: PermissionManager;

beforeEach(() => {
  cwd = realpathSync(mkdtempSync(join(tmpdir(), "permission-work-")));
  stateRoot = realpathSync(mkdtempSync(join(tmpdir(), "permission-work-state-")));
  vi.stubEnv("AVE_HOME", stateRoot);
  __resetSessionStoreForTest();
  manager = new PermissionManager(join(stateRoot, "permissions.json"));
  manager.setMode("default");
});

afterEach(() => {
  vi.restoreAllMocks();
  __resetSessionStoreForTest();
  vi.unstubAllEnvs();
  rmSync(cwd, { recursive: true, force: true });
  rmSync(stateRoot, { recursive: true, force: true });
});

// Wall time on a shared host measures the host as much as the analyzer, so these guards count the work a complete
// decision does at module boundaries instead: deterministic, and the same on every machine and under any load.
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

interface Work { readonly calls: number; readonly chars: number }
type WorkCounts = ReadonlyMap<string, Work>;

/** Count, for one complete decision, the calls to each work unit and the characters of their string inputs. */
function countWork<T>(decide: () => T): { result: T; work: WorkCounts } {
  const spies = new Map<string, MockInstance>();
  for (const [name, namespace] of [...PARSE_UNITS, ...OPERAND_UNITS, ...DECISION_UNITS]) {
    spies.set(name, vi.spyOn(namespace as unknown as Record<string, (...args: never[]) => unknown>, name));
  }
  try {
    const result = decide();
    const work = new Map<string, Work>();
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

/** Every unit grows at most linearly from the small input to the large one, through the same units, with matcher construction unchanged. */
function expectLinearWork(small: WorkCounts, large: WorkCounts, spread: number): void {
  const bound = linearGrowthBound(spread);
  expect([...large.keys()].sort()).toEqual([...small.keys()].sort());
  for (const [name, before] of small) {
    const after = large.get(name);
    if (after === undefined) throw new Error(`${name} did no work for the large input`);
    expect(after.calls / before.calls, `${name} calls`).toBeLessThan(bound);
    if (before.chars > 0) expect(after.chars / before.chars, `${name} input characters`).toBeLessThan(bound);
  }
  for (const name of unitNames(DECISION_UNITS)) expect(large.get(name)?.calls, name).toBe(small.get(name)?.calls);
  // The large input really exercises the operand units, so linear growth above is not vacuous.
  expect(unitNames(OPERAND_UNITS).some((name) => (large.get(name)?.calls ?? 0) > 100)).toBe(true);
}

/** A refusal at the analysis cap reads the input once and does no per-operand work. */
function expectRefusedAtCap(work: WorkCounts, command: string): void {
  for (const name of unitNames(OPERAND_UNITS)) expect(work.get(name), name).toBeUndefined();
  for (const [name, { calls, chars }] of work) {
    expect(calls, `${name} calls`).toBe(1);
    expect(chars, `${name} input characters`).toBeLessThanOrEqual(command.length);
  }
}

const json = (work: WorkCounts): Record<string, Work> => Object.fromEntries(work);

function distinctRelativePaths(length: number, radix: number, nested = false): string {
  let command = "echo hi > out.txt; cd a0; cd a1; cd a2; cd a3; printf %s";
  for (let index = 0; command.length < length; index += 1) {
    if (nested && index > 0 && index % 40 === 0) command += " $(:)";
    command += ` ./p${index.toString(radix)}`;
  }
  return command.slice(0, length);
}

const WORK_CASES = [
  ...(["bash", "powershell"] as const).flatMap((dialect) =>
    [false, true].flatMap((runsSandboxed) => [10, 36].map((radix) => ({ dialect, runsSandboxed, radix, nested: false, length: runsSandboxed ? 7_999 : 1_999 }))),
  ),
  ...[false, true].map((runsSandboxed) => ({ dialect: "bash" as const, runsSandboxed, radix: 36, nested: true, length: runsSandboxed ? 7_999 : 1_999 })),
];

describe("adversarial complete manager work", () => {
  it("visits nested PowerShell script blocks without repeated subtree analysis", () => {
    const depth = 14;
    const command = "& { ".repeat(depth) + "Write-Output ready" + " }".repeat(depth);
    const results = [];
    const counted = [];
    for (let observation = 0; observation < 3; observation += 1) {
      const { result, work } = countWork(() => checkShellPermission(manager, cwd, SESSION_ID, command, "powershell", true));
      results.push(result);
      counted.push(work);
    }
    const work = counted[0]!;
    process.stdout.write(`permission nested work ${JSON.stringify({ depth, chars: command.length, work: json(work), results: results.map(({ decision, forceModal }) => ({ decision, forceModal: forceModal === true })) })}\n`);
    for (const result of results) expect(result).toMatchObject({ decision: "ask", reasonCode: "shell-approval" });
    // Repeating the decision repeats exactly the same work: nothing accumulates across decisions.
    for (const repeated of counted) expect(json(repeated)).toEqual(json(work));
    // The command is parsed once, and each of its script blocks is analyzed once rather than once per enclosing block.
    expect(work.get("parsePowerShellCommand")).toEqual({ calls: 1, chars: command.length });
    for (const name of ["inspectPosixShellPermissionPaths", "parseShellSyntax"]) expect(work.get(name)?.calls, name).toBeLessThanOrEqual(depth + 1);
    for (const result of results) expect(result.forceModal).toBeUndefined();
    manager.setMode("allow");
    const permitted = checkShellPermission(manager, cwd, SESSION_ID, command, "powershell", true);
    expect(permitted).toMatchObject({ decision: "allow", reasonCode: "allow-mode" });
    expect(permitted.pipelineRequest?.shell).toEqual(results[0]!.pipelineRequest?.shell);
  });

  it.each(WORK_CASES)("$dialect sandboxed=$runsSandboxed radix=$radix nested=$nested", ({ dialect, runsSandboxed, radix, nested, length }) => {
    const command = distinctRelativePaths(length, radix, nested);
    expect(command.length).toBe(length);
    const distinctPathRecords = command.match(/\.\/p[0-9a-z]+/gu)?.length ?? 0;
    if (runsSandboxed) expect(distinctPathRecords).toBeGreaterThan(MAX_SHELL_ANALYSIS_TOKENS);
    else expect(distinctPathRecords).toBeLessThan(MAX_SHELL_ANALYSIS_TOKENS);
    // The same shape at a quarter of the length, in the same lane, for the growth comparison of a fully analyzed decision.
    const smallCommand = distinctRelativePaths(Math.floor(length / 4), radix, nested);
    const small = runsSandboxed ? undefined : countWork(() => checkShellPermission(manager, cwd, SESSION_ID, smallCommand, dialect, runsSandboxed));
    const results = [];
    const counted = [];
    for (let observation = 0; observation < 3; observation += 1) {
      const { result, work } = countWork(() => checkShellPermission(manager, cwd, SESSION_ID, command, dialect, runsSandboxed));
      results.push(result);
      counted.push(work);
    }
    const work = counted[0]!;
    process.stdout.write(`permission adversarial work ${JSON.stringify({ dialect, radix, nested, lane: runsSandboxed ? "A" : "B", chars: length, smallChars: small ? smallCommand.length : undefined, work: json(work), smallWork: small ? json(small.work) : undefined, results: results.map(({ decision, forceModal }) => ({ decision, forceModal: forceModal === true })) })}\n`);
    // These generated long inputs contain more than the complete evidence token budget.
    const expected = runsSandboxed
      ? { decision: "deny", reasonCode: "shell-analysis-limit" }
      : { decision: "ask", reasonCode: "shell-approval" };
    for (const result of results) expect(result).toMatchObject(expected);
    for (const repeated of counted) expect(json(repeated)).toEqual(json(work));
    if (small) {
      expect(small.result).toMatchObject(expected);
      expectLinearWork(small.work, work, command.length / smallCommand.length);
    } else {
      expectRefusedAtCap(work, command);
    }
    for (const result of results) expect(result.forceModal).toBeUndefined();
    manager.setMode("allow");
    const permitted = checkShellPermission(manager, cwd, SESSION_ID, command, dialect, runsSandboxed);
    expect(permitted).toMatchObject(runsSandboxed
      ? { decision: "deny", reasonCode: "shell-analysis-limit" }
      : { decision: "allow", reasonCode: "allow-mode" });
    expect(permitted.pipelineRequest?.shell).toEqual(results[0]!.pipelineRequest?.shell);
  });
});
