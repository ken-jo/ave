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
  "copy-item", "get-childitem", "remove-item",
]);
// Slash switches may be bundled (/s/m, /si); any piece carrying a recursion letter counts, whatever its other letters.
// A colon starts the option's value, which may itself hold slashes (/exclude:C:/x.txt, /c:a/s), so scanning stops there.
function slashSwitchRecurses(word: string, prefixes: string, letters: RegExp, named: readonly string[]): boolean {
  if (!prefixes.includes(word[0] ?? "")) return false;
  for (const piece of word.slice(1).split("/")) {
    const colon = piece.indexOf(":");
    const option = (colon === -1 ? piece : piece.slice(0, colon)).replace(/^-/, "").toLowerCase();
    if (!named.includes(option) && letters.test(option)) return true;
    if (colon !== -1) return false;
  }
  return false;
}

// Named switches from `xcopy /?` and `findstr /?` that are not letter bundles.
const XCOPY_NAMED = ["exclude", "compress", "sparse", "noclone"];
const FINDSTR_NAMED = ["off", "offline"];
const NATIVE_RECURSE_SWITCHES: ReadonlyMap<string, (word: string) => boolean> = new Map([
  ["robocopy", (word: string) => /^[-/](?:s|e|mir)$/i.test(word)],
  ["xcopy", (word: string) => slashSwitchRecurses(word, "/", /[set]/, XCOPY_NAMED)],
  ["findstr", (word: string) => slashSwitchRecurses(word, "/-", /s/, FINDSTR_NAMED)],
]);

/**
 * robocopy, xcopy and findstr take recursion as a switch, so a dynamic argument may carry one, and so may the verbatim
 * text after `--%`, which also expands %VAR% at run time.
 */
export function mayCarryNativeRecursionSwitch(command: string, args: readonly PowerShellTraversalArgument[]): boolean {
  if (!NATIVE_RECURSE_SWITCHES.has(commandLeaf(command))) return false;
  return args.some((argument) => argument.kind === "dynamic"
    || (argument.kind === "parameter" && argument.argument?.kind === "dynamic")
    || isStopParsing(argument));
}

function isStopParsing(argument: PowerShellTraversalArgument): boolean {
  return argument.kind === "literal" && /^[-\u2013\u2014\u2015]{2}%/.test(argument.value);
}

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
  if (!RECURSIVE_PARAMETER_COMMANDS.has(command)) return false;
  if (command === "get-childitem" && isPowerShellParameterPrefix(parameter, "depth")) return true;
  const recurse = isPowerShellParameterPrefix(parameter, "recurse")
    || (command === "get-childitem" && parameter.name.toLowerCase() === "s");
  return recurse && isPowerShellSwitchEnabled(parameter);
}

/** True when this command element certainly walks a directory tree. */
export function isDefinitePowerShellRecursion(command: string, args: readonly PowerShellTraversalArgument[]): boolean {
  const leaf = commandLeaf(command);
  if (classifyArchiveTraversal(leaf, args) === "definite") return true;
  const native = NATIVE_RECURSE_SWITCHES.get(leaf);
  if (native !== undefined) {
    // Text after `--%` is passed verbatim and may expand %VAR%, so it is undecidable rather than definite.
    const stop = args.findIndex(isStopParsing);
    return (stop === -1 ? args : args.slice(0, stop)).some((argument) => {
      const word = nativeWord(argument);
      return word !== null && native(word);
    });
  }
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
  if (argument.kind === "parameter") return `-${argument.name}${argument.argument === undefined ? "" : ":"}`;
  return argument.kind === "literal" ? argument.value : null;
}

const TAR_CREATE_LETTERS = "cru";
const TAR_OTHER_MODE_LETTERS = "txAd";
// Short options that take a value end a bundle (`-fc` names the file c).
const TAR_VALUE_LETTERS = "bCfFgHIKLNTVX";
const TAR_CREATE_LONG = ["create", "append", "update"];
const TAR_OTHER_LONG = ["list", "extract", "get", "diff", "compare", "delete", "catenate", "concatenate"];
const TAR_LONG_OPTIONS = (`
absolute-names acls add-file after-date anchored append atime-preserve auto-compress
backup block-number blocking-factor catenate check-device check-links checkpoint checkpoint-action
clamp-mtime compare compress concatenate confirmation create delay-directory-restore delete dereference
diff directory exclude exclude-backups exclude-caches exclude-caches-all exclude-caches-under exclude-from
exclude-ignore exclude-ignore-recursive exclude-tag exclude-tag-all exclude-tag-under exclude-vcs exclude-vcs-ignores
extract file files-from force-local format full-time get gnu group group-map gunzip gzip hard-dereference
help hole-detection ignore-case ignore-command-error ignore-failed-read ignore-zeros incremental index-file info-script
interactive keep-directory-symlink keep-newer-files keep-old-files label level list listed-incremental lzip lzma lzop
mode mtime multi-volume new-volume-script newer newer-mtime no-acls no-anchored no-auto-compress no-check-device
no-delay-directory-restore no-ignore-case no-ignore-command-error no-null no-overwrite-dir no-quote-chars no-recursion
no-same-owner no-same-permissions no-seek no-selinux no-unquote no-verbatim-files-from no-wildcards
no-wildcards-match-slash no-xattrs none null numeric-owner occurrence old-archive oldgnu one-file-system one-top-level
overwrite overwrite-dir owner owner-map pax pax-option portability posix preserve-order preserve-permissions
quote-chars quoting-style raw read-full-records record-size recursion recursive-unlink remove-files replace restrict
rmt-command rsh-command same-order same-owner same-permissions seek selinux show-defaults show-omitted-dirs
show-snapshot-field-ranges show-stored-names show-transformed-names skip-old-files sort sparse sparse-version star
starting-file strip-components suffix tape-length test-label to-command to-stdout totals touch transform uncompress
ungzip unlink-first unquote update usage use-compress-program ustar utc verbose verbatim-files-from verify version volno-file
warning wildcards wildcards-match-slash xattrs xattrs-exclude xattrs-include xform xz zstd
`).trim().split(/\s+/);

