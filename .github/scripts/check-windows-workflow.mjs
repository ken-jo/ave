import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";
import { WINDOWS_TEST_SHARDS, WINDOWS_TIER_TEST_SHARDS } from "../../scripts/run-windows-test-list.mjs";
import { collectedVitestFiles } from "../../scripts/lib/vitest-collection.mjs";
import { windowsPowerShellEnv, windowsPowerShellPath } from "../../scripts/lib/windows-powershell-env.mjs";

const TEST_PATH = String.raw`[\w./\\-]+\.(?:test|spec)\.[cm]?[jt]sx?`;
const BARE_TEST_PATH_RE = new RegExp(String.raw`^\s*${TEST_PATH}(?![\w./\\-])`);
const TEST_INVOCATION_RE = /\bbun[ \t]+run[ \t]+test(?::vitest)?(?=[ \t]|$)/;
const CONTAINED = String.raw`node[ \t]+\.github\/scripts\/run-in-job\.mjs[ \t]+`;
const TEST_COMMAND_RE = new RegExp(
  String.raw`^(?:${CONTAINED})?bun[ \t]+run[ \t]+(?:test[ \t]+--|test:vitest[ \t]+--(?:[ \t]+run)?)((?:[ \t]+${TEST_PATH})+)$`,
);
const REGRESSION_STEP = /^Run Windows (?:[\w ]+ )?regressions$/u;
const REGRESSION_STEP_NAME = "Run Windows regressions";
const REGRESSION_CONDITION = "steps.docs-impact.outputs.docs_only != 'true'";
// The shard runner takes its plan and shard ID from the environment only.
const SHARD_INVOCATION = "node .github/scripts/run-in-job.mjs bun run scripts/run-windows-test-list.mjs";
// Test commands in the job that owns the isolated job root run inside the containment launcher.
const CONTAINED_JOB = "windows-permission-tests";
// The tier job runs the plan's tier shards through the same contained regression step.
const TIER_JOB = "windows-tier-tests";
const TEST_JOBS = [CONTAINED_JOB, TIER_JOB];
const PREPARATION_JOB = "windows-native-preparation";
const ARM64_JOB = "windows-arm64-path-kind";
const PATH_KIND_TIMEOUT_MINUTES = 30;
// The condition each contained job's contained steps carry; arm64 steps carry only the job condition.
const CONTAINED_CONDITIONS = new Map([
  [PREPARATION_JOB, REGRESSION_CONDITION],
  [CONTAINED_JOB, REGRESSION_CONDITION],
  [TIER_JOB, REGRESSION_CONDITION],
  [ARM64_JOB, undefined],
]);
const CONTAINED_JOBS = [...CONTAINED_CONDITIONS.keys()];
const WINDOWS_PLAN_PATH = "${{ runner.temp }}/windows-ci/windows-plan.json";
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
  ...["key", "restore", "seal", "verify-installed", "verify-publication"].map(operation => ["node .github/scripts/windows-preparation-cache.mjs " + operation, "inventories or verifies preparation bytes"]),
  ["node scripts/fetch-uv.mjs", "fetches a pinned tool"],
  ["node .github/scripts/python-archive-cache.mjs", "computes a cache key"],
  ...["", " -FailureFixture", " -QueryFailureFixture", " -Helper path-kind", " -Helper path-kind -HoldFixture"].map(option => [
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
  ["node .github/scripts/restore-windows-ci-inputs.mjs", "restores the native helper artifacts and configures the mirror"],
  ["node ave/.github/scripts/isolate-job-home.mjs --cleanup", "removes the job root"],
]);

/**
 * The contained-step manifest that run-in-job.mjs registers against: one
 * receipt per contained invocation, named from its step and its position.
 */
