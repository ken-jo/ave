import { staticShellWord, type ShellRedirect } from "../../shared/shell-analysis.js";
import { hiddenCodeReason, type ParsedShellCommand } from "./shell-prefix-policy.js";
import { isDestructiveShellText } from "../reviewer/risk-classifier.js";
import { isDestructiveShellArgv, noReusableRuleReason } from "./shell-prefix-values.js";
import { parseShellFloorCommand } from "./shell-exfiltration.js";
import { recordShellFloorLiteralData, SHELL_FLOOR_INPUT_LIMIT, SHELL_LITERAL_DATA_LIMIT } from "./shell-floor-policy.js";
import type { ShellFloorWorkBudget } from "./shell-floor-work-budget.js";

export { SHELL_LITERAL_DATA_LIMIT } from "./shell-floor-policy.js";

export interface ShellFloorInput {
  command: string;
  literalDataBytes: number;
  destructive?: boolean;
  parsed?: ParsedShellCommand;
}

// Body extents come only from the original grammar. No permission consumer sees a rewritten command.
export function prepareShellFloorInput(command: string, dialect: string, budget: ShellFloorWorkBudget): ShellFloorInput | null {
  const ordinary = (): ShellFloorInput | null => command.length <= SHELL_FLOOR_INPUT_LIMIT
    ? { command, literalDataBytes: 0 } : null;
  if (dialect !== "bash" || !command.includes("<<")) return ordinary();
  if (command.length > SHELL_FLOOR_INPUT_LIMIT + SHELL_LITERAL_DATA_LIMIT) return null;
  const parsed = parseShellFloorCommand(command, budget, SHELL_FLOOR_INPUT_LIMIT + SHELL_LITERAL_DATA_LIMIT);
  if (!parsed.analysis.ok) return ordinary();
  let literalDataBytes = 0;
  let literalDataChars = 0;
  let heredocFound = false;
  let destructive = false;
  const executableWords: string[] = [];
  const stack: unknown[] = [parsed.analysis.program];
  while (stack.length > 0) {
    budget.spend();
    const node = stack.pop();
    if (node === null || typeof node !== "object") continue;
    if ("kind" in node && (node.kind === "unsupported" || node.kind === "unknown")) return ordinary();
    if ("kind" in node && node.kind === "command" && "words" in node && Array.isArray(node.words)) {
      budget.spend(node.words.length);
      const argv = node.words.map(staticShellWord);
      if (hiddenCodeReason(argv) !== null) return ordinary();
      destructive ||= isDestructiveShellArgv(argv) || noReusableRuleReason(argv) !== null;
      // Inspect original executable word spans; quoted body data never becomes command text.
      const words = node.words.map((word) => word.source.raw).join(" ");
      budget.spend(0, words.length);
      destructive ||= isDestructiveShellText(words);
      executableWords.push(words);
    }
    const redirect = node as Partial<ShellRedirect>;
    if (redirect.heredocQuoted !== undefined) {
      heredocFound = true;
      // One unquoted operator cancels the allowance for every body, including earlier quoted bodies.
      if (!redirect.heredocQuoted || redirect.data === undefined) return ordinary();
      const body = staticShellWord(redirect.data);
      if (body === undefined) return ordinary();
      budget.spend(0, body.length);
      literalDataBytes += Buffer.byteLength(body, "utf8");
      literalDataChars += body.length;
      if (literalDataBytes > SHELL_LITERAL_DATA_LIMIT) return null;
    }
    const values = Object.values(node);
    budget.spend(values.length);
    for (const value of values) {
      if (value !== null && typeof value === "object") {
        if (Array.isArray(value)) stack.push(...value);
        else stack.push(value);
      }
    }
  }
  if (!heredocFound) return ordinary();
  if (command.length - literalDataChars > SHELL_FLOOR_INPUT_LIMIT) return null;
  recordShellFloorLiteralData(parsed, literalDataChars);
  // Joining executable words can only add conservative floor matches; it is never parsed or used for identity.
  destructive ||= isDestructiveShellText(executableWords.join(" | "));
  return { command, literalDataBytes, parsed, destructive };
}
