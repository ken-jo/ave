import type * as ChildProcess from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { planCiSuite } from "../../scripts/run-ci-suite.mjs";
import { planVitestTiers, SUITE_PLAN_RULES, TRACED_AFFECTED_REASON } from "../../scripts/plan-vitest-tiers.mjs";

// planCiSuite reads the diff through git; the scenario supplies the merge commit, its changed paths and, when set, the related-test discovery result.
type Discovery = { status: number; stdout: string } | undefined;
const scenario = vi.hoisted(() => ({ paths: [] as string[], discovery: undefined as Discovery }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  const reply = (stdout: string, status = 0) => ({ pid: 0, output: [null, stdout, ""], stdout, stderr: "", status, signal: null });
  const spawnSync = ((command: string, args: readonly string[] = [], options?: ChildProcess.SpawnSyncOptions) => {
    if (command === "git" && args[0] === "rev-list") return reply(`${"c".repeat(40)} ${"a".repeat(40)} ${"b".repeat(40)}\n`);
    if (command === "git" && args[0] === "merge-base") return reply("");
    if (command === "git" && args[0] === "diff") {
      return reply(scenario.paths.map(path => `:100644 100644 ${"1".repeat(40)} ${"2".repeat(40)} M\0${path}\0`).join(""));
    }
    if (scenario.discovery && args.some(arg => arg.includes("pre-push-related-tests"))) return reply(scenario.discovery.stdout, scenario.discovery.status);
    return actual.spawnSync(command, args, options ?? {});
  }) as typeof ChildProcess.spawnSync;
  return { ...actual, spawnSync, default: { ...actual, spawnSync } };
});

const root = resolve(import.meta.dirname, "../..");
const UNRELATED_TEST = "src/ui/renderer/hooks/__tests__/use-send-message-resource.test.tsx";
const MAIN_PUSH = { eventName: "push", ref: "refs/heads/main" };
const PULL_REQUEST = { eventName: "pull_request", ref: "refs/pull/1/merge" };

function suitePlan(paths: string[], event: typeof MAIN_PUSH, refs: { headRef?: string; baseRef?: string }, discovery?: Discovery) {
  scenario.paths = paths;
  scenario.discovery = discovery;
  const written = JSON.parse(JSON.stringify(planCiSuite(event.eventName, { ...refs, ref: event.ref, before: "a".repeat(40) })));
  return { written, tiers: (plan: unknown = written) => planVitestTiers({ ...event, plan, changedPaths: paths }) };
}

afterEach(() => { scenario.paths = []; scenario.discovery = undefined; });

