// The scripts a shell input hands to PowerShell as `-EncodedCommand` (UTF-16LE base64). The text is otherwise opaque, so the host decodes it to run
// the destructive and credential floors on what will actually execute, to refuse an allow rule for it, and to show the person the decoded command.
//
// It reads the argv each shell's own lexer produced (`powerShellLaunchArgv` for PowerShell, the bash rule shape for bash): the same unescaped view
// of the command the rule matcher uses, so an escape, quote or dash spelling the lexer resolves cannot hide a parameter from this reader alone.
// Every launcher is followed (`launcherKind`): each PowerShell vocabulary entry with a `launcher` effect and the bash side's shells, wrappers and
// runners has its trailing argv re-read as a command, recursively, with its own option grammar where it has one (pwsh, cmd, wsl, POSIX shells).
// It fails closed: a launched shell whose argv is not fully literal (a variable, splat, subexpression, backtick or caret escape), a launcher option
// or command it cannot place, input the lexer cannot read, an encoded payload it cannot fully decode, or an encoded-looking word after
// `-Command`/`-File`, is `hidden` code: the permission manager treats it as a destructive floor (a forced modal, never an allow rule).
import type { ShellRuleDialect } from "../../shared/permissions-events.js";
import { powerShellLaunchArgv } from "./powershell-exfiltration.js";
import { analyzeShellForRules } from "./shell-rule-matcher.js";
import { POWERSHELL_COMMAND_POLICIES } from "./powershell-command-policy.js";
import { RUNNER_SET, SHELL_SET, WRAPPER_SET } from "./shell-prefix-values.js";
import type { ShellCommandInput } from "./shell-prefix-policy.js";

// `-EncodedCommand` and every prefix PowerShell accepts for it (`-e`, `-ec`, `-enc`, ...), behind any dash PowerShell's parser accepts as a parameter
// prefix (hyphen-minus, en dash, em dash, horizontal bar) or `/`, with an optional `:value`.
const ENCODED_PARAMETER_RE = /^[-\u2013\u2014\u2015/](?:e|ec|en|enc|enco|encod|encode|encoded|encodedc|encodedco|encodedcom|encodedcomm|encodedcomma|encodedcomman|encodedcommand)(?::([\s\S]*))?$/i;
// `-Command` / `-c` and `-CommandWithArgs` / `-cwa`: the rest is a script. `-File` / `-f`: the rest is a script path and its arguments.
const COMMAND_PARAMETER_RE = /^[-\u2013\u2014\u2015/](?:c|command|cwa|commandwithargs)(?::([\s\S]*))?$/i;
const FILE_PARAMETER_RE = /^[-\u2013\u2014\u2015/](?:f|file)(?::[\s\S]*)?$/i;
// A launched shell named anywhere in unreadable input.
const MENTIONS_LAUNCHER_RE = /(?:^|[^A-Za-z0-9_-])(?:pwsh|powershell|cmd|bash|sh|zsh|dash|ksh)(?:\.exe)?(?![A-Za-z0-9_-])/i;

// Every program that runs another command: each PowerShell vocabulary entry with a `launcher` effect (its aliases included), and the bash side's
// shells, wrappers and package runners. A launcher's trailing argv is re-read as a command, recursively (`launcherKind`).
const LAUNCHER_NAMES: ReadonlySet<string> = new Set([
  ...Object.entries(POWERSHELL_COMMAND_POLICIES)
    .filter(([, policy]) => policy.effects.includes("launcher"))
    .flatMap(([name, policy]) => [name, programOf(name), ...policy.aliases.map((alias) => alias.toLowerCase())]),
  ...SHELL_SET, ...WRAPPER_SET, ...RUNNER_SET,
  // Windows launchers outside the PowerShell vocabulary; each takes its command as a quoted command-line argument, which `generic` reads.
  "runas",
]);
const POSIX_SHELLS = new Set([...SHELL_SET].filter((name) => !["pwsh", "powershell", "cmd", "busybox"].includes(name)));

type LauncherKind = "powershell" | "cmd" | "wsl" | "posix" | "generic";

/** How the reader follows a launcher to the command it runs, or null for a program that runs none. Exported for the coverage test. */
export function launcherKind(program: string): LauncherKind | null {
  if (program === "pwsh" || program === "powershell") return "powershell";
  if (program === "cmd") return "cmd";
  if (program === "wsl") return "wsl";
  if (POSIX_SHELLS.has(program)) return "posix";
  return LAUNCHER_NAMES.has(program) ? "generic" : null;
}

