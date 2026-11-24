import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { it } from "node:test";
import { parse, stringify } from "yaml";
import { windowsTestCommands } from "../../scripts/run-windows-test-list.mjs";
import { COMMAND_LINE_BUDGET_CHARS, commandLineLength } from "../../scripts/hooks/spawn-command.mjs";
import { checkWindowsWorkflow, directCommandProblems, powerShellCommandProblems, windowsRunSteps } from "../../.github/scripts/check-windows-workflow.mjs";

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
    "bun run scripts/run-windows-test-list.mjs config/windows-permission-tests.txt",
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

it("routes the permission and native inventories through bounded batches", () => {
  const { steps } = parse(workflow).jobs["windows-permission-tests"];
  for (const [name, inventory] of [
    ["Run Windows permission regressions", "config/windows-permission-tests.txt"],
    ["Run Windows native import regressions", "config/windows-native-tests.txt"],
    ["Run Windows application regressions", "config/windows-application-tests.txt"],
  ]) {
    const step = steps.find(entry => entry.name === name);
    assert.equal(step.run, `node .github/scripts/run-in-job.mjs bun run scripts/run-windows-test-list.mjs ${inventory}`);
    assert.equal(step.env.UV_PYTHON_CACHE_DIR, `\${{ runner.temp }}/python-archives`);
    const list = readFileSync(new URL(`../../${inventory}`, import.meta.url), "utf8");
    const batches = windowsTestCommands(list);
    assert.ok(batches.length > 1);
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
    "windows-permission-tests": [
      "run-windows-permission-regressions-1", "run-windows-native-import-regressions-1",
      "run-windows-application-regressions-1",
    ],
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
  ...["key", "restore", "seal", "verify-publication"].map(operation => `node .github/scripts/windows-preparation-cache.mjs ${operation}`),
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

it("rejects dropping a shard or its shard ID", () => {
  const parsed = parse(workflow);
  const job = parsed.jobs["windows-permission-tests"];
  job.strategy.matrix.shard.pop();
  assert.throws(() => checkWindowsWorkflow(stringify(parsed), parsedLines), /must run every contained shard/);
  job.strategy.matrix.shard.push(3);
  delete job.env.AVE_WINDOWS_TEST_SHARD;
  assert.throws(() => checkWindowsWorkflow(stringify(parsed), parsedLines), /must run every contained shard/);
});

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
      const { env } = get("Run Windows native import regressions");
      if (plan === undefined) delete env.AVE_WINDOWS_TEST_PLAN;
      else env.AVE_WINDOWS_TEST_PLAN = plan;
    }, "windows-permission-tests");
    assert.throws(() => checkWindowsWorkflow(changed, parsedLines), /must use the matrix plan artifact/);
  });
}

it("rejects a contained test step allowed to fail", () => {
  const changed = changedWorkflow((_steps, get) => {
    get("Run Windows permission regressions")["continue-on-error"] = true;
  }, "windows-permission-tests");
  assert.throws(() => checkWindowsWorkflow(changed, parsedLines), /contained Windows failures must fail the job/);
});

it("rejects a matrix test after the launcher wrapper is removed", () => {
  const changed = changedWorkflow((_steps, get) => {
    const step = get("Run Windows native import regressions");
    step.run = step.run.replace(`${WRAPPER} `, "");
  }, "windows-permission-tests");
  assert.throws(() => checkWindowsWorkflow(changed, parsedLines), /test command runs outside the job containment launcher/);
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

it("cannot publish when containment cleanup fails after sealing", () => {
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
  assert.throws(() => checkWindowsWorkflow(publishedDespiteFailure, parsedLines), /must seal new outputs before saving on main/);
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
  }, /must seal new outputs before saving on main/],
  ["running more preparation after publishing", steps => {
    steps.push({ name: "Later check", run: "node late-check.mjs" });
  }, /after successful containment cleanup/],
  ["publishing before cleanup completes", (steps, get) => {
    const save = steps.pop();
    steps.splice(steps.indexOf(get("Remove isolated system-volume job directory")), 0, save);
  }, /after successful containment cleanup/],
  ["publishing without a seal tied to the preparation checks", (_steps, get) => {
    delete get("Verify sealed Windows preparation outputs").env.AVE_WINDOWS_PREP_SEAL_DIGEST;
  }, /after successful containment cleanup/],
]) {
  it(`rejects ${name}`, () => {
    assert.throws(() => checkWindowsWorkflow(changedWorkflow(change), parsedLines), expected);
  });
}
