import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";
import { windowsTestCommands } from "../../scripts/run-windows-test-list.mjs";
import { windowsPowerShellEnv, windowsPowerShellPath } from "../../scripts/lib/windows-powershell-env.mjs";

const TEST_PATH = String.raw`[\w./\\-]+\.(?:test|spec)\.[cm]?[jt]sx?`;
const BARE_TEST_PATH_RE = new RegExp(String.raw`^\s*${TEST_PATH}(?![\w./\\-])`);
const TEST_INVOCATION_RE = /\bbun[ \t]+run[ \t]+test(?::vitest)?(?=[ \t]|$)/;
const CONTAINED = String.raw`node[ \t]+\.github\/scripts\/run-in-job\.mjs[ \t]+`;
const TEST_COMMAND_RE = new RegExp(
  String.raw`^(?:${CONTAINED})?bun[ \t]+run[ \t]+(?:test[ \t]+--|test:vitest[ \t]+--(?:[ \t]+run)?)((?:[ \t]+${TEST_PATH})+)$`,
);
const REGRESSION_STEP = /^Run Windows (?:permission|appearance|session persistence|native import) regressions$/u;
const REGRESSION_CONDITION = "steps.docs-impact.outputs.docs_only != 'true'";
const LIST_INVOCATION = new RegExp(
  String.raw`^(?:${CONTAINED})?bun[ \t]+run[ \t]+scripts\/run-windows-test-list\.mjs[ \t]+(config\/[\w-]+\.txt)$`, "u",
);
// Test commands in the job that owns the isolated job root run inside the containment launcher.
const CONTAINED_JOB = "windows-permission-tests";
const ARM64_JOB = "windows-arm64-path-kind";
const PATH_KIND_TIMEOUT_MINUTES = 30;
const CONTAINED_JOBS = new Map([
  [CONTAINED_JOB, REGRESSION_CONDITION],
  [ARM64_JOB, undefined],
]);
const TEST_LINE_RE = /\bbun[ \t]+run[ \t]+test(?::[\w-]+)?(?=[ \t]|$)|\bnode[ \t]+scripts\/test-|[ \t]--test(?:-native)?(?=[ \t]|$)|\brun-windows-test-list\b/u;
const CONTAINED_LINE_RE = new RegExp(String.raw`^[ \t]*${CONTAINED}\S`, "u");

export function windowsRunSteps(workflow) {
  const { jobs, defaults } = parse(workflow);
  return Object.entries(jobs).flatMap(([jobId, job]) => {
    const runners = [job["runs-on"] ?? []].flat();
    if (!runners.some((runner) => /^windows(?:-|$)/i.test(runner))) return [];
    return (job.steps ?? []).flatMap((step, index) => step.run === undefined ? [] : [{
      jobId,
      stepName: step.name,
      name: `${jobId}: ${step.name ?? `step ${index + 1}`}`,
      condition: step.if,
      shell: step.shell ?? job.defaults?.run?.shell ?? defaults?.run?.shell ?? "pwsh",
      run: step.run,
      lines: step.run.trimEnd().split("\n"),
    }]);
  });
}

