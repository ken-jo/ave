// Encoded payloads in a shell input. Code passed as base64 (PowerShell's -EncodedCommand, `base64 -d | sh`, ...) is opaque to every other check,
// so the host treats it as hidden code: the permission manager applies the destructive floor (a forced modal, never an allow rule, no exact rule on
// the card), runs the floors on any decoded text, and shows it on the card. Three launcher-agnostic rules make an input hidden:
//
// 1. A UTF-16LE text payload. Every word the shell's lexer produces, at every depth (PowerShell: `powerShellWords`; bash: the rule shape's words),
//    and the raw input itself are searched for base64 runs (whitespace inside a run allowed, so a payload split across words or lines is still read).
//    A run that decodes to UTF-16LE text (at least MIN_TEXT characters, mostly printable ASCII) is hidden; its text is scanned again, recursively,
//    and past the depth or byte bound the input is hidden too. Only UTF-16LE counts: ASCII text in UTF-16LE has a zero high byte in every unit,
//    which hashes, JWTs, UTF-8 data and commit messages essentially never produce, so ordinary base64 data does not trip the scan.
// 2. An `-EncodedCommand`-family flag whose payload is not a decodable literal (missing, a concatenation, a variable, a subexpression, a splat, or
//    bytes that are not UTF-16LE text), after a PowerShell name or a dynamic program name. The payload is not resolved: the code it runs cannot be
//    read, and that is the reason.
// 3. A pipeline stage that reads code from stdin: a shell or interpreter after `|` with no inline code or script option (`| sh`, `| bash -s`,
//    `| pwsh -`, `base64 -d | sh`), `| iex`, `xargs` into a shell, or `/dev/stdin` as a script. What the previous stage prints is not visible
//    as code, whatever its encoding.
import type { ShellRuleDialect } from "../../shared/permissions-events.js";
import { powerShellWords, type WordStage } from "./powershell-exfiltration.js";
import { wrapperPrefixLength, type ShellCommandInput } from "./shell-prefix-policy.js";
import { INTERPRETER_SET, SHELL_SET, programName } from "./shell-prefix-values.js";
import { analyzeShellForRules } from "./shell-rule-matcher.js";

const ENCODED_PARAMETER_RE = /^[-\u2013\u2014\u2015/](?:e|ec|en|enc|enco|encod|encode|encoded|encodedc|encodedco|encodedcom|encodedcomm|encodedcomma|encodedcomman|encodedcommand)(?::([\s\S]*))?$/i;
const POWERSHELL_NAME_RE = /pwsh|powershell/i;
// The PowerShell parameters after which the rest of the line is a script and its arguments: -Command, -CommandWithArgs, -File, and prefixes.
const POWERSHELL_SCRIPT_PARAMETER_RE = /^[-\u2013\u2014\u2015/](?:c|co|com|comm|comma|comman|command|commandwithargs|cwa|f|fi|fil|file)(?::.*)?$/i;
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
const MAX_CANDIDATES = 4_096;
const MAX_RUN_PARTS = 64;
const MAX_SCRIPTS = 8;

export interface EncodedPowerShell {
  /** The decoded texts, in order (shown on the card, checked by the floors). */
  readonly scripts: string[];
  /** Encoded code is present, or the scan could not finish: see the module comment. */
  readonly hidden: boolean;
}

function isText(text: string): boolean {
  if (text.length < MIN_TEXT) return false;
  let printable = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if ((code >= 0x20 && code <= 0x7e) || code === 0x09 || code === 0x0a || code === 0x0d) printable += 1;
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
  const text = bytes.toString("utf16le").replace(/^\uFEFF/, "");
  return isText(text) ? text : null;
}

// Interpreters whose code is always an operand, never stdin.
const OPERAND_CODE_INTERPRETERS = new Set(["awk", "gawk", "mawk", "nawk"]);
// Options that hand an interpreter its code inline, so stdin is data: `python -c`, `node -e`, `perl -e`, `php -r`, `pwsh -c <code>`.
const INLINE_CODE_OPTIONS: Readonly<Record<string, RegExp>> = {
  python: /^-[A-Za-z]*[cm]$/, python2: /^-[A-Za-z]*[cm]$/, python3: /^-[A-Za-z]*[cm]$/, pypy: /^-[A-Za-z]*[cm]$/, pypy3: /^-[A-Za-z]*[cm]$/,
  node: /^(?:-[ep]|--eval|--print)$/, nodejs: /^(?:-[ep]|--eval|--print)$/, bun: /^(?:-[ep]|--eval|--print)$/, tsx: /^(?:-[ep]|--eval|--print)$/,
  deno: /^eval$/, perl: /^-[A-Za-z]*[eE]$/, ruby: /^-[A-Za-z]*e$/, php: /^-[A-Za-z]*r$/, lua: /^-[A-Za-z]*e$/, luajit: /^-[A-Za-z]*e$/,
  pwsh: /^[-\u2013\u2014\u2015/](?:c|co|com|comm|comma|comman|command|f|fi|fil|file)$/i,
  powershell: /^[-\u2013\u2014\u2015/](?:c|co|com|comm|comma|comman|command|f|fi|fil|file)$/i,
  cmd: /^\/[ck]$/i,
};
// POSIX shells: a short-option cluster with `c` (`-c`, `-ec`).
const SHELL_INLINE_CODE = /^-[A-Za-z]*c[A-Za-z]*$/;
const STDIN_PATH_RE = /^(?:\/dev\/stdin|\/dev\/fd\/0|\/proc\/self\/fd\/0)$/;
const POWERSHELL_EVAL = new Set(["iex", "invoke-expression"]);

