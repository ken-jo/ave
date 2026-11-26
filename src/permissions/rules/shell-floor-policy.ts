export const SHELL_FLOOR_INPUT_LIMIT = 8_000;
export const SHELL_LITERAL_DATA_LIMIT = 65_536;
const shellFloorLiteralDataLengths = new WeakMap<object, number>();
const shellFloorLiteralDataWords = new WeakSet<object>();

// Only the original-grammar heredoc verifier records this bounded data allowance.
export function recordShellFloorLiteralData(input: { readonly command: string }, chars: number, words: readonly object[] = []): void {
  if (!Number.isSafeInteger(chars) || chars < 0 || chars > SHELL_LITERAL_DATA_LIMIT || chars > input.command.length) {
    throw new Error("Invalid shell literal data length");
  }
  shellFloorLiteralDataLengths.set(input, chars);
  for (const word of words) shellFloorLiteralDataWords.add(word);
}
export function isShellFloorLiteralData(word: object): boolean { return shellFloorLiteralDataWords.has(word); }

export const SHELL_FLOOR_BUDGET_REASON = "Shell floor analysis budget exceeded";
const SHELL_PARSER_BUDGET_ERRORS = new Set([
  "Shell analysis source limit exceeded",
  "Shell analysis syntax limit exceeded",
  "Shell syntax output limit exceeded",
  "Shell analysis total token limit exceeded",
]);

export interface ShellFloorSignals {
  outcome: "visible-floor" | "unproven" | "static-complete";
  sensitive: string | null;
  exfiltration: string | null;
  ordinaryAsk?: string;
  analysisLimited?: true;
  exactLiteralEvaluation?: true;
}

export function shellFloorInputExceeded(input: string | { readonly command: string }): boolean {
  return typeof input === "string" ? input.length > SHELL_FLOOR_INPUT_LIMIT
    : input.command.length - (shellFloorLiteralDataLengths.get(input) ?? 0) > SHELL_FLOOR_INPUT_LIMIT;
}

export function shellFloorBudgetSignals(): ShellFloorSignals {
  return { outcome: "unproven", sensitive: null, exfiltration: null, ordinaryAsk: SHELL_FLOOR_BUDGET_REASON, analysisLimited: true };
}

// Stable limit errors emitted by the repository's parser runtime; syntax refusals are not exhaustion.
export function shellFloorParserBudgetExceeded(reason: string): boolean {
  return SHELL_PARSER_BUDGET_ERRORS.has(reason) || /^(?:\d+:\d+: )?shell (?:parser recursion|total token) limit exceeded$/.test(reason);
}
import { matcherMemo, withLocalityDecision } from "../../shared/local-path-io.js";
import { caseFoldForMatch, createConfiguredSessionReadPathMatcher, createKeyMaterialPathMatcher, createPathCanonicalizer, createSensitiveLocationMatcher, createSensitivePathMatcher, foldCanonicalPathSeparators, MAX_WALK_UP } from "../sensitive-paths.js";
import { MAX_SHELL_ANALYSIS_TOKENS } from "../../shared/shell-analysis-limits.js";
import { type ShellPathDialect } from "../../shared/shell-native-path.js";
import { resolvePhysicalFilesystemPath } from "../../shared/shell-filesystem-path.js";
import { posix } from "node:path";

export class ShellFloorLimitError extends Error {}

// Facts live for one decision, independently of execution time or machine load.
export class ShellFloorContext {
  readonly inspectHostFiles: boolean;
  readonly canonicalize: ReturnType<typeof createPathCanonicalizer>;
  readonly isSessionReadPath: ReturnType<typeof createConfiguredSessionReadPathMatcher>;
  readonly locationUnder: ReturnType<typeof createSensitiveLocationMatcher>;
  private readonly match: ReturnType<typeof createSensitivePathMatcher>;
  private contentInspections = { count: 0 };

