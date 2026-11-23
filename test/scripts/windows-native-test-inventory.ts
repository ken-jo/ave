import { transformSync } from "esbuild";
import { readFileSync, readdirSync } from "node:fs";
import { join, posix } from "node:path";
import { createRequire } from "node:module";
import { MessageChannel, receiveMessageOnPort, Worker } from "node:worker_threads";
import { createScanner } from "typescript/unstable/ast/scanner";
import { conditionalGates } from "./windows-test-gates.js";
import { isCollectedVitestFile } from "../../scripts/lib/vitest-collection.mjs";
import { assertWindowsMarkerPlacement, hasWindowsInventoryMarker } from "../../scripts/windows-test-inventory.mjs";

const SOURCE_FILE = /\.[cm]?[jt]sx?$/;

export function isInventorySource(file: string): boolean {
  return SOURCE_FILE.test(file) && !/\.d\.[cm]?ts$/.test(file)
    && !/^test\/(?:e2e|screenshots|smoke)\//.test(file);
}

function runtimeTokens(file: string, source: string, transformed?: string): string[] {
  const code = transformed ?? transformSync(source, {
    loader: file.endsWith("x") ? "tsx" : "ts",
    tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: true } },
  }).code;
  const scanner = createScanner(true, undefined, code);
  const tokens: string[] = [];
  const templates: number[] = [];
  let braces = 0;
  while (true) {
    scanner.scan();
    let text = scanner.getTokenText();
    if (!text) break;
    if (text === "}" && templates.at(-1) === braces) {
      scanner.reScanTemplateToken(false);
      text = scanner.getTokenText();
      if (!text.endsWith("${")) templates.pop();
      continue;
    }
    if (text.startsWith("`") && text.endsWith("${")) templates.push(braces);
    if (text === "/" && /^(?:|=|\(|\[|\{|,|:|;|return|=>|!|\?|&&|\|\|)$/.test(tokens.at(-1) ?? "")) {
      scanner.reScanSlashToken();
      text = scanner.getTokenText();
    }
    if (text === "}") braces--;
    tokens.push(text);
    if (text === "{") braces++;
  }
  return tokens;
}

function literal(token: string | undefined): string | undefined {
  return token !== undefined && ((token[0] === '"' || token[0] === "'")
    || (token.startsWith("`") && token.endsWith("`") && !token.includes("${"))) ? token.slice(1, -1) : undefined;
}

function isComputedRequireMember(tokens: readonly string[], index: number): boolean {
  if (literal(tokens[index]) !== "require" || tokens[index - 1] !== "[" || tokens[index + 1] !== "]") return false;
  const receiver = tokens[index - 2] ?? "";
  return ["?.", ")", "]", "}"].includes(receiver) || literal(receiver) !== undefined || /^(?:\d|\.\d)/.test(receiver)
    || (/^[$A-Z_a-z][$\w]*$/.test(receiver)
      && !["return", "throw", "yield", "await", "new", "delete", "void", "typeof", "in", "instanceof", "case", "else", "do"].includes(receiver));
}

function requireCallArgumentIndex(tokens: readonly string[], index: number): number | undefined {
  const member = isComputedRequireMember(tokens, index);
  if (tokens[index] !== "require" && !member) return undefined;
  const end = index + (member ? 2 : 1);
  const opening = end + (tokens[end] === "?." ? 1 : 0);
  return tokens[opening] === "(" ? opening + 1 : undefined;
}

function isPossibleRequireLoad(tokens: readonly string[], index: number): boolean {
  if (isComputedRequireMember(tokens, index)) return true;
  if (tokens[index] !== "require") return false;
  if (tokens[index + 1] !== ":" || !["{", ","].includes(tokens[index - 1] ?? "")) return true;
  // Only recognizable object-literal keys are harmless; binding patterns and ambiguous contexts retain coverage.
  const containers: number[] = [];
  for (let position = 0; position < index; position++) {
    if (["{", "[", "("].includes(tokens[position] ?? "")) containers.push(position);
    if (["}", "]", ")"].includes(tokens[position] ?? "")) containers.pop();
  }
  if (tokens[containers.at(-1) ?? -1] !== "{") return true;
  let possibleLabel = false;
  for (let container = containers.length - 1; container >= 0; container--) {
    const opening = containers[container] ?? -1;
    const delimiter = tokens[opening];
    const previous = tokens[opening - 1];
    if (["const", "let", "var"].includes(previous ?? "")) return true;
    if (delimiter === "{" && [undefined, ")", "=>", ";", "{", "}", "else", "do", "try", "finally"].includes(previous)) {
      return container === containers.length - 1 || possibleLabel;
    }
    let closing = opening;
    let depth = 1;
    const closingDelimiter = delimiter === "{" ? "}" : delimiter === "[" ? "]" : ")";
    while (++closing < tokens.length && depth > 0) {
      if (tokens[closing] === delimiter) depth++;
      if (tokens[closing] === closingDelimiter) depth--;
    }
    if (delimiter !== "(" && ["=", "of", "in"].includes(tokens[closing] ?? "")) return true;
    if (delimiter === "(" && (tokens[closing] === "=>" || tokens[closing] === "{" || previous === "catch")
      && !["if", "while", "switch", "with"].includes(previous ?? "")) return true;
    if (delimiter === "(") return false;
    if (["=", "return", "?", "=>"].includes(previous ?? "")) return false;
    if (delimiter === "{" && previous === ":") {
      possibleLabel = true;
      let nested = 0;
      let conditionals = 0;
      for (let position = opening - 2; position > (containers[container - 1] ?? -1); position--) {
        const token = tokens[position];
        if (["}", "]", ")"].includes(token ?? "")) nested++;
        if (["{", "[", "("].includes(token ?? "")) nested--;
        if (nested !== 0) continue;
        if (token === ":") conditionals++;
        if (token === "?" && conditionals-- === 0) { possibleLabel = false; break; }
      }
    }
  }
  return false;
}

function runtimeImports(tokens: readonly string[]): { imports: string[]; actualImports: string[]; mocks: string[] } {
  const imports = new Set<string>();
  const actualImports = new Set<string>();
  const mocks = new Set<string>();
  const unmocks = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token !== "import" && token !== "export" && token !== "vi" && token !== "require"
      && token !== '"require"' && token !== "'require'" && token !== "`require`") continue;
    const next = tokens[i + 1];
    const nextLiteral = literal(next);
    const argument = literal(tokens[i + 2]);
    const requireIndex = requireCallArgumentIndex(tokens, i);
    const requireArgument = requireIndex === undefined ? undefined : literal(tokens[requireIndex]);
    if (token === "import" && nextLiteral !== undefined) imports.add(nextLiteral);
    else if (token === "import" && next === "(" && argument !== undefined) imports.add(argument);
    else if (requireArgument !== undefined) imports.add(requireArgument);
    else if ((token === "import" && next !== "." && next !== "(") || (token === "export" && (next === "{" || next === "*"))) {
      for (let j = i + 1; j < tokens.length && ![";", "="].includes(tokens[j] ?? ""); j++) {
        const specifier = literal(tokens[j + 1]);
        if (tokens[j] === "from" && specifier !== undefined) { imports.add(specifier); break; }
      }
    }
    if (requireArgument !== undefined) actualImports.add(requireArgument);
    if (token !== "vi" || next !== "." || tokens[i + 3] !== "(") continue;
    const name = literal(tokens[i + 4]);
    if (name === undefined) continue;
    const method = tokens[i + 2];
    if (["unmock", "doUnmock", "importActual"].includes(method ?? "")) unmocks.add(name);
    if (method === "importActual") { imports.add(name); actualImports.add(name); }
    if (method !== "mock" || tokens[i + 5] !== ",") continue;
    let factory = i + 6;
    if (tokens[factory] === "async") factory++;
    // Only a complete hoisted factory cuts a runtime edge. Auto-mocks, partial factories and later unmocking retain it.
    if (tokens[factory] !== "(" || tokens[factory + 1] !== ")" || tokens[factory + 2] !== "=>") continue;
    let end = i + 4;
    let depth = 1;
    while (++end < tokens.length && depth > 0) {
      if (tokens[end] === "(") depth++;
      if (tokens[end] === ")") depth--;
    }
    if (!tokens.slice(factory, end).some((text, index) =>
      ["importActual", "importOriginal", "import"].includes(text) || isPossibleRequireLoad(tokens, factory + index))) mocks.add(name);
  }
  return { imports: [...imports], actualImports: [...actualImports], mocks: [...mocks].filter(name => !unmocks.has(name)) };
}

