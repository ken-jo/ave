import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript/unstable/ast";
import { API } from "typescript/unstable/sync";
import { describe, expect, it } from "vitest";
import { approvalSurfaceRegistry } from "../approval-surface-registry.js";

const SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OWNER_FILE = join(SOURCE_ROOT, "permissions/approval-surface-registry.ts");
const REGISTRY_MODULE = /(?:^|\/)approval-surface-registry\.(?:[cm]?js|ts)$/;

function enclosingCallable(node: ts.Node): ts.Node | undefined {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent) || ts.isArrowFunction(parent)
      || ts.isMethodDeclaration(parent) || ts.isGetAccessorDeclaration(parent) || ts.isSetAccessorDeclaration(parent)
      || ts.isConstructorDeclaration(parent)) return parent;
  }
  return undefined;
}

function writerViolations(sources: readonly ts.SourceFile[], ownerFile: string): string[] {
  const violations: string[] = [];
  const owner = sources.find((source) => resolve(source.fileName) === resolve(ownerFile));
  if (!owner) throw new Error("Approval registry source was not parsed");
  const mutableInstances: ts.VariableDeclaration[] = [];
  const mutators = new Set<string>();
  const collectOwner = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name?.text === "ApprovalSurfaceRegistry") {
      for (const method of node.members) {
        if (ts.isMethodDeclaration(method) && method.name.getText() !== "resolve") mutators.add(method.name.getText());
      }
    }
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isNewExpression(node.initializer)
      && ts.isIdentifier(node.initializer.expression) && node.initializer.expression.text === "ApprovalSurfaceRegistry") mutableInstances.push(node);
    node.forEachChild(collectOwner);
  };
  collectOwner(owner);
  if (mutableInstances.length !== 1) return ["Registry module must own exactly one mutable default instance"];
  const [instance] = mutableInstances;
  if (!ts.isIdentifier(instance.name)) return ["Mutable registry instance must have one private binding"];
  const mutableName = instance.name.text;
  const declaration = instance.parent?.parent;
  if (declaration && ts.isVariableStatement(declaration)
    && declaration.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
    violations.push("Mutable registry instance is exported at its declaration");
  }
  const callsThroughUpdate = new Set<string>();
  const updateFunctions = owner.statements.filter((node) => ts.isFunctionDeclaration(node) && node.name?.text === "updateApprovalSurface");
  if (updateFunctions.length !== 1) violations.push("Registry module must have one updateApprovalSurface function");
  const [updateFunction] = updateFunctions;

  for (const source of sources) {
    const location = relative(dirname(ownerFile), source.fileName);
    const views = new Set<string>();
    const scan = (node: ts.Node): void => {
      if (source !== owner && ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
        && REGISTRY_MODULE.test(node.moduleSpecifier.text)) {
        const clause = node.importClause;
        if (clause && clause.phaseModifier !== ts.SyntaxKind.TypeKeyword) {
          if (clause.name || clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
            violations.push(location + ": namespace or default registry import escapes the public surface");
          }
          if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
            for (const binding of clause.namedBindings.elements) {
              const imported = binding.propertyName?.text ?? binding.name.text;
              if (imported === "ApprovalSurfaceRegistry" && !binding.isTypeOnly) violations.push(location + ": registry class value imported outside its owner");
              if (imported === "approvalSurfaceRegistry" && !binding.isTypeOnly) views.add(binding.name.text);
            }
          }
        }
      }
      if (source !== owner && ts.isExportDeclaration(node) && node.moduleSpecifier
        && ts.isStringLiteral(node.moduleSpecifier) && REGISTRY_MODULE.test(node.moduleSpecifier.text) && !node.isTypeOnly) {
        violations.push(location + ": registry value re-export escapes the public surface");
      }
      if (source !== owner && ts.isCallExpression(node) && node.arguments[0] && ts.isStringLiteral(node.arguments[0])
        && REGISTRY_MODULE.test(node.arguments[0].text)
        && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === "require")) {
        violations.push(location + ": dynamic registry value import escapes the public surface");
      }
      if (source !== owner && ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "ApprovalSurfaceRegistry") {
        violations.push(location + ": another mutable registry is constructed");
      }
      if (source !== owner && ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && views.has(node.expression.text)
        && node.name.text !== "resolve") violations.push(location + ": registry view accesses writer " + node.name.text);
      if (source !== owner && ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) && views.has(node.expression.text)) {
        if (!ts.isStringLiteral(node.argumentExpression) || node.argumentExpression.text !== "resolve") violations.push(location + ": registry view accesses a computed writer");
      }
      if (source === owner && ts.isIdentifier(node) && node.text === mutableName && node !== instance.name) {
        const access = node.parent;
        if (!ts.isPropertyAccessExpression(access) || access.expression !== node) {
          violations.push(location + ": mutable registry instance escapes its private binding");
        } else if (mutators.has(access.name.text)) {
          const callable = enclosingCallable(access);
          if (!ts.isCallExpression(access.parent) || access.parent.expression !== access || !callable || !updateFunction
            || callable.pos !== updateFunction.pos || callable.end !== updateFunction.end) {
            violations.push(location + ": registry writer " + access.name.text + " is outside updateApprovalSurface");
          } else callsThroughUpdate.add(access.name.text);
        } else if (access.name.text !== "resolve") violations.push(location + ": mutable registry exposes unknown member " + access.name.text);
      }
      node.forEachChild(scan);
    };
    scan(source);
  }
  for (const method of mutators) {
    if (!callsThroughUpdate.has(method)) violations.push("Registry writer " + method + " has no common update path");
  }
  return violations;
}