/** True when a stage after `|` runs what it reads on stdin as code (rule 3 of the module comment). */
function readsCodeFromStdin(stage: WordStage): boolean {
  if (!stage.piped) return false;
  if (stage.words.some((word) => word.text !== null && STDIN_PATH_RE.test(word.text))) return true;
  let start = 0;
  while (start < stage.words.length && CALL_OPERATORS.has(stage.words[start]!.text ?? "")) start += 1;
  const argv = stage.words.slice(start).map((word) => word.literal && word.text !== null ? word.text : undefined);
  // A dynamic program name is not read as a shell: what it is fed is left to the other checks, as on any command.
  if (argv.length === 0 || argv[0] === undefined) return false;
  const wrapped = wrapperPrefixLength(argv);
  const head = argv[wrapped];
  if (head === undefined) return false;
  const program = programName(head);
  if (POWERSHELL_EVAL.has(program.replace(/^microsoft\.powershell\.utility\\/, ""))) return true;
  if (!SHELL_SET.has(program) && !INTERPRETER_SET.has(program)) return false;
  if (OPERAND_CODE_INTERPRETERS.has(program)) return false;
  // `xargs sh -c` appends what it reads to the shell's arguments.
  if (argv.slice(0, wrapped).some((word) => word !== undefined && programName(word) === "xargs")) return true;
  const inline = INLINE_CODE_OPTIONS[program] ?? (program === "fish" ? /^(?:-c|--command)$/ : SHELL_INLINE_CODE);
  const args = argv.slice(wrapped + 1);
  return !args.some((arg, index) => arg !== undefined && inline.test(arg) && args[index + 1] !== undefined && args[index + 1] !== "-");
}

class Scanner {
  // Raw decodes, before dropping those wholly inside a longer one (a mis-aligned sub-window of the same run can decode to coincidental text).
  private readonly decoded: string[] = [];
  hidden = false;
  private decodedChars = 0;
  private candidates = 0;
  private readonly seen = new Set<string>();

  constructor(private readonly cwd: string | undefined) {}

  scan(dialect: ShellRuleDialect, input: ShellCommandInput, depth: number): void {
    const text = typeof input === "string" ? input : input.command;
    if (depth > MAX_DEPTH) {
      this.hidden = true;
      return;
    }
    const words = dialect === "bash" ? bashWords(input, this.cwd) : powerShellWords(text);
    const sources = [text, ...(words?.texts ?? [])];
    for (const source of sources) this.runs(source, depth);
    for (const stage of words?.stages ?? []) {
      this.encodedFlags(stage);
      if (readsCodeFromStdin(stage)) this.hidden = true;
    }
  }

  /** Every base64 run of `source`, and every window of a whitespace-broken run that could be one payload split into chunks: every part but the
   *  last a whole number of base64 quads, as a wrapped or chunked payload is. */
  private runs(source: string, depth: number): void {
    for (const match of source.matchAll(BASE64_RUN_RE)) {
      const parts = match[0].split(/\s+/);
      for (let start = 0; start < parts.length; start += 1) {
        this.candidate(parts[start]!, depth);
        let joined = parts[start]!;
        for (let end = start + 1; end < parts.length && end - start < MAX_RUN_PARTS; end += 1) {
          if (parts[end - 1]!.length % 4 !== 0) break;
          joined += parts[end]!;
          this.candidate(joined, depth);
        }
      }
    }
  }

  private candidate(encoded: string, depth: number): void {
    if (encoded.length < 12 || this.seen.has(encoded)) return;
    this.seen.add(encoded);
    // A work cap guards against a pathological input; reaching it stops scanning but is not itself a reason (the -e-flag rule and the raw-text scan
    // still hold). Only the recursion-depth and decoded-byte bounds mean hidden.
    if (this.candidates >= MAX_CANDIDATES) return;
    this.candidates += 1;
    const text = decodeBase64Text(encoded);
    if (text === null) return;
    this.hidden = true;
    this.decodedChars += text.length;
    if (this.decodedChars > MAX_DECODED_CHARS) return;
    if (this.decoded.length < MAX_SCRIPTS) this.decoded.push(text);
    // Decoded text is read the same way: a payload inside a payload is a payload.
    this.scan("powershell", text, depth + 1);
  }

  /** The decoded texts to show, keeping only maximal ones (a decode wholly contained in a longer decode is a sub-window of the same payload). */
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
    let launcher = program < parts.length && !parts[program]!.literal;
    for (const [index, part] of parts.entries()) {
      if (part.text === null) continue;
      if (POWERSHELL_NAME_RE.test(part.text)) {
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
  const scanner = new Scanner(cwd);
  scanner.scan(dialect, command, 0);
  return { scripts: scanner.scripts, hidden: scanner.hidden };
}
