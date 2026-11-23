/** Work-board tests wait on signals, never on elapsed time. Scope: the files under src/work-board/**\/__tests__ and the work-board-*.test.ts(x)
 * files in src/core, src/main and src/ipc/domains, with the repo modules they import. Renderer RTL, memory and boot tests are out of scope. */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript/unstable/ast";
import { expect, it } from "vitest";
import { parseSourceTexts } from "../../../scripts/lib/ts7-ast.mjs";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const TIMERS = new Set(["setTimeout", "setImmediate"]);
const PROMISE_TIMER_MODULES = new Set(["timers/promises", "node:timers/promises"]);
const INTERVAL_WAITS = new Map([["vi", new Set(["waitFor", "waitUntil"])], ["expect", new Set(["poll"])]]);
/** Timer waits that are not polling: path, call text, reason. */
const ALLOWED: readonly (readonly [string, string, string])[] = [];

type FunctionNode = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration | ts.ConstructorDeclaration |
  ts.GetAccessorDeclaration | ts.SetAccessorDeclaration;
const isFunctionNode = (node: ts.Node): node is FunctionNode => ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) ||
  ts.isArrowFunction(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node) || ts.isGetAccessorDeclaration(node) ||
  ts.isSetAccessorDeclaration(node);
/** A `new Promise` executor runs at once, as part of the function that creates the promise. */
const isExecutor = (node: FunctionNode): boolean => node.parent !== undefined && ts.isNewExpression(node.parent) &&
  ts.isIdentifier(node.parent.expression) && node.parent.expression.text === "Promise" && node.parent.arguments?.[0] === node;
const isLoop = (node: ts.Node): boolean => ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node) ||
  ts.isWhileStatement(node) || ts.isDoStatement(node);

function nameOf(fn: FunctionNode): string | undefined {
  const parent = fn.parent;
  if (parent && (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) &&
    parent.initializer === fn && ts.isIdentifier(parent.name)) return parent.name.text;
  if ((ts.isFunctionDeclaration(fn) || ts.isFunctionExpression(fn)) && fn.name) return fn.name.text;
  if ((ts.isMethodDeclaration(fn) || ts.isGetAccessorDeclaration(fn) || ts.isSetAccessorDeclaration(fn)) && ts.isIdentifier(fn.name)) return fn.name.text;
  return undefined;
}

/** The function a call runs in: its nearest enclosing function other than a promise executor. */
function ownerOf(node: ts.Node): FunctionNode | undefined {
  for (let at = node.parent; at; at = at.parent) if (isFunctionNode(at) && !isExecutor(at)) return at;
  return undefined;
}

/** A named function that calls itself, or hands itself to a call, anywhere in its body: each pass through it is a loop turn. */
function isRecursive(fn: FunctionNode): boolean {
  const name = nameOf(fn);
  if (name === undefined || !fn.body) return false;
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(node) && node.text === name && node.parent && ts.isCallExpression(node.parent) &&
      (node.parent.expression === node || node.parent.arguments.some(argument => argument === node))) found = true;
    else node.forEachChild(visit);
  };
  visit(fn.body);
  return found;
}

/** A loop between the call and the function it runs in, or that function repeats itself. A test callback, like any function, starts afresh. */
function inLoop(call: ts.CallExpression): boolean {
  const owner = ownerOf(call);
  for (let at = call.parent; at && at !== owner; at = at.parent) if (isLoop(at)) return true;
  return owner !== undefined && isRecursive(owner);
}

function allCalls(source: ts.SourceFile): ts.CallExpression[] {
  const found: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) found.push(node);
    node.forEachChild(visit);
  };
  visit(source);
  return found;
}

type Binding = { local: string; imported?: string; path: string };
type Scope = {
  source: ts.SourceFile;
  /** Named imports and namespace imports (no `imported`) from relative specifiers, with the repo path each resolves to. */
  relative: Binding[];
  promiseTimers: Set<string>;
  promiseTimerNamespaces: Set<string>;
  /** The local names `vi` and `expect` go by, and locals bound to their interval waits. */
  waitObjects: Map<string, string>;
  intervalAliases: Set<string>;
};

