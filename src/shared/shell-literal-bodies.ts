import { createPermissionPathEvidence, type PermissionPathEvidence } from "../permissions/sensitive-paths.js";
import { classifySedArgumentSlots } from "./shell-sed-arguments.js";
import { classifySqliteArgumentSlots } from "../tools/shell-sqlite-arguments.js";
import type { ShellWord } from "./shell-analysis.js";

interface LiteralShellBody {
  text: string;
  dialect: "bash" | "posix" | "powershell";
  index: number;
}

export type LiteralShellArgument = string | readonly string[] | undefined
  | { kind: "parenthesized"; values: readonly string[] }
  | { kind: "expression"; argv: readonly LiteralShellArgument[] }
  | { kind: "scriptblock" | "literal"; text: string };

export interface LiteralShellFragment { text: string; index: number }

/** Project literal AST parts without changing the owning argument or interpreting its receiver. */
export function shellLiteralFragments(words: readonly ShellWord[]): readonly LiteralShellFragment[] {
  const fragments: LiteralShellFragment[] = [];
  for (let index = 0; index < words.length; index++) {
    for (const part of words[index]!.parts) {
      if (part.kind === "literal" || part.kind === "unicode-escaped") fragments.push({ text: part.value, index });
    }
  }
  return fragments;
}

/** Parser-owned literal data is screened independently of the command that receives it. */
export function literalShellBodies(
  argv: readonly LiteralShellArgument[], raw?: readonly string[], stdin?: string,
  fragments: readonly LiteralShellFragment[] = [],
): readonly LiteralShellBody[] {
  const bodies: LiteralShellBody[] = [];
  const seen = new Set<string>();
  const append = (text: string, index: number, grammars: readonly ("posix" | "powershell")[] = ["posix", "powershell"]): void => {
    // A single inert word has neither a nested argv nor an executable effect.
    if (!/[\s;|&<>(){}]/u.test(text)) return;
    for (const grammar of grammars) {
      const key = grammar + "\0" + text;
      if (seen.has(key)) continue;
      seen.add(key);
      bodies.push({ text, dialect: grammar, index });
    }
  };
  const visit = (value: LiteralShellArgument, index: number, literal = false): void => {
    if (typeof value === "string") {
      if (literal || /[\s]/u.test(value) || /['"\\]/u.test(raw?.[index] ?? "")) append(value, index);
    } else if (Array.isArray(value)) {
      for (const item of value) append(item, index);
    } else if (value && "kind" in value) {
      if (value.kind === "scriptblock") append(value.text, index, ["powershell"]);
      else if (value.kind === "literal") append(value.text, index);
      else if (value.kind === "parenthesized") for (const item of value.values) append(item, index);
      else if (value.kind === "expression") for (const item of value.argv) visit(item, index, true);
    }
  };
  for (let index = 0; index < argv.length; index++) {
    if (index > 0 || typeof argv[index] !== "string" || /^['"]/u.test(raw?.[index] ?? "")) visit(argv[index], index);
  }
  for (const fragment of fragments) {
    // An unchanged unquoted command head is not an argument body; reparsing it would rediscover itself.
    if (fragment.index === 0 && (fragment.text === argv[0] || fragment.text === raw?.[0]) && !/^['"]/u.test(raw?.[0] ?? "")) continue;
    append(fragment.text, fragment.index);
  }
  // Adjacent parser-proven literal strings may be concatenated by the receiver. Screen that possible body without assuming an invoker.
  let sequence: string[] = [], sequenceIndex = 0;
  const finishSequence = () => { if (sequence.length > 1) append(sequence.join(" "), sequenceIndex); sequence = []; };
  for (let index = 1; index < argv.length; index++) {
    const value = argv[index];
    const literal = typeof value === "string" && /^['"]/u.test(raw?.[index] ?? "") ? value
      : value && typeof value === "object" && "kind" in value && value.kind === "literal" ? value.text : undefined;
    if (literal === undefined) finishSequence();
    else { if (sequence.length === 0) sequenceIndex = index; sequence.push(literal); }
  }
  finishSequence();
  // Foreign-language parsers expose typed executable fragments; these are not host-shell invoker guesses.
  const head = argv[0];
  if (typeof head === "string" && argv.every((value): value is string => typeof value === "string")) {
    const name = head.split(/[\\/]/u).at(-1)!;
    const slots = name === "sed" ? classifySedArgumentSlots(argv) : name === "sqlite3" ? classifySqliteArgumentSlots(argv) : undefined;
    for (const body of slots?.nestedCommands ?? []) append(body.value, body.index);
  }
  if (stdin !== undefined) append(stdin, argv.length);
  return bodies;
}

export interface LiteralBodyBudget { tokens: { count: number }; depth: number; literalBody?: true; floorOnly?: true }

interface LiteralShellFlow { network: boolean; readsPath: boolean; credentialStore?: string }
const literalFlows = new WeakMap<object, LiteralShellFlow>();

/** Keep typed child flow in memory without adding execution authority or serialized signal fields. */
export function recordLiteralShellFlow<T extends object>(result: T, flow: LiteralShellFlow): T {
  literalFlows.set(result, flow);
  return result;
}

export function literalShellFlow(result: object): LiteralShellFlow | undefined { return literalFlows.get(result); }

/** Normalize positive literal-path evidence without granting authority from ordinary data operands. */
export function literalShellPathFacts(result: {
  paths: readonly PermissionPathEvidence[];
  unproven: boolean | { kind: string } | null;
  credentialStore?: string | null;
  unknownProtectedWrite?: string;
  evidenceLimitExceeded?: true;
}, executed: boolean) {
  return {
    paths: result.paths.filter(path => executed || path.protectedControl !== undefined || path.admissionDenial !== null),
    unproven: typeof result.unproven === "boolean" ? result.unproven : result.unproven !== null,
    credentialStore: result.credentialStore ?? null,
    unknownProtectedWrite: result.unknownProtectedWrite,
    evidenceLimitExceeded: result.evidenceLimitExceeded === true || typeof result.unproven === "object" && result.unproven?.kind === "analysis-limit",
  };
}

interface LiteralPathSnapshot {
  resolved: Map<string, string>;
  evidence: Map<string, ReturnType<typeof createPermissionPathEvidence>>;
}
const literalPathSnapshots = new WeakMap<LiteralBodyBudget["tokens"], LiteralPathSnapshot>();

/** Grammar children share one filesystem observation snapshot during a decision. */
export function literalShellPathSnapshot(budget: LiteralBodyBudget, projectRoot: string) {
  let snapshot = literalPathSnapshots.get(budget.tokens);
  if (snapshot === undefined) {
    snapshot = { resolved: new Map(), evidence: new Map() };
    literalPathSnapshots.set(budget.tokens, snapshot);
  }
  let evidenceForPath = snapshot.evidence.get(projectRoot);
  if (evidenceForPath === undefined) {
    evidenceForPath = createPermissionPathEvidence(projectRoot);
    snapshot.evidence.set(projectRoot, evidenceForPath);
  }
  return { resolved: snapshot.resolved, evidenceForPath };
}
