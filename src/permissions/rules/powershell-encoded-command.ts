// Encoded payloads in a shell input. Code passed as base64 (PowerShell's -EncodedCommand, `base64 -d | sh`, ...) is opaque to every other check,
// so the host treats it as hidden code: the permission manager applies the destructive floor (a forced modal, never an allow rule, no exact rule on
// the card), runs the floors on any decoded text, and shows it on the card. Three launcher-agnostic rules make an input hidden:
//
// 1. A UTF-16LE text payload. Every word the shell's lexer produces, at every depth (PowerShell: `powerShellWords`; bash: the rule shape's words),
//    and the raw input itself are searched for base64 runs. Whitespace anywhere inside a run is ignored (as .NET's FromBase64String does), so a
//    payload split across words or lines is still read. A run that decodes to UTF-16LE text (at least MIN_TEXT code units, mostly printable ASCII)
//    is hidden; its text is scanned again, recursively, and past the depth or byte bound the input is hidden too. Only UTF-16LE counts: ASCII text
//    in UTF-16LE has a zero high byte in every unit, which hashes, JWTs, UTF-8 data and commit messages essentially never produce, so ordinary
//    base64 data does not trip the scan.
// 2. An `-EncodedCommand`-family flag whose payload is not a decodable literal (missing, a concatenation, a variable, a subexpression, a splat, or
//    bytes that are not UTF-16LE text), after a PowerShell name (a basename starting with pwsh or powershell) or a dynamic program name, before
//    -Command/-File. The payload is not resolved: the code it runs cannot be read, and that is the reason. `node -e`, `grep -e` stay ordinary.
// 3. A pipeline stage that reads code from stdin: a shell or interpreter after `|` with no inline code or script option (`| sh`, `| bash -s`,
//    `| pwsh -`, `| python3 -`, `base64 -d | sh`), `| iex`, `xargs` into a shell, or `/dev/stdin` as a script. What the previous stage prints is
//    not visible as code, whatever its encoding.
//
// A code string a shell will run (`bash -c`, `sh -c`, `pwsh -Command`, `cmd /c`), including a value glued to its option (`--command=…`, `/c"…"`),
// is lexed in its own dialect and run through all three rules, within the same bounds. Every bound fails closed: an input over MAX_INPUT bytes is
// hidden without scanning, and exhausting the shared work budget, the recursion depth, or the decoded-byte bound makes the input hidden. A lex that
// fails or runs out of budget is hidden, never read as an empty command.
import type { ShellRuleDialect } from "../../shared/permissions-events.js";
import { powerShellWords, type WordStage } from "./powershell-exfiltration.js";
import { wrapperPrefixLength, type ShellCommandInput } from "./shell-prefix-policy.js";
import { INTERPRETER_SET, SHELL_SET, programName } from "./shell-prefix-values.js";
import { analyzeShellForRules } from "./shell-rule-matcher.js";

const ENCODED_PARAMETER_RE = /^(?:[-–—―]+|\/)(?:e|ec|en|enc|enco|encod|encode|encoded|encodedc|encodedco|encodedcom|encodedcomm|encodedcomma|encodedcomman|encodedcommand)(?::([\s\S]*))?$/i;
// A PowerShell name: a basename (any directory, `-Param:` prefix and .exe/.com/.cmd/.bat dropped) that starts with pwsh or powershell, so
// pwsh-preview, powershell_ise and full paths count.
function isPowerShellName(word: string): boolean {
  const value = word.replace(/^[-–—―/][^:]*:/, "");
  const base = (value.split(/[\\/]/).pop() ?? value).replace(/\.(?:exe|com|cmd|bat)$/i, "").toLowerCase();
  return base.startsWith("pwsh") || base.startsWith("powershell");
}
// The PowerShell parameters after which the rest of the line is a script and its arguments: -Command, -CommandWithArgs, -File, and prefixes.
const POWERSHELL_FILE_PARAMETER_RE = /^(?:[-–—―]+|\/)(?:f|fi|fil|file)(?::.*)?$/i;
const POWERSHELL_SCRIPT_PARAMETER_RE = /^(?:[-–—―]+|\/)(?:c|co|com|comm|comma|comman|command|commandwithargs|cwa|f|fi|fil|file)(?::.*)?$/i;
// PowerShell's call operators: the next word is the command.
const CALL_OPERATORS = new Set(["&", "."]);

