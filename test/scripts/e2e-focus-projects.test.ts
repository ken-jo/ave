import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";

const PACKAGE = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };

type PlaywrightConfig = (typeof import("../../config/playwright.config.js"))["default"];

async function loadConfig(osFocus: string | undefined): Promise<PlaywrightConfig> {
  vi.resetModules();
  vi.stubEnv("AVE_E2E_OS_FOCUS", osFocus);
  return (await import("../../config/playwright.config.js")).default;
}

afterEach(() => { vi.unstubAllEnvs(); });

function selected(config: PlaywrightConfig, projectName: string, title: string): boolean {
  const project = config.projects?.find((entry) => entry.name === projectName);
  if (!project) throw new Error(`Missing test project: ${projectName}`);
  const matches = (patterns: RegExp | RegExp[] | undefined) => patterns === undefined || (Array.isArray(patterns) ? patterns : [patterns]).some((pattern) => pattern.test(title));
  return matches(project.grep) && (project.grepInvert === undefined || !matches(project.grepInvert));
}

describe("native focus test selection", () => {
  it.each([
    ["background keyboard input", "background"],
    ["@cdp guest input", "background"],
    ["@os-focus native select", "os-focus"],
    ["popup @os-focus native focus", "os-focus"],
  ])("selects %s exactly once with the native focus opt-in", async (title, expected) => {
    const config = await loadConfig("1");
    expect(config.projects?.filter((project) => selected(config, project.name ?? "", title)).map((project) => project.name)).toEqual([expected]);
  });

  it.each([undefined, "", "0", "true"])("runs no native focus test without the exact opt-in (%s)", async (flag) => {
    const config = await loadConfig(flag);
    expect(config.projects?.map((project) => project.name)).toEqual(["background"]);
    expect(selected(config, "background", "@os-focus native select")).toBe(false);
    expect(selected(config, "background", "background keyboard input")).toBe(true);
  });

  it("keeps native activation out of the default command and explicitly reachable", () => {
    expect(PACKAGE.scripts["test:ui-e2e"]).toContain("--project=background");
    expect(PACKAGE.scripts["test:ui-e2e:os-focus"]).toContain("AVE_E2E_OS_FOCUS=1 playwright test");
    expect(PACKAGE.scripts["test:ui-e2e:os-focus"]).toContain("--project=os-focus");
    expect(PACKAGE.scripts["test:ui-e2e"]).not.toContain("AVE_E2E_OS_FOCUS");
  });

  it("preserves one worker and within-file lifetime in background shards", async () => {
    const config = await loadConfig("0");
    expect(config.workers).toBe(1);
    expect(config.fullyParallel).toBe(false);
  });

  it("keeps native focus coverage runnable on a virtual desktop", () => {
    const workflow = readFileSync(new URL("../../.github/workflows/e2e-os-focus.yml", import.meta.url), "utf8");
    expect(workflow).toContain("xvfb-run -a -s '-screen 0 1600x1000x24'");
    expect(workflow).toContain("openbox > test-results/native-os-focus/window-manager.log");
    expect(workflow).toContain("PLAYWRIGHT_JSON_OUTPUT_NAME: $" + "{{ github.workspace }}/ave/test-results/native-os-focus/results.json");
    expect(workflow).toContain("bun run test:ui-e2e:os-focus");
    expect(workflow).toContain("--retries=0");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("schedule:");
  });

  it("runs the full background sweep only on explicit manual selection", () => {
    const workflow = parse(readFileSync(new URL("../../.github/workflows/e2e-os-focus.yml", import.meta.url), "utf8"));
    expect(workflow.on.workflow_dispatch.inputs["background-sweep"].default).toBe(false);
    expect(workflow.jobs["os-focus"].if).toBe("github.event_name != 'workflow_dispatch' || !inputs.background-sweep");
    for (const id of ["background-build", "background-shard"]) {
      expect(workflow.jobs[id].if).toBe("github.event_name == 'workflow_dispatch' && inputs.background-sweep");
      expect(workflow.jobs[id].steps.some((step: { run?: string }) => step.run === "node scripts/fetch-uv.mjs")).toBe(true);
    }
    const build = workflow.jobs["background-build"];
    const upload = build.steps.find((step: { with?: { name?: string } }) => step.with?.name === "background-ui-build");
    expect(upload.with.path).toContain("ave/build");
    expect(upload.with.path).toContain("ave/dist");
    const shard = workflow.jobs["background-shard"];
    expect(shard.env.PLAYWRIGHT_BROWSERS_PATH).toContain("/.cache/ms-playwright");
    expect(shard.steps.some((step: { run?: string }) => step.run === "bun x playwright install --with-deps chromium")).toBe(true);
    expect(shard.strategy["fail-fast"]).toBe(false);
    expect(shard.strategy.matrix.shard).toEqual(Array.from({ length: 96 }, (_, index) => index + 1));
    expect(shard["timeout-minutes"]).toBe(12);
    const run = shard.steps.find((step: { name?: string }) => step.name === "Run the background shard");
    expect(run["timeout-minutes"]).toBe(10);
    expect(run.env.AVE_E2E_OS_FOCUS).toBe("0");
    expect(run.run).toContain('--shard="$SHARD/96" --retries=0');
    expect(run.run).toContain("--reporter=list,./test/e2e/reporters/spec-results.ts");
    expect(run.run).not.toMatch(/--(?:grep|max-failures|timeout|fully-parallel)/);
    expect(shard.steps.find((step: { name?: string }) => step.name === "Upload per-spec shard evidence").if).toBe("always()");
    const ci = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
    expect(ci).not.toContain("background-shard");
  });
});
