import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as ts from "typescript/unstable/ast";
import { parseSourceTexts } from "../../../scripts/lib/ts7-ast.mjs";
import { expect, it } from "vitest";

const SRC = new URL("../../", import.meta.url);
const PRESENTATION = "permissions/approval-presentation.ts";
const NATIVE_DIALOG_MEMBER = /^show(?:(?:MessageBox|SaveDialog|OpenDialog)(?:Sync)?|ErrorBox)$/;
const APPROVAL_CHANNEL = /^ave:(?:approval|ask-user-question):request$/;
const ELECTRON_MODULE = /^electron(?:\/(?:main|common|renderer))?$/;
const APPROVAL_CHANNEL_ALIAS = /^IPC_(?:APPROVAL|ASK_USER_QUESTION)_REQUEST$/;

function propertyOf(node: ts.Node): { name: string; owner: ts.Expression } | undefined {
  if (ts.isPropertyAccessExpression(node)) return { name: node.name.text, owner: node.expression };
  if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)) {
    return { name: node.argumentExpression.text, owner: node.expression };
  }
  return undefined;
}

function isElectronLoad(node: ts.Node): boolean {
  if (!ts.isCallExpression(node) || node.arguments.length !== 1) return false;
  const [module] = node.arguments;
  return module !== undefined && ts.isStringLiteral(module) && ELECTRON_MODULE.test(module.text);
}

function isApprovalRequestAccess(node: ts.Node): boolean {
  const access = propertyOf(node);
  if (access?.name !== "request") return false;
  const owner = propertyOf(access.owner);
  return owner?.name === "approval" || owner?.name === "askUserQuestion";
}

function isChannelDefinitionOrListener(path: string, node: ts.Node): boolean {
  if (path === "contract/app-contract.ts" && ts.isPropertyAssignment(node.parent) && node.parent.initializer === node) return true;
  const parent = node.parent;
  return path.startsWith("preload/") && ts.isCallExpression(parent) && parent.arguments[0] === node
    && ts.isPropertyAccessExpression(parent.expression) && ts.isIdentifier(parent.expression.expression)
    && parent.expression.expression.text === "ipcRenderer"
    && (parent.expression.name.text === "on" || parent.expression.name.text === "removeListener");
}