// A base64 run, possibly broken by whitespace, not part of a longer word: a run touching `.`, `_` or `-` belongs to a name, a path or a base64url
// token (a JWT, a file name) rather than a payload.
const BASE64_RUN_RE = /(?<![A-Za-z0-9+/._-])[A-Za-z0-9+/]+(?:\s+[A-Za-z0-9+/]+)*={0,2}(?![A-Za-z0-9+/=._-])/g;

/** The fewest decoded text code units (tab, LF, CR and printable ASCII U+0020-U+007E) that count as text. Shorter decodes (`dGVzdA==` = "test") say too little to be code worth hiding. */
const MIN_TEXT = 8;
const PRINTABLE_SHARE = 0.9;
const MAX_DEPTH = 4;
const MAX_DECODED_CHARS = 65_536;
// A hard input cap: 16 KB covers any real interactive command (a decoded -EncodedCommand of that size is already ~12 KB of script), while bounding
// the work a single decision can cost. An input over the cap is hidden without being scanned at all.
const MAX_INPUT = 16_384;
// The characters the scan may lex and decode across the whole input, recursion and dedupe included. One shared budget keeps total work linear under
// the input cap; reaching it fails closed (hidden). 1 MB leaves ample headroom for a 16 KB input decoded and re-scanned to the depth bound.
const MAX_WORK_CHARS = 1_048_576;
// The base64 parts (whitespace-separated chunks) one run may join. .NET ignores the whitespace, so chunk sizes are arbitrary.
const MAX_RUN_PARTS = 256;
// The base64 runs tried at different start parts (a payload may follow a few stray base64 letters); bounded to keep the scan linear.
const MAX_RUN_STARTS = 8;
// The most decoded scripts kept for the card; the decision is already hidden, so this only bounds disclosure and the dedupe.
const MAX_SCRIPTS = 64;

export interface EncodedPowerShell {
  /** The decoded texts, in order (shown on the card, checked by the floors). */
  readonly scripts: string[];
  /** Encoded code is present, or the scan could not finish: see the module comment. */
  readonly hidden: boolean;
}

function isTextUnit(code: number): boolean {
  return (code >= 0x20 && code <= 0x7e) || code === 0x09 || code === 0x0a || code === 0x0d;
}

function isText(text: string): boolean {
  if (text.length < MIN_TEXT) return false;
  let printable = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (isTextUnit(text.charCodeAt(index))) printable += 1;
  }
  return printable >= MIN_TEXT && printable / text.length >= PRINTABLE_SHARE;
}

/** The UTF-16LE text a base64 run decodes to (as -EncodedCommand uses), or null. .NET's FromBase64String ignores whitespace and so does this;
 *  missing padding is accepted. */
function decodeBase64Text(raw: string): string | null {
  let encoded = raw.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return null;
  encoded = encoded.replace(/=+$/, "");
  if (encoded.length % 4 === 1) return null;
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length < MIN_TEXT * 2 || bytes.length % 2 !== 0) return null;
  const text = bytes.toString("utf16le").replace(/^﻿/, "");
  return isText(text) ? text : null;
}

// Interpreters whose code is always an operand, never stdin.
const OPERAND_CODE_INTERPRETERS = new Set(["awk", "gawk", "mawk", "nawk"]);
// Options that hand an interpreter its code inline, so stdin is data: `python -c`, `node -e`, `perl -e`, `php -r`.
const INLINE_CODE_OPTIONS: Readonly<Record<string, RegExp>> = {
  python: /^-[A-Za-z]*[cm]$/, python2: /^-[A-Za-z]*[cm]$/, python3: /^-[A-Za-z]*[cm]$/, pypy: /^-[A-Za-z]*[cm]$/, pypy3: /^-[A-Za-z]*[cm]$/,
  node: /^(?:-[ep]|--eval|--print)$/, nodejs: /^(?:-[ep]|--eval|--print)$/, bun: /^(?:-[ep]|--eval|--print)$/, tsx: /^(?:-[ep]|--eval|--print)$/,
  deno: /^eval$/, perl: /^-[A-Za-z]*[eE]$/, ruby: /^-[A-Za-z]*e$/, php: /^-[A-Za-z]*r$/, lua: /^-[A-Za-z]*e$/, luajit: /^-[A-Za-z]*e$/,
};
// POSIX shells: a short-option cluster with `c` (`-c`, `-ec`).
const SHELL_INLINE_CODE = /^-[A-Za-z]*c[A-Za-z]*$/;
const STDIN_PATH_RE = /^(?:\/dev\/stdin|\/dev\/fd\/0|\/proc\/self\/fd\/0)$/;
const POWERSHELL_EVAL = new Set(["iex", "invoke-expression"]);