const CONTAINED_PREFIX_RE = new RegExp(String.raw`^[ \t]*${CONTAINED}`, "u");
// The wrapper finds its step by its exact argv, so arguments must be plain single-spaced tokens.
const PLAIN_TOKEN = String.raw`[\w./:=+-]+`;
const PLAIN_TOKEN_RE = new RegExp(`^${PLAIN_TOKEN}$`, "u");
const PLAIN_INVOCATION_RE = new RegExp(`^${PLAIN_TOKEN}(?: ${PLAIN_TOKEN})*$`, "u");
const POWERSHELL_SHELL_RE = /^(?:pwsh|powershell)(?:\.exe)?(?:\s|$)/i;
const SETUP_COMMAND = "node ave/.github/scripts/isolate-job-home.mjs";
const WRAPPER = ["node", ".github/scripts/run-in-job.mjs"];
const ARM64_BUILD = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/build-windows-job.ps1 -Arch arm64";
const ARM64_INSTALL = "bun install --frozen-lockfile --ignore-scripts --production";
const ARM64_TEST = "node scripts/test-windows-path-kind.mjs";
const ARM64_SELECTION = "needs.build.outputs.windows_arm64_path_kind";
const ARM64_AGGREGATE = [
  'case "$WINDOWS_ARM64_PATH_KIND:$WINDOWS_ARM64_PATH_KIND_RESULT" in',
  "  true:success|false:skipped) ;;",
  "  *)",
  '    echo "::error::Windows arm64 folder classification selection=$WINDOWS_ARM64_PATH_KIND result=$WINDOWS_ARM64_PATH_KIND_RESULT"',
  "    exit 1",
  "    ;;",
  "esac",
].join("\n");
// After job-root setup every command is a contained manifest invocation or one of these.
const UNCONTAINED_COMMANDS = new Map([
  ["bun install --frozen-lockfile", "installs dependencies; runs no test code"],
  ["node .github/scripts/check-windows-workflow.mjs", "this guard"],
  ["node scripts/fetch-uv.mjs", "fetches a pinned tool"],
  ["node .github/scripts/python-archive-cache.mjs", "computes a cache key"],
  ...["", " -FailureFixture", " -QueryFailureFixture", " -Helper path-kind"].map(option => [
    `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/build-windows-job.ps1${option}`,
    "builds the containment launcher and its native helpers",
  ]),
  ["bun run check:plugin-host-protocol-schema", "regenerates and compares a schema"],
  ["node scripts/check-srt-win-integrity.cjs --upstream --inputs", "hashes the sandbox helper sources"],
  ["node scripts/check-srt-win-integrity.cjs", "hashes the sandbox helper"],
  ["node scripts/fetch-mxc.mjs --arch x64", "fetches pinned native payloads"],
  ["& './node_modules/@anthropic-ai/sandbox-runtime/vendor/srt-win/x64/srt-win.exe' install", "provisions the sandbox account"],
  ["& './node_modules/@anthropic-ai/sandbox-runtime/vendor/srt-win/x64/srt-win.exe' user status", "reads the sandbox account"],
  ["ConvertFrom-Json", "parses in process"],
  ["node .github/scripts/python-download-mirror.mjs", "downloads an interpreter archive"],
  ["node ave/.github/scripts/isolate-job-home.mjs --cleanup", "removes the job root"],
]);

/**
 * The contained-step manifest that run-in-job.mjs registers against: one
 * receipt per contained invocation, named from its step and its position.
 */
export function containedSteps(workflow, containedJob = CONTAINED_JOB) {
  if (!CONTAINED_JOBS.has(containedJob)) throw new Error(`unknown contained job: ${containedJob}`);
  const expectedCondition = CONTAINED_JOBS.get(containedJob);
  const manifest = [];
  for (const { jobId, name, stepName, condition, lines } of windowsRunSteps(workflow)) {
    if (jobId !== containedJob) continue;
    const slug = (stepName ?? "").toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "");
    let position = 0;
    for (const line of lines) {
      if (!CONTAINED_LINE_RE.test(line)) continue;
      const invocation = line.replace(CONTAINED_PREFIX_RE, "").trim();
      if (!slug) throw new Error(`${name}: a contained step needs a name`);
      if (condition !== expectedCondition) {
        throw new Error(`${name}: a contained step needs ${expectedCondition ? `if: ${expectedCondition}` : "the job condition only"}`);
      }
      if (!PLAIN_INVOCATION_RE.test(invocation)) throw new Error(`${name}: contained invocation needs plain single-spaced arguments: ${invocation}`);
      const id = `${slug}-${++position}`;
      if (manifest.some(step => step.id === id || step.invocation === invocation)) {
        throw new Error(`${name}: duplicate contained invocation: ${invocation}`);
      }
      manifest.push({ id, receipt: `${id}.receipt`, invocation });
    }
  }
  if (manifest.length === 0) throw new Error(`${containedJob}: no contained test steps`);
  return manifest;
}

export function windowsRegressionStepFiles(run, readInventory, name) {
  const invocation = run.trim();
  const inventoryName = LIST_INVOCATION.exec(invocation)?.[1];
  const directPaths = TEST_COMMAND_RE.exec(invocation)?.[1];
  let list;
  if (inventoryName !== undefined) {
    list = readInventory(inventoryName);
    if (list === undefined) throw new Error(`Windows test inventory is missing: ${inventoryName}`);
  } else if (directPaths !== undefined) {
    list = directPaths.trim().split(/[ \t]+/u).join("\n");
  } else {
    throw new Error(`${name}: expected one validated test invocation`);
  }
  return windowsTestCommands(list).slice(1).flatMap(args => args.slice(4).map(file => file.slice(2)));
}

