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
  if (classifyArchiveTraversal(leaf, args) === "definite") return true;
  const native = NATIVE_RECURSE_SWITCHES.get(leaf);
  if (native !== undefined) return args.some((argument) => argument.kind === "literal" && native.test(argument.value));
  // The leaf also covers a module-qualified cmdlet name.
  return RECURSIVE_PARAMETER_COMMANDS.has(leaf)
    && args.some((argument) => argument.kind === "parameter" && isPowerShellRecursionParameter(leaf, argument));
}

// Archivers: only create/add/update reads an operand tree; list and extract do not walk the filesystem.
export type PowerShellArchiveTraversal = "definite" | "none" | "undecidable";

/** null when the command is not an archiver; "undecidable" when its mode or operand is not static. */
export function classifyPowerShellArchiveTraversal(command: string, args: readonly PowerShellTraversalArgument[]): PowerShellArchiveTraversal | null {
  return classifyArchiveTraversal(commandLeaf(command), args);
}

function classifyArchiveTraversal(leaf: string, args: readonly PowerShellTraversalArgument[]): PowerShellArchiveTraversal | null {
  switch (leaf) {
    case "tar": return tarTraversal(args);
    case "7z": case "7za": case "7zr": return sevenZipTraversal(args);
    case "zip": return zipTraversal(args);
    case "compress-archive": return compressArchiveTraversal(args);
    case "unzip": case "expand-archive": return "none";
    default: return null;
  }
}

// Native argv text; null when dynamic. A parameter's colon value does not change its option letters.
function nativeWord(argument: PowerShellTraversalArgument): string | null {
  if (argument.kind === "parameter") return `-${argument.name}`;
  return argument.kind === "literal" ? argument.value : null;
}

const TAR_CREATE_LETTERS = "cru";
const TAR_OTHER_MODE_LETTERS = "txAd";
// Short options that take a value end a bundle (`-fc` names the file c).
const TAR_VALUE_LETTERS = "bCfFgHIKLNTVX";
const TAR_CREATE_LONG = ["create", "append", "update"];
const TAR_OTHER_LONG = ["list", "extract", "get", "diff", "compare", "delete", "catenate", "concatenate"];

function tarBundleMode(letters: string): PowerShellArchiveTraversal | null {
  for (const letter of letters) {
    if (TAR_CREATE_LETTERS.includes(letter)) return "definite";
    if (TAR_OTHER_MODE_LETTERS.includes(letter)) return "none";
    if (TAR_VALUE_LETTERS.includes(letter)) return null;
  }
  return null;
}

// tar rejects two modes, so the first static mode decides; without one, any dynamic word may carry it.
function tarTraversal(args: readonly PowerShellTraversalArgument[]): PowerShellArchiveTraversal {
  let dynamic = false;
  for (const [index, argument] of args.entries()) {
    const word = nativeWord(argument);
    if (word === null) { dynamic = true; continue; }
    let mode: PowerShellArchiveTraversal | null = null;
    if (word.startsWith("--")) {
      const name = word.slice(2).split("=")[0]!.toLowerCase();
      if (name.length >= 3 && TAR_CREATE_LONG.some((option) => option.startsWith(name))) mode = "definite";
      else if (name.length >= 3 && TAR_OTHER_LONG.some((option) => option.startsWith(name))) mode = "none";
    } else if (word.startsWith("-")) mode = tarBundleMode(word.slice(1));
    else if (index === 0) mode = tarBundleMode(word);
    if (mode !== null) return mode;
  }
  return dynamic ? "undecidable" : "none";
}

// 7z <command> [switches] <archive> [paths]: a and u read operand trees.
function sevenZipTraversal(args: readonly PowerShellTraversalArgument[]): PowerShellArchiveTraversal {
  for (const argument of args) {
    const word = nativeWord(argument);
    if (word === null) return "undecidable";
    if (word.startsWith("-")) continue;
    return /^[au]$/i.test(word) ? "definite" : "none";
  }
  return "none";
}

function zipTraversal(args: readonly PowerShellTraversalArgument[]): PowerShellArchiveTraversal {
  let dynamic = false;
  for (const argument of args) {
    const word = nativeWord(argument);
    if (word === null) { dynamic = true; continue; }
    if (/^-[0-9A-Za-z]*[rR][0-9A-Za-z]*$/.test(word) || /^--recurse-pat(?:hs|terns)$/i.test(word)) return "definite";
  }
  return dynamic ? "undecidable" : "none";
}

const COMPRESS_ARCHIVE_SWITCHES = ["update", "force", "passthru", "whatif", "confirm", "verbose", "debug"];

function compressArchivePathKind(name: string): "path" | "literal" | "value" | "switch" {
  const spelled = name.toLowerCase();
  if (spelled.length >= 3 && "path".startsWith(spelled)) return "path";
  if ("literalpath".startsWith(spelled) || spelled === "pspath" || spelled === "lp") return "literal";
  if (spelled.length >= 3 && "destinationpath".startsWith(spelled)) return "value";
  if (spelled.length >= 2 && "compressionlevel".startsWith(spelled)) return "value";
  return COMPRESS_ARCHIVE_SWITCHES.some((option) => option.startsWith(spelled)) ? "switch" : "value";
}

// A wildcard -Path, or a path shaped as a directory, walks a tree. Any other literal may be a file or a directory.
function compressArchiveTraversal(args: readonly PowerShellTraversalArgument[]): PowerShellArchiveTraversal {
  const paths: Array<{ value: PowerShellTraversalValue | undefined; wildcards: boolean }> = [];
  const positional: PowerShellTraversalValue[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument.kind !== "parameter") { positional.push(argument); continue; }
    const kind = compressArchivePathKind(argument.name);
    if (kind === "switch") continue;
    let value = argument.argument;
    if (value === undefined && args[index + 1] !== undefined && args[index + 1]!.kind !== "parameter") {
      value = args[++index] as PowerShellTraversalValue;
    }
    if (kind === "path" || kind === "literal") paths.push({ value, wildcards: kind === "path" });
  }
  // The first positional value binds -Path only when no path was named.
  if (paths.length === 0 && positional[0] !== undefined) paths.push({ value: positional[0], wildcards: true });
  if (paths.some(({ value, wildcards }) => value?.kind === "literal" && !value.value.includes(",")
    && ((wildcards && /[*?[]/.test(value.value)) || /^\.{1,2}$|[\\/]$/.test(value.value)))) return "definite";
  return "undecidable";
}
