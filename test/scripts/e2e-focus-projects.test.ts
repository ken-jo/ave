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

  it("requires background approvals and keyboard authority in the existing build job", () => {
    const workflow = parse(readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8"));
    const build = workflow.jobs.build;
    expect(build["runs-on"]).toBe("ubuntu-24.04-arm");
    const step = build.steps.find((entry: { name?: string }) => entry.name === "Verify background approvals and keyboard authority");
    expect(step.if).toBe("steps.docs-impact.outputs.docs_only != 'true'");
    expect(step["timeout-minutes"]).toBe(5);
    expect(step.env.AVE_E2E_OS_FOCUS).toBe("0");
    expect(step.run).toContain("xvfb-run -a -s '-screen 0 1600x1000x24' bun run test:ui-e2e ui/approval-dialog.spec.ts ui/background-focus.spec.ts --retries=0");
    expect(step.run).toContain("--output=test-results/background/cases");
    expect(step.run).toContain("GITHUB_STEP_SUMMARY");
    expect(build.steps.find((entry: { name?: string }) => entry.name === "Upload background UI evidence").if).toContain("always()");
  });

});
