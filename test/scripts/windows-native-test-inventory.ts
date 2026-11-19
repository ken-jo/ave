import { transformSync } from "esbuild";
import { posix } from "node:path";
import { createScanner } from "typescript/unstable/ast/scanner";

const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const SOURCE_FILE = /\.[cm]?[jt]sx?$/;

export function isInventorySource(file: string): boolean {
  return SOURCE_FILE.test(file) && !/\.d\.[cm]?ts$/.test(file)
    && !/^test\/(?:e2e|screenshots|smoke)\//.test(file);
}

function runtimeTokens(file: string, source: string): string[] {
  const code = transformSync(source, {
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
  return token !== undefined && /^['"]/.test(token) ? token.slice(1, -1) : undefined;
}

function requireCallArgumentIndex(tokens: readonly string[], index: number): number | undefined {
  if (tokens[index] !== "require") return undefined;
  const opening = index + (tokens[index + 1] === "?." ? 2 : 1);
  return tokens[opening] === "(" ? opening + 1 : undefined;
}

function isPossibleRequireLoad(tokens: readonly string[], index: number): boolean {
  if (tokens[index] !== "require") return false;
  if (tokens[index + 1] !== ":" || !["{", ","].includes(tokens[index - 1] ?? "")) return true;
  // Only recognizable object-literal keys are harmless; binding patterns and ambiguous contexts retain coverage.
  let depth = 0;
  for (let opening = index - 1; opening >= 0; opening--) {
    if (tokens[opening] === "}") depth++;
    if (tokens[opening] !== "{") continue;
    if (depth-- > 0) continue;
    const previous = tokens[opening - 1];
    if (previous !== "return" && previous !== "="
      && !(previous === "(" && tokens[opening - 2] === "=>")) return true;
    let closing = opening;
    depth = 1;
    while (++closing < tokens.length && depth > 0) {
      if (tokens[closing] === "{") depth++;
      if (tokens[closing] === "}") depth--;
    }
    return tokens[closing] === "=";
  }
  return true;
}

function runtimeImports(file: string, source: string): { imports: string[]; actualImports: string[]; mocks: string[] } {
  const tokens = runtimeTokens(file, source);
  const imports = new Set<string>();
  const actualImports = new Set<string>();
  const mocks = new Set<string>();
  const unmocks = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
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
  for (const [file, source] of sources) {
    if (!isInventorySource(file)) continue;
    const parsed = runtimeImports(file, source);
    graph.set(file, parsed.imports.flatMap(specifier => {
      const dependency = resolveImport(file, specifier);
      return dependency === undefined ? [] : [{ file: dependency, actual: parsed.actualImports.includes(specifier) }];
    }));
    mockedModules.set(file, new Set(parsed.mocks.flatMap(specifier => resolveImport(file, specifier) ?? [])));
  }
  const boundary = (file: string) => file.startsWith("src/") && !file.includes("/__tests__/")
    && /\/(?:windows-|win32-)[^/]+\.[cm]?[jt]sx?$/.test(file);
  const required = new Map<string, string[]>();
  for (const file of graph.keys()) {
    if (!TEST_FILE.test(file)) continue;
    const blocked = mockedModules.get(file) ?? new Set<string>();
    const queue = [[file]];
    const seen = new Set<string>();
    for (const chain of queue) {
      const current = chain.at(-1);
      if (current === undefined) continue;
      if (seen.has(current)) continue;
      seen.add(current);
      if (boundary(current)) { required.set(file, chain); break; }
      for (const dependency of graph.get(current) ?? []) {
        if (!blocked.has(dependency.file) || dependency.actual) queue.push([...chain, dependency.file]);
      }
    }
  }
  return required;
}
