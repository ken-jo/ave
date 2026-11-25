import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfigFromFile } from "vite";
import { describe, expect, it } from "vitest";
import type { ViteUserConfig } from "vitest/config";
import { parse } from "yaml";
import { changedPathsFor, planVitestTiers, vitestTierOutputs } from "../../scripts/plan-vitest-tiers.mjs";
import { collectedVitestFiles } from "../../scripts/lib/vitest-collection.mjs";
import { CENSUS_TIER_TESTS, NATIVE_TIER_TESTS, selectedVitestTiers, vitestTierEnabled } from "../../scripts/lib/vitest-tiers.mjs";

const root = resolve(import.meta.dirname, "../..");
// A GitHub expression as the workflow spells it.
const gh = (body: string) => `\${{ ${body} }}`;
const affected = (tests: string[]) => ({ mode: "affected", reason: "test", tests });
const full = { mode: "full", reason: "test", tests: [] };
const pr = (changedPaths: string[] | null, plan: unknown = affected([])) => planVitestTiers({ eventName: "pull_request", ref: "refs/pull/1/merge", plan, changedPaths });

type Step = { name?: string; id?: string; if?: string; run?: string; env?: Record<string, string> };
type Job = { needs?: string | string[]; if?: string; outputs?: Record<string, string>; env?: Record<string, string>; strategy?: { matrix: { shard: number[] } }; steps: Step[] };
const workflow = parse(readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8")) as { on: { schedule?: { cron: string }[]; pull_request?: unknown }; jobs: Record<string, Job> };

describe("Vitest tier selection", () => {
  it("names only collected census partitions and native suites", () => {
    const collected = new Set(collectedVitestFiles(root));
    expect(CENSUS_TIER_TESTS).toHaveLength(12);
    expect(NATIVE_TIER_TESTS).toHaveLength(20);
    for (const test of [...CENSUS_TIER_TESTS, ...NATIVE_TIER_TESTS]) expect(collected.has(test), test).toBe(true);
    expect(CENSUS_TIER_TESTS.filter(test => NATIVE_TIER_TESTS.includes(test))).toEqual([]);
  });

  it("parses AVE_VITEST_TIERS and rejects unknown tiers", () => {
    expect([...selectedVitestTiers(undefined)].sort()).toEqual(["default", "native"]);
    expect(vitestTierEnabled("census", "default,census")).toBe(true);
    expect(() => selectedVitestTiers("default,cencus")).toThrow(/unknown tier/);
    expect(() => selectedVitestTiers(" , ")).toThrow(/at least one tier/);
  });

  it("selects every tier for nightly, dispatch and tags", () => {
    for (const eventName of ["schedule", "workflow_dispatch"]) expect(planVitestTiers({ eventName, ref: "refs/heads/main", plan: null, changedPaths: null })).toMatchObject({ census: true, native: true });
    expect(planVitestTiers({ eventName: "push", ref: "refs/tags/v1.0.0", plan: full, changedPaths: [] })).toMatchObject({ census: true, native: true });
  });

  it("selects the census for a pull request that changes a shell rule or encoded-command file", () => {
    for (const path of ["src/permissions/rules/powershell-encoded-command.ts", "src/permissions/rules/shell-rule-approval.ts", "src/shared/shell-parser.ts",
      "src/__tests__/support/encoded-unicode-fixtures.ts", "src/permissions/__tests__/powershell-encoded-unicode.test.ts", CENSUS_TIER_TESTS[0]]) {
      expect(pr([path]).census, path).toBe(true);
      expect(pr([path], full).census, path).toBe(true);
    }
    expect(pr(["src/permissions/permission-manager.ts"], affected([CENSUS_TIER_TESTS[3]])).census).toBe(true);
  });

  it("selects the census on a main push only from the diff or the plan, and the native tier always", () => {
    const push = (changedPaths: string[]) => planVitestTiers({ eventName: "push", ref: "refs/heads/main", plan: affected([]), changedPaths });
    expect(push(["src/permissions/rules/shell-rule-matcher.ts"]).census).toBe(true);
    expect(push(["src/ui/renderer/app.tsx"])).toMatchObject({ census: false, native: true });
  });

  it("selects the native tier for a pull request that changes permissions, sandbox, native helpers, MXC or srt-win", () => {
    for (const path of ["src/permissions/permission-manager.ts", "src/sandbox/runtime-grant.ts", "src/plugins/isolation/confined-child.ts",
      "native/windows-job/main.c", "tools/mxc-probes/probe.ts", "patches/some-package.patch", "bun.lock", "scripts/build-srt-win.mjs",
      "src/main/mxc-runtime.ts", "scripts/lib/asrt-paths.mjs", "src/shared/sandbox-paths.ts", NATIVE_TIER_TESTS[0]]) {
      expect(pr([path]).native, path).toBe(true);
    }
    expect(pr(["src/main/memory-map/index.ts"], affected([NATIVE_TIER_TESTS[0]])).native).toBe(true);
    expect(pr(["src/__tests__/support/fixture-owner.ts"], full).native).toBe(true);
  });

  it("fails closed on an unresolved diff, an unreadable plan or a tier definition change", () => {
    const every = { census: true, native: true };
    expect(pr(null)).toMatchObject(every);
    expect(pr(["src/ui/renderer/app.tsx"], { mode: "affected" })).toMatchObject(every);
    expect(pr(["src/ui/renderer/app.tsx"], null)).toMatchObject(every);
    for (const path of ["scripts/lib/vitest-tiers.mjs", "config/vitest.analysis.config.ts", ".github/workflows/ci.yml",
      "scripts/plan-windows-tests.ts", "scripts/run-windows-test-list.mjs", ".github/scripts/check-windows-workflow.mjs"]) expect(pr([path]), path).toMatchObject(every);
  });

  it("leaves both tiers out of an unrelated pull request", () => {
    expect(pr(["src/ui/renderer/app.tsx", "docs/README.md"])).toMatchObject({ census: false, native: false });
    expect(pr(["src/__tests__/support/fixture-owner.ts"], full).census).toBe(false);
  });

  it("keeps the native tier in the default shards only on events that select every tier", () => {
    const pull = vitestTierOutputs("pull_request", "refs/pull/1/merge", { census: false, native: true, reason: "" });
    expect(pull).toEqual({ census_tier: "false", native_tier: "true", default_vitest_tiers: "default", tier_job_native: "true", vitest_tier_job: "true", windows_tiers: "native" });
    expect(vitestTierOutputs("pull_request", "refs/pull/1/merge", { census: false, native: false, reason: "" }))
      .toMatchObject({ default_vitest_tiers: "default", vitest_tier_job: "false", windows_tiers: "" });
    expect(vitestTierOutputs("push", "refs/heads/main", { census: true, native: true, reason: "" }))
      .toMatchObject({ default_vitest_tiers: "default", tier_job_native: "true", windows_tiers: "native,census" });
    expect(vitestTierOutputs("schedule", "refs/heads/main", { census: true, native: true, reason: "" }))
      .toMatchObject({ default_vitest_tiers: "default,native", tier_job_native: "false", vitest_tier_job: "true", windows_tiers: "native,census" });
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

type Project = { test?: { name?: string; include?: string[]; exclude?: string[] } };
async function projectsFor(tiers: string | undefined): Promise<Project["test"][]> {
  const previous = process.env.AVE_VITEST_TIERS;
  if (tiers === undefined) delete process.env.AVE_VITEST_TIERS;
  else process.env.AVE_VITEST_TIERS = tiers;
  try {
    const loaded = await loadConfigFromFile({ command: "serve", mode: "test" }, resolve(root, "config/vitest.analysis.config.ts"));
    if (loaded === null) throw new Error("Missing test configuration");
    return (((loaded.config as ViteUserConfig).test?.projects ?? []) as Project[]).map(project => project.test);
  } finally {
    if (previous === undefined) delete process.env.AVE_VITEST_TIERS;
    else process.env.AVE_VITEST_TIERS = previous;
  }
}

describe("Vitest tier projects", () => {
  it("collects the native suites only in the native project", async () => {
    const all = await projectsFor(undefined);
    expect(all.map(project => project?.name)).toEqual(["node", "jsdom", "permission-timing", "native"]);
    expect(all[0]?.exclude).toEqual(expect.arrayContaining([...NATIVE_TIER_TESTS]));
    expect(all[3]?.include).toEqual([...NATIVE_TIER_TESTS]);
    expect((await projectsFor("default")).map(project => project?.name)).toEqual(["node", "jsdom", "permission-timing"]);
    expect((await projectsFor("native")).map(project => project?.name)).toEqual(["native"]);
    expect((await projectsFor("default,census")).map(project => project?.name)).toEqual(["node", "jsdom", "permission-timing"]);
  }, 60_000);
});

describe("Vitest tier CI wiring", () => {
  const { build, "vitest-tiers": tiers, "build-and-test": gate, vitest, "windows-permission-tests": windows, "windows-tier-tests": windowsTiers } = workflow.jobs;

  it("plans the tiers in the build job from the written suite plan", () => {
    const plan = build.steps.findIndex(step => step.id === "plan");
    const tierStep = build.steps.findIndex(step => step.id === "tiers");
    const windowsPlan = build.steps.findIndex(step => step.name === "Plan Windows regressions");
    expect(tierStep).toBeGreaterThan(plan);
    expect(windowsPlan).toBeGreaterThan(tierStep);
    expect(build.steps[tierStep].run).toBe(`node scripts/plan-vitest-tiers.mjs "$RUNNER_TEMP/ci-plan/ci-plan.json"`);
    expect(build.steps[tierStep].env?.AVE_CI_DIFF_BASE).toBe(gh("github.event.pull_request.base.sha || github.event.before"));
    expect(build.steps[windowsPlan].env?.AVE_WINDOWS_TEST_TIERS).toBe(gh("steps.tiers.outputs.windows_tiers"));
    expect(build.outputs).toMatchObject({
      census_tier: gh("steps.tiers.outputs.census_tier || 'false'"),
      native_tier: gh("steps.tiers.outputs.native_tier || 'false'"),
      default_vitest_tiers: gh("steps.tiers.outputs.default_vitest_tiers || 'default,native'"),
      tier_job_native: gh("steps.tiers.outputs.tier_job_native || 'false'"),
      vitest_tier_job: gh("steps.tiers.outputs.vitest_tier_job || 'false'"),
      windows_tier_tests: gh("steps.plan.outputs.platform_checks == 'true' && steps.tiers.outputs.windows_tiers != ''"),
    });
  });

  it("runs the default shards on the tiers the build job chose for them", () => {
    const suite = vitest.steps.find(step => step.run === "bun run test:ci");
    expect(suite?.env?.AVE_VITEST_TIERS).toBe(gh("needs.build.outputs.default_vitest_tiers"));
    expect(vitest.steps.some(step => step.env?.AVE_VITEST_TIERS?.includes("census"))).toBe(false);
  });

  it("runs the complete census and the native tier nightly and whenever the build job selects them", () => {
    expect(workflow.on.schedule?.map(entry => entry.cron)).toEqual(["0 18 * * *"]);
    expect(workflow.on.pull_request).toBeDefined();
    expect(tiers.needs).toBe("build");
    expect(tiers.if).toBe("needs.build.outputs.vitest_tier_job == 'true'");
    const census = tiers.steps.find(step => step.name === "Run the complete encoded-unicode census");
    expect(census?.if).toBe("needs.build.outputs.census_tier == 'true'");
    expect(census?.env?.AVE_VITEST_TIERS).toBe("default,census");
    expect(census?.run).toBe("bun run test:vitest -- run --silent=true src/permissions/__tests__/powershell-encoded-unicode/");
    const native = tiers.steps.find(step => step.name === "Run the native tier");
    expect(native?.if).toBe("needs.build.outputs.tier_job_native == 'true'");
    expect(native?.env).toMatchObject({ AVE_VITEST_TIERS: "native", AVE_REQUIRE_SANDBOX_CASES: "1" });
    expect(native?.run).toBe("bun run test:vitest -- run --silent=true");
    const prove = tiers.steps.findIndex(step => step.name === "Prove the sandbox backend");
    expect(prove).toBeGreaterThan(-1);
    expect(prove).toBeLessThan(tiers.steps.indexOf(native as Step));
  });

  it("runs the Windows tier shards when the build job selects a tier", () => {
    expect(windowsTiers.needs).toEqual(windows.needs);
    expect(windowsTiers.if).toBe(`${windows.if} && needs.build.outputs.windows_tier_tests == 'true'`);
    expect(windowsTiers.strategy?.matrix.shard).toEqual([1, 2, 3]);
    expect(windowsTiers.env).toMatchObject({ AVE_WINDOWS_TEST_TIER: "tiers", AVE_VITEST_TIERS: "default,native,census" });
    expect(windows.env?.AVE_WINDOWS_TEST_TIER).toBeUndefined();
  });

  it("requires each tier job in build-and-test when selected", () => {
    expect(gate.needs).toEqual(expect.arrayContaining(["vitest-tiers", "windows-tier-tests"]));
    const check = gate.steps[0];
    expect(check.env).toMatchObject({
      VITEST_TIER_JOB: gh("needs.build.outputs.vitest_tier_job"),
      VITEST_TIERS_RESULT: gh("needs.vitest-tiers.result"),
      WINDOWS_TIER_TESTS: gh("needs.build.outputs.windows_tier_tests"),
      WINDOWS_TIER_RESULT: gh("needs.windows-tier-tests.result"),
    });
    expect(check.run).toContain(`case "$VITEST_TIER_JOB:$VITEST_TIERS_RESULT" in
  true:success|false:skipped) ;;`);
    expect(check.run).toContain(`case "$WINDOWS_TIER_TESTS:$WINDOWS_TIER_RESULT" in
  true:success|false:skipped) ;;`);
  });
});
