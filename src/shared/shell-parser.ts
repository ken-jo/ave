import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";

interface ParserRuntime {
  importObject: WebAssembly.Imports;
  exited?: boolean;
  run(instance: WebAssembly.Instance): Promise<void>;
}
interface ParserLimits { sourceBytes: number; nodes: number; depth: number; outputBytes: number }
export interface ShellParserLimits { totalTokens: number }
type ParseFunction = (source: string, limits?: ShellParserLimits) => string;
const runtimeGlobal = globalThis as typeof globalThis & {
  Go?: new () => ParserRuntime;
  _aveShellParserBridge?: { ready: (parse: ParseFunction, limits: ParserLimits) => void };
};
const require = createRequire(import.meta.url);
const manifest = JSON.parse(readFileSync(require.resolve("@ave/shell-parser-runtime/manifest.json"), "utf8")) as { wasmSha256: string; runtimeSha256: string };
const wasmBytes = readFileSync(require.resolve("@ave/shell-parser-runtime/parser.wasm"));
const runtimeBytes = readFileSync(require.resolve("@ave/shell-parser-runtime/wasm_exec.cjs"));
if (createHash("sha256").update(wasmBytes).digest("hex") !== manifest.wasmSha256
  || createHash("sha256").update(runtimeBytes).digest("hex") !== manifest.runtimeSha256) throw new Error("Shell parser asset integrity check failed");
require("@ave/shell-parser-runtime/wasm_exec.cjs");
if (!runtimeGlobal.Go || runtimeGlobal._aveShellParserBridge) throw new Error("Shell parser initialization conflict");
const runtime = new runtimeGlobal.Go();
let parseFunction: ParseFunction | undefined;
let limits: Readonly<ParserLimits> | undefined;
let runtimeFailure: Error | undefined;
runtimeGlobal._aveShellParserBridge = {
  ready(parse, suppliedLimits) {
    if (parseFunction || typeof parse !== "function" || !suppliedLimits
      || !["sourceBytes", "nodes", "depth", "outputBytes"].every((key) => Number.isSafeInteger(suppliedLimits[key as keyof ParserLimits]) && suppliedLimits[key as keyof ParserLimits] > 0)) {
      throw new Error("Invalid shell parser initialization");
    }
    parseFunction = parse;
    limits = Object.freeze({ ...suppliedLimits });
  },
};
try {
  const { instance } = await WebAssembly.instantiate(wasmBytes, runtime.importObject);
  // Starting the runtime registers the synchronous callback before yielding; its lifetime promise must remain pending while the callback is callable.
  void runtime.run(instance).then(() => { runtimeFailure = new Error("Shell parser runtime exited"); }, (error: unknown) => {
    runtimeFailure = error instanceof Error ? error : new Error("Shell parser runtime failed");
  });
  // An immediately settled runtime is not ready, even if it called ready first.
  await Promise.resolve();
  if (runtimeFailure) throw runtimeFailure;
  if (runtime.exited) throw new Error("Shell parser runtime exited during initialization");
  if (!parseFunction || !limits) throw new Error("Shell parser did not become ready");
} finally {
  delete runtimeGlobal._aveShellParserBridge;
}
const parse = parseFunction;
export const SHELL_ANALYSIS_LIMITS = Object.freeze({ ...limits, states: 64 });
export class ShellAnalysisError extends Error {}

export interface ShellSyntaxNode {
  Type?: string;
  Pos?: { Offset: number; Line?: number; Col?: number };
  End?: { Offset: number; Line?: number; Col?: number };
  [field: string]: unknown;
}

/** Every call uses the initialized grammar; no source or syntax cache is kept. */
export function parseShellSyntax(source: string, parserLimits?: ShellParserLimits): ShellSyntaxNode {
  const result = parseShellSyntaxResult(source, parserLimits);
  if ("error" in result) throw new ShellAnalysisError(result.error);
  return result.tree;
}

type ShellParserResult = { tree: ShellSyntaxNode; totalTokens: number } | { error: string; totalTokens: number };