// cmd.exe switches: `/c`, `/r` (its synonym) and `/k` start the command line, also glued to it (`/cpwsh ...`); the others take no command.
const CMD_RUN_RE = /^\/[ckr]/i;
const CMD_SWITCH_RE = /^\/(?:s|q|d|a|u|(?:t|e|f|v):\S*)$/i;
// wsl.exe: options that take a value, options that run no command, and the ones that start the command (`-e`/`--exec` an argv, `--` a command line).
const WSL_VALUE_OPTIONS = new Set(["-d", "--distribution", "--distribution-id", "-u", "--user", "--cd", "--shell-type"]);
const WSL_FLAG_OPTIONS = new Set(["--system"]);
const WSL_NO_COMMAND = new Set(["-l", "--list", "--status", "--shutdown", "--update", "--version", "-v", "--help", "--install", "-s", "--set-default",
  "--set-version", "--set-default-version", "-t", "--terminate", "--unregister", "--export", "--import", "--import-in-place", "--mount", "--unmount", "--manage"]);

const MAX_PAYLOADS = 8;
const MAX_DEPTH = 4;

export interface EncodedPowerShell {
  /** The decoded scripts, in order. */
  readonly scripts: string[];
  /** Code the host could not fully read inside a launched shell; see the module comment. */
  readonly hidden: boolean;
}

function decodePayload(raw: string): string | null {
  // .NET's FromBase64String ignores whitespace, line breaks included; so does this.
  const encoded = raw.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) return null;
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length === 0 || bytes.length % 2 !== 0) return null;
  const text = bytes.toString("utf16le").replace(/^\uFEFF/, "");
  // Anything but printable text and ordinary whitespace is not a script the card could show.
  return /^[^\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFD]*$/.test(text) ? text : null;
}

/** The program a command word names: the path, trailing dots (Win32 strips them) and an executable extension dropped, lower-cased. */
function programOf(word: string): string {
  const base = word.slice(Math.max(word.lastIndexOf("\\"), word.lastIndexOf("/")) + 1).replace(/\.+$/, "");
  return base.replace(/\.(?:exe|com|cmd|bat)$/i, "").toLowerCase();
}

type Argv = readonly (string | null)[];