function tarBundleMode(letters: string): PowerShellArchiveTraversal | null {
  for (const letter of letters) {
    if (TAR_CREATE_LETTERS.includes(letter)) return "definite";
    if (TAR_OTHER_MODE_LETTERS.includes(letter)) return "none";
    if (TAR_VALUE_LETTERS.includes(letter)) return null;
  }
  return null;
}

// Long options whose value may be the next word (`--file -t` names an archive `-t`).
const TAR_LONG_VALUE_OPTIONS = [
  "add-file", "after-date", "blocking-factor", "checkpoint-action", "directory", "exclude", "exclude-from", "exclude-ignore",
  "exclude-ignore-recursive", "exclude-tag", "exclude-tag-all", "exclude-tag-under", "file", "files-from", "format", "group",
  "group-map", "hole-detection", "index-file", "info-script", "label", "level", "listed-incremental", "mode", "mtime",
  "new-volume-script", "newer", "newer-mtime", "no-quote-chars", "owner", "owner-map", "pax-option", "quote-chars",
  "quoting-style", "record-size", "rmt-command", "rsh-command", "sort", "sparse-version", "starting-file", "strip-components",
  "suffix", "tape-length", "to-command", "transform", "use-compress-program", "volno-file", "warning", "xattrs-exclude",
  "xattrs-include", "xform",
];

// tar rejects two modes, so the first static mode decides; without one, any dynamic word may carry it.
// A word that may be an option's value is not read as a mode unless it creates (failing closed).
function tarTraversal(args: readonly PowerShellTraversalArgument[]): PowerShellArchiveTraversal {
  let dynamic = false;
  let value: "none" | "known" | "maybe" = "none";
  for (const [index, argument] of args.entries()) {
    const word = nativeWord(argument);
    const previous = value;
    value = "none";
    if (word === null) { dynamic = true; continue; }
    if (previous === "known") continue;
    let mode: PowerShellArchiveTraversal | null = null;
    if (word.startsWith("--")) {
      const [spelled, inline] = [word.slice(2).split("=")[0]!.toLowerCase(), word.includes("=")];
      const matches = TAR_LONG_OPTIONS.includes(spelled) ? [spelled] : TAR_LONG_OPTIONS.filter(option => option.startsWith(spelled));
      // An unknown or ambiguous name (Windows tar is bsdtar) may carry the mode or take the next word as its value.
      if (spelled.length === 0 || matches.length !== 1) { dynamic = true; value = inline ? "none" : "maybe"; continue; }
      if (TAR_CREATE_LONG.includes(matches[0]!)) mode = "definite";
      else if (TAR_OTHER_LONG.includes(matches[0]!)) mode = "none";
      else if (!inline && TAR_LONG_VALUE_OPTIONS.includes(matches[0]!)) value = "known";
    } else if (word.startsWith("-") && word.length > 1) {
      mode = tarBundleMode(word.slice(1));
      if (mode === null && TAR_VALUE_LETTERS.includes(word.at(-1)!)) value = "known";
    } else if (index === 0) mode = tarBundleMode(word);
    if (mode === "none" && previous === "maybe") { dynamic = true; continue; }
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
    if (/^[au]$/i.test(word)) return "definite";
    return /^[lxet]$/i.test(word) ? "none" : "undecidable";
  }
  return "undecidable";
}

function zipTraversal(args: readonly PowerShellTraversalArgument[]): PowerShellArchiveTraversal {
  let dynamic = false;
  for (const argument of args) {
    const word = nativeWord(argument);
    if (word === null) { dynamic = true; continue; }
    if (/^-[0-9A-Za-z]*[rR][0-9A-Za-z]*(?::.*)?$/.test(word) || /^--recurse-pat(?:hs|terns)$/i.test(word)) return "definite";
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
