import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import config from "../../config/playwright.config.js";

const PACKAGE = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };

function selected(projectName: string, title: string): boolean {
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
  ])("selects %s exactly once", (title, expected) => {
    expect(config.projects?.filter((project) => selected(project.name ?? "", title)).map((project) => project.name)).toEqual([expected]);
  });

  it("keeps native activation out of the default command and explicitly reachable", () => {
    expect(PACKAGE.scripts["test:ui-e2e"]).toContain("--project=background");
    expect(PACKAGE.scripts["test:ui-e2e:os-focus"]).toContain("--project=os-focus");
  });

  it("keeps native focus coverage runnable on a virtual desktop", () => {
    const workflow = readFileSync(new URL("../../.github/workflows/e2e-os-focus.yml", import.meta.url), "utf8");
    expect(workflow).toContain("xvfb-run -a bun run test:ui-e2e:os-focus");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("schedule:");
  });
});