// The launcher family of a program, by the same predicate rule 2 uses: a PowerShell name by basename prefix, then cmd, then a POSIX shell or an
// interpreter. One predicate, shared by the stdin rule and the code-string recursion, so `pwsh-preview` is not missed.
type LauncherKind = "powershell" | "cmd" | "posix";
function launcherKind(head: string): LauncherKind | null {
  if (isPowerShellName(head)) return "powershell";
  const program = programName(head);
  if (program === "cmd") return "cmd";
  if (SHELL_SET.has(program) || INTERPRETER_SET.has(program)) return "posix";
  return null;
}

// A value glued to its option, split into [option, value]: a long option's `=value` (`--command=…`, `-e=…`) or a short slash option's glued tail
// (`/c…`). One normalizer, so the code-string detection need not know each shell's spelling.
function splitGluedOption(text: string): [string, string] | null {
  const equals = /^(--?[A-Za-z][\w-]*)=([\s\S]*)$/.exec(text);
  if (equals) return [equals[1]!, equals[2]!];
  const slash = /^(\/[A-Za-z])([\s\S]+)$/.exec(text);
  if (slash) return [slash[1]!, slash[2]!];
  return null;
}

/** How a stage's program takes its code, read past wrappers and PowerShell's call operators: from stdin, from an inline code string (returned for
 *  a recursive scan when it is shell code), or neither. */
type StageCode = { kind: "stdin" } | { kind: "string"; code: string | null; dialect: ShellRuleDialect | null } | { kind: "none" };

function stageCode(stage: WordStage): StageCode {
  if (stage.words.some((word) => word.text !== null && STDIN_PATH_RE.test(word.text))) return { kind: "stdin" };
  let start = 0;
  while (start < stage.words.length && CALL_OPERATORS.has(stage.words[start]!.text ?? "")) start += 1;
  const words = stage.words.slice(start);
  const argv = words.map((word) => word.literal && word.text !== null ? word.text : undefined);
  // A dynamic program name is not read as a shell: what it is fed is left to the other checks, as on any command.
  if (argv.length === 0 || argv[0] === undefined) return { kind: "none" };
  const wrapped = wrapperPrefixLength(argv);
  const head = argv[wrapped];
  if (head === undefined) return { kind: "none" };
  const program = programName(head);
  if (POWERSHELL_EVAL.has(program.replace(/^microsoft\.powershell\.utility\\/, ""))) return { kind: "stdin" };
  const kind = launcherKind(head);
  if (kind === null) return { kind: "none" };
  if (OPERAND_CODE_INTERPRETERS.has(program)) return { kind: "none" };
  // `xargs sh -c` appends what it reads to the shell's arguments.
  if (argv.slice(0, wrapped).some((word) => word !== undefined && programName(word) === "xargs")) return { kind: "stdin" };
  const inline = kind === "powershell" ? POWERSHELL_SCRIPT_PARAMETER_RE
    : kind === "cmd" ? /^\/[ck]$/i
    : INLINE_CODE_OPTIONS[program] ?? (program === "fish" ? /^(?:-c|--command)$/ : SHELL_INLINE_CODE);
  // Normalize glued option values first, so `--command=code` and `/ccode` read as the option followed by its value.
  const args = words.slice(wrapped + 1).flatMap((word): WordStage["words"] => {
    if (!word.literal || word.text === null) return [word];
    const split = splitGluedOption(word.text);
    if (split === null) return [word];
    // An empty glued value (`--command=` with the code in the next token) leaves just the option, so that next token becomes its operand.
    return split[1] === "" ? [{ text: split[0], literal: true }] : [{ text: split[0], literal: true }, { text: split[1], literal: true }];
  });
  // cmd and PowerShell run the rest of the line as code; a POSIX shell runs the one operand.
  const wholeLine = kind === "cmd" || kind === "powershell";
  for (const [index, arg] of args.entries()) {
    // `--` ends the options for a POSIX shell: a `-c` after it is a positional argument.
    if (!wholeLine && arg.literal && arg.text === "--") break;
    if (!arg.literal || arg.text === null || !inline.test(arg.text)) continue;
    const next = args[index + 1];
    if (next === undefined || (next.literal && next.text === "-")) continue;
    if (POWERSHELL_FILE_PARAMETER_RE.test(arg.text) && kind === "powershell") return { kind: "string", code: null, dialect: null };
    // Non-literal words keep their source text, so a dynamic program in the child is still seen as one.
    const rest = wholeLine ? args.slice(index + 1) : [next];
    const code = rest.every((word) => word.text !== null) ? rest.map((word) => word.text).join(" ") : null;
    const dialect: ShellRuleDialect | null = SHELL_SET.has(program) || kind === "powershell" ? (wholeLine ? "powershell" : "bash") : null;
    return { kind: "string", code, dialect };
  }
  return { kind: "stdin" };
}

