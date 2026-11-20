import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { parse, stringify } from "yaml";
import { checkWindowsWorkflow, directCommandProblems, windowsRunSteps } from "../../.github/scripts/check-windows-workflow.mjs";

const workflow = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");

it("runs the workflow guard before any Windows test commands", () => {
  const steps = parse(workflow).jobs["windows-permission-tests"].steps;
  const guard = steps.findIndex(step => step.name === "Validate Windows workflow commands");
  const firstTest = steps.findIndex(step => /(?:\bbun run test|\bnode scripts\/test-|\s--test\s|run-windows-test-list)/u.test(step.run ?? ""));
  assert.ok(firstTest >= 0);
  assert.ok(guard >= 0 && guard < firstTest);
  assert.equal(steps[guard].if, steps[firstTest].if);
  assert.equal(steps[guard]["continue-on-error"], undefined);
  assert.equal(steps[guard].run, "node .github/scripts/check-windows-workflow.mjs");
});

it("keeps the Windows direct test commands together and off bare path lines", () => {
  assert.deepEqual(directCommandProblems(windowsRunSteps(workflow)), []);
});

it("rejects the historically broken permission scalar as parsed YAML", () => {
  const historic = parse(readFileSync(new URL("../fixtures/windows-permission-command.yml", import.meta.url), "utf8"));
  const brokenWorkflow = stringify({ jobs: { "windows-permission-tests": { "runs-on": "windows-latest", steps: historic } } });
  const [step] = windowsRunSteps(brokenWorkflow);
  assert.equal(step.run, historic[0].run);
  assert.deepEqual(directCommandProblems([step]), [
    "windows-permission-tests: Run Windows permission regressions: expected one complete direct test command",
    "windows-permission-tests: Run Windows permission regressions: bare test path src/__tests__/packaging-discipline-source.test.ts",
  ]);
});

it("fails when a required PowerShell parser cannot launch", () => {
  assert.throws(() => checkWindowsWorkflow(workflow, shell => {
    throw new Error(`Missing parser: ${shell}`);
  }), /Missing parser: pwsh/);
});