function inspectSourceFiles(files: string[], ownerFile: string): string[] {
  const project = mkdtempSync(join(tmpdir(), "ave-approval-writer-syntax-"));
  const config = join(project, "tsconfig.json");
  writeFileSync(config, JSON.stringify({ compilerOptions: { noResolve: true, noLib: true, types: [] }, files }));
  const api = new API({ cwd: project });
  try {
    const program = api.updateSnapshot({ openProjects: [config] }).getProjects()[0]?.program;
    if (!program) throw new Error("Approval writer source project did not load");
    const sources = files.map((path) => {
      const source = program.getSourceFile(path);
      if (!source) throw new Error("Approval writer source did not parse: " + path);
      return source;
    });
    return writerViolations(sources, ownerFile);
  } finally {
    api.close();
    rmSync(project, { recursive: true, force: true });
  }
}

const PRIVATE_REGISTRY_SOURCE = [
  "export class ApprovalSurfaceRegistry {",
  "  register(session, owner) {}",
  "  resolve(session) { return null; }",
  "}",
  "const registry = new ApprovalSurfaceRegistry();",
  "export const approvalSurfaceRegistry = Object.freeze({ resolve: (session) => registry.resolve(session) });",
  "export function updateApprovalSurface(update) { registry.register(update.sessionId, update.surface); }",
].join("\n");

function inspectWriterAttempt(ownerSuffix: string, consumer = ""): string[] {
  const directory = mkdtempSync(join(tmpdir(), "ave-approval-writer-attempt-"));
  const owner = join(directory, "approval-surface-registry.ts");
  const caller = join(directory, "caller.ts");
  writeFileSync(owner, PRIVATE_REGISTRY_SOURCE + ownerSuffix);
  writeFileSync(caller, consumer);
  try {
    return inspectSourceFiles([owner, caller], owner);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("approval surface mutation ownership", () => {
  it("routes every production attachment and lifecycle mutation through the common update", () => {
    const files = readdirSync(SOURCE_ROOT, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name)
        && !/\.(?:test|spec)\.tsx?$/.test(entry.name)
        && !/(?:^|[/\\])__(?:tests|probes)__(?:[/\\]|$)/.test(entry.parentPath))
      .map((entry) => join(entry.parentPath, entry.name));
    expect(files.length).toBeGreaterThan(1000);
    expect(inspectSourceFiles(files, OWNER_FILE)).toEqual([]);
  });

  it("exports a frozen resolve-only view without runtime mutation methods", () => {
    expect(Object.isFrozen(approvalSurfaceRegistry)).toBe(true);
    expect(Object.keys(approvalSurfaceRegistry)).toEqual(["resolve"]);
    expect(Reflect.set(approvalSurfaceRegistry, "register", () => undefined)).toBe(false);
    expect(Reflect.has(approvalSurfaceRegistry, "register")).toBe(false);
  });

  it("allows class type references, read-only delivery and the common update entrypoint", () => {
    expect(inspectWriterAttempt("", [
      "import type { ApprovalSurfaceRegistry } from './approval-surface-registry.js';",
      "import { approvalSurfaceRegistry as delivery, updateApprovalSurface } from './approval-surface-registry.js';",
      "delivery.resolve('session'); updateApprovalSurface({sessionId:'session',surface:null});",
    ].join("\n"))).toEqual([]);
  });

  it.each([
    ["export const exposed = new ApprovalSurfaceRegistry();", "exactly one mutable default instance"],
    ["export { registry };", "mutable registry instance escapes"],
    ["const writer = registry.register;", "registry writer register is outside"],
    ["function attachElsewhere(update) { registry.register(update.sessionId, update.surface); }", "registry writer register is outside"],
    ["function outer() { function updateApprovalSurface(update) { registry.register(update.sessionId, update.surface); } }", "registry writer register is outside"],
    ["function outer() { return (update) => registry.register(update.sessionId, update.surface); }", "registry writer register is outside"],
  ])("rejects a private-instance escape or a second update path: %s", (source, reason) => {
    expect(inspectWriterAttempt(source).some((violation) => violation.includes(reason))).toBe(true);
  });

  it("rejects exporting the sole mutable instance directly at its declaration", () => {
    const directory = mkdtempSync(join(tmpdir(), "ave-approval-export-attempt-"));
    const owner = join(directory, "approval-surface-registry.ts");
    writeFileSync(owner, PRIVATE_REGISTRY_SOURCE.replace("const registry =", "export const registry ="));
    try {
      expect(inspectSourceFiles([owner], owner)).toContain("Mutable registry instance is exported at its declaration");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ["import { approvalSurfaceRegistry as delivery } from './approval-surface-registry.js'; delivery.register('session', null);", "registry view accesses writer"],
    ["import { ApprovalSurfaceRegistry as OtherRegistry } from './approval-surface-registry.js'; new OtherRegistry();", "registry class value imported"],
    ["import * as delivery from './approval-surface-registry.js';", "namespace or default registry import"],
    ["export { ApprovalSurfaceRegistry } from './approval-surface-registry.js';", "registry value re-export"],
    ["const delivery = await import('./approval-surface-registry.js');", "dynamic registry value import"],
  ])("rejects production access outside the public registry contract: %s", (source, reason) => {
    expect(inspectWriterAttempt("", source).some((violation) => violation.includes(reason))).toBe(true);
  });
});
