#!/usr/bin/env node
import {
  isExportDeclaration,
  isImportDeclaration,
  isNamedExports,
  isNamedImports,
  isStringLiteral,
} from "typescript/unstable/ast";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, extname, relative, resolve, parse, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseSourceFiles } from "./lib/ts7-ast.mjs";

const SOURCE_EXTENSIONS = [".tsx", ".ts", ".jsx", ".js"];
const EXTENSION_ALIASES = new Map([
  [".js", [".ts", ".tsx", ".js"]],
  [".mjs", [".mts", ".mjs"]],
  [".cjs", [".cts", ".cjs"]],
]);

function collectSourceFiles(root) {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = resolve(dir, name);
      const stat = statSync(path);
      if (stat.isDirectory()) walk(path);
      else if (/\.(?:[cm]?[jt]s|[jt]sx)$/u.test(name) && !/\.d\.[cm]?ts$/u.test(name)) files.push(path);
    }
  };
  walk(root);
  return files;
}

function isTypeOnlyImport(node) {
  const clause = node.importClause;
  if (!clause) return false;
  if (clause.isTypeOnly) return true;
  if (clause.name) return false;
  const bindings = clause.namedBindings;
  return isNamedImports(bindings)
    && bindings.elements.length > 0
    && bindings.elements.every((element) => element.isTypeOnly);
}

function isTypeOnlyExport(node) {
  if (node.isTypeOnly) return true;
  return node.exportClause
    && isNamedExports(node.exportClause)
    && node.exportClause.elements.length > 0
    && node.exportClause.elements.every((element) => element.isTypeOnly);
}

function findPackageConfig(start) {
  let current = resolve(start);
  const filesystemRoot = parse(current).root;
  while (true) {
    const path = resolve(current, "package.json");
    if (existsSync(path)) {
      const packageJson = JSON.parse(readFileSync(path, "utf8"));
      return { root: current, imports: packageJson.imports ?? {} };
    }
    if (current === filesystemRoot) return null;
    current = dirname(current);
  }
}

function collectImportTargets(target) {
  if (typeof target === "string") return [target];
  if (Array.isArray(target)) return target.flatMap(collectImportTargets);
  if (target && typeof target === "object") {
    return Object.values(target).flatMap(collectImportTargets);
  }
  return [];
}

function resolvePackageImport(specifier, packageConfig) {
  if (!specifier.startsWith("#") || !packageConfig) return [];
  const matches = [];
  for (const [pattern, target] of Object.entries(packageConfig.imports)) {
    const wildcardIndex = pattern.indexOf("*");
    let wildcard = "";
    if (wildcardIndex === -1) {
      if (specifier !== pattern) continue;
    } else {
      const prefix = pattern.slice(0, wildcardIndex);
      const suffix = pattern.slice(wildcardIndex + 1);
      if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue;
      wildcard = specifier.slice(prefix.length, specifier.length - suffix.length);
    }
    for (const candidate of collectImportTargets(target)) {
      if (!candidate.startsWith("./")) continue;
      matches.push(resolve(packageConfig.root, candidate.replaceAll("*", () => wildcard)));
    }
  }
  return matches;
}

function resolveLocalImport(from, specifier, fileSet, packageConfig) {
  const bases = specifier.startsWith(".")
    ? [resolve(dirname(from), specifier)]
    : resolvePackageImport(specifier, packageConfig);
  if (bases.length === 0) return null;
  const candidates = bases.flatMap((base) => {
    const extension = extname(base);
    const aliases = EXTENSION_ALIASES.get(extension);
    if (aliases) return aliases.map((alias) => base.slice(0, -extension.length) + alias);
    return [base, ...SOURCE_EXTENSIONS.map((suffix) => base + suffix),
      ...SOURCE_EXTENSIONS.map((suffix) => resolve(base, `index${suffix}`))];
  });
  return candidates.find((path) => fileSet.has(path)) ?? null;
}

// Type-only imports and exports do not create runtime graph edges.
export function buildRuntimeImportGraph(rootInput, { includeBuiltins = false } = {}) {
  const root = resolve(rootInput);
  const files = collectSourceFiles(root);
  const fileSet = new Set(files);
  const packageConfig = findPackageConfig(root);
  /** @type {Map<string, Set<string>>} */
  const graph = new Map(files.map((file) => [file, new Set()]));
  const sources = parseSourceFiles(files);
  for (const file of files) {
    const source = sources.get(file);
    if (!source) continue;
    for (const node of source.statements) {
      const importsAtRuntime = isImportDeclaration(node) && !isTypeOnlyImport(node);
      const exportsAtRuntime = isExportDeclaration(node) && !isTypeOnlyExport(node);
      if (!(importsAtRuntime || exportsAtRuntime) || !node.moduleSpecifier || !isStringLiteral(node.moduleSpecifier)) continue;
      const specifier = node.moduleSpecifier.text;
      const target = includeBuiltins && (specifier.startsWith("node:") || isBuiltin(specifier))
        ? specifier
        : resolveLocalImport(file, specifier, fileSet, packageConfig);
      if (target) graph.get(file).add(target);
    }
  }
  return graph;
}

export function findRuntimeImportCycles(rootInput) {
  const root = resolve(rootInput);
  const graph = buildRuntimeImportGraph(root);
  const files = [...graph.keys()];

  let nextIndex = 0;
  const indexes = new Map();
  const lows = new Map();
  const stack = [];
  const stacked = new Set();
  const components = [];
  const visit = (node) => {
    indexes.set(node, nextIndex);
    lows.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    stacked.add(node);
    for (const target of graph.get(node)) {
      if (!indexes.has(target)) {
        visit(target);
        lows.set(node, Math.min(lows.get(node), lows.get(target)));
      } else if (stacked.has(target)) {
        lows.set(node, Math.min(lows.get(node), indexes.get(target)));
      }
    }
    if (lows.get(node) !== indexes.get(node)) return;
    const component = [];
    let current;
    do {
      current = stack.pop();
      stacked.delete(current);
      component.push(current);
    } while (current !== node);
    if (component.length > 1 || graph.get(node).has(node)) components.push(component);
  };
  for (const file of files) if (!indexes.has(file)) visit(file);

  const display = (file) => normalizeDisplayPath(relative(root, file));
  return components.map((members) => {
    const memberSet = new Set(members);
    return {
      members: members.map(display).sort(),
      edges: members.flatMap((from) => [...graph.get(from)]
        .filter((to) => memberSet.has(to))
        .map((to) => `${display(from)} -> ${display(to)}`)).sort(),
    };
  }).sort((a, b) => b.members.length - a.members.length || a.members[0].localeCompare(b.members[0]));
}

export function normalizeDisplayPath(path, pathSeparator = sep) {
  return pathSeparator === "/" ? path : path.split(pathSeparator).join("/");
}

function runCli() {
  const root = resolve(process.argv[2] ?? "src");
  if (!existsSync(root)) throw new Error(`import-cycle root not found: ${root}`);
  const cycles = findRuntimeImportCycles(root);
  if (cycles.length === 0) {
    process.stdout.write(`[import-cycles] OK root=${relative(process.cwd(), root) || "."} cycles=0\n`);
    return;
  }
  process.stderr.write(`[import-cycles] FAIL cycles=${cycles.length}\n`);
  for (const [index, cycle] of cycles.entries()) {
    process.stderr.write(`cycle ${index + 1}: ${cycle.members.join(", ")}\n`);
    for (const edge of cycle.edges) process.stderr.write(`  ${edge}\n`);
  }
  process.exitCode = 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) runCli();
