import { transformSync } from "esbuild";
import { posix } from "node:path";
import { createRequire } from "node:module";
import { MessageChannel, receiveMessageOnPort, Worker } from "node:worker_threads";
import { createScanner } from "typescript/unstable/ast/scanner";

const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
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
  // Without a factory, tokens after the final load statement cannot affect dependency discovery.
  const lastLoad = code.includes("mock") ? code.length
    : Math.max(...["import", "export", "require"].map(word => code.lastIndexOf(word)));
  if (lastLoad < 0) return [];
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
    if (text === ";" && scanner.getTokenEnd() > lastLoad) break;
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

function runtimeImports(file: string, source: string, transformed?: string): { imports: string[]; actualImports: string[]; mocks: string[] } {
  const tokens = runtimeTokens(file, source, transformed);
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

function* transformedSources(sources: ReadonlyMap<string, string>): Generator<[string, string, string | undefined]> {
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
    let deadline = performance.now() + TRANSFORM_REPLY_TIMEOUT_MS;
    while (consumed < entries.length) {
      if (failure) throw new Error("Source transform worker failed", { cause: failure });
      const version = Atomics.load(signal, 0);
      const response = receiveMessageOnPort(port1)?.message as { results?: [string, string][]; error?: string } | undefined;
      if (response === undefined) {
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw new Error(`Source transform worker stalled or exited before replying within ${TRANSFORM_REPLY_TIMEOUT_MS}ms`);
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
      deadline = performance.now() + TRANSFORM_REPLY_TIMEOUT_MS;
    }
  } finally {
    port1.close();
    port2.close();
    void worker?.terminate();
  }
}

/** Conservative runtime reachability: lack of an observed native call is never an exclusion. */
export function nativeBackedTestFiles(sources: ReadonlyMap<string, string>): Map<string, string[]> {
  const resolveImport = (file: string, specifier: string): string | undefined => {
    if (!specifier.startsWith(".")) return undefined;
    const path = posix.normalize(posix.join(posix.dirname(file), specifier));
    return [path, path.replace(/\.js$/, ".ts"), path.replace(/\.js$/, ".tsx"), path.replace(/\.mjs$/, ".mts"),
      path.replace(/\.cjs$/, ".cts"), `${path}.ts`, `${path}.tsx`, `${path}/index.ts`, `${path}/index.tsx`].find(candidate => sources.has(candidate));
  };
  const graph = new Map<string, { file: string; actual: boolean }[]>();
  const mockedModules = new Map<string, Set<string>>();
  for (const [file, source, transformed] of transformedSources(sources)) {
    const parsed = runtimeImports(file, source, transformed);
    graph.set(file, parsed.imports.flatMap(specifier => {
      const dependency = resolveImport(file, specifier);
      return dependency === undefined ? [] : [{ file: dependency, actual: parsed.actualImports.includes(specifier) }];
    }));
    mockedModules.set(file, new Set(parsed.mocks.flatMap(specifier => resolveImport(file, specifier) ?? [])));
  }
  const boundary = (file: string) => file.startsWith("src/") && !file.includes("/__tests__/")
    && /\/(?:windows-|win32-)[^/]+\.[cm]?[jt]sx?$/.test(file);
  // Reverse reachability is shared by every suite; mock cuts can only remove paths.
  const importers = new Map<string, string[]>();
  const reachable = new Set<string>();
  for (const [file, dependencies] of graph) {
    if (boundary(file)) reachable.add(file);
    for (const dependency of dependencies) {
      const parents = importers.get(dependency.file) ?? [];
      parents.push(file);
      importers.set(dependency.file, parents);
      if (boundary(dependency.file)) reachable.add(dependency.file);
    }
  }
  const pending = [...reachable];
  for (const file of pending) {
    for (const importer of importers.get(file) ?? []) {
      if (reachable.has(importer)) continue;
      reachable.add(importer);
      pending.push(importer);
    }
  }
  const required = new Map<string, string[]>();
  for (const file of graph.keys()) {
    if (!TEST_FILE.test(file) || !reachable.has(file)) continue;
    const blocked = mockedModules.get(file) ?? new Set<string>();
    const queue = [file];
    const parents = new Map<string, string | undefined>([[file, undefined]]);
    for (const current of queue) {
      if (boundary(current)) {
        const chain = [current];
        let parent = parents.get(current);
        while (parent !== undefined) { chain.push(parent); parent = parents.get(parent); }
        required.set(file, chain.reverse());
        break;
      }
      for (const dependency of graph.get(current) ?? []) {
        if (!reachable.has(dependency.file) || parents.has(dependency.file)
          || (blocked.has(dependency.file) && !dependency.actual)) continue;
        parents.set(dependency.file, current);
        queue.push(dependency.file);
      }
    }
  }
  return required;
}