function windowsRegressionSteps(steps) {
  const regressions = steps.filter(({ jobId, stepName }) =>
    jobId === "windows-permission-tests" && REGRESSION_STEP.test(stepName ?? ""));
  for (const { name, condition } of regressions) {
    if (condition !== REGRESSION_CONDITION) {
      throw new Error(`${name}: expected if: ${REGRESSION_CONDITION}; found ${JSON.stringify(condition) ?? "no if condition"}`);
    }
  }
  return regressions;
}

export function windowsRegressionFiles(workflow, inventories) {
  const files = new Set();
  for (const { name, run } of windowsRegressionSteps(windowsRunSteps(workflow))) {
    for (const file of windowsRegressionStepFiles(run, path => inventories.get(path), name)) files.add(file);
  }
  return [...files];
}

const WORKFLOW_EXECUTABLES = [
  "bun", "node", "powershell.exe",
  "./node_modules/@anthropic-ai/sandbox-runtime/vendor/srt-win/x64/srt-win.exe",
];
const TEST_COMMAND_NAME_RE = /\.(?:ts|tsx|mjs)$|\.test\./i;
const INSPECT_POWERSHELL_AST = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$inputData = ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd())
function Get-ScopeChain($node) {
  for ($ancestor = $node.Parent; $null -ne $ancestor; $ancestor = $ancestor.Parent) {
    if ($ancestor -is [System.Management.Automation.Language.ScriptBlockAst]) { $ancestor.Extent.StartOffset }
  }
}
$steps = @(foreach ($source in $inputData.steps) {
  $tokens = $null
  $errors = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)
  @{
    errors = @(foreach ($errorItem in $errors) { "line $($errorItem.Extent.StartLineNumber): $($errorItem.Message)" })
    functions = @($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true) |
      ForEach-Object { @{ name = $_.Name; scope = @(Get-ScopeChain $_)[0] } })
    commands = @($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.CommandAst] }, $true) |
      ForEach-Object { @{ name = $_.GetCommandName(); head = $_.CommandElements[0].Extent.Text
        line = $_.Extent.StartLineNumber; scopes = @(Get-ScopeChain $_)
        text = $_.Extent.Text; redirected = $_.Redirections.Count -gt 0; operator = [string]$_.InvocationOperator
        elements = @(foreach ($element in $_.CommandElements) { @{ text = $element.Extent.Text
          plain = ($element -is [System.Management.Automation.Language.StringConstantExpressionAst] -and
            $element.StringConstantType -eq 'BareWord') -or
            ($element -is [System.Management.Automation.Language.CommandParameterAst] -and $null -eq $element.Argument) } }) } })
  }
})
$seenNames = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$resolved = @{
  Cmdlet = [Collections.Generic.List[string]]::new()
  Alias = [Collections.Generic.List[string]]::new()
}
foreach ($step in $steps) {
  foreach ($command in $step.commands) {
    $name = $command.name
    if ($name -and $name -notmatch '[/\\:]' -and $inputData.executableNames -notcontains $name -and $seenNames.Add($name)) {
      # Look up literal names, including punctuation aliases, without enumerating installed commands.
      $info = $ExecutionContext.InvokeCommand.GetCommand($name, 'Cmdlet,Alias')
      if ($info -and $info.Name -eq $name) { $resolved[[string]$info.CommandType].Add($info.Name) }
    }
  }
}
$result = @{
  cmdlets = $resolved.Cmdlet.ToArray()
  aliases = $resolved.Alias.ToArray()
  steps = $steps
}
ConvertTo-Json -InputObject $result -Depth 10 -Compress
`;

export function directCommandProblems(steps) {
  return steps.flatMap(({ jobId, name, lines }) => {
    const commands = lines.filter(line => TEST_INVOCATION_RE.test(line));
    const command = commands[0]?.trim() ?? "";
    const broken = commands.length > 0 && (commands.length !== 1 || !TEST_COMMAND_RE.test(command)
      || (!command.includes("test:vitest") && commands[0] !== lines.at(-1)));
    const problems = broken ? [`${name}: expected one complete direct test command`] : [];
    for (const line of lines) {
      const path = BARE_TEST_PATH_RE.exec(line)?.[0].trim();
      if (path !== undefined) problems.push(`${name}: bare test path ${path}`);
      if (CONTAINED_JOBS.has(jobId) && TEST_LINE_RE.test(line) && !CONTAINED_LINE_RE.test(line)) {
        problems.push(`${name}: test command runs outside the job containment launcher: ${line.trim()}`);
      }
    }
    return problems;
  });
}

function inspectPowerShell(shell, steps) {
  const env = windowsPowerShellEnv();
  const executable = shell === "powershell" ? windowsPowerShellPath(env) : shell;
  const encoded = Buffer.from(INSPECT_POWERSHELL_AST, "utf16le").toString("base64");
  const result = spawnSync(executable, ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
    input: JSON.stringify({ steps, executableNames: WORKFLOW_EXECUTABLES }),
    encoding: "utf8", windowsHide: true, timeout: 15_000,
    env,
  });
  if (result.error) throw new Error(`Cannot launch required ${shell} parser`, { cause: result.error });
  if (result.status !== 0) throw new Error(`${shell} parser failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

