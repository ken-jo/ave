/**
 * Every argument list the pre-push hook spawns stays inside a fixed
 * command-line budget. After a large merge the app-fast tier's Vitest file
 * list grew to about 50 KB, and Windows refused the single `bun.exe` spawn
 * with ENAMETOOLONG (CreateProcess caps a command line at 32,767 characters).
 * The hook now splits a list over the budget into consecutive runs that
 * together carry exactly the same files; spawning is mocked throughout.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

import { getRelatedCoverageFullReason } from "../../scripts/hooks/pre-push-source-policy.mjs";
import {
  COMMAND_LINE_BUDGET_CHARS,
  commandLineLength,
  splitArgumentsWithinBudget,
} from "../../scripts/hooks/spawn-command.mjs";

const hook = readFileSync(resolve("scripts/hooks/run-local-checks.mjs"), "utf8");
const directRun = (chunk: string[]) => ["run", "test:vitest", "--", "run", ...chunk];

// File arguments whose command line, with `prefix`, totals exactly `target`
// characters: equal-width files, then one padded to land on the boundary.
function filesTotalling(command: string, prefix: string[], target: number): string[] {
  const files: string[] = [];
  let length = commandLineLength(command, prefix);
  for (let index = 0; ; index += 1) {
    const file = `./src/feature/__tests__/generated-${String(index).padStart(5, "0")}.test.ts`;
    const remaining = target - length;
    if (remaining < (file.length + 3) * 2) {
      const last = `./src/feature/__tests__/${"x".repeat(remaining - 3 - "./src/feature/__tests__/.test.ts".length)}.test.ts`;
      files.push(last);
      length += last.length + 3;
      break;
    }
    files.push(file);
    length += file.length + 3;
  }
  expect(length).toBe(target);
  return files;
}

describe("command-line budget", () => {
  it("is a fixed budget well under the Windows CreateProcess limit", () => {
    expect(COMMAND_LINE_BUDGET_CHARS).toBe(16_384);
    expect(COMMAND_LINE_BUDGET_CHARS).toBeLessThan(32_767);
  });

  it("keeps a list exactly at the budget in one spawn and splits it one character over", () => {
    const atBoundary = filesTotalling("bun", directRun([]), COMMAND_LINE_BUDGET_CHARS);
    expect(commandLineLength("bun", directRun(atBoundary))).toBe(COMMAND_LINE_BUDGET_CHARS);
    expect(splitArgumentsWithinBudget("bun", atBoundary, directRun)).toEqual([atBoundary]);

    const over = [...atBoundary.slice(0, -1), `${atBoundary.at(-1)!.slice(0, -3)}x.ts`];
    expect(commandLineLength("bun", directRun(over))).toBe(COMMAND_LINE_BUDGET_CHARS + 1);
    const chunks = splitArgumentsWithinBudget("bun", over, directRun);
    expect(chunks).toHaveLength(2);
    expect(chunks.flat()).toEqual(over);
  });

  it("covers a 50 KB list exactly once, in order, with every chunk inside the budget", () => {
    const files = filesTotalling("bun", directRun([]), 50_000);
    const chunks = splitArgumentsWithinBudget("bun", files, directRun);
    expect(chunks.length).toBeGreaterThanOrEqual(4);
    expect(chunks.flat()).toEqual(files);
    for (const chunk of chunks) {
      expect(chunk.length).toBeGreaterThan(0);
      expect(commandLineLength("bun", directRun(chunk))).toBeLessThanOrEqual(COMMAND_LINE_BUDGET_CHARS);
    }
  });

  it("measures each chunk with its own per-chunk arguments and yields nothing for an empty list", () => {
    const withReport = (chunk: string[], index: number) => [`--outputFile=/r/${"i".repeat(index)}.json`, ...chunk];
    const files = filesTotalling("bun", [], 40_000);
    const chunks = splitArgumentsWithinBudget("bun", files, withReport);
    expect(chunks.flat()).toEqual(files);
    chunks.forEach((chunk, index) =>
      expect(commandLineLength("bun", withReport(chunk, index))).toBeLessThanOrEqual(COMMAND_LINE_BUDGET_CHARS));
    expect(splitArgumentsWithinBudget("bun", [], directRun)).toEqual([]);
  });

  it("throws on an argument that cannot fit even alone instead of dropping it", () => {
    expect(() => splitArgumentsWithinBudget("bun", ["./ok.test.ts", `./${"y".repeat(COMMAND_LINE_BUDGET_CHARS)}.test.ts`], directRun))
      .toThrow("[command-line-budget-exceeded]");
  });
});

describe("pre-push Vitest spawns under the budget", () => {
  // Hook Git context must be stripped on every chunk (pre-push-markdown-policy.test.ts).
  const STRIPPED = Object.freeze({ STRIPPED: "1" });
  let envs: unknown[] = [];
  const sandbox = (runs: string[][], reports: Map<string, object> | null = null) => (envs = [], runInNewContext(
    `${hook.slice(hook.indexOf("function runVitestWithReport("), hook.indexOf("// Per-module related-test discovery"))}; runAppFastSourceChecks`,
    {
      commands: { bun: "bun" }, available: () => "bun", hasPackageScript: () => true, hasFile: () => true,
      join, tmpdir, mkdtempSync, rmSync, console: { log: () => {} },
      runAppTypecheckGate: () => {}, ensureAppTestRuntimeAbi: () => {}, ensureWindowsJobLauncher: () => {},
      resolveHostLockSettings: () => ({ directory: "/fixture-locks", timeoutMs: 1000, fastSlots: 1 }),
      withHostLock: (_options: object, callback: () => unknown) => callback(),
      run: (_command: string, args: string[], _dir: string, env: unknown) => { runs.push(args); envs.push(env); },
      withoutGitContext: () => STRIPPED,
      readJsonFile: (path: string) => reports?.get(path.slice(-16)) ?? { numTotalTests: 1, numPassedTests: 1 },
      splitArgumentsWithinBudget,
    },
  ));
  const fileArgs = (args: string[]) => args.filter((arg) => arg.startsWith("./"));
  const noRelated = { tests: [], narrowed: [], sources: [] };

  it("splits a 50 KB direct test list into runs that each fit and together run every file once", () => {
    const tests = filesTotalling("bun", directRun([]), 50_000).map((file) => file.slice(2));
    const runs: string[][] = [];
    sandbox(runs)("/fixture", [], tests, noRelated, null);
    const vitestRuns = runs.filter((args) => args[1] === "test:vitest");
    expect(vitestRuns.length).toBeGreaterThanOrEqual(4);
    for (const args of vitestRuns) {
      expect(args.slice(0, 4)).toEqual(["run", "test:vitest", "--", "run"]);
      expect(commandLineLength("bun", args)).toBeLessThanOrEqual(COMMAND_LINE_BUDGET_CHARS);
    }
    expect(vitestRuns.flatMap(fileArgs)).toEqual(tests.map((file) => `./${file}`));
    expect(envs.filter((_env, index) => runs[index][1] === "test:vitest").every((env) => env === STRIPPED)).toBe(true);
  });

  it("runs a direct test list exactly at the budget as a single spawn", () => {
    const tests = filesTotalling("bun", directRun([]), COMMAND_LINE_BUDGET_CHARS).map((file) => file.slice(2));
    const runs: string[][] = [];
    sandbox(runs)("/fixture", [], tests, noRelated, null);
    const vitestRuns = runs.filter((args) => args[1] === "test:vitest");
    expect(vitestRuns).toHaveLength(1);
    expect(commandLineLength("bun", vitestRuns[0])).toBe(COMMAND_LINE_BUDGET_CHARS);
  });

  it("splits a bounded related list, gives each run its own report and sums them for the zero-test check", () => {
    const tests = filesTotalling("bun", directRun([]), 40_000).map((file) => file.slice(2));
    const selection = { tests, narrowed: [{ source: "src/lib/shared.ts", related: 300, direct: 1 }], sources: ["src/lib/shared.ts"] };
    const runs: string[][] = [];
    // Only the last chunk's report counts tests: the sum still passes.
    const reports = new Map<string, object>([["report-0000.json", { numTotalTests: 0, numPassedTests: 0 }]]);
    sandbox(runs, reports)("/fixture", [], [], selection, null);
    const vitestRuns = runs.filter((args) => args[1] === "test:vitest");
    expect(vitestRuns.length).toBeGreaterThanOrEqual(3);
    const outputs = vitestRuns.map((args) => args.find((arg) => arg.startsWith("--outputFile="))!);
    expect(new Set(outputs).size).toBe(vitestRuns.length);
    for (const args of vitestRuns) {
      expect(args.slice(0, 6)).toEqual(["run", "test:vitest", "--", "run", "--reporter=default", "--reporter=json"]);
      expect(commandLineLength("bun", args)).toBeLessThanOrEqual(COMMAND_LINE_BUDGET_CHARS);
    }
    expect(vitestRuns.flatMap(fileArgs)).toEqual(tests.map((file) => `./${file}`));
    expect(envs.filter((_env, index) => runs[index][1] === "test:vitest")).toEqual(vitestRuns.map(() => STRIPPED));

    const empty = new Map<string, object>();
    for (let index = 0; index < vitestRuns.length; index += 1) {
      empty.set(`report-${String(index).padStart(4, "0")}.json`, { numTotalTests: 0, numPassedTests: 0 });
    }
    expect(() => sandbox([], empty)("/fixture", [], [], selection, null)).toThrow("bounded related tests ran zero tests");
  });

  it("splits the related-test discovery spawn and concatenates its per-source reports", () => {
    const sources = filesTotalling("node", ["/fixture/scripts/hooks/pre-push-related-tests.mjs"], 40_000)
      .map((file) => file.slice(2).replace(".test.ts", ".ts"));
    const spawns: string[][] = [];
    const spawnEnvs: unknown[] = [];
    const STRIPPED_DISCOVERY = Object.freeze({ STRIPPED: "discovery" });
    const select = runInNewContext(
      `${hook.slice(hook.indexOf("// Per-module related-test discovery"), hook.indexOf("function runAppCommentOnlyChecks"))}; getFastSourceRelatedSelection`,
      {
        commands: { node: "node" }, join, withoutGitContext: () => STRIPPED_DISCOVERY, readFileSync: () => "", splitArgumentsWithinBudget,
        spawnSync: (command: string, args: string[], options: { env: unknown }) => {
          spawns.push([command, ...args]);
          spawnEnvs.push(options.env);
          return { status: 0, stdout: JSON.stringify(args.slice(1).map((source) => ({ source, tests: [] }))) };
        },
        getRelatedCoverageFullReason,
        boundRelatedTests: () => ({ tests: [], narrowed: [] }),
      },
    );
    const result = select("/fixture", [], sources);
    expect(spawns.length).toBeGreaterThanOrEqual(3);
    for (const [command, ...args] of spawns) {
      expect(commandLineLength(command, args)).toBeLessThanOrEqual(COMMAND_LINE_BUDGET_CHARS);
    }
    expect(spawns.flatMap((args) => args.slice(2))).toEqual(sources);
    expect(result.untestedConsumers).toEqual(sources);
    expect(spawnEnvs).toEqual(spawns.map(() => STRIPPED_DISCOVERY));
  });

  it("leaves no file-list spawn of the hook outside the budgeted split", () => {
    expect(hook).not.toMatch(/run\(bun, \["run", "test:vitest", "--", "run", \.\.\./u);
    expect(hook).not.toMatch(/spawnSync\(commands\.node, \[join\(dir, "scripts\/hooks\/pre-push-related-tests\.mjs"\), \.\.\./u);
    expect(hook.match(/splitArgumentsWithinBudget\(/gu)).toHaveLength(2);
  });
});
