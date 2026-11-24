/** Work-board tests wait on signals, never on elapsed time. Scope: the files under src/work-board/**\/__tests__, the work-board-*.test.ts(x)
 * files in src/core, src/main and src/ipc/domains, and every test file under src that imports the stage-run harness; with the repo functions
 * they call, followed through imports and re-exports. Renderer RTL, memory and boot tests are out of scope. */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript/unstable/ast";
import { expect, it } from "vitest";
import { parseSourceTexts } from "../../../scripts/lib/ts7-ast.mjs";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const HARNESS = "src/work-board/workflow/__tests__/stage-run-harness.ts";
const TIMERS = new Set(["setTimeout", "setImmediate"]);
const CALLBACK_TIMERS = new Set([...TIMERS, "setInterval"]);
const CALLBACK_TIMER_MODULES = new Set(["timers", "node:timers"]);
const PROMISE_TIMER_MODULES = new Set(["timers/promises", "node:timers/promises"]);
/** `scheduler.wait` waits for a time and `scheduler.yield` for a turn, like the promise timers. */
const SCHEDULER_WAITS = new Set(["wait", "yield"]);
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

/** How a call reaches the function, if it has a name: `name`, `object.name` for a member of an object literal a variable holds, or
 * `this.name` for a class member. */
function keyOf(fn: FunctionNode): string | undefined {
  const name = nameOf(fn);
  if (name === undefined) return undefined;
  const member = ts.isMethodDeclaration(fn) || ts.isGetAccessorDeclaration(fn) || ts.isSetAccessorDeclaration(fn) ? fn
    : fn.parent && (ts.isPropertyAssignment(fn.parent) || ts.isPropertyDeclaration(fn.parent)) ? fn.parent : undefined;
  if (!member) return name;
  const holder = member.parent;
  if (holder && ts.isObjectLiteralExpression(holder)) {
    const variable = holder.parent;
    return variable && ts.isVariableDeclaration(variable) && variable.initializer === holder && ts.isIdentifier(variable.name)
      ? `${variable.name.text}.${name}` : undefined;
  }
  return holder && (ts.isClassDeclaration(holder) || ts.isClassExpression(holder)) ? `this.${name}` : undefined;
}

/** The function a call runs in: its nearest enclosing function other than a promise executor. */
function ownerOf(node: ts.Node): FunctionNode | undefined {
  for (let at = node.parent; at; at = at.parent) if (isFunctionNode(at) && !isExecutor(at)) return at;
  return undefined;
}

/** A promise the enclosing function waits on: under `await`, through any `.then` chain. */
function isAwaited(node: ts.Node): boolean {
  let at = node;
  while (at.parent && (ts.isParenthesizedExpression(at.parent) || (ts.isPropertyAccessExpression(at.parent) && at.parent.expression === at) ||
    (ts.isCallExpression(at.parent) && at.parent.expression === at))) at = at.parent;
  return at.parent !== undefined && ts.isAwaitExpression(at.parent);
}

/** The awaited call an inline function runs as part of: an IIFE, a `.then` callback, or a callback handed to a call the enclosing function
 * awaits. What the inline function waits on, that function waits on. */
function awaitedCallOf(fn: FunctionNode): ts.CallExpression | undefined {
  if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return undefined;
  let at: ts.Node = fn;
  while (at.parent && ts.isParenthesizedExpression(at.parent)) at = at.parent;
  const call = at.parent;
  if (!call || !ts.isCallExpression(call) || !(call.expression === at || call.arguments.some(argument => argument === at))) return undefined;
  return isAwaited(call) ? call : undefined;
}