class Scanner {
  // Decoded texts in order; exact duplicates are kept out by `seen`.
  private readonly decoded: string[] = [];
  hidden = false;
  private decodedChars = 0;
  private work = 0;
  private readonly seen = new Set<string>();
  private readonly seenSources = new Set<string>();

  constructor(private readonly cwd: string | undefined) {}

  /** Charge the shared work budget; true once it is spent, after which the input is hidden and the scan stops. */
  private spend(chars: number): boolean {
    this.work += chars;
    if (this.work > MAX_WORK_CHARS) {
      this.hidden = true;
      return true;
    }
    return false;
  }

  scan(dialect: ShellRuleDialect, input: ShellCommandInput, depth: number): void {
    const text = typeof input === "string" ? input : input.command;
    if (depth > MAX_DEPTH) {
      this.hidden = true;
      return;
    }
    if (this.spend(text.length)) return;
    const words = dialect === "bash" ? bashWords(input, this.cwd) : powerShellWords(text);
    // A lexer that ran out of budget cannot be read as an empty command: an attacker could pad an input to make it bail, so fail closed. An input
    // that is simply not this dialect (a redirect, foreign syntax) is left to the other checks; the raw-text base64 scan below still runs on it.
    if (words === "budget") {
      this.hidden = true;
      return;
    }
    const sources = [text, ...(words?.texts ?? [])];
    for (const source of sources) {
      this.runs(source, depth);
      if (this.hidden && this.work > MAX_WORK_CHARS) return;
    }
    for (const stage of words?.stages ?? []) {
      this.encodedFlags(stage);
      const code = stageCode(stage);
      if (stage.piped && code.kind === "stdin") this.hidden = true;
      // A code string a shell will run gets the same rules, within the same bounds.
      if (code.kind === "string" && code.code !== null && code.dialect !== null) this.scan(code.dialect, code.code, depth + 1);
    }
  }

  /** Every base64 run of `source`, with its whitespace-separated parts joined (.NET's FromBase64String ignores the whitespace). The whole run is
   *  decoded once; the longest prefix that ends on a part boundary and decodes to text is the one kept, so a payload split into arbitrary chunks is
   *  read and a trailing non-payload part is left off. The work is linear in the run length — the hard input cap and the lexer budget are the only
   *  bounds that fail closed, so an ordinary long argument list is not mistaken for hidden code. */
  private runs(source: string, depth: number): void {
    if (this.seenSources.has(source)) return;
    this.seenSources.add(source);
    for (const match of source.matchAll(BASE64_RUN_RE)) {
      const parts = match[0].replace(/=+$/, "").split(/\s+/).filter((part) => part.length > 0).slice(0, MAX_RUN_PARTS);
      // A payload may begin a few parts into the run (a format specifier such as `%s` leaves a stray base64 letter before it). A bounded number of
      // starts keeps the work linear while still reading a payload that is not the first part; past that the payload is ordinary data (dangerous
      // only through a pipe, which rule 3 covers).
      for (let start = 0; start < parts.length && start < MAX_RUN_STARTS; start += 1) {
        let joined = "";
        const boundaries: number[] = [];
        for (let end = start; end < parts.length; end += 1) {
          joined += parts[end]!;
          boundaries.push(joined.length);
        }
        if (joined.length < MIN_TEXT) continue;
        if (this.spend(joined.length)) return;
        // Decode the run-from-start once, then read each part-boundary prefix off that single decode: a 4-aligned base64 prefix decodes to a prefix
        // of the bytes; the whole run (its length padded by .NET) is the final candidate.
        const units = Buffer.from(joined, "base64").toString("utf16le");
        const printable: number[] = [0];
        for (let index = 0; index < units.length; index += 1) printable.push(printable[index]! + (isTextUnit(units.charCodeAt(index)) ? 1 : 0));
        const bom = units.charCodeAt(0) === 0xfeff ? 1 : 0;
        let found: string | null = null;
        for (let boundary = 0; boundary < boundaries.length; boundary += 1) {
          const length = boundaries[boundary]!;
          const last = boundary === boundaries.length - 1;
          if (!last && length % 4 !== 0) continue;
          if (length % 4 === 1) continue;
          const count = last ? units.length : length / 4 * 3 / 2;
          if (!Number.isInteger(count) || count < MIN_TEXT) continue;
          const textLength = count - bom;
          const text = printable[count]! - printable[bom]!;
          if (textLength >= MIN_TEXT && text >= MIN_TEXT && text / textLength >= PRINTABLE_SHARE) found = units.slice(bom, count);
        }
        if (found !== null) {
          this.accept(found, depth);
          break;
        }
      }
    }
  }

