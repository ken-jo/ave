import { staticShellWord, type ShellRedirect, type ShellWord } from "../../shared/shell-analysis.js";
import { hiddenCodeReason, type ParsedShellCommand } from "./shell-prefix-policy.js";
import { isDestructiveShellText } from "../reviewer/risk-classifier.js";
import { isDestructiveShellArgv, noReusableRuleReason } from "./shell-prefix-values.js";
import { parseShellFloorCommand } from "./shell-exfiltration.js";
import { recordShellFloorLiteralData, SHELL_FLOOR_INPUT_LIMIT, SHELL_LITERAL_DATA_LIMIT } from "./shell-floor-policy.js";

export { SHELL_LITERAL_DATA_LIMIT } from "./shell-floor-policy.js";

export interface ShellFloorInput {
  command: string;
  literalDataBytes: number;
  destructive?: boolean;
  parsed?: ParsedShellCommand;
}

function executableWordText(word: ShellWord): string {
  if (!word.parts.some((part) => part.kind === "substitution" || part.kind === "parameter-choice")) return word.source.raw;
  // Nested commands have their own original AST records. Their enclosing raw
  // span can also contain data bodies and must not be inspected a second time.
  return word.parts.map((part) => part.kind === "literal" || part.kind === "pattern" ? part.value
    : part.kind === "parameter-choice" ? executableWordText(part.operand) : "").join("");
}

// Body extents come only from the original grammar. No permission consumer sees a rewritten command.
export function prepareShellFloorInput(command: string, dialect: string): ShellFloorInput | null {
  let parsed: ParsedShellCommand | undefined;
  const ordinary = (): ShellFloorInput | null => command.length <= SHELL_FLOOR_INPUT_LIMIT
    ? { command, literalDataBytes: 0, ...(parsed === undefined ? {} : { parsed }) } : null;
  if (dialect !== "bash" || !command.includes("<<")) return ordinary();
  if (command.length > SHELL_FLOOR_INPUT_LIMIT + SHELL_LITERAL_DATA_LIMIT) return null;
  parsed = parseShellFloorCommand(command, SHELL_FLOOR_INPUT_LIMIT + SHELL_LITERAL_DATA_LIMIT);
  if (!parsed.analysis.ok) return command.length <= SHELL_FLOOR_INPUT_LIMIT
    ? { command, literalDataBytes: 0, parsed } : null;
  let literalDataBytes = 0;
  let literalDataChars = 0;
  let heredocFound = false;
  let destructive = false;
  const executableWords: string[] = [];
  const dataWords: ShellWord[] = [];
  const stack: unknown[] = [parsed.analysis.program];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || typeof node !== "object") continue;
    if ("kind" in node && (node.kind === "unsupported" || node.kind === "unknown")) return ordinary();
    if ("kind" in node && node.kind === "command" && "words" in node && Array.isArray(node.words)) {
      const argv = node.words.map(staticShellWord);
      if (hiddenCodeReason(argv) !== null) return ordinary();
      destructive ||= isDestructiveShellArgv(argv) || noReusableRuleReason(argv) !== null;
      // Inspect original executable word spans; quoted body data never becomes command text.
      const words = node.words.map(executableWordText).join(" ");
      destructive ||= isDestructiveShellText(words);
      executableWords.push(words);
    }
    const redirect = node as Partial<ShellRedirect>;
    if (redirect.heredocQuoted !== undefined) {
      heredocFound = true;
      // One unquoted operator cancels the allowance for every body, including earlier quoted bodies.
      if (!redirect.heredocQuoted || redirect.data === undefined) return ordinary();
      const part = redirect.data.parts.length === 1 ? redirect.data.parts[0] : undefined;
      if (part?.kind !== "literal") return ordinary();
      const body = part.value;
      const bytes = redirect.literalDataBytes ?? (body.length === 0 ? 0 : undefined);
      if (bytes === undefined) return ordinary();
      literalDataBytes += bytes;
      literalDataChars += body.length;
      dataWords.push(redirect.data);
      if (literalDataBytes > SHELL_LITERAL_DATA_LIMIT) return null;
    }
    const values = Object.values(node);
    for (const value of values) {
      if (value !== null && typeof value === "object") {
        if (Array.isArray(value)) stack.push(...value);
        else stack.push(value);
      }
    }
  }
  if (!heredocFound) return ordinary();
  if (command.length - literalDataChars > SHELL_FLOOR_INPUT_LIMIT) return null;
  recordShellFloorLiteralData(parsed, literalDataChars, dataWords);
  // Joining executable words can only add conservative floor matches; it is never parsed or used for identity.
  destructive ||= isDestructiveShellText(executableWords.join(" | "));
  return { command, literalDataBytes, parsed, destructive };
}