const require = createRequire(import.meta.url);
const TRANSFORM_BATCH_SIZE = 128;
const TRANSFORM_REPLY_TIMEOUT_MS = 5000;
const TRANSFORM_POLL_INTERVAL_MS = 50;
const TRANSFORM_WORKER = `
const { workerData } = require("node:worker_threads");
const { port, signal, sources, transformer, batchSize } = workerData;
(async () => {
  let compiler;
  try {
    compiler = require(transformer);
    for (let i = 0; i < sources.length; i += batchSize) {
      const results = await Promise.all(sources.slice(i, i + batchSize).map(async ([file, source]) => [file, (await compiler.transform(source, {
        loader: file.endsWith("x") ? "tsx" : "ts",
        tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: true } },
      })).code]));
      port.postMessage({ results });
      Atomics.add(signal, 0, 1);
      Atomics.notify(signal, 0);
    }
  } catch (error) {
    port.postMessage({ error: error instanceof Error ? error.message : String(error) });
  } finally {
    compiler?.stop();
    port.close();
    Atomics.add(signal, 0, 1);
    Atomics.notify(signal, 0);
  }
})();
`;

function* transformedSources(sources: ReadonlyMap<string, string>, replyTimeoutMs: number): Generator<[string, string, string | undefined]> {
  const entries = [...sources].filter(([file]) => isInventorySource(file));
  // Small fixture graphs avoid worker startup; large graphs overlap compilation and scanning.
  if (entries.length < 32) {
    for (const [file, source] of entries) yield [file, source, undefined];
    return;
  }
  const { port1, port2 } = new MessageChannel();
  let worker: Worker | undefined;
  try {
    const signal = new Int32Array(new SharedArrayBuffer(4));
    worker = new Worker(TRANSFORM_WORKER, {
      eval: true,
      execArgv: [],
      workerData: { port: port2, signal, sources: entries, transformer: require.resolve("esbuild"), batchSize: TRANSFORM_BATCH_SIZE },
      transferList: [port2],
    });
    let failure: Error | undefined;
    // Events cannot run during the synchronous scan; the reply deadline also covers startup and abrupt exits.
    worker.on("error", error => { failure = error instanceof Error ? error : new Error(String(error)); });
    worker.on("exit", code => { failure ??= new Error(`Source transform worker exited with code ${code}`); });
    let consumed = 0;
    let deadline = performance.now() + replyTimeoutMs;
    while (consumed < entries.length) {
      if (failure) throw new Error("Source transform worker failed", { cause: failure });
      const version = Atomics.load(signal, 0);
      const response = receiveMessageOnPort(port1)?.message as { results?: [string, string][]; error?: string } | undefined;
      if (response === undefined) {
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw new Error(`Source transform worker stalled or exited before replying within ${replyTimeoutMs}ms`);
        Atomics.wait(signal, 0, version, Math.min(remaining, TRANSFORM_POLL_INTERVAL_MS));
        continue;
      }
      if (response.results === undefined) throw new Error(response.error ?? "Source transforms unavailable");
      for (const [file, code] of response.results) {
        const source = sources.get(file);
        if (source === undefined) throw new Error("Source transform mismatch");
        consumed++;
        yield [file, source, code];
      }
      deadline = performance.now() + replyTimeoutMs;
    }
  } finally {
    port1.close();
    port2.close();
    void worker?.terminate();
  }
}