// A word that held quoting, spacing or shell syntax before its shell's lexer took it apart: joining such words back with spaces would not give the
// command line the inner shell receives.
const REJOIN_UNSAFE_RE = /[\s;&|<>(){}$`'"^%!*?[\]~#]/;

class Reader {
  readonly scripts: string[] = [];
  hidden = false;

  constructor(private readonly cwd: string | undefined) {}

  text(dialect: ShellRuleDialect, input: ShellCommandInput, depth: number): void {
    const text = typeof input === "string" ? input : input.command;
    if (depth > MAX_DEPTH) {
      if (MENTIONS_LAUNCHER_RE.test(text)) this.hidden = true;
      return;
    }
    // The bash shape is the one the matcher and floors already computed for this input (same parse, same cwd).
    const commands = dialect === "bash" ? bashArgv(input, this.cwd) : powerShellLaunchArgv(text);
    if (commands === null) {
      if (MENTIONS_LAUNCHER_RE.test(text)) this.hidden = true;
      return;
    }
    for (const argv of commands) this.command(dialect, argv, depth);
  }

  /** `scanned`: the argv was found inside another launcher's arguments, so its tail may hold that launcher's own parameters. */
  /** Read the command line made of `words`. One word is read as it is; several are joined only when each is plain, since a word that held quoting
   *  or spacing (`bash -c "pwsh -enc ..."`) cannot be put back as the inner shell sees it, and that code is hidden. */
  private line(dialect: ShellRuleDialect, words: readonly string[], depth: number): void {
    if (words.length === 0) return;
    if (words.length === 1) return this.text(dialect, words[0]!, depth);
    if (words.some((word) => REJOIN_UNSAFE_RE.test(word))) {
      this.hidden = true;
      return;
    }
    this.text(dialect, words.join(" "), depth);
  }

  private command(dialect: ShellRuleDialect, argv: Argv, depth: number, scanned = false): void {
    const head = argv[0];
    if (typeof head !== "string") return;
    const kind = launcherKind(programOf(head));
    if (kind === null) return;
    // A chain of launchers is followed only so deep.
    if (depth > MAX_DEPTH) {
      this.hidden = true;
      return;
    }
    if (kind === "generic") return this.generic(dialect, programOf(head), argv.slice(1), depth, scanned);
    // What a shell runs must be fixed before it starts.
    if (argv.includes(null)) {
      this.hidden = true;
      return;
    }
    const args = argv.slice(1) as string[];
    switch (kind) {
      case "powershell": return this.powershell(args, depth);
      case "posix": return this.posix(args, depth);
      case "cmd": return this.cmd(args, depth);
      case "wsl": return this.wsl(args, depth);
    }
  }

  /** A launcher with no modeled grammar: the first argument that names a launcher starts the command it runs, and is read with its own grammar; an
   *  argument holding a whole command line (`-ArgumentList 'pwsh -enc ...'`, `/tr "..."`) is read as one. With no launcher named, a command wrapper
   *  runs its first plain argument (after options, `NAME=value` settings and numbers): one the host cannot read (`sudo $cmd`, `timeout 30 $cmd`) is
   *  hidden. */
  private generic(dialect: ShellRuleDialect, program: string, args: Argv, depth: number, scanned: boolean): void {
    for (const arg of args) {
      if (arg !== null && /\s/.test(arg)) this.embedded(dialect, arg, depth);
    }
    const inner = args.findIndex((arg) => arg !== null && launcherKind(programOf(arg)) !== null);
    if (inner !== -1) {
      this.command(dialect, args.slice(inner), depth + 1, true);
      return;
    }
    // Only a command wrapper's first plain argument is the command it runs; a code launcher's (`iex`, an interpreter, a package runner) is code,
    // which keeps the opaque-code asks of the floor inspection.
    if (scanned || !WRAPPER_SET.has(program)) return;
    const first = args.find((arg) => arg === null || !(/^[-/]/.test(arg) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(arg) || /^\d+(?:\.\d+)?[smhd]?$/.test(arg)));
    if (first === null) this.hidden = true;
  }

  /** An argument holding a command line: read it, and treat an encoded-command word in it as hidden (it is a launch the host cannot place). */
  private embedded(dialect: ShellRuleDialect, arg: string, depth: number): void {
    if (arg.split(/\s+/).some((word) => ENCODED_PARAMETER_RE.test(word))) this.hidden = true;
    this.text(dialect, arg, depth + 1);
  }

  private powershell(args: readonly string[], depth: number): void {
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index]!;
      const encoded = ENCODED_PARAMETER_RE.exec(arg);
      if (encoded !== null) {
        const payload = encoded[1] ?? args[index + 1];
        if (encoded[1] === undefined) index += 1;
        const script = payload === undefined || this.scripts.length >= MAX_PAYLOADS ? null : decodePayload(payload);
        if (script === null) this.hidden = true;
        else this.scripts.push(script);
        continue;
      }
      const command = COMMAND_PARAMETER_RE.exec(arg);
      if (command !== null || FILE_PARAMETER_RE.test(arg)) {
        const rest = args.slice(index + 1);
        // An encoded-looking word after the script starts is either the script's argument or a parameter the host misplaced: it cannot tell.
        if (rest.some((word) => ENCODED_PARAMETER_RE.test(word))) this.hidden = true;
        if (command !== null) this.line("powershell", command[1] === undefined || command[1] === "" ? rest : [command[1], ...rest], depth + 1);
        return;
      }
      if (/\s/.test(arg)) this.embedded("powershell", arg, depth);
    }
  }

  private posix(args: readonly string[], depth: number): void {
    // `-c <script>`, the flag possibly combined (`-lc`, `-ec`).
    const flag = args.findIndex((arg) => /^-[A-Za-z]*c[A-Za-z]*$/.test(arg));
    if (flag === -1) return;
    const script = args[flag + 1];
    if (script !== undefined) this.text("bash", script, depth + 1);
  }

  private cmd(args: readonly string[], depth: number): void {
    // cmd's own escapes and expansions (`^`, `%VAR%`, `!VAR!`) change the line before it runs.
    if (args.some((arg) => /[\^%!]/.test(arg))) {
      this.hidden = true;
      return;
    }
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index]!;
      if (CMD_RUN_RE.test(arg) && !CMD_SWITCH_RE.test(arg)) {
        const glued = arg.slice(2);
        this.line("powershell", [...(glued.length > 0 ? [glued] : []), ...args.slice(index + 1)], depth + 1);
        return;
      }
      // An unknown switch, or an argument before /c, /r or /k: the host cannot tell what cmd runs.
      if (!CMD_SWITCH_RE.test(arg)) {
        this.hidden = true;
        return;
      }
    }
  }

  private wsl(args: readonly string[], depth: number): void {
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index]!;
      const option = arg.toLowerCase();
      if (option === "-e" || option === "--exec") {
        this.command("bash", args.slice(index + 1), depth + 1);
        return;
      }
      if (option === "--") {
        this.line("bash", args.slice(index + 1), depth + 1);
        return;
      }
      if (WSL_VALUE_OPTIONS.has(option)) { index += 1; continue; }
      if (WSL_FLAG_OPTIONS.has(option)) continue;
      // A leading `~` starts in the home directory, as `--cd ~` does.
      if (arg === "~") continue;
      if (WSL_NO_COMMAND.has(option)) return;
      if (arg.startsWith("-")) {
        this.hidden = true;
        return;
      }
      // The first plain argument starts the command line wsl hands to the distribution's shell.
      this.line("bash", args.slice(index), depth + 1);
      return;
    }
  }
}

function bashArgv(input: ShellCommandInput, cwd: string | undefined): Argv[] | null {
  const shape = analyzeShellForRules(input, cwd);
  if (!shape.ok) return null;
  return shape.commands.map((command) => command.argv.map((word) => word ?? null));
}

export function inspectEncodedPowerShell(command: ShellCommandInput, dialect: ShellRuleDialect, cwd?: string): EncodedPowerShell {
  const reader = new Reader(cwd);
  reader.text(dialect, command, 0);
  return { scripts: reader.scripts, hidden: reader.hidden };
}
