import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { parse, stringify } from "yaml";
import { windowsTestCommands } from "../../scripts/run-windows-test-list.mjs";
import { COMMAND_LINE_BUDGET_CHARS, commandLineLength } from "../../scripts/hooks/spawn-command.mjs";
import { checkWindowsWorkflow, directCommandProblems, powerShellCommandProblems, windowsRunSteps } from "../../.github/scripts/check-windows-workflow.mjs";

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

it("keeps every Windows run scalar within the workflow limit", () => {
  const oversized = windowsRunSteps(workflow).filter(({ run }) => run.length > 21_000)
    .map(({ name, run }) => [name, run.length]);
  assert.deepEqual(oversized, []);
});

it("routes the permission and native inventories through bounded batches", () => {
  const { steps } = parse(workflow).jobs["windows-permission-tests"];
  for (const [name, inventory] of [
    ["Run Windows permission regressions", "config/windows-permission-tests.txt"],
    ["Run Windows native import regressions", "config/windows-native-tests.txt"],
  ]) {
    const step = steps.find(entry => entry.name === name);
    assert.equal(step.run, `bun run scripts/run-windows-test-list.mjs ${inventory}`);
    assert.equal(step.env.UV_PYTHON_CACHE_DIR, "${{ runner.temp }}/python-archives");
    const list = readFileSync(new URL(`../../${inventory}`, import.meta.url), "utf8");
    const batches = windowsTestCommands(list);
    assert.ok(batches.length > 2);
    for (const args of batches) assert.ok(commandLineLength("bun.exe", args) <= COMMAND_LINE_BUDGET_CHARS);
    assert.deepEqual(batches.slice(1).flatMap(args => args.slice(4)),
      [...new Set(list.trim().split(/\r?\n/u))].map(file => `./${file}`));
  }
});

it("uses the configured edition, its aliases, and the enclosing function scopes", () => {
  const steps = [
    { name: "core", shell: "pwsh", run: "example" },
    { name: "desktop", shell: "powershell", run: "bob" },
  ];
  const calls = [];
  const command = (name, line, scopes) => ({ name, head: name, line, scopes });
  const problems = powerShellCommandProblems(steps, (edition, sources) => {
    calls.push([edition, sources]);
    return edition === "pwsh" ? {
      cmdlets: [],
      aliases: ["alice"],
      steps: [{
        errors: [],
        functions: [{ name: "shared", scope: 0 }, { name: "example", scope: 10 }],
        commands: [
          command("alice", 1, [0]), command("shared", 2, [10, 0]), command("example", 3, [10, 0]),
          command("example", 4, [15, 0]), command("example", 5, [0]), command("bob", 6, [0]),
        ],
      }],
    } : {
      cmdlets: [],
      aliases: ["bob"],
      steps: [{ errors: [], functions: [], commands: [command("alice", 1, [0]), command("bob", 2, [0])] }],
    };
  });
  assert.deepEqual(calls, [["pwsh", ["example"]], ["powershell", ["bob"]]]);
  assert.deepEqual(problems, [
    "core: line 4: unrecognized command example",
    "core: line 5: unrecognized command example",
    "core: line 6: unrecognized command bob",
    "desktop: line 1: unrecognized command alice",
  ]);
});