  private accept(text: string, depth: number): void {
    if (this.seen.has(text)) return;
    this.seen.add(text);
    this.hidden = true;
    this.decodedChars += text.length;
    if (this.decodedChars > MAX_DECODED_CHARS) return; // already hidden: the text is not disclosed past the byte bound
    if (this.decoded.length < MAX_SCRIPTS) this.decoded.push(text);
    // Decoded text is read the same way: a payload inside a payload is a payload.
    this.scan("powershell", text, depth + 1);
  }

  /** The decoded texts to show. Exact duplicates are already gone; a bounded pass drops any that is wholly contained in a longer one (a mis-aligned
   *  sub-window of the same run). The list is capped at MAX_SCRIPTS, so this stays bounded work. */
  get scripts(): string[] {
    return this.decoded.filter((text, index) => !this.decoded.some((other, j) => j !== index && other.includes(text) && (other.length > text.length || j < index)));
  }

  /** An `-e*`-family flag among the parameters of a PowerShell name or of a dynamic program name (a non-literal word in the program position), in
   *  the same command or the same quoted word, whose payload is not a literal that decodes (rule 2 of the module comment). The parameters end at
   *  `-Command` or `-File`: what follows is the script and its arguments, read on its own if it names PowerShell again. */
  private encodedFlags(stage: WordStage): void {
    const parts = stage.words.flatMap(({ text, literal }): WordStage["words"] => {
      const split = (text ?? "").split(/\s+/).filter((part) => part.length > 0);
      return split.length === 0 ? [{ text: null, literal: false }] : split.map((part) => ({ text: part, literal }));
    });
    let program = 0;
    while (program < parts.length && CALL_OPERATORS.has(parts[program]!.text ?? "")) program += 1;
    // A dynamic program name, at the head or behind a wrapper (`env $p`, `sudo $p`), could be PowerShell.
    const wrapped = program + wrapperPrefixLength(parts.slice(program).map((part) => part.literal && part.text !== null ? part.text : undefined));
    let launcher = parts.slice(program, wrapped + 1).some((part) => !part.literal);
    for (const [index, part] of parts.entries()) {
      if (part.text === null) continue;
      if (isPowerShellName(part.text)) {
        launcher = true;
        continue;
      }
      if (!launcher) continue;
      if (POWERSHELL_SCRIPT_PARAMETER_RE.test(part.text)) {
        launcher = false;
        continue;
      }
      const flag = ENCODED_PARAMETER_RE.exec(part.text);
      if (flag === null) continue;
      const inline = flag[1];
      const operand = inline !== undefined ? { text: inline, literal: part.literal } : parts[index + 1];
      if (operand === undefined || operand.text === null || !operand.literal || decodeBase64Text(operand.text) === null) this.hidden = true;
    }
  }
}

function bashWords(input: ShellCommandInput, cwd: string | undefined): { texts: string[]; stages: WordStage[] } | null {
  const shape = analyzeShellForRules(input, cwd);
  if (!shape.ok) return null;
  const stages = shape.commands.map((command): WordStage => ({
    words: command.argv.map((word) => ({ text: word ?? null, literal: word !== undefined })),
    piped: command.piped === true,
  }));
  return { texts: shape.commands.flatMap((command) => command.argv.filter((word): word is string => word !== undefined)), stages };
}

export function inspectEncodedPowerShell(command: ShellCommandInput, dialect: ShellRuleDialect, cwd?: string): EncodedPowerShell {
  const text = typeof command === "string" ? command : command.command;
  // Over the hard input cap, fail closed without scanning: no real command is this long, and this bounds the work a decision can cost.
  if (text.length > MAX_INPUT) return { scripts: [], hidden: true };
  const scanner = new Scanner(cwd);
  scanner.scan(dialect, command, 0);
  return { scripts: scanner.scripts, hidden: scanner.hidden };
}
