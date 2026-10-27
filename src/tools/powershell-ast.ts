/** Native PowerShell AST facts. Raw source is diagnostic text, never expansion authority. */
/** UTF-16 offsets of the element in the parsed source. */
interface PowerShellExtent { start?: number; end?: number }
export type PowerShellValueArgument =
  | ({ kind: "literal"; text: string; value: string } & PowerShellExtent)
  | ({ kind: "dynamic"; text: string } & PowerShellExtent);
export type PowerShellArgument = PowerShellValueArgument
  | ({ kind: "parameter"; text: string; name: string; argument?: PowerShellValueArgument } & PowerShellExtent);
export interface PowerShellAstSummary {
  errors: string[];
  commands: Array<{ name: string | null; text: string; arguments: PowerShellArgument[] }>;
  redirections: PowerShellArgument[];
  unsupported: string[];
}

export function normalizePowerShellAstSummary(raw: unknown): PowerShellAstSummary {
  const record = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid PowerShell AST record");
    return value as Record<string, unknown>;
  };
  const strings = (value: unknown): string[] => {
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error("Invalid PowerShell AST string collection");
    return value as string[];
  };
  const extent = (item: Record<string, unknown>): PowerShellExtent => {
    if (item.start == null && item.end == null) return {};
    const { start, end } = item;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || (start as number) < 0 || (end as number) < (start as number)) {
      throw new Error("Invalid PowerShell AST extent");
    }
    return { start: start as number, end: end as number };
  };
  const valueArgument = (value: unknown): PowerShellValueArgument => {
    const item = record(value);
    if (typeof item.text !== "string") throw new Error("Invalid PowerShell AST argument source");
    if (item.kind === "literal" && typeof item.value === "string") return { kind: "literal", text: item.text, value: item.value, ...extent(item) };
    if (item.kind === "dynamic") return { kind: "dynamic", text: item.text, ...extent(item) };
    throw new Error("Invalid PowerShell AST value argument");
  };
  const argument = (value: unknown): PowerShellArgument => {
    const item = record(value);
    if (item.kind === "parameter" && typeof item.name === "string" && typeof item.text === "string") return {
      kind: "parameter", text: item.text, name: item.name,
      ...(item.argument == null ? {} : { argument: valueArgument(item.argument) }), ...extent(item),
    };
    return valueArgument(value);
  };
  const input = record(raw);
  if (!Array.isArray(input.commands) || !Array.isArray(input.redirections)) throw new Error("Missing PowerShell AST collections");
  return {
    errors: strings(input.errors), unsupported: strings(input.unsupported),
    redirections: input.redirections.map(argument),
    commands: input.commands.map((value) => {
      const item = record(value);
      if ((item.name !== null && typeof item.name !== "string") || typeof item.text !== "string" || !Array.isArray(item.arguments)) throw new Error("Invalid PowerShell AST command");
      return { name: item.name, text: item.text, arguments: item.arguments.map(argument) };
    }),
  };
}

export const POWER_SHELL_AST_PARSER = `
$ErrorActionPreference = 'Stop'
$cmd = [Console]::In.ReadToEnd()
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput($cmd, [ref]$tokens, [ref]$errors)
function Describe-Argument($node) {
  if ($node -is [System.Management.Automation.Language.CommandParameterAst]) {
    $value = $null
    if ($null -ne $node.Argument) { $value = Describe-Argument $node.Argument }
    return [ordered]@{ kind = 'parameter'; text = $node.Extent.Text; name = $node.ParameterName; argument = $value; start = $node.Extent.StartOffset; end = $node.Extent.EndOffset }
  }
  if ($node -is [System.Management.Automation.Language.StringConstantExpressionAst] -or
      ($node -is [System.Management.Automation.Language.ExpandableStringExpressionAst] -and $node.NestedExpressions.Count -eq 0) -or
      $node -is [System.Management.Automation.Language.ConstantExpressionAst]) {
    return [ordered]@{ kind = 'literal'; text = $node.Extent.Text; value = [string]$node.Value; start = $node.Extent.StartOffset; end = $node.Extent.EndOffset }
  }
  if ($node -is [System.Management.Automation.Language.VariableExpressionAst] -and
      $node.VariablePath.UserPath -in @('true', 'false')) {
    return [ordered]@{ kind = 'literal'; text = $node.Extent.Text; value = $node.VariablePath.UserPath; start = $node.Extent.StartOffset; end = $node.Extent.EndOffset }
  }
  return [ordered]@{ kind = 'dynamic'; text = $node.Extent.Text; start = $node.Extent.StartOffset; end = $node.Extent.EndOffset }
}
$commands = @(
  $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.CommandAst] }, $true) |
    ForEach-Object {
      [ordered]@{
        name = $_.GetCommandName()
        text = $_.Extent.Text
        arguments = @($_.CommandElements | ForEach-Object { Describe-Argument $_ })
      }
    }
)
$redirections = @(
  $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FileRedirectionAst] }, $true) |
    ForEach-Object { Describe-Argument $_.Location }
)
$unsupported = @(
  $ast.FindAll({ param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -or
    $node -is [System.Management.Automation.Language.InvokeMemberExpressionAst]
  }, $true) | ForEach-Object { $_.GetType().Name }
)
[ordered]@{
  errors = @($errors | ForEach-Object { $_.Message })
  commands = $commands
  redirections = $redirections
  unsupported = $unsupported
} | ConvertTo-Json -Depth 16 -Compress
`;
