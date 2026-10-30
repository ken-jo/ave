import { analyzeShell, staticShellWord, type PreparedShellAnalysis, type ShellAnalysis } from "./shell-analysis.js";
import type { ShellParserLimits } from "./shell-parser.js";

interface SyntaxObservation { analysis: ShellAnalysis; parserError?: unknown }
type SyntaxSnapshot = Map<string, SyntaxObservation>;
const requestSnapshots = new WeakMap<object, SyntaxSnapshot>();
const counterSnapshots = new WeakMap<object, SyntaxSnapshot>();

/** Share only immutable parser observations across a request's independent inspection passes. */
export function bindShellSyntaxSnapshot(owner: object, counter: object): void {
  if (counterSnapshots.has(counter)) return;
  let snapshot = requestSnapshots.get(owner);
  if (snapshot === undefined) {
    snapshot = new Map();
    requestSnapshots.set(owner, snapshot);
  }
  counterSnapshots.set(counter, snapshot);
}

/** Consumers retain their own facts and charge every visit, including a parser-cache hit. */
export function shellSyntaxObservation(command: string, dialect: "bash" | "posix", limits: ShellParserLimits, counter?: object): SyntaxObservation {
  let snapshot = counter === undefined ? undefined : counterSnapshots.get(counter);
  if (counter !== undefined && snapshot === undefined) {
    snapshot = new Map();
    counterSnapshots.set(counter, snapshot);
  }
  const key = JSON.stringify([dialect, limits.totalTokens, command]);
  const previous = snapshot?.get(key);
  if (previous !== undefined) return previous;
  let result: SyntaxObservation;
  try { result = { analysis: analyzeShell(command, dialect, limits) }; }
  catch (parserError) { result = { analysis: { ok: false, reason: "shell parser failed" }, parserError }; }
  snapshot?.set(key, result);
  return result;
}

/** Reuse original syntax only when its complete command is the same already-bound literal argv. */
export function existingStaticShellSyntax(command: string, argv: readonly (string | undefined)[], limits: ShellParserLimits, counter: object): PreparedShellAnalysis | undefined {
  const observation = counterSnapshots.get(counter)?.get(JSON.stringify(["bash", limits.totalTokens, command]));
  if (observation === undefined || "parserError" in observation || !observation.analysis.ok) return undefined;
  const { analysis } = observation;
  const node = analysis.program.kind === "sequence" && analysis.program.statements.length === 1 ? analysis.program.statements[0]! : analysis.program;
  if (node.kind !== "command" || node.assignments.length !== 0 || node.redirects.length !== 0 || node.words.length !== argv.length) return undefined;
  if (!node.words.every((word, index) => argv[index] !== undefined && staticShellWord(word) === argv[index])) return undefined;
  return { command, analysis };
}
