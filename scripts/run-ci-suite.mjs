#!/usr/bin/env node
// Plan test selection once; shards consume that exact file list.
// Patch and category merges use affected tests; untrusted selections retain the full backstop.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { parseGitRawDiff } from "./hooks/pre-push-ref-updates.mjs";
import { isCanonicalGitPath } from "./hooks/pre-push-markdown-policy.mjs";
import {
  getRelatedCoverageFullReason,
  isTestHelperModule,
  isTestOnlyDiff,
  isTestSupportFile,
  selectFastSourceChecks,
  selectMessageCatalogChecks,
  selectTriggeredLockSuites,
} from "./hooks/pre-push-source-policy.mjs";
import { isCollectedVitestFile } from "./lib/vitest-collection.mjs";
import { WINDOWS_INVENTORY_LOCK, windowsInventoryDiff } from "./windows-test-inventory.mjs";
import * as ast from "typescript/unstable/ast";
import { UNBOUNDED_INPUT_EXEMPTIONS, UNBOUNDED_INPUT_TEMP_HELPERS } from "./ci-unbounded-input-exemptions.mjs";
import { withParsedSourceTexts } from "./lib/ts7-ast.mjs";

export const MUST_RUN_TESTS_PATH = "config/ci-must-run-tests.json";

// Broad affected selections use the full suite on non-integration bases.
export const AFFECTED_TEST_LIMIT = 600;

