// Definite PowerShell recursive filesystem traversal: the host block's rule, shared with the permission decision.
// Callers pass a canonical cmdlet name (aliases resolved) and the command's arguments after the name.

export const POWERSHELL_RECURSIVE_TRAVERSAL_REASON = "recursive shell filesystem traversal is not allowed";
export const POWERSHELL_RECURSIVE_TRAVERSAL_REFUSAL = `PowerShell command blocked: ${POWERSHELL_RECURSIVE_TRAVERSAL_REASON}`;

export type PowerShellTraversalValue = { readonly kind: "literal"; readonly value: string } | { readonly kind: "dynamic" };
export interface PowerShellTraversalParameter {
  readonly kind: "parameter";
  // Spelled name without the leading dash.
  readonly name: string;
  // Colon-bound value (`-Recurse:$x`); absent for a bare switch.
  readonly argument?: PowerShellTraversalValue;
}
export type PowerShellTraversalArgument = PowerShellTraversalParameter | PowerShellTraversalValue;

// Filesystem cmdlets that take -Recurse or -Depth.
const RECURSIVE_PARAMETER_COMMANDS: ReadonlySet<string> = new Set([
  "add-content", "clear-content", "clear-item", "copy-item", "get-childitem", "get-content", "get-item", "get-itemproperty",
  "get-itempropertyvalue", "move-item", "new-item", "out-file", "remove-item", "rename-item", "set-content", "set-item",
  "set-itemproperty", "test-path",
]);
const NATIVE_RECURSE_SWITCHES: ReadonlyMap<string, RegExp> = new Map([
  ["robocopy", /^\/(?:s|e|mir)$/i],
  ["xcopy", /^\/[se]$/i],
  ["findstr", /^\/s$/i],
]);
const ARCHIVE_WALKERS: ReadonlySet<string> = new Set(["tar", "unzip", "7z", "7za", "7zr"]);

function commandLeaf(name: string): string {
  const leaf = name.slice(Math.max(name.lastIndexOf("\\"), name.lastIndexOf("/")) + 1).toLowerCase();
  return leaf.endsWith(".exe") ? leaf.slice(0, -4) : leaf;
}

// PowerShell binds any unambiguous name prefix; an ambiguous one fails to bind, so matching it only over-blocks.
export function isPowerShellParameterPrefix(parameter: PowerShellTraversalParameter, name: string, minimum = 1): boolean {
  const spelled = parameter.name.toLowerCase();
  return spelled.length >= minimum && name.startsWith(spelled);
}

// Only a literal false disables a switch; a dynamic value may be true.
export function isPowerShellSwitchEnabled(parameter: PowerShellTraversalParameter): boolean {
  return parameter.argument === undefined || parameter.argument.kind !== "literal" || parameter.argument.value.toLowerCase() !== "false";
}

/** -Depth implies -Recurse whatever its value; Get-ChildItem also aliases Recurse as -s. */
export function isPowerShellRecursionParameter(command: string, parameter: PowerShellTraversalParameter): boolean {
  if (isPowerShellParameterPrefix(parameter, "depth")) return true;
  const recurse = isPowerShellParameterPrefix(parameter, "recurse")
    || (command === "get-childitem" && parameter.name.toLowerCase() === "s");
  return recurse && isPowerShellSwitchEnabled(parameter);
}

/** True when this command element certainly walks a directory tree. */
export function isDefinitePowerShellRecursion(command: string, args: readonly PowerShellTraversalArgument[]): boolean {
  const leaf = commandLeaf(command);
  if (ARCHIVE_WALKERS.has(leaf)) return true;
  const native = NATIVE_RECURSE_SWITCHES.get(leaf);
  if (native !== undefined) return args.some((argument) => argument.kind === "literal" && native.test(argument.value));
  // The leaf also covers a module-qualified cmdlet name.
  return RECURSIVE_PARAMETER_COMMANDS.has(leaf)
    && args.some((argument) => argument.kind === "parameter" && isPowerShellRecursionParameter(leaf, argument));
}
