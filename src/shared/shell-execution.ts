import { accessSync, constants, statSync } from "node:fs";
import { isAbsolute, posix, relative as pathRelative, resolve as pathResolve, sep } from "node:path";
import { analyzeShell, literalWord, staticShellWord, validatePreparedShellAnalysis, type PreparedShellAnalysis, type ShellAnalysis, type ShellCommand, type ShellRedirect, type ShellStatement, type ShellWord, type ShellWordPart } from "./shell-analysis.js";
import { effectiveShellCommand, stripCommandPath, type EffectiveShellCommand } from "./shell-effective-command.js";
import { SHELL_ANALYSIS_LIMITS } from "./shell-parser.js";
import { resolveShellFilesystemPath } from "./shell-filesystem-path.js";
import { modelShellPath } from "./shell-native-path.js";
import { analyzeShellTestExpression, parseProvenShellInteger, type ShellTestExpression } from "./shell-test-expression.js";

export interface ShellCommandEvent {
  original: ShellCommand;
  node: ShellCommand;
  effective: EffectiveShellCommand;
  argv: readonly (string | undefined)[];
  cwd: string | null;
  environment: Readonly<Record<string, string | undefined>>;
  exportedEnvironment: Readonly<Record<string, string | undefined>>;
  builtin: boolean;
  functionCall: boolean;
  recursiveFunction: boolean;
  backquote: boolean;
  pipeline?: readonly ShellStatement[];
  fromPipe: boolean;
  activeFunctions: readonly string[];
  definedFunctions: readonly string[];
  unsetVariables: readonly string[];
  dialect: "bash" | "posix";
  testExpression?: ShellTestExpression;
  inputRedirect?: ShellRedirect;
  inspectNested(
    text: string,
    dialect: "bash" | "posix",
    context?: {
      cwd: string | null;
      environment: Readonly<Record<string, string | undefined>>;
      unsetVariables: readonly string[];
    },
    origin?: ShellWord["source"],
  ): void;
}
export interface ShellExecutionInspector {
  analysisTokens?(count: number): void;
  word?(word: ShellWord): void;
  unresolvedWord?(word: ShellWord, error: ShellExecutionError): boolean | void;
  /** Evidence-only continuation invalidates execution state after an opaque operation. */
  unresolvedState?(error: ShellExecutionError): boolean | void;
  path(path: string, raw: string, cwd: string | null, effect: "read" | "write", role?: "directory"): void;
  /** Evidence collectors may retain uncertainty and continue visiting later possible effects. */
  unresolvedPath?(raw: string, cwd: string | null, effect: "read" | "write", error?: ShellExecutionError, role?: "directory"): boolean | void;
  resolvedRedirect?(target: ShellWord, path: string, effect: "read" | "write", environment: Readonly<Record<string, string | undefined>>): void;
  command(event: ShellCommandEvent): void;
}
export class ShellExecutionError extends Error {
  constructor(message: string, readonly operand?: string) { super(message); }
}

/** Normalize a workload path without consulting the controller filesystem. */
export function resolveGuestShellPath(path: string, cwd: string | null): string {
  if (path.includes("\0")) throw new ShellExecutionError("working-directory namespace is unresolved", path);
  if (posix.isAbsolute(path)) return posix.normalize(path);
  if (cwd === null || !posix.isAbsolute(cwd)) throw new ShellExecutionError("working directory is unresolved", path);
  return posix.resolve(cwd, path);
}
export interface ShellExecutionFacts {
  dialect: "bash";
  environment: Readonly<Record<string, string | undefined>>;
  /** Present only after a fixed probe of the selected interpreter and locale. */
  unicodeEscapes?: boolean;
  prefixAssignmentRhs?: "incoming" | "sequential";
  /** Set only for a confirmed broker guest route: operands name the guest's Linux namespace. */
  guestPosixPaths?: true;
  /** Effective POSIX working directory sealed by the confirmed guest execution route. */
  guestCwd?: string;
  /** Set only for an unsandboxed host route: an observed cd may still fail at execution. */
  hostCdFaults?: true;
}
/** Only the containment gate of an unsandboxed host route models a cd that fails at execution. */
export function withHostCdFaults(facts: ShellExecutionFacts | undefined, unsandboxedHost: boolean): ShellExecutionFacts | undefined {
  return unsandboxedHost ? { ...(facts ?? { dialect: "bash", environment: {} }), hostCdFaults: true } : facts;
}
interface ShellState {
  cwd: string | null;
  variables: Map<string, string | undefined>;
  arrays: Map<string, readonly (string | undefined)[] | undefined>;
  exported: Set<string>;
  functions: Map<string, ShellStatement>;
  readonlyVariables: Set<string>;
  unsetVariables: Set<string>;
  dialect: "bash" | "posix";
  unicodeEscapes?: boolean;
  prefixAssignmentRhs?: "incoming" | "sequential";
  backquote: boolean;
  pipeline?: readonly ShellStatement[];
  fromPipe: boolean;
  activeFunctions: readonly string[];
  inputRedirect?: ShellRedirect;
  /** Follows a host cd modeled as failing although its destination was observed; holds the destinations that failed. */
  cdFault?: readonly string[];
  errexit?: true;
}
type ExitStatus = "success" | "failure" | "unknown";
interface BreakControl { kind: "break"; levels: number; boundary: number }
interface StateResult { state: ShellState; status: ExitStatus; control?: BreakControl }
interface ExecutionContext { boundary: number; loopDepth: number; condition?: true; fallback?: true }
interface WordEvaluation { lastSubstitutionStatus?: ExitStatus; mayFail?: boolean }
interface CommandRedirectObservation { state?: ShellState; inspected: boolean }
// Past this many forks without a possible filesystem change, a host cd asks like an exhausted flagged budget.
const UNFLAGGED_CD_FORK_LIMIT = SHELL_ANALYSIS_LIMITS.states / 4;
const EXECUTION_ALTERING_VARIABLES = new Set(["IFS", "BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS", "CDPATH", "PWD"]);
export function assertStableShellEnvironmentVariable(
  name: string,
  word: ShellWord,
  role: "assignment" | "environment",
): void {
  if (EXECUTION_ALTERING_VARIABLES.has(name)) {
    decline(`execution-altering shell ${role} is unsupported`, word);
  }
}
function stateKey(state: ShellState): string {
  return JSON.stringify([state.cwd, state.dialect, state.unicodeEscapes, state.prefixAssignmentRhs, state.inputRedirect?.source, [...state.variables].sort(), [...state.arrays].sort(), [...state.exported].sort(), [...state.readonlyVariables].sort(), [...state.unsetVariables].sort(), [...state.functions].map(([name, body]) => [name, body.source]), state.errexit, state.cdFault !== undefined]);
}
function decline(reason: string, word?: ShellWord): never {
  throw new ShellExecutionError(reason, word?.source.raw);
}
function cloneState(state: ShellState): ShellState {
  return { ...state, variables: new Map(state.variables), arrays: new Map(state.arrays), exported: new Set(state.exported), functions: new Map(state.functions), readonlyVariables: new Set(state.readonlyVariables), unsetVariables: new Set(state.unsetVariables) };
}
function standardInputRedirect(redirects: readonly ShellRedirect[], inherited?: ShellRedirect): ShellRedirect | undefined {
  let input = inherited;
  for (const redirect of redirects) if (redirect.fileDescriptor === 0 || redirect.fileDescriptor === undefined && redirect.effect === "read") input = redirect;
  return input;
}
function uniqueResults(results: readonly StateResult[]): StateResult[] {
  const unique = new Map<string, StateResult>();
  for (const result of results) {
    const state = result.state;
    const key = JSON.stringify([result.status, result.control, stateKey(state)]);
    const earlier = unique.get(key)?.state.cdFault;
    unique.set(key, earlier && state.cdFault ? { ...result, state: { ...state, cdFault: faultUnion(earlier, state.cdFault) } } : result);
    if (unique.size > SHELL_ANALYSIS_LIMITS.states) declineStateLimit("execution-state limit exceeded", results);
  }
  return [...unique.values()];
}
// A state limit reached by modeled cd failures alone, states differing only in working directory, is the ordinary unresolved-cwd ask.
function declineStateLimit(reason: string, results: readonly { state: ShellState }[]): never {
  const placeless = (state: ShellState): string => {
    const variables = new Map(state.variables);
    variables.delete("PWD"); variables.delete("OLDPWD");
    return stateKey({ ...state, cwd: null, cdFault: undefined, variables });
  };
  const cwdOnly = results.some((result) => result.state.cdFault) && new Set(results.map((result) => placeless(result.state))).size === 1;
  decline(cwdOnly ? "unresolved working-directory destination" : reason);
}
function faultUnion(left: readonly string[], right: readonly string[]): readonly string[] {
  return [...new Set([...left, ...right])].sort();
}
/** A sequence ignores the previous status, so a fault path equal to another path adds nothing. */
function withoutShadowedFaults(results: readonly StateResult[]): readonly StateResult[] {
  if (!results.some((result) => result.state.cdFault)) return results;
  const tagless = (state: ShellState): string => stateKey({ ...state, cdFault: undefined });
  const plain = new Set(results.filter((result) => !result.control && !result.state.cdFault).map((result) => tagless(result.state)));
  return results.filter((result) => result.control || !result.state.cdFault || !plain.has(tagless(result.state)));
}