/** The function whose turn a call's wait holds up: its owner, or past each awaited inline function, the function that awaits it. */
function waitOwnerOf(node: ts.Node): FunctionNode | undefined {
  let owner = ownerOf(node);
  for (let call = owner && awaitedCallOf(owner); owner && call; call = owner && awaitedCallOf(owner)) owner = ownerOf(call);
  return owner;
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

/** The nearest loop between a call and the function its wait holds up. A test callback, like any function, starts outside any loop. */
function loopOf(call: ts.CallExpression): ts.Node | undefined {
  const owner = waitOwnerOf(call);
  for (let at = call.parent; at && at !== owner; at = at.parent) if (isLoop(at)) return at;
  return undefined;
}

/** Inside a loop, or in a function that repeats itself. */
function inLoop(call: ts.CallExpression): boolean {
  const owner = waitOwnerOf(call);
  return loopOf(call) !== undefined || (owner !== undefined && isRecursive(owner));
}

/** The loop waits in each turn, in the function it belongs to rather than in a nested one. */
function awaitsEachTurn(loop: ts.Node): boolean {
  if (ts.isForOfStatement(loop) && loop.awaitModifier) return true;
  const owner = ownerOf(loop);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isAwaitExpression(node) && ownerOf(node) === owner) found = true;
    else node.forEachChild(visit);
  };
  loop.forEachChild(visit);
  return found;
}

function allCalls(source: ts.Node): ts.CallExpression[] {
  const found: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) found.push(node);
    node.forEachChild(visit);
  };
  visit(source);
  return found;
}

type Binding = { local: string; imported?: string; path: string };
/** A name this module exports from another: `export { imported as exported } from`, or `export { local }` of an import. */
type Reexport = { exported: string; imported: string; path: string };
type Scope = {
  source: ts.SourceFile;
  /** Named imports and namespace imports (no `imported`) from relative specifiers, with the repo path each resolves to. */
  relative: Binding[];
  reexports: Reexport[];
  /** The modules of `export * from`. */
  starExports: string[];
  /** Named functions by how a call reaches them (see keyOf). */
  functions: Map<string, FunctionNode[]>;
  promiseTimers: Set<string>;
  promiseTimerNamespaces: Set<string>;
  schedulers: Set<string>;
  /** Local names of callback timers imported from node:timers, with the timer each is. */
  callbackTimers: Map<string, string>;
  /** The local names `vi` and `expect` go by, and locals bound to their interval waits. */
  waitObjects: Map<string, string>;
  intervalAliases: Set<string>;
};

