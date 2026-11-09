import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { githubExpression } from "../../src/__tests__/test-helpers.js";

for (const file of ["ci.yml", "build-installers.yml", "web-ci.yml", "web-deploy.yml"]) {
  const workflow = parse(readFileSync(`.github/workflows/${file}`, "utf8"));
  describe(`${file} download credentials`, () => {
    it("scopes the read token to release download steps", () => {
      expect(workflow.env?.GITHUB_TOKEN).toBeUndefined();
      for (const job of Object.values(workflow.jobs) as Array<{ env?: Record<string, string>; steps: Array<{ name?: string; uses?: string; run?: string; env?: Record<string, string> }> }>) {
        expect(job.env?.GITHUB_TOKEN).toBeUndefined();
        for (const step of job.steps) {
          const downloads = step.uses?.endsWith("/.github/actions/setup-bun")
            || (file === "ci.yml" || file === "build-installers.yml") && step.run === "bun install --frozen-lockfile"
            || step.run === "node scripts/fetch-uv.mjs"
            || step.run === "node .github/scripts/python-download-mirror.mjs"
            || step.name === "Build installer";
          if (downloads) expect(step.env?.GITHUB_TOKEN).toBe(githubExpression("github.token"));
          else if (step.name !== "Report the total runner budget") expect(step.env?.GITHUB_TOKEN).toBeUndefined();
        }
      }
    });
  });
}