function containedCommandProblems(commands, manifest, wrapped, jobId) {
  return commands.flatMap(({ text, line, elements, redirected, operator }) => {
    if (elements[0]?.text !== WRAPPER[0] || elements[1]?.text !== WRAPPER[1]) {
      const arm64Setup = jobId === ARM64_JOB && [ARM64_INSTALL, ARM64_BUILD, `${ARM64_BUILD} -Helper path-kind`].includes(text);
      return arm64Setup || UNCONTAINED_COMMANDS.has(text)
        ? [] : [`line ${line}: command runs outside the job containment launcher: ${text}`];
    }
    const invocation = elements.slice(2).map(element => element.text).join(" ");
    if (redirected || operator !== "Unknown" || !elements.every(element => element.plain && PLAIN_TOKEN_RE.test(element.text))
      || !manifest.some(step => step.invocation === invocation)) {
      return [`line ${line}: contained command is not a plain manifest invocation: ${text}`];
    }
    wrapped.push(invocation);
    return [];
  });
}

export function powerShellCommandProblems(steps, inspect = inspectPowerShell, manifest = [], jobId = CONTAINED_JOB) {
  const failures = [];
  const wrapped = [];
  for (const shell of ["pwsh", "powershell"]) {
    const editionSteps = steps.filter(step => step.shell.match(/^(pwsh|powershell)(?:\.exe)?(?:\s|$)/i)?.[1].toLowerCase() === shell);
    if (editionSteps.length === 0) continue;
    const inspection = inspect(shell, editionSteps.map(step => step.run));
    if (inspection.steps.length !== editionSteps.length) throw new Error(`Incomplete ${shell} parser result`);
    const knownCommands = new Set([...WORKFLOW_EXECUTABLES, ...inspection.cmdlets, ...inspection.aliases]
      .map(name => name.toLowerCase()));
    for (const [index, { errors, functions, commands }] of inspection.steps.entries()) {
      const unknownCommands = commands.flatMap(({ name, head, line, scopes }) => {
        const command = name?.toLowerCase();
        if (command && !TEST_COMMAND_NAME_RE.test(command) && (knownCommands.has(command)
          || functions.some(fn => fn.name.toLowerCase() === command && scopes.includes(fn.scope)))) return [];
        return [`line ${line}: unrecognized command ${head}`];
      });
      const contained = editionSteps[index].contained ? containedCommandProblems(commands, manifest, wrapped, jobId) : [];
      failures.push(...[...errors, ...unknownCommands, ...contained].map(problem => `${editionSteps[index].name}: ${problem}`));
    }
  }
  if (steps.some(step => step.contained)) {
    for (const { id, invocation } of manifest) {
      if (wrapped.filter(entry => entry === invocation).length !== 1) {
        failures.push(`${jobId}: manifest step ${id} is not exactly one contained command after job-root setup`);
      }
    }
  }
  return failures;
}

// Every run step after job-root setup in the contained job is checked command by command.
function scopeContainedSteps(steps, jobId) {
  const setup = steps.findIndex(({ run }) => run.trim() === SETUP_COMMAND);
  if (setup < 0) throw new Error(`${jobId}: no job-root setup step`);
  return steps.map((step, index) => index > setup ? { ...step, contained: true } : step);
}