function scopeOf(source: ts.SourceFile, from: string, exists: (path: string) => boolean): Scope {
  const scope: Scope = {
    source, relative: [], reexports: [], starExports: [], functions: new Map(), promiseTimers: new Set(), promiseTimerNamespaces: new Set(),
    schedulers: new Set(), callbackTimers: new Map(), waitObjects: new Map([["vi", "vi"], ["expect", "expect"]]), intervalAliases: new Set(),
  };
  const resolveRelative = (specifier: string): string | undefined => {
    if (!specifier.startsWith(".")) return undefined;
    const base = posix.normalize(posix.join(posix.dirname(from), specifier));
    const stem = base.replace(/\.[cm]?[jt]sx?$/, "");
    return [base, ...[".ts", ".tsx", ".mts", ".cts"].map(extension => stem + extension)].find(exists);
  };
  const localExports: ts.ExportSpecifier[] = [];
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement)) {
      const clause = statement.exportClause;
      const target = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) ? resolveRelative(statement.moduleSpecifier.text) : undefined;
      if (!statement.moduleSpecifier && clause && ts.isNamedExports(clause)) localExports.push(...clause.elements);
      else if (target !== undefined && !clause) scope.starExports.push(target);
      else if (target !== undefined && clause && ts.isNamedExports(clause)) {
        for (const element of clause.elements) scope.reexports.push({ exported: element.name.text, imported: (element.propertyName ?? element.name).text, path: target });
      }
      continue;
    }
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings) continue;
    if (PROMISE_TIMER_MODULES.has(specifier)) {
      if (ts.isNamespaceImport(bindings)) scope.promiseTimerNamespaces.add(bindings.name.text);
      else for (const element of bindings.elements) {
        const imported = (element.propertyName ?? element.name).text;
        if (TIMERS.has(imported)) scope.promiseTimers.add(element.name.text);
        else if (imported === "scheduler") scope.schedulers.add(element.name.text);
      }
      continue;
    }
    if (CALLBACK_TIMER_MODULES.has(specifier)) {
      // A namespace import's timers are calls by their own names.
      if (ts.isNamedImports(bindings)) for (const element of bindings.elements) {
        const imported = (element.propertyName ?? element.name).text;
        if (CALLBACK_TIMERS.has(imported)) scope.callbackTimers.set(element.name.text, imported);
      }
      continue;
    }
    if (specifier === "vitest" && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        const imported = (element.propertyName ?? element.name).text;
        if (INTERVAL_WAITS.has(imported)) scope.waitObjects.set(element.name.text, imported);
      }
      continue;
    }
    const path = resolveRelative(specifier);
    if (path === undefined) continue;
    if (ts.isNamespaceImport(bindings)) scope.relative.push({ local: bindings.name.text, path });
    else for (const element of bindings.elements) scope.relative.push({ local: element.name.text, imported: (element.propertyName ?? element.name).text, path });
  }
  for (const element of localExports) {
    const local = (element.propertyName ?? element.name).text;
    const binding = scope.relative.find(candidate => candidate.local === local && candidate.imported !== undefined);
    if (binding?.imported !== undefined) scope.reexports.push({ exported: element.name.text, imported: binding.imported, path: binding.path });
  }
  // `const { waitFor } = vi` and `const poll = expect.poll` keep the interval wait under another name.
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const init = node.initializer;
      if (ts.isObjectBindingPattern(node.name) && ts.isIdentifier(init)) {
        const waits = INTERVAL_WAITS.get(scope.waitObjects.get(init.text) ?? "");
        for (const element of node.name.elements) {
          const key = element.propertyName ?? element.name;
          if (waits && key && ts.isIdentifier(key) && waits.has(key.text) && element.name && ts.isIdentifier(element.name)) {
            scope.intervalAliases.add(element.name.text);
          }
        }
      } else if (ts.isIdentifier(node.name) && isIntervalWaitCallee(scope, init)) scope.intervalAliases.add(node.name.text);
    }
    if (isFunctionNode(node)) {
      const key = keyOf(node);
      if (key !== undefined) scope.functions.set(key, [...scope.functions.get(key) ?? [], node]);
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

/** The callback timer a call arms, under its own name, a property of that name, or a name imported for it from node:timers. */
function callbackTimerOf(scope: Scope, call: ts.CallExpression): string | undefined {
  const callee = call.expression;
  const name = ts.isIdentifier(callee) ? scope.callbackTimers.get(callee.text) ?? callee.text
    : ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
  return name !== undefined && CALLBACK_TIMERS.has(name) ? name : undefined;
}

/** A timers/promises timer, or a `scheduler.wait` or `scheduler.yield` from it. */
function isPromiseTimer(scope: Scope, callee: ts.Expression): boolean {
  if (ts.isIdentifier(callee)) return scope.promiseTimers.has(callee.text);
  if (!ts.isPropertyAccessExpression(callee)) return false;
  const holder = callee.expression;
  if (ts.isIdentifier(holder)) {
    return (scope.promiseTimerNamespaces.has(holder.text) && TIMERS.has(callee.name.text)) ||
      (scope.schedulers.has(holder.text) && SCHEDULER_WAITS.has(callee.name.text));
  }
  return ts.isPropertyAccessExpression(holder) && ts.isIdentifier(holder.expression) && scope.promiseTimerNamespaces.has(holder.expression.text) &&
    holder.name.text === "scheduler" && SCHEDULER_WAITS.has(callee.name.text);
}

/** A promise nothing waits on: under `void`, or a statement of its own, through any `.then` chain. */
function isDiscarded(node: ts.Node): boolean {
  let at = node;
  while (at.parent && (ts.isParenthesizedExpression(at.parent) || (ts.isPropertyAccessExpression(at.parent) && at.parent.expression === at) ||
    (ts.isCallExpression(at.parent) && at.parent.expression === at))) at = at.parent;
  return at.parent !== undefined && (ts.isVoidExpression(at.parent) || ts.isExpressionStatement(at.parent));
}

/** A timer that is the wait: a promise timer or a callback timer resolving a promise, either one waited on; a callback timer in a loop
 * that awaits each turn (it settles what the turn awaits); or a callback timer that reschedules its own function. A callback timer armed
 * in a loop that never awaits is not a wait. */
function isTimerWait(scope: Scope, call: ts.CallExpression): boolean {
  if (isPromiseTimer(scope, call.expression)) return !isDiscarded(call);
  const timer = callbackTimerOf(scope, call);
  if (timer === undefined || timer === "setInterval") return false;
  let fn: ts.Node | undefined = call.parent;
  while (fn && !isFunctionNode(fn)) fn = fn.parent;
  if (fn && isExecutor(fn) && fn.parent && !isDiscarded(fn.parent)) return true;
  const loop = loopOf(call);
  if (loop !== undefined && awaitsEachTurn(loop)) return true;
  const owner = waitOwnerOf(call);
  return owner !== undefined && isRecursive(owner);
}

/** Parsed modules, read on demand: a lookup of a module not yet parsed asks for it, and the scan runs again once it is. */
function moduleStore(texts: ReadonlyMap<string, string>, read: (path: string) => string | undefined) {
  const reads = new Map<string, string | undefined>();
  const textOf = (path: string): string | undefined => {
    if (texts.has(path)) return texts.get(path);
    if (!reads.has(path)) reads.set(path, read(path));
    return reads.get(path);
  };
  const exists = (path: string) => textOf(path) !== undefined;
  const scopes = new Map<string, Scope>();
  const wanted = new Set<string>();
  function parse(paths: Iterable<string>): void {
    const batch = new Map([...paths].flatMap(path => { const text = textOf(path); return text === undefined ? [] : [[path, text] as const]; }));
    const parsed = parseSourceTexts(batch) as Map<string, ts.SourceFile>;
    expect([...parsed.keys()]).toEqual([...batch.keys()]);
    for (const [path, source] of parsed) scopes.set(path, scopeOf(source, path, exists));
  }
  return {
    parse,
    scopeAt(path: string): Scope | undefined {
      const scope = scopes.get(path);
      if (!scope && exists(path)) wanted.add(path);
      return scope;
    },
    /** Parses the modules asked for since the last call; false once none were. */
    loadWanted(): boolean {
      if (wanted.size === 0) return false;
      parse([...wanted]);
      wanted.clear();
      return true;
    },
  };
}

/** Whether a named function waits on a timer, directly or through another such function, in its module or one it reaches. */
function helperFinder(modules: ReturnType<typeof moduleStore>) {
  const memo = new Map<string, boolean>();
  function exportIsHelper(path: string, name: string, seen = new Set<string>()): boolean {
    const id = `${path}#${name}`;
    if (seen.has(id)) return false;
    seen.add(id);
    const scope = modules.scopeAt(path);
    if (!scope) return false;
    return isHelper(path, name) ||
      scope.reexports.some(entry => entry.exported === name && exportIsHelper(entry.path, entry.imported, seen)) ||
      scope.starExports.some(target => exportIsHelper(target, name, seen));
  }
  function isHelper(path: string, key: string): boolean {
    const id = `${path}#${key}`;
    const known = memo.get(id);
    if (known !== undefined) return known;
    memo.set(id, false);
    const scope = modules.scopeAt(path);
    const found = scope !== undefined && (scope.functions.get(key) ?? []).some(fn => allCalls(fn).some(call =>
      waitOwnerOf(call) === fn && (isTimerWait(scope, call) || callsHelper(path, scope, call))));
    memo.set(id, found);
    return found;
  }
  function callsHelper(path: string, scope: Scope, call: ts.CallExpression): boolean {
    const callee = call.expression;
    if (ts.isIdentifier(callee)) {
      if (scope.functions.has(callee.text)) return isHelper(path, callee.text);
      const binding = scope.relative.find(candidate => candidate.local === callee.text && candidate.imported !== undefined);
      return binding?.imported !== undefined && exportIsHelper(binding.path, binding.imported);
    }
    if (!ts.isPropertyAccessExpression(callee)) return false;
    const method = callee.name.text;
    if (callee.expression.kind === ts.SyntaxKind.ThisKeyword) return isHelper(path, `this.${method}`);
    if (!ts.isIdentifier(callee.expression)) return false;
    const holder = callee.expression.text;
    if (scope.functions.has(`${holder}.${method}`)) return isHelper(path, `${holder}.${method}`);
    const binding = scope.relative.find(candidate => candidate.local === holder);
    if (!binding) return false;
    return binding.imported === undefined ? exportIsHelper(binding.path, method) : exportIsHelper(binding.path, `${binding.imported}.${method}`);
  }
  return { callsHelper };
}

/** The recursive call of a polling function: its timer wait is the finding. */
function callsItself(call: ts.CallExpression): boolean {
  const owner = ownerOf(call);
  return owner !== undefined && ts.isIdentifier(call.expression) && call.expression.text === nameOf(owner);
}

/** Interval waits anywhere, and timer waits or calls to timer-wait helpers inside a loop or a function that repeats itself. */
function findPolling(texts: ReadonlyMap<string, string>, read: (path: string) => string | undefined): string[] {
  const modules = moduleStore(texts, read);
  modules.parse(texts.keys());
  for (;;) {
    const { callsHelper } = helperFinder(modules);
    const found = [...texts.keys()].flatMap(path => {
      const scope = modules.scopeAt(path);
      if (!scope) return [];
      const { source } = scope;
      return allCalls(source)
        .filter(call => isIntervalWaitCallee(scope, call.expression) || callbackTimerOf(scope, call) === "setInterval" ||
          (inLoop(call) && (isTimerWait(scope, call) || (!callsItself(call) && callsHelper(path, scope, call)))))
        .filter(call => !ALLOWED.some(([file, text]) => file === path && source.text.slice(call.getStart(source), call.end) === text))
        .map(call => `${path}:${source.getLineAndCharacterOfPosition(call.getStart(source)).line + 1}`);
    });
    if (!modules.loadWanted()) return found;
  }
}

const readRepo = (path: string): string | undefined => existsSync(join(ROOT, path)) ? readFileSync(join(ROOT, path), "utf8") : undefined;
const testFilesUnder = (dir: string) => readdirSync(join(ROOT, dir), { recursive: true, encoding: "utf8" })
  .map(path => `${dir}/${path.replaceAll("\\", "/")}`);

/** Test files that import the stage-run harness, by the path their import resolves to. */
function harnessImporters(): string[] {
  const candidates = new Map(testFilesUnder("src").filter(path => /\.test\.tsx?$/.test(path) && !path.includes("/node_modules/"))
    .map(path => [path, readRepo(path) ?? ""] as const).filter(([, text]) => text.includes("stage-run-harness")));
  const parsed = parseSourceTexts(candidates) as Map<string, ts.SourceFile>;
  expect([...parsed.keys()]).toEqual([...candidates.keys()]);
  return [...parsed].filter(([path, source]) => scopeOf(source, path, candidate => readRepo(candidate) !== undefined).relative
    .some(binding => binding.path === HARNESS)).map(([path]) => path);
}

it("waits for work-board changes without polling timers or interval waits", () => {
  const workBoardFiles = testFilesUnder("src/work-board").filter(path => /\/__tests__\/.*\.[cm]?[jt]sx?$/.test(path));
  const namedFiles = ["src/core/__tests__", "src/main/__tests__", "src/ipc/domains/__tests__"].flatMap(dir => readdirSync(join(ROOT, dir))
    .filter(path => /^work-board-.*\.test\.tsx?$/.test(path))
    .map(path => `${dir}/${path}`));
  const importers = harnessImporters();
  expect(importers).toContain("src/main/__tests__/workflow-engine-wiring.test.ts");
  const sources = new Map([...new Set([...workBoardFiles, ...namedFiles, ...importers])].sort().map(path => [path, readRepo(path) ?? ""] as const));
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
      "  for (let i = 0; i < 3 && !ready(); i += 1) { const turn = Promise.withResolvers<void>(); setTimeout(turn.resolve, 5); await turn.promise; }",
      "  for (const name of [\"a\", \"b\"]) it(name, async () => { await new Promise(resolve => setTimeout(resolve, 1)); });",
      "}",
      "export function check(ready: () => boolean): void { if (!ready()) setTimeout(() => check(ready), 5); }",
      "export async function poll(ready: () => boolean): Promise<void> { if (ready()) return; await sleep(1); return poll(ready); }",
    ].join("\n")],
  ]);
  expect(fixtureFinds(fixtures)).toEqual([9, 11, 12, 13, 14, 15, 16, 17, 20, 23, 24].map(line => `src/fixture/__tests__/more.test.ts:${line}`));
});

