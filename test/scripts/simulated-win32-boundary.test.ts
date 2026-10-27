import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as ast from "typescript/unstable/ast";
import { describe, expect, it } from "vitest";
import { buildRuntimeImportGraph } from "../../scripts/check-import-cycles.mjs";
import { parseSourceFiles, parseSourceTexts } from "../../scripts/lib/ts7-ast.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OWNER_FILES = ["ave-home-configuration-access", "windows-configuration-handles", "windows-path-facts"];
const FACTORIES = new Map([
  ["node:fs", ["simulatedConfigurationFs", "simulatedDriveFs"]],
  ["windows-configuration-handles", ["simulatedConfigurationHandles"]],
  ["windows-path-facts", ["simulatedWindowsPathFacts"]],
]);

type Source = ast.SourceFile;
type Node = ast.Node;

function descendants(node: Node): Node[] {
  const nodes: Node[] = [node];
  node.forEachChild(child => { nodes.push(...descendants(child)); });
  return nodes;
}

function text(source: Source, node: Node | undefined): string {
  return node ? source.text.slice(node.pos, node.end).trim() : "";
}

function literal(node: Node | undefined, value: string): boolean {
  return !!node && ast.isStringLiteral(node) && node.text === value;
}

function localTarget(from: string, specifier: string, files: ReadonlySet<string>): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = resolve(dirname(from), specifier);
  return [base, base.replace(/\.js$/, ".ts"), base.replace(/\.js$/, ".tsx"), `${base}.ts`, `${base}.tsx`, resolve(base, "index.ts"), resolve(base, "index.tsx")]
    .find(candidate => files.has(candidate));
}

// Discover aliases and wrappers from their bodies instead of maintaining suite/helper name lists.
function platformHelpers(sources: Map<string, Source>, files: ReadonlySet<string>): Map<string, Set<string>> {
  const helpers = new Map<string, Set<string>>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [file, source] of sources) {
      const names = helpers.get(file) ?? new Set<string>();
      helpers.set(file, names);
      for (const node of source.statements) {
        if (ast.isImportDeclaration(node) && ast.isStringLiteral(node.moduleSpecifier)) {
          const target = localTarget(file, node.moduleSpecifier.text, files);
          const bindings = node.importClause?.namedBindings;
          if (target && bindings && ast.isNamedImports(bindings)) {
            for (const binding of bindings.elements) {
              if (helpers.get(target)?.has((binding.propertyName ?? binding.name).text) && !names.has(binding.name.text)) {
                names.add(binding.name.text);
                changed = true;
              }
            }
          }
        }
      }
      for (const node of descendants(source)) {
        const functions = ast.isFunctionDeclaration(node) && node.name && node.body
          ? [[node.name.text, node.body] as const]
          : ast.isVariableDeclaration(node) && ast.isIdentifier(node.name) && node.initializer
            && (ast.isArrowFunction(node.initializer) || ast.isFunctionExpression(node.initializer))
            ? [[node.name.text, node.initializer.body] as const] : [];
        for (const [name, body] of functions) {
          if (!names.has(name) && descendants(body).some(child => platformMutation(source, child, names) !== undefined)) {
            names.add(name);
            changed = true;
          }
        }
      }
      // Re-exported helper names retain their behavior through barrels.
      for (const node of source.statements) {
        if (!ast.isExportDeclaration(node) || !node.moduleSpecifier || !ast.isStringLiteral(node.moduleSpecifier)
          || !node.exportClause || !ast.isNamedExports(node.exportClause)) continue;
        const target = localTarget(file, node.moduleSpecifier.text, files);
        for (const binding of node.exportClause.elements) {
          if (target && helpers.get(target)?.has((binding.propertyName ?? binding.name).text) && !names.has(binding.name.text)) {
            names.add(binding.name.text);
            changed = true;
          }
        }
      }
    }
  }
  return helpers;
}