/** Same original text and prepared child facts are inspected at both gates. */
export function inspectShellExecution(command: string, cwd: string, facts: ShellExecutionFacts, inspector: ShellExecutionInspector, totalTokenLimit?: number, prepared?: PreparedShellAnalysis): void {
  const analysis = prepared === undefined ? analyzeShell(command, "bash", totalTokenLimit === undefined ? undefined : { totalTokens: totalTokenLimit }) : validatePreparedShellAnalysis(command, prepared);
  if (!analysis.ok) throw new ShellExecutionError(analysis.reason);
  let remainingTokens = totalTokenLimit;
  const chargeAnalysis = (parsed: Extract<ShellAnalysis, { ok: true }>): void => {
    inspector.analysisTokens?.(parsed.totalTokens ?? 0);
    if (remainingTokens === undefined) return;
    if (!Number.isSafeInteger(parsed.totalTokens) || parsed.totalTokens! < 0) throw new Error("Shell analysis token count is unavailable");
    remainingTokens -= parsed.totalTokens!;
    if (remainingTokens < 0) throw new ShellExecutionError("Shell analysis total token limit exceeded");
  };
  chargeAnalysis(analysis);
  const nestedAnalyses = new WeakMap<ShellWord["source"], Map<string, Extract<ShellAnalysis, { ok: true }>>>();
  const guest = facts.guestPosixPaths === true;
  const initialCwd = guest ? typeof facts.guestCwd === "string" && /^\/(?!\/)/u.test(facts.guestCwd) && !facts.guestCwd.includes("\0")
    ? posix.normalize(facts.guestCwd) : null : cwd;
  const initial: ShellState = { cwd: initialCwd, dialect: "bash", unicodeEscapes: facts.unicodeEscapes, prefixAssignmentRhs: facts.prefixAssignmentRhs, variables: new Map(Object.entries(facts.environment)), arrays: new Map(), exported: new Set(Object.keys(facts.environment)), functions: new Map(), readonlyVariables: new Set(), unsetVariables: new Set(), backquote: false, fromPipe: false, activeFunctions: [] };
  initial.variables.set("PWD", initialCwd ?? undefined);
  // Filesystem effects cross process scopes; after possible mutation, pre-execution stat cannot prove a later chdir outcome. Keep this flag analysis-local.
  let filesystemMayChange = false;
  // Host cd forks: those taken after a possible filesystem change share one budget; the others have their own cap.
  let flaggedCdForks = 0;
  let unflaggedCdForks = 0;
  const within = (parent: string, path: string): boolean => {
    const rest = pathRelative(parent, path);
    return rest === "" || !isAbsolute(rest) && rest !== ".." && !rest.startsWith(`..${sep}`);
  };
  let steps = 0;
  let nextExecutionBoundary = 0;
  const failedCommandRedirects = new WeakMap<ShellExecutionError, CommandRedirectObservation>();
  // A process or function boundary keeps the errexit-suppressing condition context of its caller.
  const freshExecutionContext = (caller?: ExecutionContext): ExecutionContext => ({ boundary: ++nextExecutionBoundary, loopDepth: 0, ...(caller?.condition ? { condition: true } : {}) });
  const rootExecutionContext = freshExecutionContext();
  const leaveLoop = (result: StateResult, context: ExecutionContext): StateResult => {
    const control = result.control;
    if (!control) return result;
    if (control.boundary !== context.boundary) decline("control transfer crossed execution boundary");
    return control.levels === 1
      ? { state: result.state, status: "success" }
      : { ...result, control: { ...control, levels: control.levels - 1 } };
  };
  const checkPath = (path: string, raw: string, state: ShellState, effect: "read" | "write", role?: "directory"): void => {
    if (!(guest ? posix.isAbsolute(path) : isAbsolute(path)) && state.cwd === null) {
      const error = new ShellExecutionError("working directory is unresolved", raw);
      if (inspector.unresolvedPath?.(raw, state.cwd, effect, error, role) === true) return;
      throw error;
    }
    inspector.path(path, raw, state.cwd, effect, role);
  };
  const parameterChoice = (part: Extract<ShellWordPart, { kind: "parameter-choice" }>, state: ShellState): "operand" | "value" | "empty" | "unknown" => {
    const knownUnset = state.unsetVariables.has(part.name);
    const value = knownUnset ? "" : state.variables.get(part.name);
    if (value === undefined) return "unknown";
    const absent = knownUnset || (part.operator.startsWith(":") && value === "");
    return part.operator.endsWith("-") ? absent ? "operand" : "value" : absent ? "empty" : "operand";
  };
  const expandWord = (word: ShellWord, state: ShellState): string | undefined => {
    let output = "";
    for (const part of word.parts) {
      if (part.kind === "literal") output += part.value;
      else if (part.kind === "unicode-escaped") {
        if (state.unicodeEscapes !== true) return undefined;
        output += part.value;
      }
      else if (part.kind === "parameter") {
        if (part.index === "@") return undefined;
        const value = part.index === undefined ? state.unsetVariables.has(part.name) ? "" : state.variables.get(part.name)
          : state.arrays.has(part.name) ? state.arrays.get(part.name)?.[part.index]
          : part.index === 0 ? state.variables.get(part.name) : undefined;
        if (value === undefined) return undefined;
        if (!part.quoted && /[ \t\n*?\[\]]/.test(value)) return undefined;
        output += value;
      } else if (part.kind === "parameter-choice") {
        const choice = parameterChoice(part, state);
        const value = choice === "operand" ? expandWord(part.operand, state) : choice === "value" ? state.variables.get(part.name) : choice === "empty" ? "" : undefined;
        if (value === undefined || (!part.quoted && /[ \t\n*?\[\]]/.test(value))) return undefined;
        output += value;
      } else if (part.kind === "substitution" || part.kind === "arithmetic-data") {
        return undefined;
      } else if (part.kind === "pattern") return undefined;
      else decline(part.reason, word);
    }
    return output;
  };
  const resolveWord = (word: ShellWord, state: ShellState, depth: number, evaluation?: WordEvaluation): string | undefined => {
    inspectSubstitutions(word, state, depth, evaluation);
    return expandWord(word, state);
  };
  const resolveWords = (words: readonly ShellWord[], state: ShellState, depth: number, evaluation?: WordEvaluation): ShellWord[] => words.flatMap((word) => {
    const part = word.parts.length === 1 ? word.parts[0] : undefined;
    if (part?.kind === "parameter" && part.index === "@") {
      inspector.word?.(word);
      const elements = state.arrays.get(part.name);
      if (elements && elements.every((value) => value !== undefined && (part.quoted || !/[ \t\n*?\[\]]/.test(value)))) {
        return elements.map((value) => literalWord(value!, word.source));
      }
      return [word];
    }
    let resolved: string | undefined;
    try { resolved = resolveWord(word, state, depth, evaluation); }
    catch (error) {
      if (error instanceof ShellExecutionError && inspector.unresolvedWord?.(word, error) === true) return [word];
      throw error;
    }
    if (resolved === "" && !word.preservesEmpty) return [];
    return [resolved === undefined ? word : literalWord(resolved, word.source)];
  });
  const setScalar = (state: ShellState, name: string, value: string | undefined): void => {
    if (state.readonlyVariables.has(name)) decline("assignment to a readonly variable");
    state.variables.set(name, value);
    state.unsetVariables.delete(name);
    if (state.arrays.has(name)) {
      const elements = state.arrays.get(name);
      state.arrays.set(name, elements ? [value, ...elements.slice(1)] : undefined);
    }
  };
  const inspectSubstitutions = (word: ShellWord, state: ShellState, depth: number, evaluation?: WordEvaluation): void => {
    inspector.word?.(word);
    for (const part of word.parts) {
      if (part.kind === "substitution") {
        const results = walk(part.body, { ...cloneState(state), backquote: state.backquote || part.backquotes, errexit: undefined }, depth + 1, freshExecutionContext());
        if (!part.process && evaluation) {
          const statuses = new Set(results.map((result) => result.status));
          evaluation.lastSubstitutionStatus = statuses.size === 1 ? results[0]!.status : "unknown";
        }
      }
      if (part.kind === "parameter-choice") {
        const choice = parameterChoice(part, state);
        if (choice === "operand") inspectSubstitutions(part.operand, state, depth, evaluation);
        else if (choice === "unknown") {
          const optional: WordEvaluation = {};
          inspectSubstitutions(part.operand, state, depth, optional);
          if (evaluation && optional.lastSubstitutionStatus) evaluation.lastSubstitutionStatus = "unknown";
          if (evaluation && optional.mayFail) evaluation.mayFail = true;
        }
      }
      if (part.kind === "arithmetic-data") {
        for (const name of part.variables) {
          const value = state.unsetVariables.has(name) ? "0" : state.variables.get(name);
          if (value === undefined || state.arrays.has(name) || !/^[+-]?[0-9]+$/.test(value)) decline("unresolved arithmetic variable effects", word);
        }
        if (evaluation) evaluation.mayFail = true;
      }
      if (part.kind === "unknown") decline(part.reason, word);
    }
  };
  const applyAssignments = (node: ShellCommand, state: ShellState, incoming: ShellState, depth: number, evaluation: WordEvaluation): void => {
    for (const assignment of node.assignments) {
      const name = assignment.name;
      if (assignment.declarationOnly) {
        if (!state.variables.has(name)) state.variables.set(name, undefined);
        continue;
      }
      if (state.readonlyVariables.has(name)) decline("assignment to a readonly variable", assignment.value);
      assertStableShellEnvironmentVariable(name, assignment.value, "assignment");
      if (assignment.elements) {
        const elements = resolveWords(assignment.elements, state, depth, evaluation).map((word) => staticShellWord(word));
        const existing = state.arrays.get(name);
        const result = assignment.append ? existing ? [...existing, ...elements] : state.arrays.has(name) ? undefined : state.variables.has(name) ? [state.variables.get(name), ...elements] : elements : elements;
        state.arrays.set(name, result);
        state.variables.set(name, result?.[0]);
        state.unsetVariables.delete(name);
        continue;
      }
      const expansionState = node.assignmentScope === "command" && state.prefixAssignmentRhs === "incoming" ? incoming : state;
      let value = resolveWord(assignment.value, expansionState, depth, evaluation);
      if (node.assignmentScope === "command" && state.prefixAssignmentRhs === undefined
        && value !== expandWord(assignment.value, incoming)) value = undefined;
      setScalar(state, name, assignment.append
        ? state.variables.get(name) === undefined || value === undefined ? undefined : state.variables.get(name)! + value
        : value);
    }
  };
  const inspectNested = (text: string, state: ShellState, depth: number, origin?: ShellWord["source"]): void => {
    const key = `${state.dialect}\0${text}`;
    let nested = origin === undefined ? undefined : nestedAnalyses.get(origin)?.get(key);
    if (nested === undefined) {
      const analyzed = analyzeShell(text, state.dialect, remainingTokens === undefined ? undefined : { totalTokens: Math.max(1, remainingTokens) });
      if (!analyzed.ok) decline(`nested command cannot be analyzed: ${analyzed.reason}`);
      chargeAnalysis(analyzed);
      nested = analyzed;
      if (origin !== undefined) {
        let cached = nestedAnalyses.get(origin);
        if (!cached) { cached = new Map(); nestedAnalyses.set(origin, cached); }
        cached.set(key, nested);
      }
    }
    walk(nested.program, state, depth + 1, freshExecutionContext());
  };
  const markRedirectEffects = (redirects: readonly ShellRedirect[]): void => {
    if (redirects.some((redirect) => redirect.effect === "write" && redirect.target)) filesystemMayChange = true;
  };
  const inspectRedirects = (redirects: readonly ShellRedirect[], state: ShellState, depth: number): void => {
    for (const redirect of redirects) {
      if (redirect.target) {
        let path: string | undefined;
        try { path = resolveWord(redirect.target, state, depth); }
        catch (error) {
          if (error instanceof ShellExecutionError && inspector.unresolvedPath?.(redirect.target.source.raw, state.cwd, redirect.effect, error) === true) continue;
          throw error;
        }
        if (path === undefined) {
          if (inspector.unresolvedPath?.(redirect.target.source.raw, state.cwd, redirect.effect) === true) continue;
          decline("unresolved redirect target", redirect.target);
        }
        inspector.resolvedRedirect?.(redirect.target, path, redirect.effect, Object.fromEntries(state.variables));
        checkPath(path, redirect.target.source.raw, state, redirect.effect);
      }
      if (redirect.data) inspectSubstitutions(redirect.data, state, depth);
    }
  };
  const executeCommand = (node: ShellCommand, incoming: ShellState, depth: number, context: ExecutionContext, redirects: CommandRedirectObservation): StateResult[] => {
    const state = cloneState(incoming);
    const resolvedWords = resolveWords(node.words, incoming, depth);
    const assigned = cloneState(incoming);
    const assignmentEvaluation: WordEvaluation = {};
    applyAssignments(node, assigned, incoming, depth, assignmentEvaluation);
    redirects.state = cloneState(assigned);
    markRedirectEffects(node.redirects);
    if (node.words.length === 0) {
      inspectRedirects(node.redirects, assigned, depth);
      redirects.inspected = true;
      return [{ state: assigned, status: node.redirects.length || assignmentEvaluation.mayFail ? "unknown" : assignmentEvaluation.lastSubstitutionStatus ?? "success" }];
    }
    const resolvedNode = { ...node, words: resolvedWords };
    const effective = effectiveShellCommand(resolvedNode);
    const argv = effective.words.map((word) => staticShellWord(word));
    const head = argv[0];
    if (head === undefined) {
      if (effective.words.length === 0) return [{ state, status: "unknown" }];
      decline("unresolved executed command", effective.words[0]);
    }
    const verb = stripCommandPath(head);
    // Builtin recognition requires exact spelling; normalized paths, case variants, and .exe names are external programs.
    const shellBuiltin = head === verb && effective.wrappers.every((wrapper) => wrapper === "command" || wrapper === "time");
    const commandState = cloneState(assigned);
    commandState.inputRedirect = standardInputRedirect(node.redirects, incoming.inputRedirect);
    for (const assignment of node.assignments) commandState.exported.add(assignment.name);
    for (const transition of effective.environmentTransitions) {
      if (transition.kind === "reset") {
        commandState.variables.clear(); commandState.arrays.clear(); commandState.exported.clear(); commandState.unsetVariables.clear();
      } else if (transition.kind === "unset") {
        commandState.variables.delete(transition.name); commandState.arrays.delete(transition.name);
        commandState.exported.delete(transition.name); commandState.unsetVariables.add(transition.name);
      } else if (transition.kind === "set") {
        const assignment = transition.assignment;
        assertStableShellEnvironmentVariable(assignment.name, assignment.value, "environment");
        commandState.variables.set(assignment.name, staticShellWord(assignment.value)); commandState.exported.add(assignment.name);
        commandState.unsetVariables.delete(assignment.name);
      } else {
        const target = staticShellWord(transition.path);
        if (target === undefined) decline("unresolved wrapper working directory", transition.path);
        checkPath(target, transition.path.source.raw, commandState, "write", "directory");
        if (guest && target.split("/").includes("..")) decline("cannot resolve wrapper working directory", transition.path);
        try { commandState.cwd = guest ? resolveGuestShellPath(target, commandState.cwd) : resolveShellFilesystemPath(target, commandState.cwd!, { dialect: "bash" }); }
        catch (error) {
          if (!(error instanceof Error) || !("code" in error)) throw error;
          decline("cannot resolve wrapper working directory", transition.path);
        }
        commandState.variables.set("PWD", commandState.cwd);
      }
    }
    for (const path of effective.wrapperPaths) {
      const target = staticShellWord(path);
      if (target === undefined) decline("unresolved wrapper path", path);
      checkPath(target, path.source.raw, state, "read");
    }
    inspectRedirects(node.redirects, incoming, depth);
    redirects.inspected = true;
    if (effective.unsupported) decline(effective.unsupported, effective.words[0]);
    const functionBody = effective.wrappers.length === 0 && !head.includes("/") && state.functions.get(head);
    const testForm = functionBody || !shellBuiltin ? undefined
      : node.testForm === "double-bracket" ? "double-bracket"
      : verb === "test" ? "test"
      : verb === "[" ? "bracket"
      : undefined;
    const testAnalysis = testForm
      ? analyzeShellTestExpression(testForm, effective.words, argv, state.dialect)
      : undefined;
    if (testAnalysis && !testAnalysis.ok) {
      decline(testAnalysis.error.reason, testAnalysis.error.operandIndex === undefined ? effective.words[0] : effective.words[testAnalysis.error.operandIndex]);
    }
    let breakControl: BreakControl | undefined;
    if (!functionBody && shellBuiltin && verb === "break") {
      if (context.loopDepth === 0) decline("break has no local enclosing loop", effective.words[0]);
      if (argv.length > 2) decline("unsupported break argument count", effective.words[2]);
      const rawCount = argv.length === 1 ? "1" : argv[1];
      const count = rawCount !== undefined && /^[0-9]+$/.test(rawCount) ? parseProvenShellInteger(rawCount) : undefined;
      if (count === undefined || count < 1n) decline("unsupported break count", effective.words[1]);
      const levels = count > BigInt(context.loopDepth) ? context.loopDepth : Number(count);
      breakControl = { kind: "break", levels, boundary: context.boundary };
    }
    inspector.command({
      original: node, node: resolvedNode, effective, argv, cwd: commandState.cwd,
      environment: Object.freeze(Object.fromEntries(commandState.variables)), builtin: shellBuiltin,
      exportedEnvironment: Object.freeze(Object.fromEntries([...commandState.variables].filter(([name]) => commandState.exported.has(name) && !commandState.arrays.has(name)))),
      functionCall: !!functionBody, recursiveFunction: !!functionBody && state.activeFunctions.includes(head), backquote: state.backquote, pipeline: state.pipeline, fromPipe: state.fromPipe, activeFunctions: state.activeFunctions,
      definedFunctions: Object.freeze([...state.functions.keys()]),
      unsetVariables: Object.freeze([...commandState.unsetVariables]),
      dialect: state.dialect,
      inputRedirect: standardInputRedirect(node.redirects, state.inputRedirect),
      ...(testAnalysis?.ok ? { testExpression: testAnalysis.expression } : {}),
      inspectNested(text, dialect, nestedContext, origin) {
        const child = cloneState(commandState);
        child.dialect = dialect;
        child.unicodeEscapes = undefined; child.prefixAssignmentRhs = undefined;
        child.variables = new Map([...child.variables].filter(([name]) => child.exported.has(name) && !child.arrays.has(name)));
        child.arrays.clear(); child.functions.clear(); child.readonlyVariables.clear(); child.errexit = undefined;
        if (nestedContext) {
          child.cwd = nestedContext.cwd;
          child.variables = new Map(Object.entries(nestedContext.environment));
          child.exported = new Set(Object.keys(nestedContext.environment));
          child.unsetVariables = new Set(nestedContext.unsetVariables);
        }
        child.variables.set("PWD", child.cwd ?? undefined);
        inspectNested(text, child, depth, origin);
      },
    });
    if (functionBody) {
      if (state.activeFunctions.includes(head)) decline("recursive function execution cannot establish finite authority", effective.words[0]);
      const local = cloneState(commandState);
      local.activeFunctions = [...state.activeFunctions, head];
      for (const name of local.variables.keys()) if (/^\d+$/.test(name)) local.variables.delete(name);
      argv.slice(1).forEach((argument, index) => local.variables.set(String(index + 1), argument));
      return walk(functionBody, local, depth + 1, freshExecutionContext(context)).map((result) => {
        result.state.activeFunctions = state.activeFunctions;
        for (const name of result.state.variables.keys()) if (/^\d+$/.test(name)) result.state.variables.delete(name);
        for (const [name, value] of state.variables) if (/^\d+$/.test(name)) result.state.variables.set(name, value);
        for (const assignment of node.assignments) {
          if (state.exported.has(assignment.name)) result.state.exported.add(assignment.name);
          else result.state.exported.delete(assignment.name);
          if (state.variables.has(assignment.name)) result.state.variables.set(assignment.name, state.variables.get(assignment.name));
          else result.state.variables.delete(assignment.name);
          if (state.arrays.has(assignment.name)) result.state.arrays.set(assignment.name, state.arrays.get(assignment.name));
          else result.state.arrays.delete(assignment.name);
          if (state.unsetVariables.has(assignment.name)) result.state.unsetVariables.add(assignment.name);
          else result.state.unsetVariables.delete(assignment.name);
        }
        return result;
      });
    }
    // exit with a bad operand or a failed redirect returns instead of exiting.
    if (state.cdFault && shellBuiltin && verb === "exit" && !node.redirects.length && (argv.length === 1 || argv.length === 2 && /^[0-9]{1,9}$/u.test(argv[1] ?? ""))) return [];
    if (state.dialect === "posix" && shellBuiltin && [":", "export", "readonly", "set", "unset", "exit"].includes(verb)) {
      // Special builtins retain prefix assignments, but outer argv expansion uses incoming state.
      for (const assignment of node.assignments) setScalar(state, assignment.name, assigned.variables.get(assignment.name));
    }
    if (!functionBody && (!shellBuiltin || !["echo", "printf", "tr", "true", "false", ":", "pwd", "cd", "test", "[", "break", "set", "export", "readonly", "unset", "read"].includes(verb))) {
      filesystemMayChange = true;
    }
    const knownArgv = argv.map((argument) => argument ?? "");
    if (["eval", "source", ".", "exec", "builtin", "shopt", "trap", "alias", "unalias", "pushd", "popd", "continue", "return", "shift", "getopts", "mapfile", "readarray", "let", "enable", "hash"].includes(verb)) decline(`unsupported execution-state operation: ${verb}`, effective.words[0]);
    if (breakControl) return [{ state, status: "success", control: breakControl }];
    if (testAnalysis?.ok) return [{ state, status: testAnalysis.expression.status }];
    if (shellBuiltin && verb === "set") {
      for (let index = 1; index < argv.length; index += 1) {
        const option = argv[index];
        if (option !== undefined && /^[-+][euxvET]+$/.test(option)) {
          if (option.includes("e")) state.errexit = option.startsWith("-") ? true : undefined;
          continue;
        }
        if ((option === "-o" || option === "+o") && argv[index + 1] === "pipefail") { index += 1; continue; }
        decline("unsupported shell option state", effective.words[index]);
      }
      return [{ state, status: "success" }];
    }
    if (shellBuiltin && ["export", "readonly"].includes(verb)) {
      for (const assignment of node.assignments) {
        state.variables.set(assignment.name, assigned.variables.get(assignment.name));
        if (!assignment.declarationOnly) state.unsetVariables.delete(assignment.name);
        if (assigned.arrays.has(assignment.name)) state.arrays.set(assignment.name, assigned.arrays.get(assignment.name));
        if (verb === "export") state.exported.add(assignment.name);
        else state.readonlyVariables.add(assignment.name);
      }
      return [{ state, status: "success" }];
    }
    if (shellBuiltin && verb === "unset") {
      let namespace: "variable" | "function" | "either" = "either";
      let options = true;
      for (const name of argv.slice(1)) {
        if (options && name === "--") { options = false; continue; }
        if (options && (name === "-v" || name === "-f")) { namespace = name === "-v" ? "variable" : "function"; continue; }
        options = false;
        if (name === undefined || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) decline("unsupported unset operand");
        if (namespace === "function" || (namespace === "either" && !assigned.variables.has(name) && !assigned.arrays.has(name))) {
          state.functions.delete(name);
          continue;
        }
        if (state.readonlyVariables.has(name)) decline("unset of a readonly variable");
        // Unsetting a temporary command-prefix binding does not unset its parent binding.
        if (state.dialect === "posix" || !node.assignments.some((assignment) => assignment.name === name)) {
          state.variables.delete(name); state.unsetVariables.add(name); state.arrays.delete(name); state.exported.delete(name);
        }
      }
      return [{ state, status: "success" }];
    }
    if (shellBuiltin && verb === "printf" && argv[1] === "-v") {
      const name = argv[2];
      if (name === undefined || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) decline("unresolved printf variable", effective.words[2]);
      setScalar(state, name, undefined);
    }
    if (shellBuiltin && verb === "read") {
      const names: string[] = [];
      let raw = false;
      let simple = true;
      for (let index = 1; index < argv.length; index += 1) {
        const name = argv[index];
        if (name === "-r") { raw = true; continue; }
        if (name === "--") continue;
        if (name !== undefined && ["-d", "-n", "-N", "-p", "-t", "-u"].includes(name)) { simple = false; index += 1; continue; }
        if (name === undefined || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) decline("unsupported read variable", effective.words[index]);
        names.push(name);
      }
      const implicitReply = names.length === 0;
      if (implicitReply) names.push("REPLY");
      const data = node.redirects.length === 1 ? node.redirects[0]?.data : undefined;
      const text = data ? expandWord(data, incoming) : undefined;
      const line = text?.split("\n")[0];
      const value = raw && simple && names.length === 1 && line !== undefined
        ? implicitReply ? line : line.replace(/^[ \t]+|[ \t]+$/g, "") : undefined;
      // Interpreter versions differ when read writes a command-prefix variable; neither outcome grants authority without capability proof.
      for (const name of names) setScalar(state, name,
        node.assignments.some((assignment) => assignment.name === name) ? undefined : value);
      return [{ state, status: "unknown" }];
    }
    if (shellBuiltin && verb === "cd") {
      if (argv.some((argument) => argument === undefined)) decline("unresolved working-directory destination", effective.words[1]);
      const args: string[] = [];
      let options = true;
      let physical = false;
      let targetWord: ShellWord | undefined;
      for (let index = 1; index < knownArgv.length; index += 1) {
        const argument = knownArgv[index]!;
        if (options && argument === "--") { options = false; continue; }
        if (options && /^-[LP]+$/.test(argument)) { physical = argument.endsWith("P"); continue; }
        if (options && argument.startsWith("-") && argument !== "-") return [{ state, status: "failure" }];
        options = false;
        args.push(argument);
        targetWord ??= effective.words[index];
      }
      if (args.length > 1) return [{ state, status: "failure" }];
      const target = args[0] === "-" ? commandState.variables.get("OLDPWD") : args[0] ?? commandState.variables.get("HOME");
      // The one fault-path error that ends the path: the starting OLDPWD is outside the modeled script.
      if (target === undefined && args[0] === "-" && state.cdFault) return [];
      if (target === undefined) decline("unresolved working-directory destination", effective.words[1]);
      if (state.cwd === null && !isAbsolute(target)) decline("working directory is unresolved", targetWord);
      const label = targetWord?.source.raw ?? head;
      if (guest) {
        if (physical) decline("cannot resolve working-directory destination", targetWord);
        const destination = resolveGuestShellPath(target, state.cwd);
        checkPath(destination, label, state, "write", "directory");
        const changed = cloneState(state);
        changed.variables.set("OLDPWD", state.cwd ?? undefined);
        changed.cwd = destination;
        changed.variables.set("PWD", destination);
        // Existence and search permissions are unknown without workload filesystem access.
        return [{ state: changed, status: "success" }, { state, status: "failure" }];
      }
      const modeledTarget = modelShellPath(target, { dialect: "bash", location: state.cwd ?? undefined }).nativePath;
      if (modeledTarget === undefined) decline("working-directory namespace is unresolved", targetWord);
      const next = pathResolve(modeledTarget);
      let destination = next;
      if (physical) {
        try { destination = resolveShellFilesystemPath(target, state.cwd!, { dialect: "bash" }); }
        catch (error) {
          if (!(error instanceof Error) || !("code" in error)) throw error;
          decline("cannot resolve working-directory destination", targetWord);
        }
      }
      // A modeled fault path ends where it leaves the starting directory.
      if (state.cdFault && !within(cwd, destination)) return [];
      // Logical cd collapses .., but original components must still be searchable; physical cd follows links.
      checkPath(destination, label, state, "write", "directory");
      let observedDirectory = false;
      try {
        const original = process.platform === "win32" ? modeledTarget : isAbsolute(target) ? target : `${state.cwd!}/${target}`;
        observedDirectory = statSync(original).isDirectory();
        accessSync(original, constants.X_OK);
        accessSync(destination, constants.X_OK);
      } catch { observedDirectory = false; }
      const changed = cloneState(state);
      changed.variables.set("OLDPWD", state.cwd ?? undefined); changed.cwd = destination; changed.variables.set("PWD", destination);
      if (facts.hostCdFaults !== true) {
        // Another process can create the destination before execution.
        return !observedDirectory || filesystemMayChange
          ? [{ state: changed, status: "success" }, { state, status: "failure" }]
          : [{ state: changed, status: "success" }];
      }
      // Unsandboxed host: another process can also remove an observed destination before execution.
      // Failing to enter an ancestor leaves the shell in its current directory, whose identity is assumed throughout; errexit ends a failed cd outside a condition.
      const success: StateResult = { state: changed, status: "success" };
      // On a fault path a directory that failed to open stays missing until something may have changed.
      if (state.cdFault?.some((missing) => within(missing, destination)) && !filesystemMayChange) {
        const failed: StateResult[] = state.errexit && !context.condition ? [] : [{ state, status: "failure" }];
        return state.cdFault.length === 1 ? failed : [success, ...failed];
      }
      if (observedDirectory && state.cwd !== null && within(destination, state.cwd) || state.errexit && !context.condition) return [success];
      // A fault path models one failure: it forks again only after a possible change or for a fallback cd.
      if (state.cdFault && observedDirectory && !filesystemMayChange && !context.fallback) return [success];
      if (filesystemMayChange) {
        if (++flaggedCdForks > SHELL_ANALYSIS_LIMITS.states) decline("unresolved working-directory destination", targetWord);
      } else if (observedDirectory && ++unflaggedCdForks > UNFLAGGED_CD_FORK_LIMIT) decline("unresolved working-directory destination", targetWord);
      const failure = observedDirectory ? { ...cloneState(state), cdFault: faultUnion(state.cdFault ?? [], [destination]) } : state;
      return [success, { state: failure, status: "failure" }];
    }
    return [{ state, status: shellBuiltin && ["true", ":"].includes(verb) ? "success" : shellBuiltin && verb === "false" ? "failure" : "unknown" }];
  };
  const inspectCommand = (node: ShellCommand, incoming: ShellState, depth: number, context: ExecutionContext): StateResult[] => {
    const redirects: CommandRedirectObservation = { inspected: false };
    let results: StateResult[];
    try { results = executeCommand(node, incoming, depth, context, redirects); }
    catch (error) {
      if (error instanceof ShellExecutionError) failedCommandRedirects.set(error, redirects);
      throw error;
    }
    // Path admission does not prove redirect I/O success; a failed open prevents the whole body, including state changes and control transfers.
    return node.redirects.length
      ? uniqueResults([...results, { state: cloneState(incoming), status: "failure" }])
      : results;
  };
  const walk = (node: ShellStatement, state: ShellState, depth: number, context: ExecutionContext): StateResult[] => {
    if (++steps > SHELL_ANALYSIS_LIMITS.nodes) decline("execution-step limit exceeded");
    if (depth > SHELL_ANALYSIS_LIMITS.depth) decline("execution analysis depth exceeded");
    try {
    switch (node.kind) {
      case "unsupported": decline(node.reason);
      case "command": return inspectCommand(node, state, depth, context);
      case "redirected": {
        markRedirectEffects(node.redirects);
        inspectRedirects(node.redirects, state, depth);
        const bodyState = cloneState(state);
        bodyState.inputRedirect = standardInputRedirect(node.redirects, state.inputRedirect);
        return uniqueResults([...walk(node.body, bodyState, depth + 1, context),
          { state: cloneState(state), status: "failure" }]);
      }
      case "sequence": {
        let results: StateResult[] = [{ state, status: "success" }];
        for (const statement of node.statements) results = uniqueResults(withoutShadowedFaults(results).flatMap((result) =>
          result.control ? [result] : walk(statement, result.state, depth + 1, context)));
        return results;
      }
      case "and": case "or": {
        const results: StateResult[] = [];
        for (const left of walk(node.left, state, depth + 1, { ...context, condition: true })) {
          if (left.control) { results.push(left); continue; }
          const desired = node.kind === "and" ? "success" : "failure";
          if (left.status !== desired) results.push({ state: left.state, status: desired === "success" ? "failure" : "success" });
          const rightContext = node.kind === "or" && left.state.cdFault ? { ...context, fallback: true as const } : context;
          if (left.status === desired || left.status === "unknown") results.push(...walk(node.right, left.state, depth + 1, rightContext));
        }
        return uniqueResults(results);
      }
      case "if": {
        const results: StateResult[] = [];
        for (const condition of walk(node.condition, state, depth + 1, { ...context, condition: true })) {
          if (condition.control) { results.push(condition); continue; }
          if (condition.status !== "failure") results.push(...walk(node.consequent, condition.state, depth + 1, context));
          if (condition.status !== "success") results.push(...walk(node.alternate, condition.state, depth + 1, context));
        }
        return uniqueResults(results);
      }
      case "subshell": case "background": {
        const result = walk(node.body, cloneState(state), depth + 1, freshExecutionContext(context));
        if (result.some((entry) => entry.control)) decline("control transfer escaped execution boundary");
        // A fault path that ends inside the child process still continues in the parent.
        if (!result.length && state.cdFault) return [{ state, status: node.kind === "background" ? "success" : "unknown" }];
        return result.map((entry) => ({ state, status: node.kind === "background" ? "success" : entry.status }));
      }
      case "negate": return walk(node.body, state, depth + 1, { ...context, condition: true }).map((result) => result.control ? result : ({ ...result, status: result.status === "success" ? "failure" : result.status === "failure" ? "success" : "unknown" }));
      case "pipeline":
        node.statements.forEach((statement, index) => {
          const results = walk(statement, { ...cloneState(state), inputRedirect: index === 0 ? state.inputRedirect : undefined, pipeline: node.statements, fromPipe: index > 0 }, depth + 1, freshExecutionContext(context));
          if (results.some((entry) => entry.control)) decline("control transfer escaped execution boundary");
        });
        return [{ state, status: "unknown" }];
      case "function": { const next = cloneState(state); next.functions.set(node.name, node.body); return [{ state: next, status: "success" }]; }
      case "for": {
        if (node.values === null) decline("implicit loop values are unresolved");
        const values = resolveWords(node.values, state, depth).map((word) => {
          const value = staticShellWord(word);
          if (value === undefined) decline("unresolved loop value", word);
          return value;
        });
        if (values.length > SHELL_ANALYSIS_LIMITS.states) decline("loop expansion limit exceeded");
        const loopContext = { ...context, loopDepth: context.loopDepth + 1 };
        let active: StateResult[] = [{ state, status: "success" }];
        const exited: StateResult[] = [];
        for (const value of values) {
          active = uniqueResults(active.flatMap((result) => {
            const next = cloneState(result.state);
            setScalar(next, node.name, value);
            const continuing: StateResult[] = [];
            for (const body of walk(node.body, next, depth + 1, loopContext)) {
              if (!body.control) { continuing.push(body); continue; }
              exited.push(leaveLoop(body, context));
            }
            return continuing;
          }));
          if (active.length === 0) break;
        }
        return uniqueResults([...exited, ...active]);
      }
      case "while": {
        const results: StateResult[] = [];
        const pending: ShellState[] = [state];
        const seen = new Set<string>();
        const terminal = node.until ? "success" : "failure";
        const loopContext = { ...context, loopDepth: context.loopDepth + 1 };
        while (pending.length) {
          const current = pending.shift()!;
          const key = stateKey(current) + JSON.stringify(current.cdFault ?? null);
          if (seen.has(key)) continue;
          seen.add(key);
          if (seen.size > SHELL_ANALYSIS_LIMITS.states) declineStateLimit("loop authority state does not converge within the execution-state limit", [{ state: current }, ...pending.map((pendingState) => ({ state: pendingState }))]);
          for (const condition of walk(node.condition, current, depth + 1, { ...loopContext, condition: true })) {
            if (condition.control) {
              results.push(leaveLoop(condition, context));
              continue;
            }
            // The condition runs even when the body runs zero times.
            if (condition.status === terminal || condition.status === "unknown") results.push({ state: condition.state, status: "unknown" });
            if (condition.status !== terminal) {
              for (const body of walk(node.body, condition.state, depth + 1, loopContext)) {
                if (!body.control) { pending.push(body.state); continue; }
                results.push(leaveLoop(body, context));
              }
            }
          }
        }
        return uniqueResults(results);
      }
    }
    } catch (error) {
      if (!(error instanceof ShellExecutionError) || inspector.unresolvedState?.(error) !== true) throw error;
      if (node.kind === "unsupported" && node.redirected) {
        inspectRedirects(node.redirected.redirects, state, depth);
        const bodyState = cloneState(state);
        bodyState.inputRedirect = standardInputRedirect(node.redirected.redirects, state.inputRedirect);
        return uniqueResults([{ state: cloneState(state), status: "unknown" }, ...walk(node.redirected.body, bodyState, depth + 1, context)]);
      }
      const uncertain = cloneState(state);
      uncertain.cwd = null;
      uncertain.variables.clear(); uncertain.arrays.clear(); uncertain.exported.clear();
      uncertain.readonlyVariables.clear(); uncertain.unsetVariables.clear();
      filesystemMayChange = true;
      // Redirections are recognizable effects even when the executable or its state is opaque.
      const commandRedirects = failedCommandRedirects.get(error);
      if (node.kind === "command" && !commandRedirects?.inspected) for (const redirect of node.redirects) {
        try { inspectRedirects([redirect], commandRedirects?.state ?? uncertain, depth); }
        catch (redirectError) {
          if (!(redirectError instanceof ShellExecutionError) || inspector.unresolvedState?.(redirectError) !== true) throw redirectError;
        }
      }
      // Unknown loop values can execute the existing body zero or more times.
      // Visit it once with unknown bindings through the same bounded walker.
      if (node.kind === "for") {
        const dataOnlyValues = error.message === "unresolved loop value" && node.values !== null
          && node.values.every(word => word.parts.every(part => part.kind === "literal" || part.kind === "parameter"));
        const loopState = dataOnlyValues ? cloneState(state) : cloneState(uncertain);
        loopState.variables.set(node.name, undefined);
        loopState.arrays.delete(node.name); loopState.unsetVariables.delete(node.name);
        const body = walk(node.body, loopState, depth + 1, { ...context, loopDepth: context.loopDepth + 1 });
        return uniqueResults([{ state: dataOnlyValues ? state : uncertain, status: "unknown" }, ...body.map(result => result.control ? leaveLoop(result, context) : result)]);
      }
      if (node.kind === "redirected") return uniqueResults([
        { state: uncertain, status: "unknown" },
        ...walk(node.body, cloneState(uncertain), depth + 1, context),
      ]);
      return [{ state: uncertain, status: "unknown" }];
    }
  };
  const results = walk(analysis.program, initial, 0, rootExecutionContext);
  if (results.some((result) => result.control)) decline("unconsumed shell control transfer");
}