function violations(sources: Map<string, string>): string[] {
  const candidates = new Map([...sources].filter(([path, source]) =>
    path !== PRESENTATION && /electron|show(?:MessageBox|SaveDialog|OpenDialog|ErrorBox)|IPC_(?:APPROVAL|ASK_USER_QUESTION)_REQUEST|approval|askUserQuestion|ask-user-question|sendDecisionCard/i.test(source)));
  const parsed = parseSourceTexts(candidates) as Map<string, ts.SourceFile>;
  const found: string[] = [];
  for (const path of candidates.keys()) {
    const file = parsed.get(path);
    if (!file) throw new Error(`Could not parse ${path}`);
    const record = (node: ts.Node, capability: string) => {
      const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
      found.push(`${path}:${line} ${capability}`);
    };
    const electronBindings = new Set<string>();
    function findElectronBindings(node: ts.Node): void {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && ELECTRON_MODULE.test(node.moduleSpecifier.text)) {
        if (node.importClause?.name) electronBindings.add(node.importClause.name.text);
        const binding = node.importClause?.namedBindings;
        if (binding && ts.isNamespaceImport(binding)) electronBindings.add(binding.name.text);
      }
      if (ts.isVariableDeclaration(node) && node.initializer) {
        const value = ts.isAwaitExpression(node.initializer) ? node.initializer.expression : node.initializer;
        if (isElectronLoad(value) && ts.isIdentifier(node.name)) electronBindings.add(node.name.text);
      }
      node.forEachChild(findElectronBindings);
    }
    findElectronBindings(file);
    const fromElectron = (node: ts.Expression): boolean => isElectronLoad(node)
      || (ts.isAwaitExpression(node) && isElectronLoad(node.expression))
      || (ts.isParenthesizedExpression(node) && fromElectron(node.expression))
      || (ts.isIdentifier(node) && electronBindings.has(node.text));

    function inspect(node: ts.Node): void {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        const from = node.moduleSpecifier;
        if (from && ts.isStringLiteral(from) && ELECTRON_MODULE.test(from.text)) {
          const clause = ts.isImportDeclaration(node) ? node.importClause?.namedBindings : node.exportClause;
          if (clause && (ts.isNamedImports(clause) || ts.isNamedExports(clause))) {
            for (const entry of clause.elements) {
              if ((entry.propertyName ?? entry.name).text === "dialog") record(entry, "electron dialog import");
            }
          }
        }
      }
      if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        if (NATIVE_DIALOG_MEMBER.test(node.text)) record(node, "native dialog");
        if ((APPROVAL_CHANNEL.test(node.text) || APPROVAL_CHANNEL_ALIAS.test(node.text)) && !isChannelDefinitionOrListener(path, node)) {
          const declaration = ts.isExportSpecifier(node.parent) ? node.parent.parent.parent : undefined;
          const from = declaration && ts.isExportDeclaration(declaration) ? declaration.moduleSpecifier : undefined;
          const exportFromGate = from && ts.isStringLiteral(from) && from.text.endsWith("approval-presentation.js");
          if (!exportFromGate) record(node, "approval request channel");
        }
      }
      if (isApprovalRequestAccess(node) && !isChannelDefinitionOrListener(path, node)) record(node, "approval request channel");
      const property = propertyOf(node);
      if (property?.name === "dialog" && fromElectron(property.owner)) record(node, "electron dialog access");
      if (ts.isVariableDeclaration(node) && node.initializer && fromElectron(node.initializer) && ts.isObjectBindingPattern(node.name)) {
        for (const entry of node.name.elements) {
          const name = entry.propertyName ?? entry.name;
          if (name && (ts.isIdentifier(name) || ts.isStringLiteral(name)) && name.text === "dialog") record(entry, "electron dialog import");
        }
      }
      if (property?.name === "sendDecisionCard" && !ts.isTypeOfExpression(node.parent)) record(node, "remote approval card");
      node.forEachChild(inspect);
    }
    inspect(file);
  }
  return found;
}

function productionSources(): Map<string, string> {
  const paths = readdirSync(fileURLToPath(SRC), { recursive: true, encoding: "utf8" });
  return new Map(paths.map(path => path.replaceAll("\\", "/"))
    .filter(path => /\.[cm]?[jt]sx?$/.test(path) && !path.split("/").includes("__tests__") && !path.includes("/test-helpers."))
    .map(path => [path, readFileSync(new URL(path, SRC), "utf8")]));
}

it("reserves native dialogs and approval request transports for the common presentation gate", () => {
  expect(violations(productionSources())).toEqual([]);
});

it("rejects a raw native dialog in a virtual new file", () => {
  const path = "main/new-picker.ts";
  expect(violations(new Map([[path, `import { dialog as picker } from "electron";
picker["showSaveDialogSync"]({});`]]))).toEqual([
    `${path}:1 electron dialog import`,
    `${path}:2 native dialog`,
  ]);
});

it("rejects an extra native dialog and approval send in an existing presenter", () => {
  const path = "main/browser/browser-workspace-desktop.ts";
  const source = readFileSync(new URL(path, SRC), "utf8");
  const line = source.split("\n").length + 1;
  expect(violations(new Map([[path, `${source}
async function added(win: Electron.WebContents) {
  const platform = await import("electron");
  platform.dialog.showMessageBox({});
  win.send("ave:approval:request", {});
}`]]))).toEqual([`${path}:${line + 2} electron dialog access`, `${path}:${line + 2} native dialog`, `${path}:${line + 3} approval request channel`]);
});