export function containedSteps(workflow, job = CONTAINED_JOB) {
  if (!CONTAINED_JOBS.includes(job)) throw new Error(`Unknown contained Windows job: ${job}`);
  const expectedCondition = CONTAINED_CONDITIONS.get(job);
  const manifest = [];
  for (const { jobId, name, stepName, condition, lines } of windowsRunSteps(workflow)) {
    if (jobId !== job) continue;
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
  if (manifest.length === 0) throw new Error(`${job}: no contained test steps`);
  return manifest;
}

function windowsRegressionSteps(steps) {
  const regressions = steps.filter(({ jobId, stepName }) =>
    TEST_JOBS.includes(jobId) && REGRESSION_STEP.test(stepName ?? ""));
  for (const { name, condition } of regressions) {
    if (condition !== REGRESSION_CONDITION) {
      throw new Error(`${name}: expected if: ${REGRESSION_CONDITION}; found ${JSON.stringify(condition) ?? "no if condition"}`);
    }
  }
  return regressions;
}

function hasOneRegressionStepPerTestJob(regressions) {
  return regressions.length === TEST_JOBS.length && TEST_JOBS.every(jobId => regressions.filter(step => step.jobId === jobId).length === 1)
    && regressions.every(step => step.stepName === REGRESSION_STEP_NAME && step.run.trim() === SHARD_INVOCATION);
}

/**
 * The suites the Windows regression steps run: every collected suite in the
 * checkout at root, split by the build job's plan across the default shards
 * and, for the selected tiers, the tier shards.
 */
export function windowsRegressionSuites(workflow, root) {
  if (!hasOneRegressionStepPerTestJob(windowsRegressionSteps(windowsRunSteps(workflow)))) {
    throw new Error(`Each Windows test job must run one ${REGRESSION_STEP_NAME} step: ${SHARD_INVOCATION}`);
  }
  return collectedVitestFiles(root);
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
      if (CONTAINED_JOBS.includes(jobId) && TEST_LINE_RE.test(line) && !CONTAINED_LINE_RE.test(line)) {
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

export function powerShellCommandProblems(steps, inspect = inspectPowerShell, manifest = [], job = CONTAINED_JOB) {
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
      const contained = editionSteps[index].contained ? containedCommandProblems(commands, manifest, wrapped, job) : [];
      failures.push(...[...errors, ...unknownCommands, ...contained].map(problem => `${editionSteps[index].name}: ${problem}`));
    }
  }
  if (steps.some(step => step.contained)) {
    for (const { id, invocation } of manifest) {
      if (wrapped.filter(entry => entry === invocation).length !== 1) {
        failures.push(`${job}: manifest step ${id} is not exactly one contained command after job-root setup`);
      }
    }
  }
  return failures;
}

// Every run step after job-root setup in the contained job is checked command by command.
function scopeContainedSteps(steps, job) {
  const setup = steps.findIndex(({ run }) => run.trim() === SETUP_COMMAND);
  if (setup < 0) throw new Error(`${job}: no job-root setup step`);
  return steps.map((step, index) => index > setup ? { ...step, contained: true } : step);
}

const PREPARATION_CACHE_PATH = "${{ runner.temp }}/windows-preparation-cache";
const PREPARATION_CACHE_KEY = "${{ steps.windows-preparation-key.outputs.key }}";
const PREPARATION_CACHE_COMMAND = "node .github/scripts/windows-preparation-cache.mjs";
const PREPARATION_CACHE_MAIN_SAVE = REGRESSION_CONDITION + " && github.ref == 'refs/heads/main' && github.event_name != 'pull_request' && env.AVE_WINDOWS_PREP_STORE != '' && env.AVE_WINDOWS_PREP_VERIFIED == 'false'";

function checkPreparationCache(job) {
  const steps = job.steps;
  const find = name => steps.find(step => step.name === name);
  const key = find("Generate the Windows preparation input manifest");
  const restore = find("Restore Windows preparation outputs");
  const verify = find("Verify Windows preparation outputs or rebuild");
  const build = find("Build Windows launcher and classification helpers");
  const seal = find("Seal Windows preparation outputs");
  const cleanup = find("Remove isolated system-volume job directory");
  const publication = find("Verify sealed Windows preparation outputs");
  const save = find("Save Windows preparation outputs");
  const before = (first, second) => first && second && steps.indexOf(first) < steps.indexOf(second);
  const exact = (step, action) => step?.uses?.startsWith("actions/cache/" + action + "@")
    && step.with?.key === PREPARATION_CACHE_KEY && step.with?.path === PREPARATION_CACHE_PATH
    && Object.keys(step.with).length === 2;
  if (key?.id !== "windows-preparation-key" || key.run !== PREPARATION_CACHE_COMMAND + " key"
    || key.if !== REGRESSION_CONDITION || key["working-directory"] !== "ave"
    || !exact(restore, "restore") || restore.id !== "windows-preparation-restore"
    || restore.if !== REGRESSION_CONDITION + " && steps.windows-preparation-key.outputs.key != '' && (github.ref == 'refs/heads/main' || github.event_name == 'pull_request')"
    || !before(key, restore)) {
    throw new Error("Windows preparation needs a generated input key and an exact scoped restore");
  }
  if (verify?.run !== PREPARATION_CACHE_COMMAND + " restore" || verify.if !== REGRESSION_CONDITION
    || verify["working-directory"] !== "ave" || verify.env?.AVE_WINDOWS_PREP_KEY !== PREPARATION_CACHE_KEY
    || verify.env?.AVE_WINDOWS_PREP_EXACT_HIT !== "${{ steps.windows-preparation-restore.outputs.cache-hit }}"
    || !before(restore, verify) || !before(verify, build)
    || build.if !== REGRESSION_CONDITION + " && env.AVE_WINDOWS_PREP_VERIFIED != 'true'") {
    throw new Error("Windows preparation cache must verify or rebuild before any output is used");
  }
  for (const name of ["Verify native background process ownership", "Verify both Windows native payload packages",
    "Verify Windows folder classification", "Build and test patched Windows sandbox helper"]) {
    const step = find(name);
    if (!before(build, step) || step.if !== REGRESSION_CONDITION || !before(step, seal)) {
      throw new Error("Windows preparation must run its checks on both cold and warm paths: " + name);
    }
  }
  for (const env of [job.env, ...steps.map(step => step.env)]) {
    if (env && ["AVE_WINDOWS_PREP_VERIFIED", "AVE_WINDOWS_PREP_STORE", "AVE_WINDOWS_PREP_RESTORED_DIGEST"].some(name => Object.hasOwn(env, name))) {
      throw new Error("Only the Windows preparation verifier may set the cache state");
    }
  }
  const saveOnlyOnSuccess = "success() && " + PREPARATION_CACHE_MAIN_SAVE;
  // Publication depends on the declared preparation steps through the final digest check.
  const verifiedAfterCleanup = saveOnlyOnSuccess
    + " && steps.windows-preparation-seal.outcome == 'success' && steps.windows-job-cleanup.outcome == 'success'";
  if (seal?.id !== "windows-preparation-seal" || seal.run !== PREPARATION_CACHE_COMMAND + " seal" || seal.if !== PREPARATION_CACHE_MAIN_SAVE
    || seal["working-directory"] !== "ave" || seal.env?.AVE_WINDOWS_PREP_KEY !== PREPARATION_CACHE_KEY
    || cleanup?.id !== "windows-job-cleanup" || cleanup.run !== SETUP_COMMAND + " --cleanup"
    || cleanup.if !== REGRESSION_CONDITION + " && always() && env.AVE_CI_JOB_ROOT != ''"
    || publication?.id !== "windows-preparation-publication" || publication.run !== PREPARATION_CACHE_COMMAND + " verify-publication"
    || publication.if !== verifiedAfterCleanup || publication["working-directory"] !== "ave"
    || publication.env?.AVE_WINDOWS_PREP_KEY !== PREPARATION_CACHE_KEY
    || publication.env?.AVE_WINDOWS_PREP_SEAL_DIGEST !== "${{ steps.windows-preparation-seal.outputs.digest }}"
    || !before(seal, cleanup) || !before(cleanup, publication) || !before(publication, save) || save !== steps.at(-1)
    || !exact(save, "save") || save.if !== saveOnlyOnSuccess + " && steps.windows-preparation-publication.outcome == 'success'") {
    throw new Error("Saving Windows helpers on main requires successful preparation steps through containment cleanup and the final digest check");
  }
}

function checkFirstPreparationLaunch(steps) {
  const firstLaunch = steps.find(step => step.run?.split(/\r?\n/u).some(line => CONTAINED_LINE_RE.test(line)));
  if (firstLaunch?.name !== "Verify native background process ownership"
    || firstLaunch["working-directory"] !== "ave" || firstLaunch.env?.AVE_WINDOWS_PREP_KEY !== PREPARATION_CACHE_KEY
    || firstLaunch.run.trim() !== [
      PREPARATION_CACHE_COMMAND + " verify-installed",
      "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
      "node .github/scripts/run-in-job.mjs node scripts/test-windows-job.mjs",
    ].join("\n")) {
    throw new Error("The first launcher step must rehash installed Windows helpers before executing the launcher");
  }
}

// Restored or cached native binaries: the containment launcher (every
// run-in-job line), its fixtures, the path classifier and the sandbox helper.
const HELPER_EXECUTABLE_RE = /(?:^|[^\w-])(?:upstream-)?(?:srt-win|ave-job(?:-failure|-query-failure)?|ave-path-kind(?:-hold-fixture)?|ave-path-pin-test)\.exe(?![\w.-])/u;
const SRT_WIN_EXECUTABLE_RE = /(?:^|[^\w-])srt-win\.exe(?![\w.-])/u;
const EXIT_ON_FAILURE = "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }";
const SRT_WIN_INTEGRITY = "node scripts/check-srt-win-integrity.cjs";
// Where each job's helper bytes become the checked ones, and where the sandbox
// helper in node_modules is replaced. The node_modules cache is saved after a
// job has rebuilt or restored that helper, so its copy is never trusted.
const HELPER_TRUST = {
  [PREPARATION_JOB]: {
    anchor: PREPARATION_CACHE_COMMAND + " verify-installed",
    what: "rehashing the installed helpers",
    srtWin: "node .github/scripts/run-in-job.mjs node scripts/build-srt-win.mjs --test-native",
  },
  [CONTAINED_JOB]: {
    anchor: "node .github/scripts/restore-windows-ci-inputs.mjs",
    what: "installing the checked helper artifacts",
    srtWin: "node .github/scripts/restore-windows-ci-inputs.mjs",
  },
};
HELPER_TRUST[TIER_JOB] = HELPER_TRUST[CONTAINED_JOB];

function executesHelper(line) {
  return CONTAINED_LINE_RE.test(line) || HELPER_EXECUTABLE_RE.test(line);
}

/**
 * Every step that executes a restored or cached binary runs after the job's
 * trust point, and the sandbox helper also runs only after this job replaced
 * the node_modules copy and the same step checked its integrity.
 */
export function checkHelperExecutionOrder(jobId, steps) {
  const trust = HELPER_TRUST[jobId];
  if (!trust) throw new Error(`Unknown contained Windows job: ${jobId}`);
  let anchored = false;
  let replaced = false;
  for (const step of steps) {
    if (step.run === undefined) continue;
    const lines = step.run.trimEnd().split(/\r?\n/u).map(line => line.trim());
    let integrityChecked = false;
    for (const [index, line] of lines.entries()) {
      if (line === trust.anchor) {
        if (anchored) throw new Error(`${jobId}: ${trust.what} must happen once`);
        if (step["working-directory"] !== "ave" || step.if !== REGRESSION_CONDITION
          || (index + 1 < lines.length && lines[index + 1] !== EXIT_ON_FAILURE)) {
          throw new Error(`${jobId}: ${step.name}: ${trust.what} must stop the step when it fails`);
        }
        anchored = true;
      }
      if (line === SRT_WIN_INTEGRITY && lines[index + 1] === EXIT_ON_FAILURE) integrityChecked = true;
      if (executesHelper(line)) {
        if (!anchored) {
          throw new Error(`${jobId}: ${step.name}: executes a restored or cached binary before ${trust.what}: ${line}`);
        }
        if (SRT_WIN_EXECUTABLE_RE.test(line) && !(replaced && integrityChecked)) {
          throw new Error(`${jobId}: ${step.name}: runs the sandbox helper before this job replaced the cached node_modules copy and checked its integrity: ${line}`);
        }
      }
      if (line === trust.srtWin) replaced = true;
    }
  }
  if (!anchored) throw new Error(`${jobId}: no step for ${trust.what}`);
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

const TIER_SELECTION = "needs.build.outputs.windows_tier_tests == 'true'";
const TIER_SELECTION_OUTPUT = "${{ steps.docs-impact.outputs.docs_only != 'true' && steps.tiers.outputs.windows_tiers != '' }}";
const PLAN_UPLOAD_CONDITION = "steps.docs-impact.outputs.docs_only != 'true' && "
  + "(steps.plan.outputs.platform_checks == 'true' || steps.tiers.outputs.windows_tiers != '')";
const TIER_AGGREGATE = 'case "$WINDOWS_TIER_TESTS:$WINDOWS_TIER_RESULT" in\n  true:success|false:skipped) ;;';
const PREPARATION_AGGREGATE = [
  "preparation=$expected",
  'if [ "$WINDOWS_TIER_TESTS" = "true" ]; then preparation=success; fi',
  'if [ "$WINDOWS_PREPARATION_RESULT" != "$preparation" ]; then',
].join("\n");

// A selected Windows tier is prepared, uploaded, run and required even when the platform matrix is skipped.
function checkTierSelection(jobs, tierCondition) {
  const upload = jobs.build?.steps?.filter(step => step.name === "Upload the Windows regression plan");
  const tierJob = jobs[TIER_JOB];
  const aggregate = jobs["build-and-test"];
  const result = aggregate?.steps?.[0];
  if (jobs.build?.outputs?.windows_tier_tests !== TIER_SELECTION_OUTPUT
    || upload?.length !== 1 || upload[0].if !== PLAN_UPLOAD_CONDITION
    || tierJob?.if !== tierCondition || JSON.stringify(tierJob?.needs) !== JSON.stringify(["build", PREPARATION_JOB])
    || !Array.isArray(aggregate?.needs) || !aggregate.needs.includes(TIER_JOB) || !aggregate.needs.includes(PREPARATION_JOB)
    || result?.env?.WINDOWS_TIER_TESTS !== "${{ needs.build.outputs.windows_tier_tests }}"
    || result.env.WINDOWS_TIER_RESULT !== `\${{ needs.${TIER_JOB}.result }}`
    || result.env.WINDOWS_PREPARATION_RESULT !== `\${{ needs.${PREPARATION_JOB}.result }}`
    || typeof result.run !== "string" || !result.run.includes(TIER_AGGREGATE) || !result.run.includes(PREPARATION_AGGREGATE)
    || result.run.includes('"$WINDOWS_PREPARATION_RESULT" "$WINDOWS_RESULT"')) {
    throw new Error("The Windows tier shards must follow tier selection through preparation, plan upload and the aggregate");
  }
}

export function checkWindowsWorkflow(workflow, inspect) {
  const { jobs } = parse(workflow);
  checkArm64PathKindJob(jobs);
  const x64 = jobs[PREPARATION_JOB]?.steps?.filter(step => step.name === "Verify Windows folder classification");
  if (x64?.length !== 1 || x64[0]["timeout-minutes"] !== PATH_KIND_TIMEOUT_MINUTES) {
    throw new Error(`${PREPARATION_JOB}: path-kind step expected a 30-minute timeout`);
  }
  const job = jobs[CONTAINED_JOB];
  const platform = "needs.build.outputs.platform_checks == 'true'";
  const prepared = "needs.windows-native-preparation.result == 'success'";
  if (jobs[PREPARATION_JOB]?.if !== `${platform} || ${TIER_SELECTION}` || jobs[PREPARATION_JOB]?.needs !== "build"
    || job?.if !== `${platform} && ${prepared}`
    || JSON.stringify(job?.needs) !== JSON.stringify(["build", PREPARATION_JOB])) {
    throw new Error("Windows preparation and every shard must follow native platform selection");
  }
  const tierJob = jobs[TIER_JOB];
  checkTierSelection(jobs, `${TIER_SELECTION} && ${prepared}`);
  for (const [testJob, shards, tier] of [[job, WINDOWS_TEST_SHARDS, undefined], [tierJob, WINDOWS_TIER_TEST_SHARDS, "tiers"]]) {
    const strategy = testJob?.strategy;
    if (strategy?.["fail-fast"] !== false || Object.keys(strategy.matrix ?? {}).length !== 1
      || JSON.stringify(strategy.matrix.shard) !== JSON.stringify(shards)
      || testJob.env?.AVE_WINDOWS_TEST_SHARD !== "${{ matrix.shard }}" || testJob.env?.AVE_WINDOWS_TEST_TIER !== tier) {
      throw new Error("The Windows test job must run every contained shard");
    }
  }
  for (const id of CONTAINED_JOBS) {
    const contained = jobs[id];
    if (contained?.["continue-on-error"] !== undefined || contained?.steps?.some(step => step["continue-on-error"] !== undefined)) {
      throw new Error(`${id}: contained Windows failures must fail the job`);
    }
  }
  checkPreparationCache(jobs[PREPARATION_JOB]);
  const steps = windowsRunSteps(workflow);
  const regressions = windowsRegressionSteps(steps);
  if (!hasOneRegressionStepPerTestJob(regressions)) {
    throw new Error(`The Windows shard must run every collected suite through one ${REGRESSION_STEP_NAME} step: ${SHARD_INVOCATION}`);
  }
  for (const step of TEST_JOBS.flatMap(id => jobs[id].steps ?? [])) {
    if (!REGRESSION_STEP.test(step.name ?? "")) continue;
    if (Object.hasOwn(step.env ?? {}, "AVE_WINDOWS_TEST_SHARD")) {
      throw new Error(`${step.name}: Windows regression steps must inherit the matrix shard ID`);
    }
    if (step.env?.AVE_WINDOWS_TEST_PLAN !== WINDOWS_PLAN_PATH) {
      throw new Error(`${step.name}: Windows regression steps must use the matrix plan artifact`);
    }
  }
  // Matrix copies share this exact template and receive distinct shard IDs.
  const failures = [
    ...directCommandProblems(steps),
    ...CONTAINED_JOBS.flatMap(jobId => {
      const scoped = scopeContainedSteps(steps.filter(step => step.jobId === jobId), jobId);
      return [
        ...scoped.filter(step => step.contained && !POWERSHELL_SHELL_RE.test(step.shell))
          .map(({ name }) => `${name}: steps after job-root setup need a PowerShell shell`),
        ...powerShellCommandProblems(scoped, inspect, containedSteps(workflow, jobId), jobId),
      ];
    }),
    ...powerShellCommandProblems(steps.filter(step => !CONTAINED_JOBS.includes(step.jobId)), inspect),
  ];
  if (failures.length) throw new Error(failures.join("\n"));
  checkFirstPreparationLaunch(jobs[PREPARATION_JOB].steps);
  for (const id of Object.keys(HELPER_TRUST)) checkHelperExecutionOrder(id, jobs[id].steps);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  checkWindowsWorkflow(readFileSync(new URL("../workflows/ci.yml", import.meta.url), "utf8"));
}