it("finds timer waits behind awaited inline callbacks, node:timers aliases, scheduler waits and helpers reached through re-exports", () => {
  const fixtures = new Map([
    ["src/fixture/timers.ts", "export function sleepTurn(): Promise<void> { return new Promise(resolve => { setImmediate(resolve); }); }"],
    ["src/fixture/barrel.ts", ['export { sleepTurn as nap } from "./timers.js";', 'export * from "./timers.js";'].join("\n")],
    ["src/fixture/wrap.ts", ['import { sleepTurn } from "./timers.js";', "export const settle = (): Promise<void> => sleepTurn();"].join("\n")],
    ["src/fixture/__tests__/inline.test.ts", [
      'import { setInterval as every, setTimeout as delay } from "node:timers";',
      'import { scheduler, setTimeout as sleep } from "node:timers/promises";',
      'import * as promises from "node:timers/promises";',
      'import { nap, sleepTurn } from "../barrel.js";',
      'import { settle } from "../wrap.js";',
      "const queue = { pause: (): Promise<void> => Promise.resolve() };",
      "const pause = (): Promise<void> => sleep(1);",
      "export async function inline(ready: () => boolean, run: (work: () => Promise<void>) => Promise<void>): Promise<void> {",
      "  while (!ready()) await (async () => { await sleep(1); })();",
      "  while (!ready()) await Promise.resolve().then(() => sleep(1));",
      "  while (!ready()) await run(async () => { await sleep(1); });",
      "  while (!ready()) await new Promise(resolve => delay(resolve, 1));",
      "  clearInterval(every(() => undefined, 5));",
      "  while (!ready()) await scheduler.wait(1);",
      "  while (!ready()) await promises.scheduler.wait(1);",
      "  while (!ready()) await nap();",
      "  while (!ready()) await sleepTurn();",
      "  while (!ready()) await settle();",
      "  while (!ready()) await pause();",
      "  while (!ready()) await queue.pause();",
      "  for (let i = 0; i < 3; i += 1) void (async () => { await sleep(1); })();",
      "  for (let i = 0; i < 3; i += 1) void Promise.resolve().then(() => sleep(1));",
      "  for (let i = 0; i < 3; i += 1) run(async () => { await sleep(1); }).catch(() => undefined);",
      "}",
    ].join("\n")],
  ]);
  // queue.pause shares only its name with the helper pause; the discarded callbacks of the last three loops hold no turn up.
  expect(fixtureFinds(fixtures)).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19].map(line => `src/fixture/__tests__/inline.test.ts:${line}`));
});
