import { analyzeShell, type ShellAnalysis } from "./shell-analysis.js";
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
