import assert from "node:assert/strict";
import childProcess, { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { parse, stringify } from "yaml";
import { windowsTestCommands } from "../../scripts/run-windows-test-list.mjs";
import { COMMAND_LINE_BUDGET_CHARS, commandLineLength } from "../../scripts/hooks/spawn-command.mjs";
import { collectedVitestFiles } from "../../scripts/lib/vitest-collection.mjs";
import {
  checkHelperExecutionOrder, checkWindowsWorkflow, directCommandProblems, powerShellCommandProblems, windowsRegressionSuites, windowsRunSteps,
} from "../../.github/scripts/check-windows-workflow.mjs";

const workflow = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");

it("runs the workflow guard before any Windows test commands", () => {
  for (const job of ["windows-native-preparation", "windows-permission-tests"]) {
    const steps = parse(workflow).jobs[job].steps;
    const guard = steps.findIndex(step => step.name === "Validate Windows workflow commands");
    const firstTest = steps.findIndex(step => /(?:\bbun run test|\bnode scripts\/test-|\s--test\s|run-windows-test-list)/u.test(step.run ?? ""));
    assert.ok(firstTest >= 0);
    assert.ok(guard >= 0 && guard < firstTest);
    assert.equal(steps[guard].if, steps[firstTest].if);
    assert.equal(steps[guard]["continue-on-error"], undefined);
    assert.equal(steps[guard].run, "node .github/scripts/check-windows-workflow.mjs");
  }
});

it("keeps the Windows direct test commands together and off bare path lines", () => {
  assert.deepEqual(directCommandProblems(windowsRunSteps(workflow)), []);
});

it("rejects the historically broken permission scalar as parsed YAML", () => {
  const historic = parse(readFileSync(new URL("../fixtures/windows-permission-command.yml", import.meta.url), "utf8"));
  const brokenWorkflow = stringify({ jobs: { "windows-permission-tests": { "runs-on": "windows-latest", steps: historic } } });
  const [step] = windowsRunSteps(brokenWorkflow);
  assert.equal(step.run, historic[0].run);
  const [command, containment, bare, ...rest] = directCommandProblems([step]);
  assert.deepEqual([command, bare, rest], [
    "windows-permission-tests: Run Windows permission regressions: expected one complete direct test command",
    "windows-permission-tests: Run Windows permission regressions: bare test path src/__tests__/packaging-discipline-source.test.ts",
    [],
  ]);
  assert.ok(containment.startsWith("windows-permission-tests: Run Windows permission regressions: test command runs outside the job containment launcher: bun run test -- "), containment);
});

it("rejects job-root test commands that run outside the containment launcher", () => {
  const commands = [
    "bun run test:scripts",
    "bun run test:vitest -- src/example.test.ts",
    "bun run scripts/run-windows-test-list.mjs",
    "node scripts/test-windows-job.mjs",
    "node --import ./scripts/lib/document-consumer-guard.mjs --test test/scripts/example.test.mjs",
    "node scripts/build-srt-win.mjs --test-native",
  ];
  const steps = commands.flatMap(run => windowsRunSteps(stringify({ jobs: { "windows-permission-tests": {
    "runs-on": "windows-2025",
    steps: [{ name: "example", run }, { name: "contained", run: `node .github/scripts/run-in-job.mjs ${run}` }],
  } } })));
  assert.deepEqual(directCommandProblems(steps), commands.map(run =>
    `windows-permission-tests: example: test command runs outside the job containment launcher: ${run}`));
});

it("fails when a required PowerShell parser cannot launch", () => {
  assert.throws(() => checkWindowsWorkflow(workflow, shell => {
    throw new Error(`Missing parser: ${shell}`);
  }), /Missing parser: pwsh/);
});

for (const systemRootName of ["SystemRoot", "SYSTEMROOT"]) {
  it(`launches the system parser with literal command lookup and an edition-specific environment (${systemRootName})`, t => {
    const originalEnv = process.env;
    const launch = t.mock.method(childProcess, "spawnSync", () => ({
      status: 0, stdout: JSON.stringify({ cmdlets: [], aliases: [], steps: [{ errors: [], functions: [], commands: [] }] }),
    }));
    syncBuiltinESMExports();
    const env = Object.fromEntries(Object.entries(originalEnv).filter(([key]) => !/^systemroot$/i.test(key)));
    process.env = { ...env, [systemRootName]: "D:\\Windows", PSModulePath: "D:\\example" };
    const steps = [{ name: "example", shell: "powershell", run: "Write-Output 'example'" }];
    try {
      assert.deepEqual(powerShellCommandProblems(steps), []);
      assert.equal(launch.mock.callCount(), 1);
      const [executable, args, options] = launch.mock.calls[0].arguments;
      const script = Buffer.from(args[args.indexOf("-EncodedCommand") + 1], "base64").toString("utf16le");
      assert.doesNotMatch(script, /\bGet-Command\b(?![^\r\n)]*\s-Name\b)/iu);
      assert.equal(executable, "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
      assert.equal(options.env[systemRootName], process.env[systemRootName]);
      assert.equal(Object.keys(options.env).some(key => /^psmodulepath$/i.test(key)), false);

      process.env[systemRootName] = "Windows";
      assert.throws(() => powerShellCommandProblems(steps), /absolute system directory/);
      assert.equal(launch.mock.callCount(), 1);
    } finally {
      process.env = originalEnv;
      launch.mock.restore();
      syncBuiltinESMExports();
    }
  });
}

it("keeps every Windows run scalar within the workflow limit", () => {
  const oversized = windowsRunSteps(workflow).filter(({ run }) => run.length > 21_000)
    .map(({ name, run }) => [name, run.length]);
  assert.deepEqual(oversized, []);
});

it("routes every collected suite through one bounded shard step", () => {
  const { steps } = parse(workflow).jobs["windows-permission-tests"];
  const regressions = steps.filter(entry => /^Run Windows .*regressions$/u.test(entry.name ?? ""));
  assert.deepEqual(regressions.map(step => step.name), ["Run Windows regressions"]);
  const [step] = regressions;
  assert.equal(step.run, "node .github/scripts/run-in-job.mjs bun run scripts/run-windows-test-list.mjs");
  assert.equal(step.env.AVE_WINDOWS_TEST_PLAN, `\${{ runner.temp }}/windows-ci/windows-plan.json`);
  assert.equal(step.env.UV_PYTHON_CACHE_DIR, `\${{ runner.temp }}/python-archives`);
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const suites = windowsRegressionSuites(workflow, root);
  assert.deepEqual(suites, collectedVitestFiles(root));
  const batches = windowsTestCommands(suites);
  assert.ok(batches.length > 2);
  for (const args of batches) assert.ok(commandLineLength("bun.exe", args) <= COMMAND_LINE_BUDGET_CHARS);
  assert.deepEqual(batches.slice(1).flatMap(args => args.slice(4)), suites.map(file => `./${file}`));
});

for (const [name, change] of [
  ["a committed list argument", (_steps, get) => { get("Run Windows regressions").run += " config/windows-native-tests.txt"; }],
  ["a second regression step", (steps, get) => {
    const step = get("Run Windows regressions");
    steps.splice(steps.indexOf(step), 0, { ...step, name: "Run Windows native import regressions" });
  }],
  ["a renamed regression step", (_steps, get) => { get("Run Windows regressions").name = "Run Windows permission regressions"; }],
]) {
  it(`rejects ${name} in place of the all-suites shard step`, () => {
    const changed = changedWorkflow(change, "windows-permission-tests");
    assert.throws(() => checkWindowsWorkflow(changed, parsedLines), /must run every collected suite through one Run Windows regressions step/);
  });
}

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

async function containedManifest(steps) {
  const { containedSteps } = await import("../../.github/scripts/check-windows-workflow.mjs");
  return containedSteps(stringify({ jobs: { "windows-permission-tests": { "runs-on": "windows-2025", steps } } }));
}
const CONDITION = "steps.docs-impact.outputs.docs_only != 'true'";

it("derives independent receipts for preparation and every shard", async () => {
  const { containedSteps } = await import("../../.github/scripts/check-windows-workflow.mjs");
  const expected = {
    "windows-native-preparation": [
      "verify-native-background-process-ownership-1",
      "verify-both-windows-native-payload-packages-1", "verify-both-windows-native-payload-packages-2",
      "verify-windows-folder-classification-1",
      "build-and-test-patched-windows-sandbox-helper-1", "build-and-test-patched-windows-sandbox-helper-2",
      "run-script-tests-1",
    ],
    "windows-permission-tests": ["run-windows-regressions-1"],
  };
  for (const [job, ids] of Object.entries(expected)) {
    const manifest = containedSteps(workflow, job);
    assert.deepEqual(manifest.map(({ id }) => id), ids);
    const lines = windowsRunSteps(workflow).filter(({ jobId }) => jobId === job)
      .flatMap(({ lines }) => lines).filter(line => line.includes("run-in-job.mjs"))
      .map(line => line.trim().replace("node .github/scripts/run-in-job.mjs ", ""));
    assert.deepEqual(manifest.map(({ invocation }) => invocation), lines);
    for (const { id, receipt } of manifest) assert.equal(receipt, `${id}.receipt`);
  }
});

for (const [name, steps, expected] of [
  ["a repeated invocation", [
    { name: "alice", if: CONDITION, run: "node .github/scripts/run-in-job.mjs node example.mjs" },
    { name: "bob", if: CONDITION, run: "node .github/scripts/run-in-job.mjs node example.mjs" },
  ], /duplicate contained invocation: node example\.mjs/],
  ["a quoted argument", [{ name: "alice", if: CONDITION, run: "node .github/scripts/run-in-job.mjs node -e \"example\"" }],
    /plain single-spaced arguments/],
  ["a doubled space", [{ name: "alice", if: CONDITION, run: "node .github/scripts/run-in-job.mjs node  example.mjs" }],
    /plain single-spaced arguments/],
  ["a step without the regression condition", [{ name: "alice", run: "node .github/scripts/run-in-job.mjs node example.mjs" }],
    /a contained step needs if:/],
  ["no contained step", [{ name: "alice", if: CONDITION, run: "node example.mjs" }], /no contained test steps/],
]) {
  it(`rejects a contained-step manifest with ${name}`, async () => {
    await assert.rejects(containedManifest(steps), expected);
  });
}

function changedWorkflow(change, job = "windows-native-preparation") {
  const parsed = parse(workflow);
  const { steps } = parsed.jobs[job];
  change(steps, name => steps.find(entry => entry.name === name));
  return stringify(parsed);
}

// The workflow's own parser is Windows PowerShell; other hosts check the same rules on injected parser output.
const realParser = { skip: process.platform !== "win32" && "needs the Windows PowerShell parser" };
const WRAPPER = "node .github/scripts/run-in-job.mjs";

function parsedCommand(source, line, { text = source, redirected = false, operator = "Unknown", plain = true, scopes = [0] } = {}) {
  const elements = source.match(/'[^']*'|\S+/gu).map(word => ({ text: word, plain: plain && !word.startsWith("'") }));
  return { name: elements[0].text.replace(/^'(.*)'$/u, "$1"), head: elements[0].text, line, scopes, text, redirected, operator, elements };
}

const KEYWORD_RE = /^(?:if|elseif|else|foreach|for|while|switch|try|catch|finally|throw|exit|return)\b/iu;
// Reports what the parser reports for this workflow's simple lines: statements split at braces, one command per
// pipeline element, and none for keywords, comments or expressions.
function parsedLines(_shell, sources) {
  return { cmdlets: ["ConvertFrom-Json"], aliases: [], steps: sources.map(source => ({ errors: [], functions: [],
    commands: source.split("\n").flatMap((line, index) => line.split(/[{}]/u).flatMap(statement => {
      const pipeline = statement.trim().replace(/^\$\w+\s*=\s*/u, "");
      if (!pipeline || /^[#$[('"]/u.test(pipeline) || KEYWORD_RE.test(pipeline)) return [];
      return pipeline.split(" | ").map(text => text.startsWith("& ")
        ? parsedCommand(text.slice(2), index + 1, { text, operator: "Ampersand" }) : parsedCommand(text, index + 1));
    })) })) };
}

it("accepts the workflow's contained commands and stated exemptions", realParser, () => {
  checkWindowsWorkflow(workflow);
});

it("accepts the workflow's contained commands and stated exemptions from parsed lines", () => {
  checkWindowsWorkflow(workflow, parsedLines);
});

// Every command after job-root setup is a manifest invocation or one of the guard's stated exemptions.
const EXEMPTIONS = [
  "bun install --frozen-lockfile",
  "node .github/scripts/check-windows-workflow.mjs",
  ...["key", "restore", "seal", "verify-installed", "verify-publication"].map(operation => `node .github/scripts/windows-preparation-cache.mjs ${operation}`),
  "node scripts/fetch-uv.mjs",
  "node .github/scripts/python-archive-cache.mjs",
  ...["", " -FailureFixture", " -QueryFailureFixture", " -Helper path-kind"]
    .map(option => `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/build-windows-job.ps1${option}`),
  "bun run check:plugin-host-protocol-schema",
  "node scripts/check-srt-win-integrity.cjs --upstream --inputs",
  "node scripts/check-srt-win-integrity.cjs",
  "node scripts/fetch-mxc.mjs --arch x64",
  "& './node_modules/@anthropic-ai/sandbox-runtime/vendor/srt-win/x64/srt-win.exe' install",
  "& './node_modules/@anthropic-ai/sandbox-runtime/vendor/srt-win/x64/srt-win.exe' user status",
  "ConvertFrom-Json",
  "node .github/scripts/python-download-mirror.mjs",
  "node .github/scripts/restore-windows-ci-inputs.mjs",
  "node ave/.github/scripts/isolate-job-home.mjs --cleanup",
];
const containedStep = run => [{ name: "example", shell: "powershell", run, contained: true }];
for (const exemption of EXEMPTIONS) {
  it(`accepts the stated exemption after job-root setup: ${exemption}`, () => {
    assert.deepEqual(parsedLines("powershell", [exemption]).steps[0].commands.map(({ text }) => text), [exemption]);
    assert.deepEqual(powerShellCommandProblems(containedStep(exemption), parsedLines, []), []);
  });
}

it("rejects the bare packaging check after job-root setup", () => {
  assert.deepEqual(powerShellCommandProblems(containedStep("bun run check:mxc-packaging"), parsedLines, []),
    ["example: line 1: command runs outside the job containment launcher: bun run check:mxc-packaging"]);
});

for (const [name, change, expected] of [
  ["a bare bun test line", (_steps, step) => { step("Run script tests").run += "\nbun test"; },
    "Run script tests: line 2: command runs outside the job containment launcher: bun test"],
  ["a test runner hidden in a script block", (_steps, step) => { step("Run script tests").run += "\nif ($true) { bun x vitest run }"; },
    "Run script tests: line 2: command runs outside the job containment launcher: bun x vitest run"],
  ["an uncontained packaging check", (_steps, step) => {
    const packaging = step("Verify both Windows native payload packages");
    packaging.run = packaging.run.replace("node .github/scripts/run-in-job.mjs bun run check:mxc-packaging", "bun run check:mxc-packaging");
  }, "Verify both Windows native payload packages: line 3: command runs outside the job containment launcher: bun run check:mxc-packaging"],
  ["a non-PowerShell step after setup", (_steps, step) => { step("Ensure uv toolchain").shell = "bash"; },
    "Ensure uv toolchain: steps after job-root setup need a PowerShell shell"],
  ["a contained command before setup", steps => {
    steps.unshift({ name: "Early", if: CONDITION, run: "node .github/scripts/run-in-job.mjs node scripts/test-windows-job.mjs --early" });
  }, "manifest step early-1 is not exactly one contained command after job-root setup"],
]) {
  const rejects = inspect => () => assert.throws(() => checkWindowsWorkflow(changedWorkflow(change), inspect),
    error => error.message.split("\n").includes(`windows-native-preparation: ${expected}`) || assert.fail(error.message));
  it(`rejects ${name} in the contained job`, realParser, rejects());
  it(`rejects ${name} in the contained job from parsed lines`, rejects(parsedLines));
}

const EXAMPLE_MANIFEST = [{ id: "example-1", invocation: "bun run test:scripts" }];
const WRAPPED = `${WRAPPER} bun run test:scripts`;
const notPlain = (line, text = WRAPPED) => `example: line ${line}: contained command is not a plain manifest invocation: ${text}`;
const unwrapped = "windows-permission-tests: manifest step example-1 is not exactly one contained command after job-root setup";
for (const [name, commands, expected] of [
  ["a wrapped manifest step and a stated exemption",
    [parsedCommand("bun install --frozen-lockfile", 1), parsedCommand(WRAPPED, 2)], []],
  ["a bare test command", [parsedCommand(WRAPPED, 1), parsedCommand("bun test", 2)],
    ["example: line 2: command runs outside the job containment launcher: bun test"]],
  ["a test runner in a script block", [parsedCommand(WRAPPED, 1), parsedCommand("bun x vitest run", 2, { scopes: [12, 0] })],
    ["example: line 2: command runs outside the job containment launcher: bun x vitest run"]],
  ["a redirected wrapper", [parsedCommand(WRAPPED, 1, { text: `${WRAPPED} > example.log`, redirected: true })],
    [notPlain(1, `${WRAPPED} > example.log`), unwrapped]],
  ["an invocation operator", [parsedCommand(WRAPPED, 1, { text: `& ${WRAPPED}`, operator: "Ampersand" })],
    [notPlain(1, `& ${WRAPPED}`), unwrapped]],
  ["a quoted wrapper argument", [parsedCommand(WRAPPED, 1, { plain: false })], [notPlain(1), unwrapped]],
  ["an invocation outside the manifest", [parsedCommand(`${WRAPPER} bun run other`, 1)],
    [notPlain(1, `${WRAPPER} bun run other`), unwrapped]],
  ["a manifest step wrapped twice", [parsedCommand(WRAPPED, 1), parsedCommand(WRAPPED, 2)], [unwrapped]],
]) {
  it(`checks parsed contained commands: ${name}`, () => {
    const steps = [{ name: "example", shell: "pwsh", run: "example", contained: true }];
    const inspect = () => ({ cmdlets: [], aliases: [], steps: [{ errors: [], functions: [], commands }] });
    assert.deepEqual(powerShellCommandProblems(steps, inspect, EXAMPLE_MANIFEST), expected);
  });
}

it("rejects a second bare test command on a contained line", () => {
  assert.throws(() => checkWindowsWorkflow(changedWorkflow((_steps, step) => {
    step("Run script tests").run = "node .github/scripts/run-in-job.mjs bun run test:scripts; bun run test:scripts";
  })), /contained invocation needs plain single-spaced arguments: bun run test:scripts; bun run test:scripts/);
});

const ARM64_JOB = "windows-arm64-path-kind";
const ARM64_RESULT_STEP = "Require the build and every Vitest shard";

it("runs path classification with the arm64 runtime and native job launcher", () => {
  const { jobs } = parse(workflow);
  const arm64 = jobs[ARM64_JOB];
  assert.ok(arm64, "missing Windows arm64 path-kind job");
  assert.equal(arm64["runs-on"], "windows-11-arm");
  assert.equal(arm64["timeout-minutes"], 30);
  assert.equal(arm64.needs, "build");
  assert.equal(arm64.if, "needs.build.outputs.windows_arm64_path_kind == 'true'");

  const [, node, , isolate, install, build, test, cleanup] = arm64.steps;
  assert.equal(node.with.architecture, "arm64");
  assert.equal(isolate.run, "node ave/.github/scripts/isolate-job-home.mjs");
  assert.equal(install.run, "bun install --frozen-lockfile --ignore-scripts --production");
  assert.equal(build.run, "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/build-windows-job.ps1 -Arch arm64");
  assert.deepEqual(test.run.trimEnd().split("\n"), [
    "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/build-windows-job.ps1 -Arch arm64 -Helper path-kind",
    "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
    "node .github/scripts/run-in-job.mjs node scripts/test-windows-path-kind.mjs",
  ]);
  assert.equal(cleanup.if, "always() && env.AVE_CI_JOB_ROOT != ''");
  assert.equal(cleanup.run, "node ave/.github/scripts/isolate-job-home.mjs --cleanup");
});

it("registers only the arm64 job's path-kind receipt in its manifest", async () => {
  const { containedStepManifest } = await import("../../.github/scripts/run-in-job.mjs");
  const manifest = await containedStepManifest(ARM64_JOB);
  assert.deepEqual(manifest, [{
    id: "verify-windows-folder-classification-1",
    receipt: "verify-windows-folder-classification-1.receipt",
    invocation: "node scripts/test-windows-path-kind.mjs",
  }]);
  await assert.rejects(containedStepManifest("example"), /Unknown contained Windows job/u);
});

it("requires the arm64 result for selected runs, including docs-only main pushes", () => {
  const { jobs } = parse(workflow);
  const aggregate = jobs["build-and-test"];
  const step = aggregate.steps.find(entry => entry.name === ARM64_RESULT_STEP);
  assert.ok(aggregate.needs.includes(ARM64_JOB));
  assert.equal(step.env.WINDOWS_ARM64_PATH_KIND_RESULT, `\${{ needs.${ARM64_JOB}.result }}`);
  assert.equal(step.env.WINDOWS_ARM64_PATH_KIND, `\${{ needs.build.outputs.windows_arm64_path_kind }}`);

  for (const docs of ["true", "false"]) {
    for (const [selected, arm64, status] of [
      ["true", "success", 0], ["true", "failure", 1], ["true", "cancelled", 1], ["true", "skipped", 1],
      ["false", "skipped", 0], ["false", "failure", 1], ["false", "cancelled", 1], ["", "skipped", 1],
    ]) {
      const result = spawnSync("bash", ["-e", "-c", step.run], { encoding: "utf8", windowsHide: true, env: {
        ...process.env, GATE_CORE_RESULT: "success", MXC_PINS_RESULT: "success", BUILD_RESULT: "success",
        VITEST_RESULT: docs === "true" ? "skipped" : "success", DOCS_ONLY: docs, PLATFORM_CHECKS: "false",
        WINDOWS_PREPARATION_RESULT: "skipped", WINDOWS_RESULT: "skipped", MACOS_RESULT: "skipped", LINUX_RESULT: "skipped",
        WINDOWS_ARM64_PATH_KIND: selected, WINDOWS_ARM64_PATH_KIND_RESULT: arm64,
        VITEST_TIER_JOB: "false", VITEST_TIERS_RESULT: "skipped", WINDOWS_TIER_TESTS: "false", WINDOWS_TIER_RESULT: "skipped",
      } });
      assert.ifError(result.error);
      assert.equal(result.status, status, JSON.stringify({ docs, selected, arm64, output: result.stdout + result.stderr }));
    }
  }
});

const x64PathKind = (jobs) => jobs["windows-native-preparation"].steps.find(step => step.name === "Verify Windows folder classification");

it("caps the x64 path-kind step at 30 minutes", () => {
  assert.equal(x64PathKind(parse(workflow).jobs)["timeout-minutes"], 30);
});

for (const arch of ["arm64", "x64"]) {
  for (const timeout of [undefined, 31]) {
    it(`rejects a ${arch} path-kind timeout of ${timeout}`, () => {
      const parsed = parse(workflow);
      const item = arch === "arm64" ? parsed.jobs[ARM64_JOB] : x64PathKind(parsed.jobs);
      item["timeout-minutes"] = timeout;
      assert.throws(() => checkWindowsWorkflow(stringify(parsed), parsedLines), /expected a 30-minute timeout/u);
    });
  }
}

for (const [name, change, expected] of [
  ["a different runner", jobs => { jobs[ARM64_JOB]["runs-on"] = "windows-2025"; }, /hosted arm64 runner/u],
  ["a narrower selection", jobs => {
    jobs.build.outputs.windows_arm64_path_kind = jobs.build.outputs.platform_checks;
  }, /path-kind selection/u],
  ["an emulated runtime", jobs => { jobs[ARM64_JOB].steps[1].with.architecture = "x64"; }, /expected arm64 setup/u],
  ["a test outside the launcher", jobs => {
    const step = jobs[ARM64_JOB].steps[6];
    step.run = step.run.replace(`${WRAPPER} `, "");
  }, /contained path-kind test/u],
  ["cleanup without the job-root guard", jobs => { jobs[ARM64_JOB].steps[7].if = "always()"; }, /job-root cleanup/u],
  ["a missing aggregate dependency", jobs => {
    const aggregate = jobs["build-and-test"];
    aggregate.needs = aggregate.needs.filter(jobId => jobId !== ARM64_JOB);
  }, /expected build-and-test/u],
  ["a bypassed failure result", jobs => {
    const step = jobs["build-and-test"].steps[0];
    step.run = step.run.replace("true:success|false:skipped", "true:*|false:skipped");
  }, /require the selected arm64 result/u],
]) {
  it(`rejects ${name} for the arm64 path-kind job`, () => {
    const parsed = parse(workflow);
    change(parsed.jobs);
    assert.throws(() => checkWindowsWorkflow(stringify(parsed), parsedLines), expected);
  });
}

it("rejects dropping a shard or its shard ID", () => {
  const parsed = parse(workflow);
  const job = parsed.jobs["windows-permission-tests"];
  job.strategy.matrix.shard.pop();
  assert.throws(() => checkWindowsWorkflow(stringify(parsed), parsedLines), /must run every contained shard/);
  job.strategy.matrix.shard.push(3);
  delete job.env.AVE_WINDOWS_TEST_SHARD;
  assert.throws(() => checkWindowsWorkflow(stringify(parsed), parsedLines), /must run every contained shard/);
});

it("rejects tier shards that skip tier selection, drop a shard or lose the tier", () => {
  for (const change of [
    job => { job.if = "needs.windows-native-preparation.result == 'success'"; },
    job => { job.strategy.matrix.shard.pop(); },
    job => { delete job.env.AVE_WINDOWS_TEST_TIER; },
  ]) {
    const parsed = parse(workflow);
    change(parsed.jobs["windows-tier-tests"]);
    assert.throws(() => checkWindowsWorkflow(stringify(parsed), parsedLines), /tier shards must follow|must run every contained shard/);
  }
  const parsed = parse(workflow);
  parsed.jobs["windows-permission-tests"].env.AVE_WINDOWS_TEST_TIER = "tiers";
  assert.throws(() => checkWindowsWorkflow(stringify(parsed), parsedLines), /must run every contained shard/);
});

it("requires selected Windows tiers when the platform matrix is skipped", () => {
  const step = parse(workflow).jobs["build-and-test"].steps[0];
  for (const [tiers, preparation, tierResult, status] of [
    ["true", "success", "success", 0], ["true", "skipped", "skipped", 1], ["true", "success", "skipped", 1],
    ["true", "failure", "skipped", 1], ["false", "skipped", "skipped", 0], ["false", "success", "skipped", 1],
  ]) {
    const result = spawnSync("bash", ["-e", "-c", step.run], { encoding: "utf8", windowsHide: true, env: {
      ...process.env, GATE_CORE_RESULT: "success", MXC_PINS_RESULT: "success", BUILD_RESULT: "success",
      VITEST_RESULT: "success", DOCS_ONLY: "false", PLATFORM_CHECKS: "false",
      WINDOWS_PREPARATION_RESULT: preparation, WINDOWS_RESULT: "skipped", MACOS_RESULT: "skipped", LINUX_RESULT: "skipped",
      WINDOWS_ARM64_PATH_KIND: "false", WINDOWS_ARM64_PATH_KIND_RESULT: "skipped",
      VITEST_TIER_JOB: "false", VITEST_TIERS_RESULT: "skipped", WINDOWS_TIER_TESTS: tiers, WINDOWS_TIER_RESULT: tierResult,
    } });
    assert.ifError(result.error);
    assert.equal(result.status, status, JSON.stringify({ tiers, preparation, tierResult, output: result.stdout + result.stderr }));
  }
});

for (const [name, change, expected] of [
  ["a platform-gated tier selection", jobs => {
    jobs.build.outputs.windows_tier_tests = `\${{ steps.plan.outputs.platform_checks == 'true' && steps.tiers.outputs.windows_tiers != '' }}`;
  }, /tier selection through preparation/u],
  ["a platform-gated plan upload", jobs => {
    jobs.build.steps.find(step => step.name === "Upload the Windows regression plan").if =
      "steps.docs-impact.outputs.docs_only != 'true' && steps.plan.outputs.platform_checks == 'true'";
  }, /tier selection through preparation/u],
  ["a platform-gated preparation", jobs => {
    jobs["windows-native-preparation"].if = "needs.build.outputs.platform_checks == 'true'";
  }, /follow native platform selection/u],
  ["platform-gated tier shards", jobs => {
    const job = jobs["windows-tier-tests"];
    job.if = `needs.build.outputs.platform_checks == 'true' && ${job.if}`;
  }, /tier selection through preparation/u],
  ["a platform-only preparation result", jobs => {
    const step = jobs["build-and-test"].steps[0];
    step.run = step.run.replace('for result in "$WINDOWS_RESULT"', 'for result in "$WINDOWS_PREPARATION_RESULT" "$WINDOWS_RESULT"');
  }, /tier selection through preparation/u],
]) {
  it(`rejects ${name}`, () => {
    const parsed = parse(workflow);
    change(parsed.jobs);
    assert.throws(() => checkWindowsWorkflow(stringify(parsed), parsedLines), expected);
  });
}

it("rejects reusing shard one for every regression step", () => {
  const changed = changedWorkflow(steps => {
    for (const step of steps.filter(step => step.run?.includes("run-windows-test-list.mjs"))) {
      step.env.AVE_WINDOWS_TEST_SHARD = "1";
    }
  }, "windows-permission-tests");
  assert.throws(() => checkWindowsWorkflow(changed, parsedLines), /must inherit the matrix shard ID/);
});

for (const plan of [undefined, "config/alternate.json"]) {
  it(`rejects a regression step with a changed plan binding (${plan})`, () => {
    const changed = changedWorkflow((_steps, get) => {
      const { env } = get("Run Windows regressions");
      if (plan === undefined) delete env.AVE_WINDOWS_TEST_PLAN;
      else env.AVE_WINDOWS_TEST_PLAN = plan;
    }, "windows-permission-tests");
    assert.throws(() => checkWindowsWorkflow(changed, parsedLines), /must use the matrix plan artifact/);
  });
}

it("rejects a contained test step allowed to fail", () => {
  const changed = changedWorkflow((_steps, get) => {
    get("Run Windows regressions")["continue-on-error"] = true;
  }, "windows-permission-tests");
  assert.throws(() => checkWindowsWorkflow(changed, parsedLines), /contained Windows failures must fail the job/);
});

it("rejects a matrix test after the launcher wrapper is removed", () => {
  const changed = changedWorkflow((_steps, get) => {
    const step = get("Run Windows regressions");
    step.run = step.run.replace(`${WRAPPER} `, "");
  }, "windows-permission-tests");
  assert.throws(() => checkWindowsWorkflow(changed, parsedLines), /must run every collected suite through one Run Windows regressions step/);
});

it("builds and checks shared native inputs once, before any shard provisions its account", () => {
  const { jobs } = parse(workflow);
  const before = jobs["windows-native-preparation"].steps;
  const after = jobs["windows-permission-tests"].steps;
  for (const name of ["Verify both Windows native payload packages", "Build and test patched Windows sandbox helper", "Prepare authenticated interpreter mirror"]) {
    assert.equal(before.filter(step => step.name === name).length, 1);
    assert.equal(after.some(step => step.name === name), false);
  }
  const initialize = after.findIndex(step => step.name === "Verify and configure the shared test inputs");
  const provision = after.findIndex(step => step.name === "Provision sandbox for native permission tests");
  assert.ok(initialize >= 0 && initialize < provision);
  for (const name of ["windows-native-helpers", "windows-interpreter-mirror"]) {
    const upload = before.find(step => step.with?.name === name);
    const download = after.find(step => step.with?.name === name);
    assert.match(upload.uses, /^actions\/upload-artifact@/);
    assert.equal(upload.with["if-no-files-found"], "error");
    assert.match(download.uses, /^actions\/download-artifact@/);
    assert.ok(after.indexOf(download) < initialize);
  }
});

it("rejects either Windows job bypassing the native platform gate", () => {
  for (const job of ["windows-native-preparation", "windows-permission-tests"]) {
    const parsed = parse(workflow);
    parsed.jobs[job].if = "needs.build.outputs.docs_only == 'false'";
    assert.throws(() => checkWindowsWorkflow(stringify(parsed), parsedLines), /must follow native platform selection/);
  }
});

it("rehashes the installed helpers before the first launcher command", () => {
  const steps = parse(workflow).jobs["windows-native-preparation"].steps;
  const first = steps.find(step => step.run?.includes("node .github/scripts/run-in-job.mjs "));
  assert.equal(first.run.trim().split("\n")[0], "node .github/scripts/windows-preparation-cache.mjs verify-installed");
  for (const mutate of [
    run => run.split("\n").slice(1).join("\n"),
    run => `node scripts/fetch-uv.mjs\n${run}`,
    run => run.replace("if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }\n", ""),
  ]) {
    assert.throws(() => checkWindowsWorkflow(changedWorkflow((_steps, get) => {
      const step = get("Verify native background process ownership");
      step.run = mutate(step.run);
    }), parsedLines), /first launcher step must rehash/);
  }
});

it("runs every restored or cached binary after the job's trust point", () => {
  const { jobs } = parse(workflow);
  for (const job of ["windows-native-preparation", "windows-permission-tests"]) checkHelperExecutionOrder(job, jobs[job].steps);
  const preparation = jobs["windows-native-preparation"].steps;
  const rehash = preparation.findIndex(step => step.run?.trim().startsWith("node .github/scripts/windows-preparation-cache.mjs verify-installed"));
  const provision = preparation.findIndex(step => step.name === "Provision sandbox for native permission tests");
  assert.ok(rehash >= 0 && rehash < provision);
});

for (const [name, job, change, expected, workflowExpected] of [
  // r9: the old lock only looked at the first run-in-job line, so this passed.
  ["the sandbox provisioning above the rehash", "windows-native-preparation", (steps, get) => {
    const provision = get("Provision sandbox for native permission tests");
    steps.splice(steps.indexOf(provision), 1);
    steps.splice(steps.indexOf(get("Verify native background process ownership")), 0, provision);
  }, /windows-native-preparation: Provision sandbox for native permission tests: executes a restored or cached binary before rehashing the installed helpers/],
  ["the sandbox provisioning above the helper rebuild", "windows-native-preparation", (steps, get) => {
    const provision = get("Provision sandbox for native permission tests");
    steps.splice(steps.indexOf(provision), 1);
    steps.splice(steps.indexOf(get("Build and test patched Windows sandbox helper")), 0, provision);
  }, /runs the sandbox helper before this job replaced the cached node_modules copy/],
  ["a sandbox helper call without its integrity check", "windows-native-preparation", (_steps, get) => {
    const provision = get("Provision sandbox for native permission tests");
    provision.run = provision.run.replace("node scripts/check-srt-win-integrity.cjs\n", "");
  }, /runs the sandbox helper before this job replaced the cached node_modules copy and checked its integrity/],
  ["a launcher fixture run before the rehash", "windows-native-preparation", (_steps, get) => {
    const build = get("Build Windows launcher and classification helpers");
    build.run += "& './resources/windows-job/x64/ave-job-failure.exe' --probe\n";
  }, /Build Windows launcher and classification helpers: executes a restored or cached binary before rehashing/,
  // The command allowlist also refuses this uncontained helper call.
  /command runs outside the job containment launcher: & '\.\/resources\/windows-job\/x64\/ave-job-failure\.exe' --probe/],
  ["the shard provisioning above the artifact restore", "windows-permission-tests", (steps, get) => {
    const restore = get("Verify and configure the shared test inputs");
    steps.splice(steps.indexOf(restore), 1);
    steps.splice(steps.indexOf(get("Provision sandbox for native permission tests")) + 1, 0, restore);
  }, /windows-permission-tests: Provision sandbox for native permission tests: executes a restored or cached binary before installing the checked helper artifacts/],
]) {
  it(`rejects ${name}`, () => {
    const changed = parse(changedWorkflow(change, job));
    assert.throws(() => checkHelperExecutionOrder(job, changed.jobs[job].steps), expected);
    assert.throws(() => checkWindowsWorkflow(stringify(changed), parsedLines), workflowExpected ?? expected);
  });
}

const PUBLICATION_GATE = /requires successful preparation steps through containment cleanup and the final digest check/;

it("publishes only after the preparation steps through cleanup and digest verification succeed", () => {
  const steps = parse(workflow).jobs["windows-native-preparation"].steps;
  const seal = steps.findIndex(step => step.name === "Seal Windows preparation outputs");
  const cleanup = steps.findIndex(step => step.name === "Remove isolated system-volume job directory");
  const verified = steps.findIndex(step => step.name === "Verify sealed Windows preparation outputs");
  const save = steps.findIndex(step => step.name === "Save Windows preparation outputs");
  assert.ok(seal >= 0 && seal < cleanup && cleanup < verified && verified < save);
  assert.equal(save, steps.length - 1);
  assert.match(steps[save].if, /^success\(\) && /);
  assert.ok(steps[verified].if.includes(`steps.${steps[cleanup].id}.outcome == 'success'`));
  assert.ok(steps[save].if.includes(`steps.${steps[verified].id}.outcome == 'success'`));
  const publishedDespiteFailure = changedWorkflow((_steps, get) => {
    const step = get("Verify sealed Windows preparation outputs");
    step.if = step.if
      .replace("success() && ", "always() && ")
      .replace(" && steps.windows-job-cleanup.outcome == 'success'", "");
  });
  assert.throws(() => checkWindowsWorkflow(publishedDespiteFailure, parsedLines), PUBLICATION_GATE);
});

for (const [name, change, expected] of [
  ["a cache key without the generated manifest", (_steps, get) => {
    get("Restore Windows preparation outputs").with.key = "windows-preparation";
  }, /needs a generated input key/],
  ["a partial fallback cache key", (_steps, get) => {
    get("Restore Windows preparation outputs").with["restore-keys"] = "ave-windows-preparation-";
  }, /needs a generated input key/],
  ["using the output before verification", (steps, get) => {
    const step = get("Verify Windows preparation outputs or rebuild");
    steps.splice(steps.indexOf(step), 1);
    steps.splice(steps.indexOf(get("Verify both Windows native payload packages")) + 1, 0, step);
  }, /must verify or rebuild before any output is used/],
  ["skipping a native test on a cache hit", (_steps, get) => {
    get("Build and test patched Windows sandbox helper").if += " && env.AVE_WINDOWS_PREP_VERIFIED == 'false'";
  }, /must run its checks on both cold and warm paths/],
  ["forcing a hit without verification", (_steps, get) => {
    get("Verify native background process ownership").env = { AVE_WINDOWS_PREP_VERIFIED: "true" };
  }, /only the Windows preparation verifier/i],
  ["saving prep outputs from an untrusted ref", (_steps, get) => {
    get("Save Windows preparation outputs").if = CONDITION;
  }, PUBLICATION_GATE],
  ["running more preparation after publishing", steps => {
    steps.push({ name: "Later check", run: "node late-check.mjs" });
  }, PUBLICATION_GATE],
  ["publishing before cleanup completes", (steps, get) => {
    const save = steps.pop();
    steps.splice(steps.indexOf(get("Remove isolated system-volume job directory")), 0, save);
  }, PUBLICATION_GATE],
  ["publishing without a seal tied to the preparation checks", (_steps, get) => {
    delete get("Verify sealed Windows preparation outputs").env.AVE_WINDOWS_PREP_SEAL_DIGEST;
  }, PUBLICATION_GATE],
  ["binding cache publication to a terminal job result", (_steps, get) => {
    get("Save Windows preparation outputs").if += " && needs.windows-native-preparation.result == 'success'";
  }, PUBLICATION_GATE],
]) {
  it(`rejects ${name}`, () => {
    assert.throws(() => checkWindowsWorkflow(changedWorkflow(change), parsedLines), expected);
  });
}