function scopeOf(source: ts.SourceFile, from: string, exists: (path: string) => boolean): Scope {
  const scope: Scope = { source, relative: [], promiseTimers: new Set(), promiseTimerNamespaces: new Set(), waitObjects: new Map([["vi", "vi"], ["expect", "expect"]]), intervalAliases: new Set() };
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings) continue;
    if (PROMISE_TIMER_MODULES.has(specifier)) {
      if (ts.isNamespaceImport(bindings)) scope.promiseTimerNamespaces.add(bindings.name.text);
      else for (const element of bindings.elements) if (TIMERS.has((element.propertyName ?? element.name).text)) scope.promiseTimers.add(element.name.text);
      continue;
    }
    if (specifier === "vitest" && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        const imported = (element.propertyName ?? element.name).text;
        if (INTERVAL_WAITS.has(imported)) scope.waitObjects.set(element.name.text, imported);
      }
      continue;
    }
    if (!specifier.startsWith(".")) continue;
    const base = posix.normalize(posix.join(posix.dirname(from), specifier));
    const stem = base.replace(/\.[cm]?[jt]sx?$/, "");
    const path = [base, ...[".ts", ".tsx", ".mts", ".cts"].map(extension => stem + extension)].find(exists);
    if (path === undefined) continue;
    if (ts.isNamespaceImport(bindings)) scope.relative.push({ local: bindings.name.text, path });
    else for (const element of bindings.elements) scope.relative.push({ local: element.name.text, imported: (element.propertyName ?? element.name).text, path });
  }
  // `const { waitFor } = vi` and `const poll = expect.poll` keep the interval wait under another name.
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const init = node.initializer;
      if (ts.isObjectBindingPattern(node.name) && ts.isIdentifier(init)) {
        const waits = INTERVAL_WAITS.get(scope.waitObjects.get(init.text) ?? "");
        for (const element of node.name.elements) {
          const key = element.propertyName ?? element.name;
          if (waits && ts.isIdentifier(key) && waits.has(key.text) && ts.isIdentifier(element.name)) scope.intervalAliases.add(element.name.text);
        }
      } else if (ts.isIdentifier(node.name) && isIntervalWaitCallee(scope, init)) scope.intervalAliases.add(node.name.text);
    }
    node.forEachChild(visit);
  };
  visit(source);
  return scope;
}

function isIntervalWaitCallee(scope: Scope, callee: ts.Expression): boolean {
  if (ts.isIdentifier(callee)) return scope.intervalAliases.has(callee.text);
  return ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) &&
    (INTERVAL_WAITS.get(scope.waitObjects.get(callee.expression.text) ?? "")?.has(callee.name.text) ?? false);
}

const calleeName = (call: ts.CallExpression): string | undefined => ts.isIdentifier(call.expression) ? call.expression.text
  : ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : undefined;

/** A promise nothing waits on: under `void`, or a statement of its own, through any `.then` chain. */
function isDiscarded(node: ts.Node): boolean {
  let at = node;
  while (at.parent && (ts.isParenthesizedExpression(at.parent) || (ts.isPropertyAccessExpression(at.parent) && at.parent.expression === at) ||
    (ts.isCallExpression(at.parent) && at.parent.expression === at))) at = at.parent;
  return at.parent !== undefined && (ts.isVoidExpression(at.parent) || ts.isExpressionStatement(at.parent));
}

/** A timer that is the wait: a timers/promises call or a callback timer resolving a promise, either one waited on; or a callback timer that
 * reschedules its own function. */
function isTimerWait(scope: Scope, call: ts.CallExpression): boolean {
  const callee = call.expression;
  if ((ts.isIdentifier(callee) && scope.promiseTimers.has(callee.text)) || (ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) && scope.promiseTimerNamespaces.has(callee.expression.text) && TIMERS.has(callee.name.text))) {
    return !isDiscarded(call);
  }
  if (!TIMERS.has(calleeName(call) ?? "")) return false;
  let fn: ts.Node | undefined = call.parent;
  while (fn && !isFunctionNode(fn)) fn = fn.parent;
  if (fn && isExecutor(fn) && fn.parent && !isDiscarded(fn.parent)) return true;
  const owner = ownerOf(call);
  return owner !== undefined && isRecursive(owner);
}

/** The modules a scan needs: each scanned file's relative imports, and theirs while the importer is test support under `__tests__`. */
function loadScopes(texts: ReadonlyMap<string, string>, read: (path: string) => string | undefined): Map<string, Scope> {
  const exists = (path: string) => texts.has(path) || read(path) !== undefined;
  const scopes = new Map<string, Scope>();
  let batch = new Map(texts);
  while (batch.size > 0) {
    const parsed = parseSourceTexts(batch) as Map<string, ts.SourceFile>;
    expect([...parsed.keys()]).toEqual([...batch.keys()]);
    const next = new Map<string, string>();
    for (const [path, source] of parsed) {
      const scope = scopeOf(source, path, exists);
      scopes.set(path, scope);
      if (!texts.has(path) && !path.includes("/__tests__/")) continue;
      for (const { path: imported } of scope.relative) {
        if (!scopes.has(imported) && !batch.has(imported) && !next.has(imported)) next.set(imported, texts.get(imported) ?? read(imported) ?? "");
      }
    }
    batch = next;
  }
  return scopes;
}