function parseShellSyntaxResult(source: string, parserLimits?: ShellParserLimits): ShellParserResult {
  if (runtime.exited && !runtimeFailure) runtimeFailure = new Error("Shell parser runtime exited");
  if (runtimeFailure) throw runtimeFailure;
  // Preserve source identity before crossing the UTF-8 runtime boundary.
  if (/\p{Cs}/u.test(source)) throw new ShellAnalysisError("Shell command contains an unpaired surrogate");
  if (Buffer.byteLength(source, "utf8") > SHELL_ANALYSIS_LIMITS.sourceBytes) throw new ShellAnalysisError("Shell analysis source limit exceeded");
  const bytes = Buffer.from(source, "utf8");
  try {
    const serialized = parserLimits === undefined ? parse(source) : parse(source, parserLimits);
    if (typeof serialized !== "string" || Buffer.byteLength(serialized, "utf8") > SHELL_ANALYSIS_LIMITS.outputBytes) throw new Error("Invalid shell parser output");
    const result: unknown = JSON.parse(serialized);
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Invalid shell parser result");
    const keys = Object.keys(result);
    if (!("totalTokens" in result) || !Number.isSafeInteger(result.totalTokens) || (result.totalTokens as number) < 0) throw new Error("Invalid shell parser token count");
    if ("error" in result) {
      if (keys.length !== 2 || typeof result.error !== "string" || !result.error) throw new Error("Invalid shell parser failure");
      return { error: result.error, totalTokens: result.totalTokens as number };
    }
    if (keys.length !== 5 || !("tree" in result) || !result.tree || typeof result.tree !== "object" || Array.isArray(result.tree)
      || !("Type" in result.tree) || result.tree.Type !== "File"
      || !("braceWords" in result) || !Array.isArray(result.braceWords)
      || !("escapedStrings" in result) || !result.escapedStrings || typeof result.escapedStrings !== "object" || Array.isArray(result.escapedStrings)) throw new Error("Missing shell syntax tree");
    const validRange = (range: unknown): boolean => Array.isArray(range) && range.length === 2
      && range.every((offset) => Number.isSafeInteger(offset) && offset >= 0 && offset <= bytes.length
        && (offset === bytes.length || (bytes[offset]! & 0xc0) !== 0x80))
      && range[0] <= range[1];
    if (result.braceWords.length > SHELL_ANALYSIS_LIMITS.nodes || !result.braceWords.every(validRange)) throw new Error("Invalid shell brace annotations");
    if (!("literalHeredocs" in result) || !Array.isArray(result.literalHeredocs)) throw new Error("Invalid shell literal data annotations");
    const literalHeredocs = result.literalHeredocs;
    if (literalHeredocs.length > SHELL_ANALYSIS_LIMITS.nodes || literalHeredocs.some((range, index) =>
      !Array.isArray(range) || range.length !== 4 || !validRange(range.slice(0, 2))
      || !range.slice(2).every((offset) => Number.isSafeInteger(offset) && offset >= 0 && offset <= source.length)
      || range[2] > range[3] || (index > 0 && literalHeredocs[index - 1][1] > range[0]))) throw new Error("Invalid shell literal data range");
    const strings = Object.entries(result.escapedStrings);
    if (strings.length > SHELL_ANALYSIS_LIMITS.nodes || strings.some(([range, value]) => !validRange(JSON.parse(range)) || typeof value !== "string" || value.includes("\0"))) throw new Error("Invalid shell string annotations");
    return { tree: { ...result.tree, BraceWords: result.braceWords, EscapedStrings: result.escapedStrings, LiteralHeredocs: result.literalHeredocs, TotalTokens: result.totalTokens } as ShellSyntaxNode, totalTokens: result.totalTokens as number };
  } catch (error) {
    if (error instanceof ShellAnalysisError) throw error;
    // A runtime trap or broken ABI may poison the runtime; never re-enter it.
    runtimeFailure = error instanceof Error ? error : new Error("Shell parser runtime failed");
    throw runtimeFailure;
  }
}
