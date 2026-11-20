import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";
import { windowsPowerShellEnv } from "../../scripts/lib/windows-powershell-env.mjs";

const TEST_PATH = String.raw`[\w./\\-]+\.(?:test|spec)\.[cm]?[jt]sx?`;
const BARE_TEST_PATH_RE = new RegExp(String.raw`^\s*${TEST_PATH}(?![\w./\\-])`);
const TEST_INVOCATION_RE = /\bbun[ \t]+run[ \t]+test(?::vitest)?(?=[ \t]|$)/;
const TEST_COMMAND_RE = new RegExp(
  String.raw`^bun[ \t]+run[ \t]+(?:test[ \t]+--|test:vitest[ \t]+--(?:[ \t]+run)?)(?:[ \t]+${TEST_PATH})+$`,
);
export function windowsRunSteps(workflow) {
  const { jobs, defaults } = parse(workflow);
  return Object.entries(jobs).flatMap(([jobId, job]) => {
    const runners = [job["runs-on"] ?? []].flat();
    if (!runners.some((runner) => /^windows(?:-|$)/i.test(runner))) return [];
    return (job.steps ?? []).flatMap((step, index) => step.run === undefined ? [] : [{
      name: `${jobId}: ${step.name ?? `step ${index + 1}`}`,
      shell: step.shell ?? job.defaults?.run?.shell ?? defaults?.run?.shell ?? "pwsh",
      run: step.run,
      lines: step.run.trimEnd().split("\n"),
    }]);
  });
}

const WORKFLOW_EXECUTABLES = [
  "bun", "node", "powershell.exe",
  "./node_modules/@anthropic-ai/sandbox-runtime/vendor/srt-win/x64/srt-win.exe",
];
const TEST_COMMAND_NAME_RE = /\.(?:ts|tsx|mjs)$|\.test\./i;
const INSPECT_POWERSHELL_AST = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$inputData = ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd())
$result = @{
  cmdlets = @((Get-Command -CommandType Cmdlet).Name)
  steps = @(foreach ($source in $inputData.steps) {
    $tokens = $null
    $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)
    @{
      errors = @(foreach ($errorItem in $errors) { "line $($errorItem.Extent.StartLineNumber): $($errorItem.Message)" })
      functions = @($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true) |
        ForEach-Object { $_.Name })
      commands = @($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.CommandAst] }, $true) |
        ForEach-Object { @{ name = $_.GetCommandName(); head = $_.CommandElements[0].Extent.Text; line = $_.Extent.StartLineNumber } })
    }
  })
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
    input: JSON.stringify({ steps }), encoding: "utf8", windowsHide: true, timeout: 15_000,
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
    for (const [index, { errors, functions, commands }] of inspection.steps.entries()) {
      const knownCommands = new Set([...WORKFLOW_EXECUTABLES, ...inspection.cmdlets, ...functions].map(name => name.toLowerCase()));
      const unknownCommands = commands.flatMap(({ name, head, line }) =>
        name !== null && !TEST_COMMAND_NAME_RE.test(name) && knownCommands.has(name.toLowerCase())
          ? [] : [`line ${line}: unrecognized command ${head}`]);
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