function checkArm64PathKindJob(jobs) {
  const arm64 = jobs[ARM64_JOB];
  if (arm64?.["runs-on"] !== "windows-11-arm" || arm64.needs !== "build"
    || arm64.if !== `${ARM64_SELECTION} == 'true'` || arm64["continue-on-error"] !== undefined
    || jobs.build?.outputs?.windows_arm64_path_kind !==
      "${{ (github.event_name == 'pull_request' && steps.plan.outputs.platform_checks == 'true') || " +
      "(github.event_name == 'push' && github.ref == 'refs/heads/main') || " +
      "github.event_name == 'schedule' || github.event_name == 'workflow_dispatch' }}") {
    throw new Error(`${ARM64_JOB}: expected the hosted arm64 runner and the path-kind selection`);
  }
  if (arm64["timeout-minutes"] !== PATH_KIND_TIMEOUT_MINUTES) {
    throw new Error(`${ARM64_JOB}: expected a 30-minute timeout`);
  }
  const [checkout, node, bun, isolate, install, launcher, test, cleanup] = arm64.steps ?? [];
  if (arm64.steps?.length !== 8
    || !checkout?.uses?.startsWith("actions/checkout@") || checkout.with?.path !== "ave"
    || checkout.with?.["persist-credentials"] !== false
    || !node?.uses?.startsWith("actions/setup-node@") || node.with?.["node-version"] !== "24"
    || node.with?.architecture !== "arm64" || node.with?.["package-manager-cache"] !== false
    || bun?.uses !== "./ave/.github/actions/setup-bun" || bun.with?.["bun-version-file"] !== "ave/.bun-version"
    || isolate?.run !== SETUP_COMMAND || isolate.shell !== "bash"
    || install?.run !== ARM64_INSTALL || launcher?.run !== ARM64_BUILD
    || test?.run?.trimEnd() !== [`${ARM64_BUILD} -Helper path-kind`,
      "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }", `${WRAPPER.join(" ")} ${ARM64_TEST}`].join("\n")
    || [install, launcher, test].some(step => step["working-directory"] !== "ave" || step.shell !== "powershell")
    || cleanup?.run !== `${SETUP_COMMAND} --cleanup` || cleanup.shell !== "powershell"
    || cleanup.if !== "always() && env.AVE_CI_JOB_ROOT != ''"
    || arm64.steps.some(step => step["continue-on-error"] !== undefined || (step !== cleanup && step.if !== undefined))) {
    throw new Error(`${ARM64_JOB}: expected arm64 setup, contained path-kind test and job-root cleanup`);
  }
  const aggregate = jobs["build-and-test"];
  const result = aggregate?.steps?.[0];
  const arm64Check = result?.run?.indexOf(ARM64_AGGREGATE) ?? -1;
  if (!Array.isArray(aggregate?.needs) || !aggregate.needs.includes(ARM64_JOB)
    || aggregate.if !== "always()" || aggregate["continue-on-error"] !== undefined || result?.if !== "always()"
    || result.env?.WINDOWS_ARM64_PATH_KIND !== `\${{ ${ARM64_SELECTION} }}`
    || result.env?.WINDOWS_ARM64_PATH_KIND_RESULT !== `\${{ needs.${ARM64_JOB}.result }}`
    || result["continue-on-error"] !== undefined || arm64Check < 0
    || arm64Check >= result.run.indexOf('if [ "$DOCS_ONLY" = "true" ]; then')) {
    throw new Error(`${ARM64_JOB}: expected build-and-test to require the selected arm64 result before the docs-only exit`);
  }
}

export function checkWindowsWorkflow(workflow, inspect) {
  const { jobs } = parse(workflow);
  checkArm64PathKindJob(jobs);
  const x64 = jobs[CONTAINED_JOB]?.steps?.filter(step => step.name === "Verify Windows folder classification");
  if (x64?.length !== 1 || x64[0]["timeout-minutes"] !== PATH_KIND_TIMEOUT_MINUTES) {
    throw new Error(`${CONTAINED_JOB}: path-kind step expected a 30-minute timeout`);
  }
  const steps = windowsRunSteps(workflow);
  if (!windowsRegressionSteps(steps).some(step => step.stepName === "Run Windows permission regressions"
    && POWERSHELL_SHELL_RE.test(step.shell))) {
    throw new Error("The Windows permission step requires a PowerShell parser");
  }
  const failures = [
    ...directCommandProblems(steps),
    ...powerShellCommandProblems(steps.filter(step => !CONTAINED_JOBS.has(step.jobId)), inspect),
  ];
  for (const jobId of CONTAINED_JOBS.keys()) {
    const jobSteps = scopeContainedSteps(steps.filter(step => step.jobId === jobId), jobId);
    const manifest = containedSteps(workflow, jobId);
    failures.push(
      ...jobSteps.filter(step => step.contained && !POWERSHELL_SHELL_RE.test(step.shell))
        .map(({ name }) => `${name}: steps after job-root setup need a PowerShell shell`),
      ...powerShellCommandProblems(jobSteps, inspect, manifest, jobId),
    );
  }
  if (failures.length) throw new Error(failures.join("\n"));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  checkWindowsWorkflow(readFileSync(new URL("../workflows/ci.yml", import.meta.url), "utf8"));
}