// Return the assigned expression, or null for a wrapper with no argument.
function platformMutation(source: Source, node: Node, helpers: ReadonlySet<string>): Node | null | undefined {
  if (!ast.isCallExpression(node)) return undefined;
  const call = text(source, node.expression).replace(/\s/g, "");
  if (helpers.has(call)) return node.arguments[0] ?? null;
  if (call === "Object.defineProperty" && text(source, node.arguments[0]!) === "process" && literal(node.arguments[1], "platform")) {
    const descriptor = node.arguments[2];
    if (descriptor && ast.isObjectLiteralExpression(descriptor)) {
      const property = descriptor.properties.find(property => "name" in property && text(source, property.name) === "value");
      if (property && ast.isPropertyAssignment(property)) return property.initializer;
      if (property && ast.isShorthandPropertyAssignment(property)) return property.name;
    }
  }
  if (call === "vi.stubGlobal" && literal(node.arguments[0], "process")) {
    const descriptor = node.arguments[1];
    if (descriptor && ast.isObjectLiteralExpression(descriptor)) {
      const property = descriptor.properties.find(property => "name" in property && text(source, property.name) === "platform");
      if (property && ast.isPropertyAssignment(property)) return property.initializer;
      if (property && ast.isShorthandPropertyAssignment(property)) return property.name;
    }
    if (descriptor && ast.isCallExpression(descriptor) && text(source, descriptor.expression) === "Object.create") {
      const properties = descriptor.arguments[1];
      if (properties && ast.isObjectLiteralExpression(properties)) {
        const platform = properties.properties.find(property => ast.isPropertyAssignment(property) && text(source, property.name) === "platform");
        if (platform && ast.isPropertyAssignment(platform) && ast.isObjectLiteralExpression(platform.initializer)) {
          const value = platform.initializer.properties.find(property => ast.isPropertyAssignment(property) && text(source, property.name) === "value");
          if (value && ast.isPropertyAssignment(value)) return value.initializer;
        }
      }
    }
  }
  if (ast.isPropertyAccessExpression(node.expression) && /^mock(ReturnValue|Implementation)$/.test(node.expression.name.text)) {
    const spy = node.expression.expression;
    if (ast.isCallExpression(spy) && text(source, spy.expression).replace(/\s/g, "") === "vi.spyOn"
      && text(source, spy.arguments[0]!) === "process" && literal(spy.arguments[1], "platform")) return node.arguments[0];
  }
  return undefined;
}

