import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { changedPathsFor, planVitestTiers } from "../../scripts/plan-vitest-tiers.mjs";
import { collectedVitestFiles } from "../../scripts/lib/vitest-collection.mjs";
import { CENSUS_TIER_TESTS, selectedVitestTiers, vitestTierEnabled } from "../../scripts/lib/vitest-tiers.mjs";

const root = resolve(import.meta.dirname, "../..");
// A GitHub expression as the workflow spells it.
const gh = (body: string) => `\${{ ${body} }}`;
const affected = (tests: string[]) => ({ mode: "affected", reason: "test", tests });
const full = { mode: "full", reason: "test", tests: [] };
const pr = (changedPaths: string[] | null, plan: unknown = affected([])) => planVitestTiers({ eventName: "pull_request", ref: "refs/pull/1/merge", plan, changedPaths });

type Step = { name?: string; id?: string; if?: string; run?: string; env?: Record<string, string> };
type Job = { needs?: string | string[]; if?: string; outputs?: Record<string, string>; steps: Step[] };
const workflow = parse(readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8")) as { on: { schedule?: { cron: string }[]; pull_request?: unknown }; jobs: Record<string, Job> };

describe("Vitest tier selection", () => {
  it("names only collected census partitions", () => {
    const collected = new Set(collectedVitestFiles(root));
    expect(CENSUS_TIER_TESTS).toHaveLength(12);
    for (const test of CENSUS_TIER_TESTS) expect(collected.has(test), test).toBe(true);
  });

  it("parses AVE_VITEST_TIERS and rejects unknown tiers", () => {
    expect([...selectedVitestTiers(undefined)]).not.toContain("census");
    expect(vitestTierEnabled("census", "default,census")).toBe(true);
    expect(() => selectedVitestTiers("default,cencus")).toThrow(/unknown tier/);
    expect(() => selectedVitestTiers(" , ")).toThrow(/at least one tier/);
  });

  it("selects the census for nightly, dispatch and tags", () => {
    for (const eventName of ["schedule", "workflow_dispatch"]) expect(planVitestTiers({ eventName, ref: "refs/heads/main", plan: null, changedPaths: null }).census).toBe(true);
    expect(planVitestTiers({ eventName: "push", ref: "refs/tags/v1.0.0", plan: full, changedPaths: [] }).census).toBe(true);
  });

  it("selects the census for a pull request that changes a shell rule or encoded-command file", () => {
    for (const path of ["src/permissions/rules/powershell-encoded-command.ts", "src/permissions/rules/shell-rule-approval.ts", "src/shared/shell-parser.ts",
      "src/__tests__/support/encoded-unicode-fixtures.ts", "src/permissions/__tests__/powershell-encoded-unicode.test.ts", CENSUS_TIER_TESTS[0]]) {
      expect(pr([path]).census, path).toBe(true);
      expect(pr([path], full).census, path).toBe(true);
    }
    expect(pr(["src/permissions/permission-manager.ts"], affected([CENSUS_TIER_TESTS[3]])).census).toBe(true);
  });

  it("selects the census on a main push only from the diff or the plan", () => {
    const push = (changedPaths: string[]) => planVitestTiers({ eventName: "push", ref: "refs/heads/main", plan: affected([]), changedPaths });
    expect(push(["src/permissions/rules/shell-rule-matcher.ts"]).census).toBe(true);
    expect(push(["src/ui/renderer/app.tsx"]).census).toBe(false);
  });

  it("fails closed on an unresolved diff, an unreadable plan or a tier definition change", () => {
    expect(pr(null).census).toBe(true);
    expect(pr(["src/ui/renderer/app.tsx"], { mode: "affected" }).census).toBe(true);
    expect(pr(["src/ui/renderer/app.tsx"], null).census).toBe(true);
    for (const path of ["scripts/lib/vitest-tiers.mjs", "config/vitest.analysis.config.ts", ".github/workflows/ci.yml"]) expect(pr([path]).census, path).toBe(true);
  });

  it("leaves the census out of an unrelated pull request, full or affected", () => {
    expect(pr(["src/ui/renderer/app.tsx", "docs/README.md"]).census).toBe(false);
    expect(pr(["src/__tests__/support/fixture-owner.ts"], full).census).toBe(false);
  });

  it("diffs a pull request against its merge commit's first parent and a push against a resolvable before commit", () => {
    const calls: string[][] = [];
    const run = (args: string[]) => {
      calls.push(args);
      if (args[0] === "rev-list") return "merge base head\n";
      if (args[0] === "diff") return "a.ts\0b.ts\0";
      return "";
    };
    expect(changedPathsFor("pull_request", undefined, run)).toEqual(["a.ts", "b.ts"]);
    expect(calls.at(-1)).toEqual(["diff", "--no-renames", "--name-only", "-z", "base", "HEAD", "--"]);
    expect(changedPathsFor("push", "0".repeat(40), run)).toBeNull();
    expect(changedPathsFor("push", "not-a-sha", run)).toBeNull();
    expect(changedPathsFor("pull_request", undefined, () => "only-one\n")).toBeNull();
    expect(changedPathsFor("push", "a".repeat(40), () => { throw new Error("not an ancestor"); })).toBeNull();
  });
});

describe("Vitest tier CI wiring", () => {
  const { build, "vitest-tiers": tiers, "build-and-test": gate, vitest } = workflow.jobs;

  it("plans the tiers in the build job from the written suite plan", () => {
    const plan = build.steps.findIndex(step => step.id === "plan");
    const tierStep = build.steps.findIndex(step => step.id === "tiers");
    expect(tierStep).toBeGreaterThan(plan);
    expect(build.steps[tierStep].run).toBe(`node scripts/plan-vitest-tiers.mjs "$RUNNER_TEMP/ci-plan/ci-plan.json"`);
    expect(build.steps[tierStep].env?.AVE_CI_DIFF_BASE).toBe(gh("github.event.pull_request.base.sha || github.event.before"));
    expect(build.outputs?.census_tier).toBe(gh("steps.tiers.outputs.census_tier || 'false'"));
  });

  it("runs the complete census nightly and whenever the build job selects it", () => {
    expect(workflow.on.schedule?.map(entry => entry.cron)).toEqual(["0 18 * * *"]);
    expect(workflow.on.pull_request).toBeDefined();
    expect(tiers.needs).toBe("build");
    expect(tiers.if).toContain("needs.build.outputs.census_tier == 'true'");
    const census = tiers.steps.find(step => step.name === "Run the complete encoded-unicode census");
    expect(census?.if).toBe("needs.build.outputs.census_tier == 'true'");
    expect(census?.env?.AVE_VITEST_TIERS).toBe("default,census");
    expect(census?.run).toBe("bun run test:vitest -- run --silent=true src/permissions/__tests__/powershell-encoded-unicode/");
    expect(vitest.steps.some(step => step.env?.AVE_VITEST_TIERS?.includes("census"))).toBe(false);
  });

  it("requires the tier job in build-and-test when selected", () => {
    expect(gate.needs).toContain("vitest-tiers");
    const check = gate.steps[0];
    expect(check.env?.CENSUS_TIER).toBe(gh("needs.build.outputs.census_tier"));
    expect(check.env?.VITEST_TIERS_RESULT).toBe(gh("needs.vitest-tiers.result"));
    expect(check.run).toContain(`case "$CENSUS_TIER:$VITEST_TIERS_RESULT" in\n  true:success|false:skipped) ;;`);
  });
});
