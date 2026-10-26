import { literalWord, staticShellWord, type ShellCommand, type ShellRedirect } from "../../shared/shell-analysis.js";
import { hiddenCodeReason, type ParsedShellCommand } from "./shell-prefix-policy.js";
import { parseShellFloorCommand } from "./shell-exfiltration.js";
import { SHELL_FLOOR_INPUT_LIMIT } from "./shell-floor-policy.js";
import type { ShellFloorWorkBudget } from "./shell-floor-work-budget.js";

export const SHELL_LITERAL_DATA_LIMIT = 65_536;

interface Delimiter { text: string; raw: string; quoted: boolean; tabs: boolean }
export interface ShellFloorInput {
  command: string;
  literalDataBytes: number;
  parsed?: ParsedShellCommand;
}

// Only the bounded executable envelope reaches general analysis. Literal bodies are counted once as data.
export function prepareShellFloorInput(command: string, dialect: string, budget: ShellFloorWorkBudget): ShellFloorInput | null {
  const ordinary = (): ShellFloorInput | null => command.length <= SHELL_FLOOR_INPUT_LIMIT
    ? { command, literalDataBytes: 0 } : null;
  if (dialect !== "bash" || !command.includes("<<")) return ordinary();
  if (command.length > SHELL_FLOOR_INPUT_LIMIT + SHELL_LITERAL_DATA_LIMIT) return null;
  const lines = command.split("\n");
  const output: string[] = [];
  const signatures: string[] = [];
  let literalDataBytes = 0;
  let quote: string | undefined;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]!;
    budget.spend(1, line.length);
    const pending: Delimiter[] = [];
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index]!;
      if (char === "\\" && quote !== "'") { index += 1; continue; }
      if (quote !== undefined) { if (char === quote) quote = undefined; continue; }
      if (char === "'" || char === '"') { quote = char; continue; }
      if (char === "#" && (index === 0 || /[\s;|&]/.test(line[index - 1]!))) break;
      if (char !== "<" || line[index + 1] !== "<") continue;
      if (line[index + 2] === "<") { index += 2; continue; }
      const start = index;
      index += 2;
      const tabs = line[index] === "-";
      if (tabs) index += 1;
      while (line[index] === " " || line[index] === "\t") index += 1;
      let delimiterQuote: string | undefined;
      let quoted = false;
      let text = "";
      while (index < line.length) {
        const part = line[index]!;
        if (part === "\\") return ordinary();
        if (delimiterQuote !== undefined) {
          if (part === delimiterQuote) delimiterQuote = undefined;
          else text += part;
        } else if (part === "'" || part === '"') {
          quoted = true;
          delimiterQuote = part;
        } else {
          if (/[\s;|&<>()]/.test(part)) break;
          text += part;
        }
        index += 1;
      }
      if (delimiterQuote !== undefined || text.length === 0 || (!quoted && !/^[A-Za-z_][\w.-]*$/.test(text))) return ordinary();
      pending.push({ text, raw: line.slice(start, index), quoted, tabs });
      index -= 1;
    }
    output.push(line);
    if (pending.length === 0) continue;
    if (quote !== undefined || line.endsWith("\\")) return ordinary();
    for (const delimiter of pending) {
      let closed = false;
      for (lineIndex += 1; lineIndex < lines.length; lineIndex += 1) {
        const bodyLine = lines[lineIndex]!;
        const compared = delimiter.tabs ? bodyLine.replace(/^\t+/, "") : bodyLine;
        if (compared === delimiter.text) { output.push(bodyLine); closed = true; break; }
        if (delimiter.quoted) {
          literalDataBytes += Buffer.byteLength(bodyLine, "utf8") + (lineIndex < lines.length - 1 ? 1 : 0);
          if (literalDataBytes > SHELL_LITERAL_DATA_LIMIT) return null;
        } else {
          budget.spend(1, bodyLine.length);
          output.push(bodyLine);
        }
      }
      if (!closed) return ordinary();
      if (delimiter.quoted) signatures.push(delimiter.raw);
    }
  }
  if (signatures.length === 0) return ordinary();
  const projected = output.join("\n");
  if (projected.length > SHELL_FLOOR_INPUT_LIMIT) return null;
  const parsed = parseShellFloorCommand(projected, budget);
  const analysis = parsed.analysis;
  if (!analysis.ok) return null;
  // Verify every removed body belongs to an actual literal heredoc redirect in the grammar.
  const remaining = [...signatures];
  const stack: unknown[] = [analysis.program];
  while (stack.length > 0) {
    budget.spend();
    const node = stack.pop();
    if (node === null || typeof node !== "object") continue;
    const commandNode = node as Partial<ShellCommand>;
    // A known code consumer keeps its visible body under the ordinary analysis bound.
    if (commandNode.kind === "command" && commandNode.words !== undefined
      && hiddenCodeReason(commandNode.words.map(staticShellWord)) !== null) return ordinary();
    const redirect = node as Partial<ShellRedirect>;
    if (redirect.effect === "read" && (redirect.data === undefined || staticShellWord(redirect.data) === "")) {
      budget.spend(remaining.length);
      const index = remaining.findIndex((raw) => redirect.source?.raw.startsWith(raw));
      if (index >= 0) {
        remaining.splice(index, 1);
        // The grammar omits Hdoc for an empty body. This verified redirect still consumes data, not a file named by its delimiter.
        if (redirect.data === undefined && redirect.source !== undefined) {
          redirect.data = literalWord("", { ...redirect.source, raw: "" });
          delete redirect.target;
        }
      }
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
  if (remaining.length > 0) return null;
  return { command: projected, literalDataBytes, parsed };
}
