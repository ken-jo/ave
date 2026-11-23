import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript/unstable/ast";
import { expect, it } from "vitest";
import { parseSourceTexts } from "../../../scripts/lib/ts7-ast.mjs";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const TIMERS = new Set(["setTimeout", "setImmediate"]);
const INTERVAL_WAITS = new Set(["waitFor", "waitUntil"]);
/** Timer calls in a loop that are time under test, not a wait: path, call text, reason. */
const ALLOWED: readonly (readonly [string, string, string])[] = [
  ["src/core/__tests__/work-board-stage-run.test.ts", "setImmediate(gate.release)", "releases a held write one event-loop turn later; that turn is the order under test"],
];

function calleeName(call: ts.CallExpression): string | undefined {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return undefined;
}

const isIntervalWait = (call: ts.CallExpression): boolean => ts.isPropertyAccessExpression(call.expression) &&
  ts.isIdentifier(call.expression.expression) && call.expression.expression.text === "vi" && INTERVAL_WAITS.has(call.expression.name.text);

const isLoop = (node: ts.Node): boolean => ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node) ||
  ts.isWhileStatement(node) || ts.isDoStatement(node);

function calls(source: ts.SourceFile): { call: ts.CallExpression; inLoop: boolean }[] {
  const found: { call: ts.CallExpression; inLoop: boolean }[] = [];
  function visit(node: ts.Node, inLoop: boolean): void {
    if (ts.isCallExpression(node)) found.push({ call: node, inLoop });
    const inside = inLoop || isLoop(node);
    node.forEachChild(child => visit(child, inside));
  }
  visit(source, false);
  return found;
}

/** The named function nearest a timer call: a declaration, or an arrow or function expression bound to a variable. */
function helperName(call: ts.CallExpression): string | undefined {
  for (let node = call.parent; node; node = node.parent) {
    if (ts.isFunctionDeclaration(node)) return node.name?.text;
    if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && node.parent && ts.isVariableDeclaration(node.parent) &&
      ts.isIdentifier(node.parent.name)) return node.parent.name.text;
  }
  return undefined;
}

const timerHelpers = (source: ts.SourceFile): Set<string> => new Set(calls(source)
  .filter(({ call }) => TIMERS.has(calleeName(call) ?? ""))
  .flatMap(({ call }) => helperName(call) ?? []));

/** Named imports from relative specifiers, with the repo path each resolves to. */
function relativeImports(source: ts.SourceFile, from: string, exists: (path: string) => boolean): { local: string; imported: string; path: string }[] {
  return source.statements.flatMap(statement => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) return [];
    const specifier = statement.moduleSpecifier.text;
    const bindings = statement.importClause?.namedBindings;
    if (!specifier.startsWith(".") || !bindings || !ts.isNamedImports(bindings)) return [];
    const base = posix.normalize(posix.join(posix.dirname(from), specifier));
    const stem = base.replace(/\.[cm]?[jt]sx?$/, "");
    const path = [base, ...[".ts", ".tsx", ".mts", ".cts"].map(extension => stem + extension)].find(exists);
    if (path === undefined) return [];
    return bindings.elements.map(element => ({ local: element.name.text, imported: (element.propertyName ?? element.name).text, path }));
  });
}

/** Interval waits anywhere, and timer calls or calls to timer helpers (same file or imported from the repo) inside a loop. */
function findPolling(texts: ReadonlyMap<string, string>, read: (path: string) => string | undefined): string[] {
  const parsed = parseSourceTexts(texts) as Map<string, ts.SourceFile>;
  expect([...parsed.keys()]).toEqual([...texts.keys()]);
  const imports = new Map([...parsed].map(([path, source]) => [path, relativeImports(source, path, candidate => read(candidate) !== undefined)]));
  const modules = new Map([...new Set([...imports.values()].flat().map(binding => binding.path))]
    .filter(path => !parsed.has(path))
    .map(path => [path, read(path) ?? ""] as const));
  const importedSources = parseSourceTexts(modules) as Map<string, ts.SourceFile>;
  expect([...importedSources.keys()]).toEqual([...modules.keys()]);
  const helpersOf = (path: string) => {
    const source = parsed.get(path) ?? importedSources.get(path);
    return source ? timerHelpers(source) : new Set<string>();
  };
  return [...parsed].flatMap(([path, source]) => {
    const helpers = timerHelpers(source);
    for (const binding of imports.get(path) ?? []) if (helpersOf(binding.path).has(binding.imported)) helpers.add(binding.local);
    return calls(source)
      .filter(({ call, inLoop }) => isIntervalWait(call) || (inLoop && (TIMERS.has(calleeName(call) ?? "") ||
        (ts.isIdentifier(call.expression) && helpers.has(call.expression.text)))))
      .filter(({ call }) => !ALLOWED.some(([file, text]) => file === path && source.text.slice(call.getStart(source), call.end) === text))
      .map(({ call }) => `${path}:${source.getLineAndCharacterOfPosition(call.getStart(source)).line + 1}`);
  });
}

const readRepo = (path: string): string | undefined => existsSync(join(ROOT, path)) ? readFileSync(join(ROOT, path), "utf8") : undefined;

it("waits for work-board changes without polling timers or interval waits", () => {
  const workBoardFiles = readdirSync(join(ROOT, "src", "work-board"), { recursive: true, encoding: "utf8" })
    .map(path => `src/work-board/${path.replaceAll("\\", "/")}`)
    .filter(path => /\/__tests__\/.*\.[cm]?[jt]sx?$/.test(path));
  const namedFiles = ["src/core/__tests__", "src/main/__tests__", "src/ipc/domains/__tests__"].flatMap(dir => readdirSync(join(ROOT, dir))
    .filter(path => /^work-board-.*\.test\.tsx?$/.test(path))
    .map(path => `${dir}/${path}`));
  const sources = new Map([...workBoardFiles, ...namedFiles].sort().map(path => [path, readRepo(path) ?? ""] as const));
  expect(findPolling(sources, readRepo), "Use a signal or an observed promise to wait for work-board changes").toEqual([]);
});

it("finds interval waits, timers in loops and imported timer helpers in loops", () => {
  const fixtures = new Map([
    ["src/fixture/support.ts", [
      "export function afterTurn(): Promise<void> { return new Promise(resolve => { setImmediate(resolve); }); }",
      "export const plain = (): Promise<void> => Promise.resolve();",
    ].join("\n")],
    ["src/fixture/__tests__/waits.test.ts", [
      'import { vi } from "vitest";',
      'import { afterTurn as turn, plain } from "../support.js";',
      "export async function waits(ready: () => boolean): Promise<void> {",
      "  await vi.waitFor(() => ready());",
      "  await vi.waitUntil(() => ready());",
      "  while (!ready()) await new Promise(resolve => setImmediate(resolve));",
      "  for (let i = 0; i < 400 && !ready(); i += 1) await new Promise(resolve => setTimeout(resolve, 5));",
      "  for (let i = 0; i < 400 && !ready(); i += 1) await turn();",
      "  for (let i = 0; i < 3; i += 1) await plain();",
      "  await turn();",
      "}",
    ].join("\n")],
  ]);
  const scanned = new Map([...fixtures].filter(([path]) => path.includes("__tests__")));
  expect(findPolling(scanned, path => fixtures.get(path))).toEqual([4, 5, 6, 7, 8].map(line => `src/fixture/__tests__/waits.test.ts:${line}`));
});