type Edge = { file: string; actual: boolean; specifier: string };
type RuntimeModule = { dependencies: Edge[]; mocks: Set<string>; tokens: string[] };

const WINDOWS_MODULE = /^src\/(?!.*\/__tests__\/)(?:.*\/)?(?:windows-|win32-)[^/]+\.[cm]?[jt]sx?$/u;
const WINDOWS_EXTERNAL = /^(?:@?win32[-/]|winreg$|@microsoft\/mxc-sdk(?:\/|$)|@koromix\/koffi-win32-)/u;
const WINDOWS_HELPER = /(?:^|[\\/])(?:wxc-exec|ave-(?:job|path-kind|acl-host)|srt-win|icacls|reg)(?:\.exe)?$/iu;

export function windowsImportGraph(sources: ReadonlyMap<string, string>, replyTimeoutMs = TRANSFORM_REPLY_TIMEOUT_MS) {
  const resolveImport = (file: string, specifier: string): string | undefined => {
    if (!specifier.startsWith(".") && !specifier.startsWith("@/")) return undefined;
    const path = specifier.startsWith("@/") ? posix.join("src", specifier.slice(2))
      : posix.normalize(posix.join(posix.dirname(file), specifier));
    return [path, path.replace(/\.js$/, ".ts"), path.replace(/\.js$/, ".tsx"), path.replace(/\.mjs$/, ".mts"),
      path.replace(/\.cjs$/, ".cts"), ...[".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]
        .flatMap(extension => [path + extension, `${path}/index${extension}`])].find(candidate => sources.has(candidate));
  };
  const graph = new Map<string, RuntimeModule>();
  for (const [file, source, transformed] of transformedSources(sources, replyTimeoutMs)) {
    const tokens = runtimeTokens(file, source, transformed);
    const parsed = runtimeImports(tokens);
    const dependencies = parsed.imports.map(specifier => ({
      file: resolveImport(file, specifier) ?? specifier, actual: parsed.actualImports.includes(specifier), specifier,
    }));
    const mocks = new Set(parsed.mocks.map(specifier => resolveImport(file, specifier) ?? specifier));
    graph.set(file, { dependencies, mocks, tokens });
  }
  return graph;
}

function declarationBindings(tokens: readonly string[]): [string, string][] {
  const entries: [string, string][] = [];
  for (let i = 0; i < tokens.length; i++) {
    const original = tokens[i] ?? "";
    const aliased = tokens[i + 1] === "as" || tokens[i + 1] === ":";
    const alias = aliased ? tokens[i + 2] ?? "" : original;
    if (aliased) i += 2;
    if (/^[$\w]+$/u.test(original) && /^[$\w]+$/u.test(alias)) entries.push([alias, original]);
  }
  return entries;
}

function moduleBindings(tokens: readonly string[], specifier: string) {
  const immediate = new Set<string>();
  const bindings = new Map<string, string>();
  for (let i = 0; i < tokens.length; i++) {
    if (literal(tokens[i]) !== specifier) continue;
    if (tokens[i - 1] === "from") {
      let start = i - 2;
      while (start >= 0 && !["import", ";", "export"].includes(tokens[start] ?? "")) start--;
      if (tokens[start] !== "import") continue;
      const clause = tokens.slice(start + 1, i - 1);
      if (clause[0] && /^[$\w]+$/u.test(clause[0])) bindings.set(clause[0], "default");
      const brace = clause.indexOf("{");
      if (brace >= 0) for (const [local, imported] of declarationBindings(clause.slice(brace + 1, -1))) bindings.set(local, imported);
      const namespace = clause.indexOf("*");
      const namespaceBinding = clause[namespace + 2];
      if (namespace >= 0 && namespaceBinding) bindings.set(namespaceBinding, "*");
      continue;
    }
    if (tokens[i - 1] !== "(" || !(["import", "require", "importActual"].includes(tokens[i - 2] ?? "")
      || requireCallArgumentIndex(tokens, i - 4) === i || requireCallArgumentIndex(tokens, i - 5) === i)) continue;
    const directMember = tokens[i + 3];
    if (tokens[i + 2] === "." && directMember && ["(", "?."].includes(tokens[i + 4] ?? "")) immediate.add(directMember);
    let start = i - 2;
    while (start >= 0 && !["=", ";", "=>"].includes(tokens[start] ?? "")) start--;
    if (tokens[start] !== "=") continue;
    const lhs = tokens[start - 1];
    if (lhs === "}") {
      const brace = tokens.lastIndexOf("{", start - 1);
      for (const [local, imported] of declarationBindings(tokens.slice(brace + 1, start - 1))) bindings.set(local, imported);
    } else if (lhs) bindings.set(lhs, "*");
  }
  return { bindings, immediate };
}

function memberCall(tokens: readonly string[], bindings: ReadonlyMap<string, string>, index: number) {
  const binding = bindings.get(tokens[index] ?? "");
  const memberAccess = tokens[index + 1] === "." || tokens[index + 1] === "?.";
  const namespace = memberAccess && (binding === "*" || binding === "default" || binding === "promises");
  const member = namespace ? tokens[index + 2] : binding;
  const last = namespace ? index + 3 : index + 1;
  const opening = tokens[last] === "?." ? last + 1 : last;
  return member && tokens[opening] === "(" ? { member, opening } : undefined;
}

function usedMembers(tokens: readonly string[], specifier: string): Set<string> {
  const { bindings, immediate: members } = moduleBindings(tokens, specifier);
  for (let i = 0; i < tokens.length; i++) {
    const member = bindings.get(tokens[i] ?? "");
    if (member === undefined) continue;
    const property = tokens[i + 2];
    if ((member === "*" || member === "default") && [".", "?."].includes(tokens[i + 1] ?? "") && property
      && ["(", "?.", "."].includes(tokens[i + 3] ?? "")) members.add(property);
    if (["(", "?."].includes(tokens[i + 1] ?? "")) members.add(member);
  }
  return members;
}

const NATIVE_COMMANDS = new Set(["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync"]);
const LINK_METHODS = new Set(["symlink", "symlinkSync", "readlink", "readlinkSync"]);

function bindingsFor(tokens: readonly string[], mocks: ReadonlySet<string>, specifiers: string[]) {
  return new Map(specifiers.filter(specifier => !mocks.has(specifier)).flatMap(specifier => [...moduleBindings(tokens, specifier).bindings]));
}

function callsNativeHelper(tokens: readonly string[], mocks: ReadonlySet<string>): boolean {
  const bindings = bindingsFor(tokens, mocks, ["node:child_process", "child_process"]);
  function isHelper(start: number): boolean {
    const direct = literal(tokens[start]);
    if (direct !== undefined) return WINDOWS_HELPER.test(direct);
    if (!["join", "resolve"].includes(tokens[start] ?? "") || tokens[start + 1] !== "(") return false;
    for (let cursor = start + 2, depth = 1; cursor < tokens.length; cursor++) {
      if (tokens[cursor] === "(") depth++;
      if (tokens[cursor] === ")" && --depth === 0) return WINDOWS_HELPER.test(literal(tokens[cursor - 1]) ?? "");
    }
    return false;
  }
  for (let i = 0; i < tokens.length; i++) {
    const call = memberCall(tokens, bindings, i);
    if (!call || !NATIVE_COMMANDS.has(call.member)) continue;
    const argument = tokens[call.opening + 1];
    if (isHelper(call.opening + 1)) return true;
    const definition = tokens.findIndex((token, index) => token === argument && tokens[index - 1] === "const" && tokens[index + 1] === "=");
    if (definition >= 0 && isHelper(definition + 2)) return true;
  }
  return false;
}

function exercisesFilesystemLinks(tokens: readonly string[], mocks: ReadonlySet<string>): boolean {
  const bindings = bindingsFor(tokens, mocks, ["node:fs", "fs", "node:fs/promises", "fs/promises"]);
  for (let i = 0; i < tokens.length; i++) {
    const call = memberCall(tokens, bindings, i);
    if (call && LINK_METHODS.has(call.member)) return true;
    const binding = bindings.get(tokens[i] ?? "");
    if ((binding === "*" || binding === "default") && tokens[i + 1] === "." && tokens[i + 2] === "promises"
      && tokens[i + 3] === "." && LINK_METHODS.has(tokens[i + 4] ?? "") && tokens[i + 5] === "(") return true;
  }
  return false;
}

function checksWindowsPlatform(source: string, tokens: readonly string[], mocks: ReadonlySet<string>): boolean {
  if (/\b(?:setProcessPlatform\s*\(|stubGlobal\s*\(\s*["']process|(?:defineProperty|replaceProperty|spyOn)\s*\(\s*process\s*,\s*["']platform|process\.platform\s*=(?!=))/u.test(source)) return false;
  if (!mocks.has("node:os") && !mocks.has("os") && conditionalGates(source).some(gate => gate.classification === "win32-only")) return true;
  if (!tokens.some(token => literal(token) === "win32")) return false;
  const bindings = bindingsFor(tokens, mocks, ["node:os", "os"]);
  const platformAliases = new Set<string>();
  const windowsAliases = new Set<string>();
  const comparisons = new Set(["===", "!==", "==", "!="]);
  const declarations = new Set(["const", "let", "var"]);
  function platformEnd(index: number): number | undefined {
    if (tokens[index] === "process" && tokens[index + 1] === "." && tokens[index + 2] === "platform") return index + 3;
    const call = memberCall(tokens, bindings, index);
    if (call?.member === "platform" && tokens[call.opening + 1] === ")") return call.opening + 2;
    if (platformAliases.has(tokens[index] ?? "")) return index + 1;
    return undefined;
  }
  const windowsValue = (index: number) => literal(tokens[index]) === "win32" || windowsAliases.has(tokens[index] ?? "");
  for (let i = 0; i < tokens.length; i++) {
    const name = tokens[i + 1];
    if (!declarations.has(tokens[i] ?? "") || !name || tokens[i + 2] !== "=") continue;
    const end = platformEnd(i + 3);
    if (end !== undefined && tokens[end] === ";") platformAliases.add(name);
    if (windowsValue(i + 3) && tokens[i + 4] === ";") windowsAliases.add(name);
  }
  for (let i = 0; i < tokens.length; i++) {
    const end = platformEnd(i);
    if (end !== undefined && comparisons.has(tokens[end] ?? "") && windowsValue(end + 1)) return true;
    if (windowsValue(i) && comparisons.has(tokens[i + 1] ?? "") && platformEnd(i + 2) !== undefined) return true;
    if (tokens[i] === "switch" && tokens[i + 1] === "(" && platformEnd(i + 2) !== undefined
      && tokens.some((token, index) => index > i && token === "case" && windowsValue(index + 1))) return true;
  }
  return false;
}

function declarationEnd(tokens: readonly string[], start: number): number {
  let depth = 0;
  for (let i = start; i < tokens.length; i++) {
    const token = tokens[i] ?? "";
    if (depth === 0 && [";", "export"].includes(token)) return i;
    if (["{", "(", "["].includes(token)) depth++;
    if (["}", ")", "]"].includes(token) && --depth === 0 && token === "}" && tokens[start - 1] === "function") return i;
  }
  return tokens.length;
}

// Source paths can be passed through helpers, captured in a closure, or interpolated
// into bundled code. Index their literals independently of import syntax.
export function windowsRuntimeInputIndex(sources: ReadonlyMap<string, string>) {
  const suffixes = new Map<string, string[]>();
  for (const file of sources.keys()) {
    const segments = file.split("/");
    for (let i = 0; i < segments.length; i++) {
      const suffix = segments.slice(i).join("/");
      const runtimeSuffix = suffix.replace(/\.tsx?$/u, ".js").replace(/\.mts$/u, ".mjs").replace(/\.cts$/u, ".cjs");
      for (const spelling of new Set([suffix, runtimeSuffix])) {
        const paths = suffixes.get(spelling) ?? [];
        paths.push(file);
        suffixes.set(spelling, paths);
      }
    }
  }
  return (tokens: readonly string[]) => {
    const files = new Set<string>();
    for (const token of tokens) {
      const value = literal(token)?.replaceAll("\\\\", "/").replace(/^--(?:require|import|loader)=/u, "")
        .split(/[?#]/u)[0];
      if (!value || !SOURCE_FILE.test(value)) continue;
      const path = posix.normalize(value).replace(/^(?:\.\.\/)+|^\//u, "");
      for (const file of suffixes.get(path) ?? []) files.add(file);
    }
    return files;
  };
}

function callArguments(tokens: readonly string[], opening: number, closing = ")"): string[][] {
  const args: string[][] = [];
  let start = opening + 1;
  let depth = 0;
  for (let end = opening + 1; end < tokens.length; end++) {
    const token = tokens[end] ?? "";
    if (depth === 0 && (token === "," || token === closing)) {
      if (end !== start) args.push(tokens.slice(start, end));
      if (token === closing) return args;
      start = end + 1;
    }
    if (["(", "[", "{"].includes(token)) depth++;
    if ([")", "]", "}"].includes(token)) depth--;
  }
  return [];
}

const SOURCE_READS = new Set(["readFile", "readFileSync", "createReadStream"]);
const SOURCE_BUILDS = new Set(["build", "buildSync", "context"]);

export function hasUnverifiedWindowsRuntimeInput(tokens: readonly string[]): boolean {
  if (!tokens.some(token => token === "Bun" || /^(?:node:)?(?:fs(?:\/promises)?|child_process|esbuild)$/u.test(literal(token) ?? ""))) {
    return false;
  }
  const imports = (specifiers: string[]) => bindingsFor(tokens, new Set(), specifiers);
  const fs = imports(["node:fs", "fs", "node:fs/promises", "fs/promises"]);
  const children = imports(["node:child_process", "child_process"]);
  const bundler = imports(["esbuild"]);
  // A literal final component fixes the file name even when the parent is dynamic.
  // Every matching repository path is already indexed by its suffix.
  function fixedFilename(expression: readonly string[]): boolean {
    if (expression.length === 1 && literal(expression[0]) !== undefined) return true;
    const opening = expression.indexOf("(");
    if (opening < 0 || expression.at(-1) !== ")") return false;
    const name = expression[opening - 1] ?? "";
    if (name === "URL" && expression[0] === "new") return literal(expression[opening + 1]) !== undefined;
    if (name === "fileURLToPath") return fixedFilename(expression.slice(opening + 1, -1));
    const basename = literal(expression.at(-2))?.split(/[\\/]/u).at(-1);
    return (name === "join" || name === "resolve") && Boolean(basename && basename !== "." && basename !== "..");
  }
  function capturedReader(bindings: ReadonlyMap<string, string>, methods: ReadonlySet<string>, index: number): boolean {
    const binding = bindings.get(tokens[index] ?? "");
    const captured = ["=", "(", ",", "return"].includes(tokens[index - 1] ?? "");
    if (binding === "*" || binding === "default" || binding === "promises") {
      if (tokens[index + 1] === "[") return true;
      if (tokens[index + 1] === ".") return captured && methods.has(tokens[index + 2] ?? "")
        && !["(", "?."].includes(tokens[index + 3] ?? "");
      return captured && !["from", "as", "}"].includes(tokens[index + 1] ?? "");
    }
    if (!methods.has(binding ?? "") || !captured || ["(", "?.", ":", "=", "as", "}"].includes(tokens[index + 1] ?? "")) return false;
    const statement = tokens.lastIndexOf(";", index - 1) + 1;
    return tokens[statement] !== "import" || ["(", "."].includes(tokens[statement + 1] ?? "");
  }
  const childMethods = new Set([...NATIVE_COMMANDS, "fork"]);
  for (let i = 0; i < tokens.length; i++) {
    if (capturedReader(fs, SOURCE_READS, i) || capturedReader(children, childMethods, i) || capturedReader(bundler, SOURCE_BUILDS, i)) return true;
    const read = memberCall(tokens, fs, i);
    if (read && SOURCE_READS.has(read.member) && !fixedFilename(callArguments(tokens, read.opening)[0] ?? [])) return true;
    const filesystem = fs.get(tokens[i] ?? "");
    if ((filesystem === "*" || filesystem === "default") && tokens[i + 1] === "." && tokens[i + 2] === "promises"
      && tokens[i + 3] === "." && SOURCE_READS.has(tokens[i + 4] ?? "") && tokens[i + 5] === "("
      && !fixedFilename(callArguments(tokens, i + 5)[0] ?? [])) return true;
    const bundled = memberCall(tokens, bundler, i);
    if (bundled && SOURCE_BUILDS.has(bundled.member)) {
      const options = callArguments(tokens, bundled.opening)[0] ?? [];
      const entries = options.findIndex((token, index) => (token === "entryPoints" || literal(token) === "entryPoints")
        && options[index + 1] === ":" && options[index + 2] === "[");
      if (options[0] !== "{" || entries < 0 || options.some(token => ["...", "stdin", "plugins", "inject", "tsconfig"]
        .includes(literal(token) ?? token)) || !callArguments(options, entries + 2, "]").every(arg => fixedFilename(arg))) return true;
    }
    const child = memberCall(tokens, children, i);
    if (child && childMethods.has(child.member)) {
      const [command = [], args = []] = callArguments(tokens, child.opening);
      if (child.member === "exec" || child.member === "execSync") return true;
      if (child.member === "fork") {
        if (!fixedFilename(command)) return true;
      } else if (args[0] !== "[" || args.at(-1) !== "]"
        || !(fixedFilename(command) || command.join("") === "process.execPath")
        || args.some(token => /^(?:-e|-p|-c|--eval|--print|--command)(?:=|$)/u.test(literal(token) ?? ""))
        || !callArguments(args, 0, "]").every(arg => fixedFilename(arg))) return true;
    }
    if (tokens[i] === "Bun" && tokens[i + 1] === "." && ["spawn", "spawnSync", "build", "file"].includes(tokens[i + 2] ?? "")
      && tokens[i + 3] === "(") return true;
  }
  return false;
}

function forwardsNative(module: RuntimeModule, member: string, native: Edge): boolean {
  const { tokens } = module;
  const imports = tokens.flatMap((token, index) => {
    if (token !== "import" || tokens[index + 1] === "(") return [];
    const end = tokens.indexOf(";", index);
    return end < 0 ? [] : tokens.slice(index, end + 1);
  });
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] !== "export") continue;
    const start = tokens[i + 1] === "async" ? i + 2 : i + 1;
    if (tokens[start] === "*" && literal(tokens[start + 2]) === native.specifier) return true;
    if (["function", "const", "let", "var"].includes(tokens[start] ?? "") && tokens[start + 1] === member
      && usedMembers([...imports, ...tokens.slice(start + 1, declarationEnd(tokens, start + 1))], native.specifier).size) return true;
    if (tokens[start] !== "{") continue;
    const end = tokens.indexOf("}", start + 1);
    if (end < 0) continue;
    const local = declarationBindings(tokens.slice(start + 1, end)).find(([name]) => name === member)?.[1];
    if (!local) continue;
    if (tokens[end + 1] === "from") {
      if (literal(tokens[end + 2]) === native.specifier) return true;
      continue;
    }
    const declaration = tokens.findIndex((token, index) => token === local && ["function", "const", "let", "var"].includes(tokens[index - 1] ?? ""));
    if (declaration >= 0 && usedMembers([...imports, ...tokens.slice(declaration, declarationEnd(tokens, declaration))], native.specifier).size) return true;
  }
  return false;
}

/** Test-local evidence and calls across at most one forwarding module. */
export function nativeBackedTestFiles(sources: ReadonlyMap<string, string>): Map<string, string[]> {
  return scanNativeBackedTestFiles(sources, TRANSFORM_REPLY_TIMEOUT_MS);
}

function scanNativeBackedTestFiles(sources: ReadonlyMap<string, string>, replyTimeoutMs: number): Map<string, string[]> {
  assertWindowsMarkerPlacement(sources);
  const graph = windowsImportGraph(sources, replyTimeoutMs);
  const required = new Map<string, string[]>();
  for (const [file, module] of graph) {
    if (!isCollectedVitestFile(file)) continue;
    const source = sources.get(file);
    if (source === undefined) throw new Error(`Missing Windows test source: ${file}`);
    if (hasWindowsInventoryMarker(source, "windows-native") || file.endsWith(".windows.test.ts")
      || callsNativeHelper(module.tokens, module.mocks) || exercisesFilesystemLinks(module.tokens, module.mocks) || checksWindowsPlatform(source, module.tokens, module.mocks)) {
      required.set(file, [file]);
      continue;
    }
    const isActual = (edge: Edge) => edge.actual || !module.mocks.has(edge.file);
    const isNative = (edge: Edge) => WINDOWS_MODULE.test(edge.file) || WINDOWS_EXTERNAL.test(edge.specifier);
    for (const edge of module.dependencies.filter(isActual)) {
      const importer = graph.get(edge.file);
      if (!isNative(edge) && !importer?.dependencies.some(isNative)) continue;
      const used = usedMembers(module.tokens, edge.specifier);
      if (used.size === 0) continue;
      const native = importer?.dependencies.find(candidate => isNative(candidate) && isActual(candidate) && (candidate.actual || !importer.mocks.has(candidate.file))
        && [...used].some(member => forwardsNative(importer, member, candidate)));
      if (isNative(edge) || native) {
        required.set(file, native ? [file, edge.file, native.file] : [file, edge.file]);
        break;
      }
    }
  }
  return required;
}

export function readWindowsSources(root: string): Map<string, string> {
  const sources = new Map<string, string>();
  function visit(dir: string): void {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const file = `${dir}/${entry.name}`;
      if (entry.isDirectory() && entry.name !== "node_modules") visit(file);
      if (entry.isFile() && isInventorySource(file)) sources.set(file, readFileSync(join(root, file), "utf8"));
    }
  }
  for (const dir of ["src", "test", "scripts", "config", ".github"]) visit(dir);
  return sources;
}

export function windowsNativeInventory(sources: ReadonlyMap<string, string>): string {
  return `${[...nativeBackedTestFiles(sources).keys()].sort().join("\n")}\n`;
}
