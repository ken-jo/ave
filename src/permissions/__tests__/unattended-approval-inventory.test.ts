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
const APPROVAL_CHANNEL_GROUP = /^(?:approval|askUserQuestion)$/;

function literalText(node: ts.Node): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return undefined;
}

function memberName(node: ts.Node | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isComputedPropertyName(node)) return literalText(node.expression);
  return literalText(node);
}

function propertyOf(node: ts.Node): { name: string; owner: ts.Expression } | undefined {
  if (ts.isPropertyAccessExpression(node)) return { name: node.name.text, owner: node.expression };
  if (ts.isElementAccessExpression(node)) {
    const name = literalText(node.argumentExpression);
    if (name !== undefined) return { name, owner: node.expression };
  }
  return undefined;
}

function isChannelTable(node: ts.Expression, bindings: ReadonlySet<string>): boolean {
  if (ts.isIdentifier(node)) return bindings.has(node.text);
  if (ts.isParenthesizedExpression(node) || ts.isAssertionExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) {
    return isChannelTable(node.expression, bindings);
  }
  return propertyOf(node)?.name === "CHANNELS";
}

function channelTableBindings(file: ts.SourceFile): ReadonlySet<string> {
  const bindings = new Set(["CHANNELS"]);
  const aliases: { name: string; value: ts.Expression }[] = [];
  function collect(node: ts.Node): void {
    if (ts.isImportSpecifier(node) && (node.propertyName ?? node.name).text === "CHANNELS") bindings.add(node.name.text);
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isIdentifier(node.name)) aliases.push({ name: node.name.text, value: node.initializer });
      if (ts.isObjectBindingPattern(node.name)) {
        for (const entry of node.name.elements) {
          if (entry.name && ts.isIdentifier(entry.name) && memberName(entry.propertyName ?? entry.name) === "CHANNELS") bindings.add(entry.name.text);
        }
      }
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) {
      aliases.push({ name: node.left.text, value: node.right });
    }
    node.forEachChild(collect);
  }
  collect(file);
  // An alias can be used by a callback declared before the alias is initialized.
  let previousSize: number;
  do {
    previousSize = bindings.size;
    for (const { name, value } of aliases) {
      if (isChannelTable(value, bindings)) bindings.add(name);
    }
  } while (bindings.size !== previousSize);
  return bindings;
}

function isElectronLoad(node: ts.Node): boolean {
  if (!ts.isCallExpression(node) || node.arguments.length !== 1) return false;
  const [module] = node.arguments;
  return module !== undefined && ts.isStringLiteral(module) && ELECTRON_MODULE.test(module.text);
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
    path !== PRESENTATION && /electron|show(?:MessageBox|SaveDialog|OpenDialog|ErrorBox)|IPC_(?:APPROVAL|ASK_USER_QUESTION)_REQUEST|approval|askUserQuestion|ask-user-question|sendDecisionCard|\bCHANNELS\b/i.test(source)));
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
    const channelTables = path.startsWith("contract/") || path.startsWith("preload/") ? undefined : channelTableBindings(file);
    const fromChannelTable = (owner: ts.Expression): boolean => channelTables !== undefined && isChannelTable(owner, channelTables);
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
      const property = propertyOf(node);
      if (property && APPROVAL_CHANNEL_GROUP.test(property.name) && fromChannelTable(property.owner)) record(node, "approval channel group");
      if (ts.isElementAccessExpression(node) && !property && fromChannelTable(node.expression)) record(node, "computed approval channel group access");
      if (ts.isVariableDeclaration(node) && node.initializer && ts.isObjectBindingPattern(node.name) && fromChannelTable(node.initializer)) {
        for (const entry of node.name.elements) {
          const name = memberName(entry.propertyName ?? entry.name);
          if (entry.dotDotDotToken || name === undefined || APPROVAL_CHANNEL_GROUP.test(name)) record(entry, "approval channel group");
        }
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isObjectLiteralExpression(node.left) && fromChannelTable(node.right)) {
        for (const entry of node.left.properties) {
          const name = ts.isSpreadAssignment(entry) ? undefined : memberName(entry.name);
          if (name === undefined || APPROVAL_CHANNEL_GROUP.test(name)) record(entry, "approval channel group");
        }
      }
      if (channelTables !== undefined && property?.name === "request") {
        const group = propertyOf(property.owner);
        if (group && APPROVAL_CHANNEL_GROUP.test(group.name) && !fromChannelTable(group.owner)) record(node, "approval request channel");
      }
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

it.each([
  ["a destructured approval group", "const { approval } = CHANNELS; win.send(approval.request, card)", 1],
  ["an aliased approval group", "const ch = CHANNELS.approval; win.send(ch.request, card)", 1],
  ["an alias of the channel table", "const ch = CHANNELS;\nconst alias = ch;\nwin.send(alias[`askUserQuestion`].respond, card)", 3],
  ["a renamed channel table import", 'import { CHANNELS as wire } from "../contract/app-contract.js";\nconst { askUserQuestion: question } = wire; win.send(question.request, card)', 2],
  ["a destructured channel from an approval group", "const { settled } = CHANNELS.approval; win.send(settled, card)", 1],
  ["a destructuring assignment", "let group;\n({ approval: group } = CHANNELS)", 2],
  ["an assigned channel table alias", "let wire;\nwire = (CHANNELS);\nwire.approval.settled", 3],
])("rejects $0 in a virtual source file", (_name, source, line) => {
  const path = "main/new-approval.ts";
  expect(violations(new Map([[path, source]]))).toEqual([`${path}:${line} approval channel group`]);
});

it.each(["contract/channel-consumer.ts", "preload/channel-consumer.ts", PRESENTATION])("allows approval channel groups in %s", (path) => {
  expect(violations(new Map([[path, "const { approval } = CHANNELS; win.send(approval.request, card)"]]))).toEqual([]);
});

it("allows aliases that access unrelated properties on the channel table", () => {
  expect(violations(new Map([["main/channel-consumer.ts", "const wire = CHANNELS; const { chat } = wire; wire.settings.update; chat.send"]]))).toEqual([]);
});