  constructor(readonly pathDialect: ShellPathDialect = "bash", options: { inspectHostFiles?: boolean } = {}) {
    this.inspectHostFiles = options.inspectHostFiles !== false;
    this.canonicalize = this.inspectHostFiles ? createPathCanonicalizer() : path => foldCanonicalPathSeparators(posix.normalize(path));
    this.isSessionReadPath = this.inspectHostFiles ? createConfiguredSessionReadPathMatcher() : () => false;
    this.locationUnder = this.inspectHostFiles ? createSensitiveLocationMatcher(this.canonicalize) : directory => this.matchName(directory, true);
    this.match = createSensitivePathMatcher("read", undefined, this.canonicalize, {
      inspectKeyMaterial: this.inspectHostFiles,
      resolveNativePath: path => resolvePhysicalFilesystemPath(path, process.cwd(), MAX_WALK_UP),
    });
  }
  unresolvedPath = false;
  readonly retained: { sensitive: string | null; exfiltration: string | null } = { sensitive: null, exfiltration: null };
  readonly visits = { frames: 0, stages: 0, lexes: 0, transfers: 0, walk: 0, inventory: 0, commands: 0, feeder: 0, code: 0, coverage: 0, codeNodes: 0, codeWordLinks: 0, codeSourceChars: 0, codeTokenFacts: 0, codeTokenUses: 0, codeCoverage: 0, codeRangeSteps: 0, staticTokens: 0, staticArguments: 0, staticChars: 0, staticNodes: 0, staticViews: 0 };
  readonly facts = new Map<string, unknown>();
  readonly requiresContentInspection = createKeyMaterialPathMatcher();
  private matchNames: ReturnType<typeof createSensitivePathMatcher> | undefined;
  private matchOpaqueNames: ReturnType<typeof createSensitivePathMatcher> | undefined;
  private readonly pathMatchOwner = {};
  private readonly nameMatchOwner = {};

  get contentInspectionCount(): number { return this.contentInspections.count; }

  createChild(dialect: ShellPathDialect): ShellFloorContext {
    const child = new ShellFloorContext(dialect, { inspectHostFiles: this.inspectHostFiles });
    if (process.platform !== "win32") child.contentInspections = this.contentInspections;
    return child;
  }

  matchPath(path: string): string | null {
    const match = (): string | null => {
      if (this.requiresContentInspection(path)) {
        if (process.platform !== "win32" && this.inspectHostFiles) this.contentInspections.count += 1;
        return this.match(path);
      }
      const matches = matcherMemo<string | null>(this.pathMatchOwner);
      const cached = matches.get(path);
      if (cached !== undefined) return cached;
      const hit = this.match(path);
      matches.set(path, hit);
      return hit;
    };
    return process.platform === "win32" ? withLocalityDecision(match) : match();
  }

  matchName(path: string, includeKeyMaterial = false): string | null {
    const match = (): string | null => {
      const folded = caseFoldForMatch(foldCanonicalPathSeparators(path));
      const key = JSON.stringify([includeKeyMaterial, folded]);
      const matches = matcherMemo<string | null>(this.nameMatchOwner);
      const cached = matches.get(key);
      if (cached !== undefined) return cached;
      let matcher: ReturnType<typeof createSensitivePathMatcher>;
      if (includeKeyMaterial) {
        if (this.matchOpaqueNames === undefined) this.matchOpaqueNames = createSensitivePathMatcher("read", undefined, undefined, { inspectKeyMaterial: false });
        matcher = this.matchOpaqueNames;
      } else {
        if (this.matchNames === undefined) this.matchNames = createSensitivePathMatcher("read", undefined, undefined, { includeKeyMaterial: false });
        matcher = this.matchNames;
      }
      const hit = matcher(folded);
      matches.set(key, hit);
      return hit;
    };
    return process.platform === "win32" ? withLocalityDecision(match) : match();
  }
}

// An unparsed tail cannot claim that apparent word boundaries are quoted data.
// Count its existing visible spans before invoking any path or effect scanner.
export function shellFloorFallbackInputExceeded(command: string): boolean {
  let tokens = 0;
  for (const _match of command.matchAll(/[^\s;|&()<>{}\[\],"'`]+/g)) {
    if (++tokens > MAX_SHELL_ANALYSIS_TOKENS) return true;
  }
  return false;
}