/** Named functions that wait on a timer, directly or through another such function, in this module or one it imports. */
function helperFinder(scopes: ReadonlyMap<string, Scope>) {
  const memo = new Map<string, Set<string>>();
  function helpersOf(path: string): Set<string> {
    const known = memo.get(path);
    if (known) return known;
    const helpers = new Set<string>();
    memo.set(path, helpers);
    const scope = scopes.get(path);
    if (!scope) return helpers;
    const calls = allCalls(scope.source);
    for (let grew = true; grew;) {
      grew = false;
      for (const call of calls) {
        const owner = ownerOf(call);
        const name = owner && nameOf(owner);
        if (name === undefined || helpers.has(name)) continue;
        if (isTimerWait(scope, call) || callsHelper(scope, call, helpers)) {
          helpers.add(name);
          grew = true;
        }
      }
    }
    return helpers;
  }
  function callsHelper(scope: Scope, call: ts.CallExpression, own: Set<string>): boolean {
    const callee = call.expression;
    if (ts.isIdentifier(callee)) {
      if (own.has(callee.text)) return true;
      return scope.relative.some(binding => binding.local === callee.text && binding.imported !== undefined && helpersOf(binding.path).has(binding.imported));
    }
    if (!ts.isPropertyAccessExpression(callee)) return false;
    const method = callee.name.text;
    if (ts.isIdentifier(callee.expression)) {
      const namespace = scope.relative.find(binding => binding.local === (callee.expression as ts.Identifier).text && binding.imported === undefined);
      if (namespace) return helpersOf(namespace.path).has(method);
    }
    return own.has(method);
  }
  return { helpersOf, callsHelper };
}

/** The recursive call of a polling function: its timer wait is the finding. */
function callsItself(call: ts.CallExpression): boolean {
  const owner = ownerOf(call);
  return owner !== undefined && ts.isIdentifier(call.expression) && call.expression.text === nameOf(owner);
}

/** Interval waits anywhere, and timer waits or calls to timer-wait helpers inside a loop or a function that repeats itself. */
function findPolling(texts: ReadonlyMap<string, string>, read: (path: string) => string | undefined): string[] {
  const scopes = loadScopes(texts, read);
  const { helpersOf, callsHelper } = helperFinder(scopes);
  return [...texts.keys()].flatMap(path => {
    const scope = scopes.get(path);
    if (!scope) return [];
    const { source } = scope;
    const helpers = helpersOf(path);
    return allCalls(source)
      .filter(call => isIntervalWaitCallee(scope, call.expression) || calleeName(call) === "setInterval" ||
        (inLoop(call) && (isTimerWait(scope, call) || (!callsItself(call) && callsHelper(scope, call, helpers)))))
      .filter(call => !ALLOWED.some(([file, text]) => file === path && source.text.slice(call.getStart(source), call.end) === text))
      .map(call => `${path}:${source.getLineAndCharacterOfPosition(call.getStart(source)).line + 1}`);
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

const fixtureFinds = (fixtures: ReadonlyMap<string, string>) =>
  findPolling(new Map([...fixtures].filter(([path]) => path.includes("__tests__"))), path => fixtures.get(path));

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
  expect(fixtureFinds(fixtures)).toEqual([4, 5, 6, 7, 8].map(line => `src/fixture/__tests__/waits.test.ts:${line}`));
});

it("finds intervals, polls, renamed and destructured waits, namespace, method and two-hop helpers and recursive polling", () => {
  const fixtures = new Map([
    ["src/fixture/timers.ts", [
      "export function sleepTurn(): Promise<void> { return new Promise(resolve => { setImmediate(resolve); }); }",
      "export const twoHop = (): Promise<void> => sleepTurn();",
      "export function arm(expire: () => void): () => void { const timer = setTimeout(expire, 10); return () => clearTimeout(timer); }",
    ].join("\n")],
    ["src/fixture/__tests__/more.test.ts", [
      'import { expect, it, vi } from "vitest";',
      'import { setTimeout as sleep } from "node:timers/promises";',
      'import * as support from "../timers.js";',
      'import { arm, twoHop } from "../timers.js";',
      "const { waitFor } = vi;",
      "const relay = (): Promise<void> => support.sleepTurn();",
      "const ticker = { tick(): Promise<void> { return new Promise(resolve => setTimeout(resolve, 1)); } };",
      "export async function more(ready: () => boolean): Promise<void> {",
      "  const id = setInterval(() => undefined, 5);",
      "  clearInterval(id);",
      "  await expect.poll(() => ready()).toBe(true);",
      "  await waitFor(() => ready());",
      "  while (!ready()) await sleep(5);",
      "  while (!ready()) await support.sleepTurn();",
      "  while (!ready()) await ticker.tick();",
      "  while (!ready()) await twoHop();",
      "  while (!ready()) await relay();",
      "  for (let i = 0; i < 3; i += 1) arm(() => undefined);",
      "  for (let i = 0; i < 3; i += 1) setImmediate(() => undefined);",
      "  for (const name of [\"a\", \"b\"]) it(name, async () => { await new Promise(resolve => setTimeout(resolve, 1)); });",
      "}",
      "export function check(ready: () => boolean): void { if (!ready()) setTimeout(() => check(ready), 5); }",
      "export async function poll(ready: () => boolean): Promise<void> { if (ready()) return; await sleep(1); return poll(ready); }",
    ].join("\n")],
  ]);
  expect(fixtureFinds(fixtures)).toEqual([9, 11, 12, 13, 14, 15, 16, 17, 22, 23].map(line => `src/fixture/__tests__/more.test.ts:${line}`));
});
