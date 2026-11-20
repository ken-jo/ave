import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";
import { windowsTestCommands } from "../../scripts/run-windows-test-list.mjs";
import { windowsPowerShellEnv } from "../../scripts/lib/windows-powershell-env.mjs";

const TEST_PATH = String.raw`[\w./\\-]+\.(?:test|spec)\.[cm]?[jt]sx?`;
const BARE_TEST_PATH_RE = new RegExp(String.raw`^\s*${TEST_PATH}(?![\w./\\-])`);
const TEST_INVOCATION_RE = /\bbun[ \t]+run[ \t]+test(?::vitest)?(?=[ \t]|$)/;
const TEST_COMMAND_RE = new RegExp(
  String.raw`^bun[ \t]+run[ \t]+(?:test[ \t]+--|test:vitest[ \t]+--(?:[ \t]+run)?)((?:[ \t]+${TEST_PATH})+)$`,
);
const REGRESSION_STEP = /^Run Windows (?:permission|appearance|session persistence|native import) regressions$/u;
const LIST_INVOCATION = /^bun[ \t]+run[ \t]+scripts\/run-windows-test-list\.mjs[ \t]+(config\/[\w-]+\.txt)$/u;

export function windowsRunSteps(workflow) {
  const { jobs, defaults } = parse(workflow);
  return Object.entries(jobs).flatMap(([jobId, job]) => {
    const runners = [job["runs-on"] ?? []].flat();
    if (!runners.some((runner) => /^windows(?:-|$)/i.test(runner))) return [];
    return (job.steps ?? []).flatMap((step, index) => step.run === undefined ? [] : [{
      jobId,
      stepName: step.name,
      name: `${jobId}: ${step.name ?? `step ${index + 1}`}`,
      shell: step.shell ?? job.defaults?.run?.shell ?? defaults?.run?.shell ?? "pwsh",
      run: step.run,
      lines: step.run.trimEnd().split("\n"),
    }]);
  });
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

export function windowsRegressionFiles(workflow, inventories) {
  const files = new Set();
  for (const { jobId, stepName, name, run } of windowsRunSteps(workflow)) {
    if (jobId !== "windows-permission-tests" || !REGRESSION_STEP.test(stepName ?? "")) continue;
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
        line = $_.Extent.StartLineNumber; scopes = @(Get-ScopeChain $_) } })
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
ConvertTo-Json -InputObject $result -Depth 6 -Compress
`;

export function directCommandProblems(steps) {
  return steps.flatMap(({ name, lines }) => {
    const commands = lines.filter(line => TEST_INVOCATION_RE.test(line));
    const command = commands[0]?.trim() ?? "";
    const broken = commands.length > 0 && (commands.length !== 1 || !TEST_COMMAND_RE.test(command)
      || (!command.includes("test:vitest") && commands[0] !== lines.at(-1)));
    const problems = broken ? [`${name}: expected one complete direct test command`] : [];
    for (const line of lines) {
      const path = BARE_TEST_PATH_RE.exec(line)?.[0].trim();
      if (path !== undefined) problems.push(`${name}: bare test path ${path}`);
    }
    return problems;
  });
}

function inspectPowerShell(shell, steps) {
  const encoded = Buffer.from(INSPECT_POWERSHELL_AST, "utf16le").toString("base64");
  const result = spawnSync(shell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
    input: JSON.stringify({ steps, executableNames: WORKFLOW_EXECUTABLES }),
    encoding: "utf8", windowsHide: true, timeout: 15_000,
    env: windowsPowerShellEnv(),
  });
  if (result.error) throw new Error(`Cannot launch required ${shell} parser`, { cause: result.error });
  if (result.status !== 0) throw new Error(`${shell} parser failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

export function powerShellCommandProblems(steps, inspect = inspectPowerShell) {
  const failures = [];
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
      failures.push(...[...errors, ...unknownCommands].map(problem => `${editionSteps[index].name}: ${problem}`));
    }
  }
  return failures;
}

export function checkWindowsWorkflow(workflow, inspect) {
  const steps = windowsRunSteps(workflow);
  if (!steps.some(step => step.name === "windows-permission-tests: Run Windows permission regressions"
    && /^(?:pwsh|powershell)(?:\.exe)?(?:\s|$)/i.test(step.shell))) {
    throw new Error("The Windows permission step requires a PowerShell parser");
  }
  const failures = [...directCommandProblems(steps), ...powerShellCommandProblems(steps, inspect)];
  if (failures.length) throw new Error(failures.join("\n"));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  checkWindowsWorkflow(readFileSync(new URL("../workflows/ci.yml", import.meta.url), "utf8"));
}
