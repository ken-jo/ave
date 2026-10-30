import type { ShellRuleDialect } from "../../shared/permissions-events.js";
import { literalRuleWord } from "./rule-specifier.js";
import { wrapperCommand, type ShellCommandInput } from "./shell-prefix-policy.js";
import { isPowerShellLauncher } from "./shell-prefix-values.js";

const DISPLAY_ENCODED_PARAMETER_RE = /^(?:[-–—―]+|\/)(?:e|ec|en|enc|enco|encod|encode|encoded|encodedc|encodedco|encodedcom|encodedcomm|encodedcomma|encodedcomman|encodedcommand)(?::(.*))?$/is;

const DISPLAY_SCRIPT_PARAMETER_RE = /^(?:[-–—―]+|\/)(?:c|co|com|comm|comma|comman|command|commandwithargs|cwa|f|fi|fil|file)(?::.*)?$/i;
const DISPLAY_VALUE_PARAMETER_RE = /^(?:[-–—―]+|\/)(?:workingdirectory|configurationname|configurationfile|custompipename|executionpolicy|inputformat|outputformat|settingsfile|version|windowstyle)$/i;

// Reject the complement of the positive literal alphabet before reading option prefixes.
const UNPROVEN_ARGUMENT_CHARACTER_RE = /[^\p{L}\p{N}\p{P}\p{S} ]/u;
const LAUNCHER_WORD_RE = /[^ "'`;|&()<>{},=\p{Z}\p{C}]+/gu;

// Value and raw-word streams preserve both joined literal words and boundaries inside quoted command text.
export function encodedPowerShellExecutionReason(
  argv: readonly (string | null | undefined)[],
  rawWords: readonly (string | null | undefined)[] = [],
): string | null {
  for (const words of [argv, rawWords]) {
    let launcherSeen = false;
    for (const value of words) {
      if (value == null) continue;
      if (launcherSeen && UNPROVEN_ARGUMENT_CHARACTER_RE.test(value)) return "unproven PowerShell argument characters";
      for (const match of value.matchAll(LAUNCHER_WORD_RE)) {
        const word = match[0];
        if (launcherSeen && word.replace(/^[-/–—―]+/, "").toLowerCase().startsWith("e")) return "encoded PowerShell argument exclusion";
        if (!launcherSeen && isPowerShellLauncher(word)) {
          launcherSeen = true;
          if (UNPROVEN_ARGUMENT_CHARACTER_RE.test(value.slice(match.index + word.length))) return "unproven PowerShell argument characters";
        }
      }
    }
  }
  return null;
}

// Decode only a launcher's literal operand for display. No decoded text participates in permission decisions or further decoding.
export function decodePowerShellEncodedCommands(input: ShellCommandInput, dialect: ShellRuleDialect): string[] {
  const command = typeof input === "string" ? input : input.command;
  const scripts: string[] = [];
  const seen = new Set<string>();
  for (const words of displayArgv(command, dialect) ?? []) {
    const start = wrapperCommand(words, words.length).index;
    const head = words[start];
    if (head === undefined || !isPowerShellLauncher(head)) continue;
    for (let index = start + 1; index < words.length; index += 1) {
      const arg = words[index];
      if (arg === undefined || DISPLAY_SCRIPT_PARAMETER_RE.test(arg)) break;
      if (DISPLAY_VALUE_PARAMETER_RE.test(arg)) { index += 1; continue; }
      const flag = DISPLAY_ENCODED_PARAMETER_RE.exec(arg);
      if (flag === null) continue;
      const operand = flag[1] ?? words[index + 1];
      const decoded = operand === undefined ? null : decodeLiteralOperand(operand);
      if (decoded !== null && !seen.has(decoded)) { seen.add(decoded); scripts.push(decoded); }
      break;
    }
  }
  return scripts;
}

function decodeLiteralOperand(operand: string): string | null {
  const encoded = operand.replace(/[\t\n\v\f\r ]+/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.replace(/=+$/, "").length % 4 === 1) return null;
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length % 2 !== 0) return null;
  return bytes.toString("utf16le").replace(/^\uFEFF/, "");
}

// A display-only reader for direct command boundaries. Unsupported syntax declines disclosure; it never supplies permission evidence.
function displayArgv(command: string, dialect: ShellRuleDialect): (string | undefined)[][] | null {
  const commands: (string | undefined)[][] = [];
  let argv: (string | undefined)[] = [];
  let raw = "";
  let quote: "'" | '"' | undefined;
  const word = (): void => {
    if (raw.length > 0) argv.push(literalRuleWord(raw.replace(/[\r\n]/g, " "), dialect));
    raw = "";
  };
  const stage = (): void => {
    word();
    if (argv.length > 0) commands.push(argv);
    argv = [];
  };
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (quote !== undefined) {
      raw += char;
      if (char === quote) quote = undefined;
      else if ((dialect === "bash" && quote === '"' && char === "\\") || (dialect === "powershell" && quote === '"' && char === "`")) return null;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; raw += char; continue; }
    if ("(){}<>`".includes(char) || (dialect === "bash" && char === "\\")) return null;
    if (char === "#" && raw.length === 0) {
      while (index < command.length && command[index] !== "\n") index += 1;
      stage();
      continue;
    }
    if (char === ";" || char === "|" || char === "&" || char === "\n" || char === "\r") { stage(); continue; }
    if (" \t\v\f".includes(char)) { word(); continue; }
    raw += char;
  }
  if (quote !== undefined) return null;
  stage();
  return commands;
}