describe("Vitest tiers for written planCiSuite plans", () => {
  it.each([
    ["a pull request into main", { headRef: "test/renderer", baseRef: "main" }, "pull request into main; "],
    ["a test-only category merge", { headRef: "integration/renderer", baseRef: "main" }, "test-only category merge; "],
    ["a pull request into an integration base", { headRef: "test/renderer", baseRef: "integration/renderer" }, "pull request into integration/renderer; "],
  ])("selects neither tier for %s that traces an unrelated test", (_label, refs, rule) => {
    const { written, tiers } = suitePlan([UNRELATED_TEST], PULL_REQUEST, refs);
    expect(written).toMatchObject({ mode: "affected", reason: expect.stringMatching(new RegExp(`^${rule}`, "u")) });
    expect(written.tests).toContain(UNRELATED_TEST);
    expect(tiers()).toMatchObject({ census: false, native: false });
  }, 120_000);

  it("selects only the native tier for a comparable main push", () => {
    const { written, tiers } = suitePlan([UNRELATED_TEST], MAIN_PUSH, {});
    expect(written.reason).toMatch(/^main push: trusted selection over before\.\.HEAD; /u);
    expect(tiers()).toMatchObject({ census: false, native: true });
  }, 120_000);

  it("selects the native tier for a traced dependency of a native tier suite", () => {
    // Discovery reports one native importer, so the tier comes from the traced plan rather than a must-run group.
    const source = "src/lib/confined-process-phase.ts";
    const importer = "src/permissions/__tests__/asrt-sandbox.test.ts";
    const { written, tiers } = suitePlan([source], PULL_REQUEST, { headRef: "fix/phase", baseRef: "main" },
      { status: 0, stdout: JSON.stringify([{ source, tests: [importer] }]) });
    expect(written.reason).toMatch(/^pull request into main; 1 changed module\(s\) reach 1 test file\(s\); /u);
    expect(written.tests).toContain(importer);
    expect(tiers()).toEqual({ census: false, native: true, reason: `census: no shell rule change; native: the plan selects ${importer}` });
  }, 120_000);

  it("selects both tiers for an integration plan that carries a fallback warning", () => {
    const { written, tiers } = suitePlan(["src/shared/shell-filesystem-path.ts"], PULL_REQUEST, { headRef: "fix/paths", baseRef: "integration/permissions" }, { status: 1, stdout: "" });
    expect(written).toMatchObject({ mode: "affected", reason: expect.stringContaining("related test discovery failed; ") });
    expect(tiers()).toMatchObject({ census: true, native: true });
  }, 120_000);

  it("selects both tiers for an integration plan whose path warning opens like the traced summary", () => {
    const path = "1 changed module(s) reach 1 test file(s); a.ts";
    const { written, tiers } = suitePlan([UNRELATED_TEST, path], PULL_REQUEST, { headRef: "fix/paths", baseRef: "integration/renderer" }, { status: 0, stdout: "[]" });
    expect(written).toMatchObject({ mode: "affected", reason: expect.stringMatching(/^pull request into integration\/renderer; 1 changed module\(s\) reach 1 test file\(s\); a\.ts is not a safe command-line path; /u) });
    expect(written.tests.length).toBeGreaterThan(0);
    expect(tiers()).toMatchObject({ census: true, native: true });
  }, 120_000);

  it("selects both tiers for a full, invalid or empty written plan", () => {
    const fullPlan = suitePlan(["tsconfig.tests.json"], PULL_REQUEST, { headRef: "fix/config", baseRef: "main" });
    expect(fullPlan.written.mode).toBe("full");
    expect(fullPlan.tiers()).toMatchObject({ census: true, native: true });
    const { written, tiers } = suitePlan([UNRELATED_TEST], PULL_REQUEST, { headRef: "test/renderer", baseRef: "main" });
    for (const plan of [{ ...written, tests: [] }, { ...written, tests: [null, 42] }, { ...written, reason: undefined }, null]) {
      expect(tiers(plan)).toMatchObject({ census: true, native: true });
    }
  }, 120_000);

  it("knows every rule planCiSuite prefixes to an affected plan's reason", () => {
    const source = readFileSync(resolve(root, "scripts/run-ci-suite.mjs"), "utf8");
    const statements = [...source.matchAll(/const rule = ([\s\S]*?);\n/gu)].map(match => match[1]);
    expect(statements).toHaveLength(1);
    const rule = statements[0].replace(/\s+/gu, " ");
    const literals = [...rule.matchAll(/"([^"]*)"|`([^`]*)`/gu)].map(match => match[1] ?? match[2].replace(/\$\{baseRef\}$/u, ""));
    expect(rule.replace(/"[^"]*"|`[^`]*`/gu, "")).toBe("mainPush ?  : isCategoryMergeToMain(headRef, baseRef) ? (isTestOnlyDiff(changes.entries) ?  : ) : ");
    expect(literals).toEqual([...SUITE_PLAN_RULES.push, ...SUITE_PLAN_RULES.pull_request]);
    expect(source.match(/reason: `\$\{rule\}; \$\{plan\.reason\}`/gu)).toHaveLength(1);
  });

  it("matches the selectCiTests summary template to the traced grammar", () => {
    const source = readFileSync(resolve(root, "scripts/run-ci-suite.mjs"), "utf8");
    const templates = [...source.matchAll(/reason:\s*warnings \+ selectionRule \+([\s\S]*?),\n\s*tests,/gu)].map(match => match[1]);
    expect(templates).toHaveLength(1);
    const pieces = templates[0].split("+").map(piece => piece.trim());
    expect(pieces.every(piece => /^`[^`]*`$/u.test(piece))).toBe(true);
    const summary = pieces.map(piece => piece.slice(1, -1).replace(/\$\{[^}]*\}/gu, "0")).join("");
    const rules = [...(source.match(/const selectionRule = ([\s\S]*?);\n/u)?.[1] ?? "").matchAll(/"([^"]*)"/gu)].map(match => match[1]);
    expect(rules).toEqual(["test-only diff: affected tests on every base; ", "integration base: traced selection, strict fallback at the main boundary; ", ""]);
    for (const rule of rules) {
      expect(TRACED_AFFECTED_REASON.test(`${rule}${summary}`), rule).toBe(true);
      expect(TRACED_AFFECTED_REASON.test(`a.ts is a global test or build input; ${rule}${summary}`), rule).toBe(false);
    }
  });
});