// Computed imports escape the module graph and require full checks on non-integration bases.
const COMPUTED_IMPORT = /\bimport\.meta\.glob\b|\brequire\.context\b|\b(?:import|require)\s*\(\s*(?:\/\*[\s\S]*?\*\/\s*)*(?!["'\s)/]|`[^`$]*`)/u;

export function loadsComputedImport(text) {
  return COMPUTED_IMPORT.test(text);
}

const REPO_PATH_LITERAL = /["'`]((?:src|test|scripts|config|resources|docs)\/[^"'`\s$]*)["'`]/gu;
const RELATIVE_PATH_LITERAL = /["'`](\.{1,2}\/[^"'`\s$]+)["'`]/gu;
// Retain fixture-directory readers when split path joins hide the complete changed path.
const FIXTURE_DIRECTORY_LITERAL = /["'`](?:[^"'`$\r\n]*\/)?fixtures(?:\/[^"'`$\r\n]*)?["'`]/u;
// A root-level directory join names every path below that directory.
const ROOTED_DIRECTORY_LITERAL = /\b(?:resolve|join)\(\s*[\w.]*(?:root|ROOT|Root|cwd\(\)|__dirname|dirname)[^)]*?["'`](src|test|scripts|config|resources|docs)\/?["'`]/gu;
const MODULE_EXTENSION = /\.(?:tsx?|mts|cts|mjs|cjs|jsx?)$/u;

// Literal file reads and tree scans reach inputs outside the import graph.
export function namedRepositoryPaths(testPath, text) {
  const paths = new Set();
  for (const [, literal] of text.matchAll(REPO_PATH_LITERAL)) paths.add(literal);
  for (const [, directory] of text.matchAll(ROOTED_DIRECTORY_LITERAL)) paths.add(`${directory}/`);
  for (const [, literal] of text.matchAll(RELATIVE_PATH_LITERAL)) {
    paths.add(posix.normalize(posix.join(posix.dirname(testPath), literal)));
  }
  return [...paths];
}

export function namesChangedPath(named, changedPath) {
  if (named === changedPath) return true;
  if (named.replace(MODULE_EXTENSION, "") === changedPath.replace(MODULE_EXTENSION, "")) return true;
  const directory = named.endsWith("/") ? named : `${named}/`;
  return changedPath.startsWith(directory);
}

// Tests executing repository code in children or bundles belong in the must-run set.
const OUT_OF_PROCESS_CODE = /["'`]--import["'`]\s*,\s*["'`]tsx["'`]|--import[= ]tsx\b|\btsx\/(?:esm|cjs)\b|require\.resolve\(\s*["'`]tsx["'`]|\bentryPoints\s*:/u;

export function runsRepoCodeOutOfProcess(text) {
  return OUT_OF_PROCESS_CODE.test(text);
}

const RELATIVE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\bvi\.(?:mock|doMock|importActual)\s*(?:<[^>]*>)?\(\s*)["'](\.{1,2}\/[^"']+)["']/gu;
const HELPER_EXTENSIONS = ["", ".ts", ".tsx", ".mts", ".cts", ".mjs", ".cjs", ".js", ".jsx", ".json"];

function someHelperSource(testPath, readText, matches, isHelperPath) {
  const seen = new Set();
  const pending = [testPath];
  while (pending.length > 0) {
    const path = pending.pop();
    if (seen.has(path)) continue;
    seen.add(path);
    const text = readText(path);
    if (typeof text !== "string") continue;
    if (matches(path, text)) return true;
    for (const [, specifier] of text.matchAll(RELATIVE_IMPORT)) {
      const target = posix.normalize(posix.join(posix.dirname(path), specifier));
      if (!isHelperPath(target) || /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(target)) continue;
      const base = target.replace(/\.[cm]?js$/u, "");
      for (const extension of HELPER_EXTENSIONS) {
        const candidate = `${extension === "" ? target : base}${extension}`;
        if (typeof readText(candidate) === "string") {
          pending.push(candidate);
          break;
        }
      }
    }
  }
  return false;
}

// Follow helper imports too: they can bundle or spawn code absent from the test body.
export function testRunsRepoCodeOutOfProcess(testPath, readText) {
  return someHelperSource(testPath, readText, (_path, text) => runsRepoCodeOutOfProcess(text), (target) => target.includes("/__tests__/"));
}

const FS_MODULES = new Set(["fs", "node:fs", "fs/promises", "node:fs/promises", "graceful-fs", "fs-extra"]);
const SUBPROCESS_MODULES = new Set(["child_process", "node:child_process", "worker_threads", "node:worker_threads", "execa", "cross-spawn", "@npmcli/promise-spawn"]);
const GLOB_MODULES = new Set(["glob", "fast-glob", "tinyglobby", "globby", "glob-fs", "glob-stream", "glob-promise", "node-glob", "fdir", "readdirp", "minimatch", "picomatch", "micromatch"]);
const LOCAL_SPECIFIER = /^(?:\.{1,2}\/|@\/|#)/u;
const INPUT_HELPER_EXTENSIONS = ["", ".ts", ".tsx", ".mts", ".cts", ".mjs", ".cjs", ".js", ".jsx"];

function packageImportTarget(imports, specifier) {
  for (const [key, value] of Object.entries(imports ?? {})) {
    const target = typeof value === "string" ? value : null;
    if (!target) continue;
    if (key === specifier) return posix.normalize(target);
    if (key.endsWith("*") && specifier.startsWith(key.slice(0, -1))) {
      return posix.normalize(target.replace("*", specifier.slice(key.length - 1)));
    }
  }
  return null;
}

// The helper a test-closure specifier names, or null when it names no
// __tests__/, test/ or scripts/ module. Unresolvable specifiers return
// { unresolved: true } so the closure fails closed.
function resolveInputHelper(path, specifier, imports, readText) {
  const target = specifier.startsWith("@/") ? posix.join("src", specifier.slice(2))
    : specifier.startsWith("#") ? packageImportTarget(imports, specifier)
      : posix.normalize(posix.join(posix.dirname(path), specifier));
  if (target === null) return { unresolved: true };
  const helper = (target.startsWith("__tests__/") || target.includes("/__tests__/") || target.startsWith("test/") || target.startsWith("scripts/"))
    && !/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(target);
  if (!helper || /\.json$/u.test(target)) return null;
  const base = target.replace(/\.[cm]?js$/u, "");
  const candidates = INPUT_HELPER_EXTENSIONS.flatMap((extension) => [`${base}${extension}`, `${target}${extension}`, `${base}/index${extension}`]);
  return { path: candidates.find((candidate) => typeof readText(candidate) === "string") ?? target };
}

function packageImports(readText) {
  try { return JSON.parse(readText("package.json") ?? "{}").imports; } catch { return undefined; }
}

const PATH_CALLS = new Set([
  "access", "accessSync", "appendFile", "appendFileSync", "chmod", "chmodSync",
  "exists", "existsSync", "lstat", "lstatSync", "mkdir", "mkdirSync", "mkdtemp", "mkdtempSync",
  "open", "openSync", "readdir", "readdirSync", "readFile", "readFileSync", "readlink", "readlinkSync",
  "realpath", "realpathSync", "rm", "rmSync", "rmdir", "rmdirSync", "stat", "statSync",
  "unlink", "unlinkSync", "writeFile", "writeFileSync",
]);
const TWO_PATH_CALLS = new Set(["symlinkSync", "symlink", "linkSync", "link", "cpSync", "cp", "copyFileSync", "copyFile", "renameSync", "rename"]);

const stringOf = (node) => node && (ast.isStringLiteral(node) || ast.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;
const accessOf = (node) => ast.isPropertyAccessExpression(node)
  ? { receiver: unwrapExpression(node.expression), name: node.name.text }
  : ast.isElementAccessExpression(node)
    ? { receiver: unwrapExpression(node.expression), name: stringOf(unwrapExpression(node.argumentExpression)) }
    : null;

function inspectInputSource(source, exemptions) {
  const classes = new Set();
  const specifiers = new Set();
  const calls = [];
  const variables = [];
  const loaders = new Set(["require"]);
  const factories = new Set(["createRequire"]);
  const forwards = new Map(Object.values(exemptions).flatMap((entry) => Object.entries(entry.forwards ?? {})
    .flatMap(([kind, names]) => names.map((name) => [name, kind]))));
  const fsLocals = new Set();
  let staticFs = true;
  let forwarded = false;
  const addModule = (specifier, isStatic) => {
    if (FS_MODULES.has(specifier)) {
      classes.add("read");
      if (!isStatic || moduleFamily(specifier) !== "fs") staticFs = false;
    }
    if (SUBPROCESS_MODULES.has(specifier)) classes.add("git");
    if (GLOB_MODULES.has(specifier) || specifier.startsWith("@glob/")) classes.add("listing");
    if (specifier === "bun" || specifier === "process" || specifier === "node:process") {
      // Module aliases can expose the same primitives as the globals.
      classes.add("runtime");
    }
  };
  const isTypeOnly = (clause) => clause?.isTypeOnly || (clause && !clause.name
    && clause.namedBindings && ast.isNamedImports(clause.namedBindings)
    && clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every((entry) => entry.isTypeOnly));
  const visit = (node) => {
    if (ast.isImportDeclaration(node) || ast.isExportDeclaration(node) || ast.isImportEqualsDeclaration(node)) {
      const specifier = stringOf(ast.isImportEqualsDeclaration(node) ? node.moduleReference.expression : node.moduleSpecifier);
      if (specifier !== undefined && !node.isTypeOnly && !isTypeOnly(node.importClause)) {
        specifiers.add(specifier);
        addModule(specifier, ast.isImportDeclaration(node) && node.importClause !== undefined);
        if (FS_MODULES.has(specifier) && node.importClause) {
          const { name, namedBindings } = node.importClause;
          if (name) fsLocals.add(name.text);
          if (namedBindings && ast.isNamespaceImport(namedBindings)) fsLocals.add(namedBindings.name.text);
          if (namedBindings && ast.isNamedImports(namedBindings)) {
            for (const entry of namedBindings.elements) if (!entry.isTypeOnly) fsLocals.add(entry.name.text);
          }
        }
        if (specifier === "module" || specifier === "node:module") {
          const bindings = node.importClause?.namedBindings;
          if (bindings && ast.isNamedImports(bindings)) {
            for (const entry of bindings.elements) {
              if ((entry.propertyName ?? entry.name).text === "createRequire") factories.add(entry.name.text);
            }
          }
        }
      }
    }
    if (ast.isCallExpression(node)) calls.push(node);
    if (ast.isElementAccessExpression(node) && ["Bun", "process"].includes(stringOf(node.argumentExpression))) classes.add("runtime");
    if (ast.isVariableDeclaration(node) && ast.isIdentifier(node.name) && node.initializer) variables.push(node);

    if (ast.isIdentifier(node)) {
      const access = accessOf(node.parent);
      const name = access?.name ?? (access ? undefined : node.text);
      if (node.text === "Bun" || node.text === "process") {
        const members = node.text === "Bun" ? ["file", "spawn", "spawnSync", "$", "Glob"] : ["binding"];
        if (!access || access.receiver !== node || access.name === undefined || members.includes(access.name)) classes.add("runtime");
      }
      const kind = forwards.get(node.text) ?? forwards.get(name);
      if (kind) {
        const callee = access?.receiver === node ? node.parent : node;
        const call = callee.parent;
        // The literal-path index already accounts for direct literal calls.
        if (!(ast.isCallExpression(call) && call.expression === callee && stringOf(call.arguments[0]) !== undefined)
          && !(ast.isImportSpecifier(node.parent) && !node.parent.propertyName)) {
          classes.add(kind);
          forwarded = true;
        }
      }
    }
    if (ast.isStringLiteral(node) || ast.isNoSubstitutionTemplateLiteral(node)) {
      if (node.text === "git" || node.text.startsWith("git ")) classes.add("git");
      const kind = ast.isElementAccessExpression(node.parent) ? forwards.get(node.text) : undefined;
      if (kind) {
        classes.add(kind);
        forwarded = true;
      }
    }
    node.forEachChild(visit);
  };
  visit(source);

  const loaderExpression = (expression) => {
    const callee = unwrapExpression(expression);
    if (ast.isIdentifier(callee)) return loaders.has(callee.text);
    if (accessOf(callee)?.name === "require") return true;
    if (!ast.isCallExpression(callee)) return false;
    const factory = unwrapExpression(callee.expression);
    return ast.isIdentifier(factory) ? factories.has(factory.text) : accessOf(factory)?.name === "createRequire";
  };
  // Names are over-approximated here. The temp proof uses scope-resolved bindings.
  for (const variable of variables) {
    if (loaderExpression(variable.initializer)) loaders.add(variable.name.text);
  }
  for (const call of calls) {
    const specifier = stringOf(call.arguments[0]);
    const callee = unwrapExpression(call.expression);
    const method = accessOf(callee)?.name;
    const moduleCall = loaderExpression(callee) || callee.kind === ast.SyntaxKind.ImportKeyword
      || ["mock", "doMock", "importActual", "importMock", "unstable_mockModule"].includes(method);
    // A module-name argument through an opaque loader cannot support a temp proof.
    if (specifier !== undefined) {
      addModule(specifier, false);
      if (moduleCall) specifiers.add(specifier);
    } else if (loaderExpression(callee) || callee.kind === ast.SyntaxKind.ImportKeyword) {
      classes.add("runtime");
    }
  }
  return { classes, specifiers, canProveFs: staticFs && !forwarded, fsLocals };
}

export function unboundedInputClasses(text, exemptions = UNBOUNDED_INPUT_EXEMPTIONS) {
  return withParsedSourceTexts(new Map([["source.ts", text]]), (sources) => {
    const source = sources.get("source.ts");
    return source ? [...inspectInputSource(source, exemptions).classes] : ["unresolved"];
  });
}

// A file can leave the always-run set when every runtime use of its fs imports
// is a modelled operation on a path derived from a known temporary root.
const TEMP_VALUE_LIMIT = 64;
const moduleFamily = (specifier) => ({ fs: "fs", "node:fs": "fs", "fs/promises": "fs", "node:fs/promises": "fs",
  path: "path", "node:path": "path", os: "os", "node:os": "os" })[specifier] ?? null;
const unwrapExpression = (node) => {
  while (ast.isParenthesizedExpression(node) || ast.isAsExpression(node) || ast.isNonNullExpression(node) || ast.isSatisfiesExpression(node)) node = node.expression;
  return node;
};
const escapesRoot = (value) => value.split(/[\\/]+/u).includes("..") || value.includes("~");
const isAbsoluteSegment = (value) => /^(?:[\\/]|[A-Za-z]:)/u.test(value);

function importOf(declaration) {
  if (!declaration) return null;
  if (ast.isImportSpecifier(declaration)) {
    const clause = declaration.parent?.parent;
    const statement = clause?.parent;
    if (!ast.isImportClause(clause) || clause.isTypeOnly || declaration.isTypeOnly || !ast.isImportDeclaration(statement)) return null;
    return { specifier: statement.moduleSpecifier.text, name: (declaration.propertyName ?? declaration.name).text };
  }
  const clause = ast.isNamespaceImport(declaration) ? declaration.parent : ast.isImportClause(declaration) ? declaration : null;
  const statement = clause?.parent;
  if (!clause || clause.isTypeOnly || !ast.isImportDeclaration(statement)) return null;
  return { specifier: statement.moduleSpecifier.text, name: "*" };
}

// The digest an audited temp helper entry pins: the helper and every file it covers.
export function tempHelperDigest(path, entry, readText) {
  const hash = createHash("sha256");
  for (const file of [path, ...(entry.covers ?? [])]) {
    const text = readText(file);
    if (typeof text !== "string") return null;
    hash.update(`${file}\0${text}\0`);
  }
  return hash.digest("hex");
}

function identifiersOf(source) {
  const identifiers = [];
  const collect = (node) => {
    if (ast.isIdentifier(node)) identifiers.push(node);
    node.forEachChild(collect);
  };
  collect(source);
  return identifiers;
}

function proveTempReads(path, declarations, fsLocals, context) {
  const references = new Map();
  for (const [node, declaration] of declarations) {
    const parent = node.parent;
    const nonBinding = (ast.isPropertyAccessExpression(parent) && parent.name === node)
      || (ast.isImportSpecifier(parent) && parent.propertyName === node);
    if (!declaration && fsLocals.has(node.text) && !nonBinding) return false;
    if (!declaration) continue;
    if (!references.has(declaration)) references.set(declaration, []);
    references.get(declaration).push(node);
  }

  // { family, name } for an fs, path or os function, or { helper, name } for an
  // imported function of a resolved helper module.
  const calleeOf = (expression) => {
    const callee = unwrapExpression(expression);
    if (ast.isIdentifier(callee)) {
      const imported = importOf(declarations.get(callee));
      if (!imported || imported.name === "*") return null;
      const family = moduleFamily(imported.specifier);
      if (family) return { family, name: imported.name };
      const helper = /^(?:\.{1,2}\/|@\/|#)/u.test(imported.specifier)
        ? resolveInputHelper(path, imported.specifier, context.imports, context.readText) : null;
      return helper?.path ? { helper: helper.path, name: imported.name } : null;
    }
    const access = accessOf(callee);
    if (access?.name === undefined) return null;
    const inner = accessOf(access.receiver);
    const receiver = inner ? inner.receiver : access.receiver;
    const member = inner?.name;
    if (!ast.isIdentifier(receiver)) return null;
    const imported = importOf(declarations.get(receiver));
    const family = imported ? moduleFamily(imported.specifier) : null;
    if (!family) return null;
    // fs.promises.readFile, path.posix.join, or { promises } / { posix } imports.
    const namespace = !inner ? imported.name : imported.name === "*" ? member : undefined;
    if (namespace === "*" || (family === "fs" && namespace === "promises") || (family === "path" && namespace === "posix")) {
      return { family, name: access.name };
    }
    return null;
  };

  // The audited factory a `const maker = factory(...literal segments)` binding
  // was made by, with its literal arguments, or null.
  const auditedMaker = (expression) => {
    const callee = unwrapExpression(expression);
    const declaration = ast.isIdentifier(callee) ? declarations.get(callee) : undefined;
    if (!declaration || !ast.isVariableDeclaration(declaration) || !ast.isIdentifier(declaration.name)) return null;
    const list = declaration.parent;
    if (!ast.isVariableDeclarationList(list) || (list.flags & ast.NodeFlags.Const) === 0 || !ast.isVariableStatement(list.parent)) return null;
    const made = declaration.initializer && unwrapExpression(declaration.initializer);
    if (!made || !ast.isCallExpression(made)) return null;
    const factory = calleeOf(made.expression);
    const entry = factory?.helper ? context.helpers[factory.helper] : undefined;
    const kind = entry?.factories[factory.name];
    if (!kind || tempHelperDigest(factory.helper, entry, context.readText) !== entry.digest) return null;
    const args = made.arguments.map(derive);
    if (args.some((arg) => !arg || arg.temp || arg.values.some((value) => escapesRoot(value) || isAbsoluteSegment(value)))) return null;
    return { kind, args };
  };

  const cross = (left, right, join) => {
    const values = left.flatMap((a) => right.map((b) => `${a}${join}${b}`));
    return values.length > TEMP_VALUE_LIMIT ? null : values;
  };

  // { temp, values }: values are the possible literal strings, or for a temp
  // path the possible suffixes after the temporary root. null is unproven.
  const visiting = new Set();
  const derive = (input) => {
    const node = unwrapExpression(input);
    if (ast.isStringLiteral(node) || ast.isNoSubstitutionTemplateLiteral(node) || ast.isNumericLiteral(node)) {
      return { temp: false, values: [node.text] };
    }
    if (ast.isTemplateExpression(node)) {
      if (node.head.text !== "") return null;
      let result = null;
      for (const span of node.templateSpans) {
        const part = derive(span.expression);
        if (!part || (result === null ? !part.temp : part.temp)) return null;
        const values = result === null ? part.values : cross(result.values, part.values, "");
        const withLiteral = values && cross(values, [span.literal.text], "");
        if (!withLiteral) return null;
        result = { temp: true, values: withLiteral };
      }
      return result;
    }
    if (ast.isBinaryExpression(node) && node.operatorToken.kind === ast.SyntaxKind.PlusToken) {
      const left = derive(node.left);
      const right = derive(node.right);
      if (!left || !right || right.temp) return null;
      const values = cross(left.values, right.values, "");
      return values && { temp: left.temp, values };
    }
    if (ast.isAwaitExpression(node)) {
      const inner = unwrapExpression(node.expression);
      return ast.isCallExpression(inner) ? deriveCall(inner, true) : null;
    }
    if (ast.isCallExpression(node)) return deriveCall(node, false);
    if (ast.isIdentifier(node)) return deriveBinding(declarations.get(node));
    return null;
  };

  const deriveCall = (call, awaited) => {
    const args = call.arguments.map(derive);
    if (args.some((arg) => arg === null)) return null;
    const maker = auditedMaker(call.expression);
    if (maker) {
      // A directory maker takes an optional own prefix; a path maker joins its file name.
      const literal = (arg) => !arg.temp && !arg.values.some((value) => escapesRoot(value) || isAbsoluteSegment(value));
      if (maker.kind === "directory" && args.length <= 1 && args.every(literal)) return { temp: true, values: [""] };
      if (maker.kind === "path" && args.length === 0 && maker.args.length === 2) {
        return { temp: true, values: maker.args[1].values.map((value) => `/${value}`) };
      }
      return null;
    }
    const callee = calleeOf(call.expression);
    if (!callee) return null;
    if (callee.family === "path" && (callee.name === "join" || callee.name === "resolve")) {
      const [root, ...segments] = args;
      if (!root?.temp || segments.some((segment) => segment.temp)) return null;
      if (callee.name === "resolve" && segments.some((segment) => segment.values.some(isAbsoluteSegment))) return null;
      let values = root.values;
      for (const segment of segments) {
        values = cross(values, segment.values, "/");
        if (!values) return null;
      }
      return { temp: true, values };
    }
    const fresh = (callee.family === "fs" && ["mkdtempSync", "realpathSync"].includes(callee.name))
      || (callee.family === "fs" && awaited && ["mkdtemp", "realpath"].includes(callee.name))
      || (callee.family === "os" && callee.name === "tmpdir" && args.length === 0);
    if (!fresh) return null;
    // realpath keeps its argument's root, so its argument must already be temp.
    if (callee.name.startsWith("realpath") && !(args.length >= 1 && args[0].temp && args.slice(1).every((arg) => !arg.temp))) return null;
    return { temp: true, values: [""] };
  };

  const assignmentTarget = (reference) => {
    let node = reference;
    let nested = false;
    while (ast.isParenthesizedExpression(node.parent) || ast.isArrayLiteralExpression(node.parent) || ast.isObjectLiteralExpression(node.parent)
      || ast.isShorthandPropertyAssignment(node.parent) || ast.isSpreadElement(node.parent) || ast.isSpreadAssignment(node.parent)
      || (ast.isPropertyAssignment(node.parent) && node.parent.initializer === node)) {
      if (!ast.isParenthesizedExpression(node.parent)) nested = true;
      node = node.parent;
    }
    const parent = node.parent;
    const assignment = ast.isBinaryExpression(parent) && parent.left === node
      && parent.operatorToken.kind >= ast.SyntaxKind.FirstAssignment && parent.operatorToken.kind <= ast.SyntaxKind.LastAssignment;
    const loopTarget = (ast.isForOfStatement(parent) || ast.isForInStatement(parent)) && parent.initializer === node;
    const update = (ast.isPrefixUnaryExpression(parent) || ast.isPostfixUnaryExpression(parent))
      && (parent.operator === ast.SyntaxKind.PlusPlusToken || parent.operator === ast.SyntaxKind.MinusMinusToken);
    if (!assignment && !loopTarget && !update) return { write: false };
    const simple = !nested && assignment && parent.operatorToken.kind === ast.SyntaxKind.EqualsToken && node === reference;
    return { write: true, value: simple ? parent.right : null };
  };

  const deriveBinding = (declaration) => {
    if (!declaration || !ast.isVariableDeclaration(declaration) || !ast.isIdentifier(declaration.name)) return null;
    if (visiting.has(declaration)) return null;
    visiting.add(declaration);
    try {
      const list = declaration.parent;
      if (!ast.isVariableDeclarationList(list)) return null;
      const constant = (list.flags & ast.NodeFlags.Const) !== 0;
      if (ast.isForOfStatement(list.parent)) {
        const items = unwrapExpression(list.parent.expression);
        if (!constant || !ast.isArrayLiteralExpression(items)) return null;
        const values = [];
        for (const item of items.elements) {
          if (!ast.isStringLiteral(item) && !ast.isNoSubstitutionTemplateLiteral(item)) return null;
          values.push(item.text);
        }
        return values.length > 0 && values.length <= TEMP_VALUE_LIMIT ? { temp: false, values } : null;
      }
      if (!ast.isVariableStatement(list.parent)) return null;
      const sources = declaration.initializer ? [declaration.initializer] : [];
      if (!constant) {
        for (const reference of references.get(declaration) ?? []) {
          if (reference === declaration.name) continue;
          const target = assignmentTarget(reference);
          if (!target.write) continue;
          if (!target.value) return null;
          sources.push(target.value);
        }
      } else if (!declaration.initializer) return null;
      if (sources.length === 0) return null;
      const values = [];
      for (const source of sources) {
        const derived = derive(source);
        if (!derived?.temp) return null;
        values.push(...derived.values);
      }
      return values.length <= TEMP_VALUE_LIMIT ? { temp: true, values } : null;
    } finally {
      visiting.delete(declaration);
    }
  };

  let provedUse = false;
  for (const [declaration, uses] of references) {
    const imported = importOf(declaration);
    if (!imported || moduleFamily(imported.specifier) !== "fs") continue;
    const namespace = imported.name === "*" || imported.name === "promises";
    for (const use of uses) {
      if (use === declaration.name || use === declaration.propertyName || use.parent === declaration) continue;
      let callee = use;
      if (namespace) {
        const member = accessOf(use.parent);
        if (member?.receiver !== use) return false;
        callee = use.parent;
        if (member.name === "promises" && imported.name === "*") {
          if (accessOf(callee.parent)?.receiver !== callee) return false;
          callee = callee.parent;
        }
      }
      const target = calleeOf(callee);
      const call = callee.parent;
      if (!target || !ast.isCallExpression(call) || call.expression !== callee) return false;
      const count = TWO_PATH_CALLS.has(target.name) ? 2 : PATH_CALLS.has(target.name) ? 1 : 0;
      if (count === 0 || call.arguments.length < count) return false;
      for (const input of call.arguments.slice(0, count)) {
        const argument = derive(input);
        if (!argument?.temp || argument.values.some(escapesRoot)) return false;
      }
      provedUse = true;
    }
  }
  return provedUse;
}

function inspectTestInputs(tests, readText, exemptions) {
  const context = { readText, imports: packageImports(readText), helpers: UNBOUNDED_INPUT_TEMP_HELPERS };
  const roots = new Set(tests);
  const graph = new Map();
  let pending = tests;
  while (pending.length > 0) {
    const texts = new Map();
    for (const path of new Set(pending)) {
      if (graph.has(path)) continue;
      graph.set(path, { hits: [`${path}:unresolved`], helpers: [] });
      const text = readText(path);
      if (typeof text === "string") texts.set(path, text);
    }
    pending = [];
    withParsedSourceTexts(texts, (sources, resolveDeclarations) => {
      for (const [path, source] of sources) {
        const { classes, specifiers, canProveFs, fsLocals } = inspectInputSource(source, exemptions);
        const hits = [];
        const helpers = [];
        for (const specifier of specifiers) {
          if (!LOCAL_SPECIFIER.test(specifier)) continue;
          const helper = resolveInputHelper(path, specifier, context.imports, readText);
          if (helper?.unresolved) hits.push(`${path}:unresolved ${specifier}`);
          else if (helper) {
            helpers.push(helper.path);
            pending.push(helper.path);
          }
        }
        if (roots.has(path) && classes.size === 1 && classes.has("read") && canProveFs
          && proveTempReads(path, resolveDeclarations(path, identifiersOf(source)), fsLocals, context)) classes.delete("read");
        for (const kind of classes) {
          if (!Object.hasOwn(exemptions[path] ?? {}, kind)) hits.push(`${path}:${kind}`);
        }
        graph.set(path, { hits, helpers });
      }
    });
  }
  return new Map(tests.map((test) => {
    const reached = new Set([test]);
    const hits = [];
    for (const path of reached) {
      const input = graph.get(path);
      hits.push(...input.hits);
      for (const helper of input.helpers) reached.add(helper);
    }
    return [test, hits];
  }));
}

/**
 * Primitive uses in a test and in the __tests__/, test/ and scripts/ modules it
 * imports, as `file:class` entries. A helper import that cannot be resolved or
 * read counts as `file:unresolved`, so an unreadable closure fails closed. A
 * test can drop its filesystem hit when every use is proven temp-bounded.
 */
export function unboundedInputHits(testPath, readText, exemptions = UNBOUNDED_INPUT_EXEMPTIONS) {
  return inspectTestInputs([testPath], readText, exemptions).get(testPath);
}

const unboundedInputCache = new WeakMap();
// Tests always run on affected plans because a primitive use could read any repository path.
export function selectUnboundedInputTests(trackedTests, readText, exemptions = UNBOUNDED_INPUT_EXEMPTIONS) {
  const byTests = unboundedInputCache.get(readText) ?? new WeakMap();
  unboundedInputCache.set(readText, byTests);
  const cached = exemptions === UNBOUNDED_INPUT_EXEMPTIONS ? byTests.get(trackedTests) : undefined;
  if (cached) return cached;
  const hits = inspectTestInputs(trackedTests, readText, exemptions);
  const selected = [...hits].filter(([, entries]) => entries.length > 0).map(([test]) => test).sort();
  if (exemptions === UNBOUNDED_INPUT_EXEMPTIONS) byTests.set(trackedTests, selected);
  return selected;
}

// Directory entries expand to collected tests; stale entries selecting nothing fail.
export function expandMustRunTests(document, trackedTests, changedPaths) {
  const groups = document?.groups;
  if (!groups || typeof groups !== "object" || Array.isArray(groups)) {
    throw new Error(`${MUST_RUN_TESTS_PATH} must hold a "groups" object`);
  }
  const triggers = document.triggers ?? {};
  if (!triggers || typeof triggers !== "object" || Array.isArray(triggers)) throw new Error("must-run triggers must be an object");
  for (const [group, paths] of Object.entries(triggers)) {
    if (!Object.hasOwn(groups, group) || !Array.isArray(paths) || paths.length === 0 || paths.some((path) => typeof path !== "string" || !isCanonicalGitPath(path.replace(/\/$/u, "")))) {
      throw new Error(`invalid must-run triggers for ${group}`);
    }
  }
  const selected = new Set();
  for (const [group, entries] of Object.entries(groups)) {
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new Error(`${MUST_RUN_TESTS_PATH} group "${group}" must list at least one path`);
    }
    for (const entry of entries) {
      if (typeof entry !== "string" || entry.length === 0) {
        throw new Error(`${MUST_RUN_TESTS_PATH} group "${group}" holds a non-path entry`);
      }
      const matches = entry.endsWith("/")
        ? trackedTests.filter((test) => test.startsWith(entry))
        : trackedTests.filter((test) => test === entry);
      if (matches.length === 0) {
        throw new Error(`${MUST_RUN_TESTS_PATH} group "${group}" entry ${entry} selects no collected test file`);
      }
      const triggered = changedPaths === undefined || !Object.hasOwn(triggers, group)
        || changedPaths.some((path) => triggers[group].some((prefix) => path.startsWith(prefix)));
      if (triggered) for (const test of matches) selected.add(test);
    }
  }
  if (selected.size === 0) throw new Error(`${MUST_RUN_TESTS_PATH} must select at least one collected test file`);
  return [...selected].sort();
}

export const COVERAGE_EVENTS = Object.freeze(["schedule", "workflow_dispatch"]);

export function runsCoverage(eventName) {
  return COVERAGE_EVENTS.includes(eventName);
}

// A native run already dominates the critical path. Keep one full worker pool
// beside it instead of paying for extra runners that finish early.
export const FULL_RUN_SHARDS = 4;

// About one full-run shard's worth of suites (a full shard runs roughly 1,900
// files / 4; the always-run unbounded-input suites are heavier). A larger
// affected plan uses the full run's shards so it cannot outlast the full run.
export const AFFECTED_SHARD_THRESHOLD = 240;

export function ciShardCount(plan, coverage, nativeChecks = false) {
  if (coverage || nativeChecks) return 1;
  if (plan.mode === "full") return FULL_RUN_SHARDS;
  return plan.tests.length > AFFECTED_SHARD_THRESHOLD ? FULL_RUN_SHARDS : 1;
}


// Reject malformed shard values so the aggregate cannot misreport coverage.
export function parseCiShard(value) {
  if (value === undefined || value === "") return null;
  const match = /^([1-9]\d*)\/([1-9]\d*)$/u.exec(value);
  if (!match || Number(match[1]) > Number(match[2])) {
    throw new Error(`AVE_CI_SHARD must be <index>/<count> with 1 <= index <= count, got ${JSON.stringify(value)}`);
  }
  return Number(match[2]) === 1 ? null : `${match[1]}/${match[2]}`;
}

// Every shard consumes the same written plan rather than recomputing selection.
export function readPlanFile(text) {
  const plan = JSON.parse(text);
  const valid = plan !== null && typeof plan === "object"
    && (plan.mode === "full" || plan.mode === "affected")
    && typeof plan.reason === "string"
    && Array.isArray(plan.tests) && plan.tests.every((test) => typeof test === "string");
  if (!valid) throw new Error("the CI plan file is not a { mode, reason, tests } plan");
  return { mode: plan.mode, reason: plan.reason, tests: plan.tests };
}

function full(reason) {
  return { mode: "full", reason, tests: [] };
}

function traceableInputs(changes, trackedTests) {
  const testFiles = new Set();
  const relatedFiles = new Set();
  for (const change of changes) {
    const single = selectFastSourceChecks([change]);
    for (const test of single.testFiles) testFiles.add(test);
    for (const source of single.relatedFiles) relatedFiles.add(source);
    const { path, status } = change;
    if (status === "D" || !isCanonicalGitPath(path)) continue;
    if (trackedTests.includes(path)) testFiles.add(path);
    else if (MODULE_EXTENSION.test(path)) relatedFiles.add(path);
  }
  return { testFiles: [...testFiles].sort(), relatedFiles: [...relatedFiles].sort() };
}

// Follow helper readers and match paths before opening them to retain deleted or renamed targets.
function testNamesChangedPath(test, changedPaths, readText) {
  const fixtureChanged = changedPaths.some((path) => path.includes("/fixtures/"));
  const seen = new Set();
  const pending = [test];
  while (pending.length > 0) {
    const path = pending.pop();
    if (seen.has(path)) continue;
    seen.add(path);
    const text = readText(path);
    if (typeof text !== "string") continue;
    if (fixtureChanged && FIXTURE_DIRECTORY_LITERAL.test(text)) return true;
    const named = namedRepositoryPaths(path, text);
    if (changedPaths.some((changed) => named.some((name) => namesChangedPath(name, changed)))) return true;
    for (const name of named) {
      const base = name.replace(MODULE_EXTENSION, "");
      for (const candidate of [name, ...HELPER_EXTENSIONS.flatMap((ext) => [`${base}${ext}`, `${base}/index${ext}`])]) {
        if (isTestSupportFile(candidate) && typeof readText(candidate) === "string") {
          pending.push(candidate);
        }
      }
    }
  }
  return false;
}

// Related-test discovery returns null on failure, not an empty successful result.
// Integration bases retain the best traced selection when coverage is uncertain.
export function selectCiTests({ changes, trackedTests, mustRunTests: requiredTests, readText, readVersion, discoverRelated, selectCatalog, baseRef }) {
  const inventory = windowsInventoryDiff(changes, readVersion);
  // Header-only declarations have no code impact on their containing domain.
  const mustRunTests = typeof requiredTests === "function"
    ? requiredTests(inventory.ordinary.map(({ path }) => path)) : requiredTests;
  const tracked = new Set(trackedTests);
  const deleted = new Set(changes.filter(({ status }) => status === "D").map(({ path }) => path));
  const inventoryTests = [...inventory.suites.keys()].filter(file => !deleted.has(file));
  if (inventory.changed) inventoryTests.push(WINDOWS_INVENTORY_LOCK);
  const unboundedTests = selectUnboundedInputTests(trackedTests, readText);
  const invalidInventoryTest = inventoryTests.find(file => !tracked.has(file));
  if (invalidInventoryTest) throw new Error(`Windows inventory names an uncollected test: ${invalidInventoryTest}`);
  if (inventory.changed && inventory.ordinary.length === 0) {
    if (mustRunTests.length === 0 || mustRunTests.some(file => !tracked.has(file))) {
      throw new Error("Windows inventory-only diff requires a nonempty collected must-run set");
    }
    return {
      mode: "affected",
      reason: `Windows inventory-only diff; ${inventory.suites.size} membership change(s); drift check, ${mustRunTests.length} must-run and ${unboundedTests.length} unbounded-input file(s)`,
      tests: [...new Set([...inventoryTests, ...mustRunTests, ...unboundedTests])].sort(),
    };
  }
  changes = inventory.ordinary;
  const integrationBase = typeof baseRef === "string" && baseRef.startsWith("integration/");
  const testOnly = isTestOnlyDiff(changes);
  const scoped = integrationBase || testOnly;
  const fullReasons = [];
  let fast = selectFastSourceChecks(changes);
  if (!fast.eligible) {
    if (!scoped) return full(fast.reason);
    if (!testOnly) fullReasons.push(fast.reason);
  }
  // Helpers reach tests outside import and literal-reader graphs, so their changes are not test-only.
  const helper = changes.find(({ path }) => isTestHelperModule(path));
  if (helper) {
    const reason = `${helper.path} is a test helper or setup module, which runs the full suite`;
    if (!integrationBase) return full(reason);
    fullReasons.push(`${reason} at the category merge`);
  }
  if (scoped) fast = { ...fast, ...traceableInputs(changes, trackedTests) };
  if (fast.messageCatalogEntries.length > 0) {
    const catalog = selectCatalog?.(fast.messageCatalogEntries);
    const reason = catalog?.reason ?? (!catalog ? `${fast.messageCatalogEntries[0].path} is message catalog data` : null);
    if (reason) {
      if (!integrationBase) return full(reason);
      fullReasons.push(reason);
    } else {
      const catalogPaths = new Set(fast.messageCatalogEntries.map(({ path }) => path));
      fast = { ...fast,
        testFiles: [...new Set([...fast.testFiles, ...catalog.testFiles])],
        relatedFiles: [...new Set([...fast.relatedFiles.filter((path) => !catalogPaths.has(path)), ...catalog.consumerModules])],
      };
    }
  }
  for (const path of fast.relatedFiles) {
    const text = readText(path);
    const reason = typeof text !== "string" ? `${path} could not be read`
      : loadsComputedImport(text) ? `${path} loads code through a computed import` : null;
    if (reason) {
      if (testOnly) throw new Error(`test-only selection cannot trace ${path}: ${reason}`);
      if (!scoped) return full(reason);
      fullReasons.push(reason);
    }
  }

  let related = [];
  if (fast.relatedFiles.length > 0) {
    const coverage = discoverRelated(fast.relatedFiles);
    const reason = coverage === null ? "related test discovery failed"
      // Unused helpers may have no importers; report records and returned paths must still validate.
      : getRelatedCoverageFullReason(testOnly ? [] : fast.relatedFiles, coverage, testOnly ? fast.relatedFiles : []);
    if (reason) {
      if (testOnly) throw new Error(`test-only selection cannot resolve importers: ${reason}`);
      if (!scoped) return full(reason);
      fullReasons.push(reason);
    }
    related = Array.isArray(coverage) ? coverage.flatMap((record) => Array.isArray(record?.tests) ? record.tests : []) : [];
  }

  const changedPaths = changes.map(({ path }) => path);
  const textReaders = [];
  for (const test of trackedTests) {
    const text = readText(test);
    if (typeof text !== "string") {
      const reason = `${test} could not be read`;
      if (testOnly) throw new Error(`test-only selection cannot trace readers: ${reason}`);
      if (!scoped) return full(reason);
      fullReasons.push(reason);
      continue;
    }
    const namesChange = testOnly || helper
      ? testNamesChangedPath(test, changedPaths, readText)
      : changedPaths.some((changed) => namedRepositoryPaths(test, text).some((path) => namesChangedPath(path, changed)));
    if (namesChange) textReaders.push(test);
  }

  const traced = new Set([...fast.testFiles, ...related, ...textReaders]);
  if (traced.size > AFFECTED_TEST_LIMIT) {
    const reason = `${traced.size} changed and related test files exceed ${AFFECTED_TEST_LIMIT}`;
    if (!scoped) return full(reason);
    fullReasons.push(reason);
  }

  const lockSuites = selectTriggeredLockSuites(changes.map(({ path }) => path)).flatMap(({ suite }) => {
    const matches = trackedTests.filter((test) => test === suite || test.startsWith(`${suite}/`));
    if (matches.length === 0) throw new Error(`lock suite ${suite} selects no collected test file`);
    return matches;
  });

  let tests = [...new Set([...traced, ...lockSuites, ...inventoryTests, ...mustRunTests, ...unboundedTests])].sort();
  const missing = tests.filter((test) => !trackedTests.includes(test));
  if (missing.length > 0) {
    if (testOnly) throw new Error(`test-only selection names an uncollected test: ${missing[0]}`);
    if (!scoped) return full(`${missing[0]} is not a collected test file of this tree`);
    fullReasons.push(...missing.map((test) => `${test} dropped: not a collected test file of this tree`));
    tests = tests.filter((test) => trackedTests.includes(test));
  }
  if (scoped && (mustRunTests.length === 0 || mustRunTests.some((test) => !tests.includes(test)))) {
    throw new Error(`${testOnly ? "test-only diff" : "integration base"} requires a nonempty collected must-run set`);
  }
  const warnings = [...new Set(fullReasons)].map((reason) => `${reason}; `).join("");
  const selectionRule = testOnly ? "test-only diff: affected tests on every base; " : integrationBase
    ? "integration base: traced selection, strict fallback at the main boundary; " : "";
  return {
    mode: "affected",
    reason:
      warnings + selectionRule +
      `${fast.relatedFiles.length} changed module(s) reach ${related.length === 0 ? 0 : new Set(related).size} test file(s); ` +
      `${fast.testFiles.length} changed test file(s); ${textReaders.length} test file(s) name a changed path; ` +
      `${lockSuites.length} lock suite file(s); ` +
      `${mustRunTests.length} must-run file(s); ${unboundedTests.length} unbounded-input file(s)`,
    tests,
  };
}

function git(args) {
  const result = spawnSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.error?.message ?? result.stderr.trim()}`);
  }
  return result.stdout;
}

function trackedVitestFiles() {
  return git(["ls-files", "-z", "--", "src", "test"]).split("\0").filter((path) => path && isCollectedVitestFile(path)).sort();
}

function rawDiff(base, what) {
  const entries = parseGitRawDiff(git(["diff", "--no-renames", "--raw", "-z", base, "HEAD", "--"]));
  return entries === null ? { reason: `${what} could not be parsed` } : { entries, base };
}

function pullRequestChanges() {
  const parents = git(["rev-list", "--parents", "-n", "1", "HEAD"]).trim().split(" ").slice(1);
  if (parents.length !== 2) return { reason: `HEAD has ${parents.length} parent(s), not a pull request merge commit` };
  return rawDiff(parents[0], "the merge commit's diff");
}

const FULL_SHA = /^[0-9a-f]{40}$/u;

// Compare every delivered commit, not just the final parent, so earlier production changes cannot hide.
// Missing or non-ancestral before commits provide no trusted base.
function pushChanges(before) {
  if (typeof before !== "string" || !FULL_SHA.test(before)) return { reason: "the push has no before commit to diff against" };
  if (/^0+$/u.test(before)) return { reason: "the push created the branch (zero before commit)" };
  const ancestry = spawnSync("git", ["merge-base", "--is-ancestor", before, "HEAD"], { encoding: "utf8" });
  if (ancestry.error || ancestry.status !== 0) {
    return { reason: `the push's before commit ${before} is not an ancestor of HEAD` };
  }
  return rawDiff(before, "the push's before..HEAD diff");
}

function discoverRelatedTests(paths) {
  const result = spawnSync(process.execPath, [join("scripts", "hooks", "pre-push-related-tests.mjs"), ...paths], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

// Category refs are reported separately; they use the same trusted affected selection as other PRs.
export function isCategoryMergeToMain(headRef, baseRef) {
  return baseRef === "main" && typeof headRef === "string" && headRef.startsWith("integration/");
}

export function planCiSuite(eventName, { headRef, baseRef, ref, before } = {}) {
  if (typeof eventName !== "string" || eventName.length === 0) {
    throw new Error("GITHUB_EVENT_NAME is unset: the CI suite needs the triggering event");
  }
  const mainPush = eventName === "push" && ref === "refs/heads/main";
  if (eventName !== "pull_request" && !mainPush) return full(`${eventName} runs the full suite`);
  if (!mainPush && (typeof headRef !== "string" || headRef.length === 0 || typeof baseRef !== "string" || baseRef.length === 0)) {
    throw new Error("GITHUB_HEAD_REF and GITHUB_BASE_REF must be set for a pull_request run");
  }
  let changes;
  try {
    changes = mainPush ? pushChanges(before) : pullRequestChanges();
  } catch (error) {
    changes = { reason: error instanceof Error ? error.message : String(error) };
  }
  if (changes.reason) {
    if (!mainPush && baseRef.startsWith("integration/")) {
      throw new Error(`integration base requires a resolved pull request diff: ${changes.reason}`);
    }
    return full(changes.reason);
  }
  const trackedTests = trackedVitestFiles();
  const mustRunDocument = JSON.parse(readFileSync(MUST_RUN_TESTS_PATH, "utf8"));
  const textCache = new Map();
  const plan = selectCiTests({
    changes: changes.entries,
    baseRef: mainPush ? "main" : baseRef,
    trackedTests,
    mustRunTests: (changedPaths) => expandMustRunTests(mustRunDocument, trackedTests, changedPaths),
    readVersion: (path, side) => {
      try { return git(["show", `${side === "before" ? changes.base : "HEAD"}:${path}`]); } catch { return null; }
    },
    readText: (path) => {
      if (textCache.has(path)) return textCache.get(path);
      let text = null;
      try {
        text = readFileSync(path, "utf8");
      } catch { /* Deleted helpers have no current source to read. */ }
      textCache.set(path, text);
      return text;
    },
    discoverRelated: discoverRelatedTests,
    selectCatalog: (entries) => selectMessageCatalogChecks(entries.map((entry) => ({ ...entry, baseSha: changes.base, localSha: "HEAD" })), {
      allowKeyChanges: true,
      includeUnresolvedConsumers: true,
      trackedFiles: git(["ls-files", "-z", "--", "src", "test"]).split("\0").filter(Boolean),
      readTrackedFile: (path) => {
        try { return readFileSync(path, "utf8"); } catch { return null; }
      },
      readBlob: (sha, path) => {
        try { return git(["show", `${sha}:${path}`]); } catch { return null; }
      },
    }),
  });
  const rule = mainPush ? "main push: trusted selection over before..HEAD" : isCategoryMergeToMain(headRef, baseRef)
    ? (isTestOnlyDiff(changes.entries) ? "test-only category merge" : "category merge: affected checks") : `pull request into ${baseRef}`;
  return { ...plan, reason: `${rule}; ${plan.reason}` };
}

// Only proven renderer-only patches omit native regression runners. Unknown
// paths and broad plans retain all platforms, including on scheduled releases.
export function platformChecksRequired(eventName, plan, changes, baseRef) {
  if (eventName === "pull_request" && baseRef?.startsWith("integration/")) return false;
  if (plan.mode === "full" || !["pull_request", "push"].includes(eventName) || !Array.isArray(changes) || changes.length === 0) return true;
  return changes.some(({ path }) => path === "src/ui/renderer/types.ts" || !["src/ui/renderer/", "src/components/", "src/i18n/messages/"].some((prefix) => path.startsWith(prefix)));
}

function describeRun(plan, coverage) {
  if (plan.mode === "affected") return `${plan.tests.length} affected test files`;
  return coverage ? "full suite with coverage gate" : "full suite";
}

function writeSummary(plan, coverage) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  const lines = [`### Vitest: ${describeRun(plan, coverage)}`, "", plan.reason];
  if (!coverage) lines.push("", "Coverage thresholds are enforced on the nightly and manually dispatched runs.");
  appendFileSync(summaryPath, `${lines.join("\n")}\n`);
}

export function ciSuiteArguments(plan, coverage, shard = null) {
  if (coverage && shard !== null) throw new Error("a coverage run cannot be sharded: its thresholds describe the whole suite");
  if (coverage) return [join("scripts", "run-test-coverage-gate.mjs")];
  if (plan.mode === "affected" && plan.tests.length === 0) throw new Error("affected CI selection must not be empty");
  const tests = plan.mode === "full" ? [] : plan.tests.map((test) => `./${test}`);
  // Vitest shards the given files with the full run's hash balancing.
  const split = shard === null ? [] : [`--shard=${shard}`];
  return [join("scripts", "run-vitest-under-electron.mjs"), "run", "--silent=true", ...split, ...tests];
}

function runPlan(plan, coverage, shard) {
  return spawnSync(process.execPath, ciSuiteArguments(plan, coverage, shard), { stdio: "inherit" });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    // Write the plan once; shards read it without replanning.
    const writePlanAt = process.argv[2] === "--write-plan" ? process.argv[3] : undefined;
    if (process.argv[2] === "--write-plan" && !writePlanAt) throw new Error("--write-plan needs a file path");
    const planFile = process.env.AVE_CI_PLAN_FILE;
    const plan = planFile && !writePlanAt
      ? readPlanFile(readFileSync(planFile, "utf8"))
      : planCiSuite(process.env.GITHUB_EVENT_NAME, {
        headRef: process.env.GITHUB_HEAD_REF,
        baseRef: process.env.GITHUB_BASE_REF,
        ref: process.env.GITHUB_REF,
        before: process.env.AVE_CI_DIFF_BASE,
      });
    const eventName = process.env.GITHUB_EVENT_NAME;
    const coverage = runsCoverage(eventName);
    if (coverage && plan.mode !== "full") throw new Error(`${eventName} must plan a full run to enforce coverage`);
    if (writePlanAt) {
      writeFileSync(writePlanAt, `${JSON.stringify(plan)}\n`, "utf8");
      let changes;
      try { changes = eventName === "push" ? pushChanges(process.env.AVE_CI_DIFF_BASE).entries : pullRequestChanges().entries; } catch { /* Unknown impact retains platforms. */ }
      const platforms = platformChecksRequired(eventName, plan, changes, process.env.GITHUB_BASE_REF);
      const shards = Array.from({ length: ciShardCount(plan, coverage, platforms) }, (_, index) => index + 1);
      console.log(`[ci-suite] planned ${describeRun(plan, coverage)} in ${shards.length} shard(s): ${plan.reason}`);
      writeSummary(plan, coverage);
      if (process.env.GITHUB_OUTPUT) {
        appendFileSync(process.env.GITHUB_OUTPUT, `shards=${JSON.stringify(shards)}\nplatform_checks=${platforms}\n`);
        if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\nNative platform checks: ${platforms ? "required" : "not selected (renderer-only diff)"}.\n`);
      }
      process.exit(0);
    }
    const shard = parseCiShard(process.env.AVE_CI_SHARD);
    console.log(`[ci-suite] ${describeRun(plan, coverage)}${shard ? `, shard ${shard}` : ""}: ${plan.reason}`);
    if (!planFile) writeSummary(plan, coverage);
    const result = runPlan(plan, coverage, shard);
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } catch (error) {
    console.error(`[ci-suite] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
