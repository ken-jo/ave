// The scripts a shell input hands to PowerShell as `-EncodedCommand` (UTF-16LE base64). The text is otherwise opaque, so the host decodes it to run
// the destructive and credential floors on what will actually execute, to refuse an allow rule for it, and to show the person the decoded command.
//
// It reads the argv each shell's own lexer produced (`powerShellLaunchArgv` for PowerShell, the bash rule shape for bash): the same unescaped view
// of the command the rule matcher uses, so an escape, quote or dash spelling the lexer resolves cannot hide a parameter from this reader alone.
// It fails closed: a launched shell (`pwsh`, `powershell`, `cmd`, `bash`, `sh`, ...) whose argv is not fully literal (a variable, splat,
// subexpression, backtick or caret escape), input the lexer cannot read, an encoded payload it cannot fully decode, or an encoded-looking word
// after `-Command`/`-File`, is `hidden` code: the permission manager treats it as a destructive floor (a forced modal, never an allow rule).
import type { ShellRuleDialect } from "../../shared/permissions-events.js";
import { powerShellLaunchArgv } from "./powershell-exfiltration.js";
import { analyzeShellForRules } from "./shell-rule-matcher.js";
import type { ShellCommandInput } from "./shell-prefix-policy.js";

// `-EncodedCommand` and every prefix PowerShell accepts for it (`-e`, `-ec`, `-enc`, ...), behind any dash PowerShell's parser accepts as a parameter
// prefix (hyphen-minus, en dash, em dash, horizontal bar) or `/`, with an optional `:value`.
const ENCODED_PARAMETER_RE = /^[-\u2013\u2014\u2015/](?:e|ec|en|enc|enco|encod|encode|encoded|encodedc|encodedco|encodedcom|encodedcomm|encodedcomma|encodedcomman|encodedcommand)(?::([\s\S]*))?$/i;
// `-Command` / `-c` and `-CommandWithArgs` / `-cwa`: the rest is a script. `-File` / `-f`: the rest is a script path and its arguments.
const COMMAND_PARAMETER_RE = /^[-\u2013\u2014\u2015/](?:c|command|cwa|commandwithargs)(?::([\s\S]*))?$/i;
const FILE_PARAMETER_RE = /^[-\u2013\u2014\u2015/](?:f|file)(?::[\s\S]*)?$/i;
// A launched shell named anywhere in unreadable input.
const MENTIONS_LAUNCHER_RE = /(?:^|[^A-Za-z0-9_-])(?:pwsh|powershell|cmd|bash|sh|zsh|dash|ksh)(?:\.exe)?(?![A-Za-z0-9_-])/i;

const POWERSHELL_LAUNCHERS = new Set(["pwsh", "powershell"]);
const POSIX_LAUNCHERS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);

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
    for (const argv of commands) this.command(argv, depth);
  }

  private command(argv: Argv, depth: number): void {
    const head = argv[0];
    if (typeof head !== "string") return;
    const program = programOf(head);
    const powershell = POWERSHELL_LAUNCHERS.has(program);
    const posix = POSIX_LAUNCHERS.has(program);
    const cmd = program === "cmd";
    if (!powershell && !posix && !cmd) return;
    // What a launched shell runs must be fixed before it starts.
    if (argv.includes(null)) {
      this.hidden = true;
      return;
    }
    const args = argv.slice(1) as string[];
    if (powershell) this.powershell(args, depth);
    else if (posix) this.posix(args, depth);
    else this.cmd(args, depth);
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
        if (command !== null) this.text("powershell", [command[1] ?? "", ...rest].join(" ").trim(), depth + 1);
        return;
      }
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
    const run = args.findIndex((arg) => /^\/[ck]$/i.test(arg));
    if (run === -1) return;
    this.text("powershell", args.slice(run + 1).join(" "), depth + 1);
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