function forcesWin32(source: Source, helpers: ReadonlySet<string>): boolean {
  const nodes = descendants(source);
  const hasWin32 = nodes.some(node => literal(node, "win32"));
  if (!hasWin32) return false;
  const capturedHost = new Set(nodes.filter(ast.isVariableDeclaration)
    .filter(node => node.initializer && /^(process\.platform|Object\.getOwnPropertyDescriptor\(process,\s*["']platform["']\))$/.test(text(source, node.initializer)))
    .map(node => text(source, node.name)));
  return nodes.some(node => {
    const value = platformMutation(source, node, helpers);
    if (value === undefined) return false;
    if (value === null) return true;
    if (ast.isStringLiteral(value)) return value.text === "win32";
    if (capturedHost.has(text(source, value)) || text(source, value) === "process.platform") return false;
    // Loop/table parameters and local wrappers may supply win32; uncertainty requires the boundary.
    return true;
  });
}

function mockCalls(source: Source) {
  return descendants(source).filter(ast.isCallExpression).filter(node => text(source, node.expression).replace(/\s/g, "") === "vi.mock"
    && node.arguments[0] && ast.isStringLiteral(node.arguments[0]));
}

function missingFactories(source: Source, file: string, files: ReadonlySet<string>): string[] {
  return [...FACTORIES].filter(([key, factories]) => !mockCalls(source).some(mock => {
    const specifier = mock.arguments[0];
    if (!ast.isStringLiteral(specifier)) return false;
    if (key === "node:fs" ? specifier.text !== key
      : localTarget(file, specifier.text, files) !== resolve(ROOT, "src/shared", `${key}.ts`)) return false;
    const factory = mock.arguments[1];
    if (!factory) return false;
    const nodes = descendants(factory);
    return nodes.some(node => ast.isCallExpression(node) && factories.some(name =>
      ast.isPropertyAccessExpression(node.expression) && node.expression.name.text === name
      || ast.isIdentifier(node.expression) && node.expression.text === name))
      && nodes.some(node => ast.isCallExpression(node) && node.expression.kind === ast.SyntaxKind.ImportKeyword
        && ast.isStringLiteral(node.arguments[0])
        && localTarget(file, node.arguments[0].text, files) === resolve(ROOT, "src/__tests__/support/simulated-win32-drive.ts"));
  })).map(([key]) => key);
}

function ownerPath(start: string, graph: Map<string, Set<string>>, owners: ReadonlySet<string>): string[] | undefined {
  const visited = new Set<string>();
  const visit = (file: string): string[] | undefined => {
    if (visited.has(file)) return undefined;
    visited.add(file);
    if (owners.has(file)) return [file];
    for (const next of graph.get(file) ?? []) {
      const path = visit(next);
      if (path) return [file, ...path];
    }
    return undefined;
  };
  return visit(start);
}

describe("simulated win32 configuration boundaries", () => {
  it("requires all shared factories in every forcing suite with a reachable configuration owner", () => {
    const graph = buildRuntimeImportGraph(resolve(ROOT, "src")) as Map<string, Set<string>>;
    const files = new Set(graph.keys());
    const sources = parseSourceFiles([...files]) as Map<string, Source>;
    expect(sources.size).toBe(files.size);
    // The shared graph covers runtime imports/re-exports. Add literal dynamic imports and require calls.
    for (const [file, source] of sources) {
      for (const node of descendants(source)) {
        if (!ast.isCallExpression(node) || !(node.expression.kind === ast.SyntaxKind.ImportKeyword || text(source, node.expression) === "require")) continue;
        const specifier = node.arguments[0];
        if (specifier && ast.isStringLiteral(specifier)) {
          const target = localTarget(file, specifier.text, files);
          if (target) graph.get(file)!.add(target);
        }
      }
    }
    const helpers = platformHelpers(sources, files);
    const owners = new Set(OWNER_FILES.map(name => resolve(ROOT, "src/shared", `${name}.ts`)));
    const failures: string[] = [];
    for (const [file, source] of sources) {
      if (!file.replaceAll("\\", "/").includes("/__tests__/") || !file.endsWith(".test.ts") || !forcesWin32(source, helpers.get(file)!)) continue;
      // No suite exemptions or mock-pruned edges: replacements can later become partial.
      const path = ownerPath(file, graph, owners);
      const missing = missingFactories(source, file, files);
      if (path && missing.length) failures.push(`${relative(ROOT, file).replaceAll("\\", "/")}: missing ${missing.join(", ")}\n  ${path.map(part => relative(ROOT, part).replaceAll("\\", "/")).join(" -> ")}`);
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("recognizes direct overrides, aliases, wrappers, spies and table-driven platforms", () => {
    const sources = parseSourceTexts(new Map([
      ["platform.ts", 'export function setProcessPlatform(value: string) { Object.defineProperty(process, "platform", { value }); }'],
      ["suite.ts", 'import { setProcessPlatform as forcePlatform } from "./platform.js"; forcePlatform("win32");'],
      ["direct.ts", 'Object.defineProperty(process, "platform", { value: "win32" });'],
      ["spy.ts", 'vi.spyOn(process, "platform", "get").mockReturnValue("win32");'],
      ["table.ts", 'it.each(["linux", "win32"])("platform", platform => { Object.defineProperty(process, "platform", { value: platform }); });'],
      ["wrapper.ts", 'function partial() { Object.defineProperty(process, "platform", { value: "win32" }); } partial();'],
      ["global.ts", 'vi.stubGlobal("process", { ...process, platform: "win32" });'],
      ["created.ts", 'vi.stubGlobal("process", Object.create(process, { platform: { value: "win32" } }));'],
      ["native.ts", 'const host = process.platform; if (host === "win32") {} Object.defineProperty(process, "platform", { value: host });'],
      ["comment.ts", '// forcePlatform("win32")\nconst example = `Object.defineProperty(process, "platform", { value: "win32" })`;'],
    ])) as Map<string, Source>;
    const absolute = new Map([...sources].map(([file, source]) => [resolve(file), source]));
    const helpers = platformHelpers(absolute, new Set(absolute.keys()));
    for (const [file, source] of absolute) {
      expect(forcesWin32(source, helpers.get(file)!), file).toBe(!["platform.ts", "native.ts", "comment.ts"].some(name => file.endsWith(name)));
    }
  });

  it("rejects the sandbox suite when its shared boundary factories are removed", () => {
    const file = resolve(ROOT, "src/permissions/__tests__/windows-sandbox-logic.test.ts");
    const original = readFileSync(file, "utf8");
    const stripped = original.replace(/^vi\.mock\([^\n]+simulated(?:ConfigurationFs|ConfigurationHandles|WindowsPathFacts)[^\n]+\n/gm, "");
    expect(stripped).not.toBe(original);
    const sources = parseSourceTexts(new Map([["original.ts", original], ["stripped.ts", stripped]])) as Map<string, Source>;
    expect(sources.size).toBe(2);
    const files = new Set([
      file,
      resolve(ROOT, "src/__tests__/support/simulated-win32-drive.ts"),
      ...OWNER_FILES.map(name => resolve(ROOT, "src/shared", `${name}.ts`)),
    ]);
    expect(missingFactories(sources.get("original.ts")!, file, files)).toEqual([]);
    expect(missingFactories(sources.get("stripped.ts")!, file, files)).toEqual([...FACTORIES.keys()]);
  });

  it("walks transitive and cyclic import paths without treating unrelated modules as owners", () => {
    const graph = new Map([
      ["suite", new Set(["barrel"])],
      ["barrel", new Set(["suite", "owner"])],
      ["isolated", new Set(["unrelated"])],
    ]);
    expect(ownerPath("suite", graph, new Set(["owner"]))).toEqual(["suite", "barrel", "owner"]);
    expect(ownerPath("isolated", graph, new Set(["owner"]))).toBeUndefined();
    expect(ownerPath("suite", graph, new Set(["unreachable"]))).toBeUndefined();
  });
});
