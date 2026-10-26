import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
  isArrowFunction,
  isAsExpression,
  isAwaitExpression,
  isBinaryExpression,
  isBindingElement,
  isCallExpression,
  isClassDeclaration,
  isClassExpression,
  isConditionalExpression,
  isDeleteExpression,
  isElementAccessExpression,
  isExpressionWithTypeArguments,
  isFunctionDeclaration,
  isFunctionExpression,
  isHeritageClause,
  isIdentifier,
  isImportClause,
  isImportDeclaration,
  isImportSpecifier,
  isJsxAttribute,
  isJsxExpression,
  isJsxOpeningElement,
  isJsxSelfClosingElement,
  isJsxSpreadAttribute,
  isMethodDeclaration,
  isNamespaceImport,
  isNewExpression,
  isNonNullExpression,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectBindingPattern,
  isObjectLiteralExpression,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isQualifiedName,
  isSatisfiesExpression,
  isShorthandPropertyAssignment,
  isSourceFile,
  isSpreadAssignment,
  isStringLiteral,
  isTemplateExpression,
  isTypeAssertion,
  isTypeQueryNode,
  isTypeReferenceNode,
  isVariableDeclaration,
  NodeFlags,
  SyntaxKind,
  type Expression,
  type Node,
  type ObjectLiteralExpression,
  type SourceFile,
} from "typescript/unstable/ast";
import { API, SignatureKind, SymbolFlags, TypeFlags, type Checker, type Project, type Symbol as TsSymbol } from "typescript/unstable/sync";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Preload and sandbox choices must come from src/shared/preload-bundles.json.
// Unreadable sites fail this audit; runtime attachment guards enforce guest preferences.

type Row = { entry: string; file: string; build: "webpack" | "copy"; sandbox: boolean; runsIn: string };
type Table = Record<string, Row>;
type Site = { file: string; kind: "window" | "session" | "webview" | "html-webview"; id: string | null; request?: string | null; guard?: string | null };
type Audit = { sites: Site[]; problems: string[]; files: number };

const ROOT = process.cwd();
const TABLE: Table = JSON.parse(readFileSync(resolve(ROOT, "src/shared/preload-bundles.json"), "utf-8"));

// A null row denotes guests whose preloads are stripped and whose sandbox is enforced.
const WEBVIEW_SITES: Record<string, string | null> = {
  "src/plugin-ui-host.tsx": "pluginPreload",
  "src/floating-dock-window.js": "pluginPreload",
  "src/ui/renderer/components/McpAppView.tsx": "mcpAppPreload",
  "src/ui/renderer/components/ChatSidePanelPreview.tsx": null,
  // Browser tabs use the preview guest partition and sandbox policy.
  "src/ui/renderer/components/WebSurfaceLayer.tsx": null,
  "src/main/link-window-service.ts": null,
  "src/main/auth-window-content.ts": null,
};

const WINDOW_CLASSES = new Set(["BrowserWindow", "BrowserView", "WebContentsView"]);
const GUARDED_ELECTRON_TYPES = new Set([...WINDOW_CLASSES, "Session", "WebContents"]);
const ELECTRON_DTS = "/node_modules/electron/electron.d.ts";
const PRELOAD_HELPERS = "src/main/preload-bundles.ts";
const PRELOAD_TABLE_MODULE = "src/shared/preload-bundles.ts";
const ATTACH_GUARDS = "src/main/plugin-webview-attach.ts";
const HTML_SINK_PROPERTIES = new Set(["innerHTML", "outerHTML"]);
const HTML_SINK_CALLS: Record<string, number> = { insertAdjacentHTML: 1, write: 0, writeln: 0, parseFromString: 0, createContextualFragment: 0, setHTMLUnsafe: 0 };

// Compiler paths use forward slashes on every platform.
const toWire = (path: string): string => path.split("\\").join("/");

function listSources(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!["__tests__", "__probes__", "node_modules"].includes(entry.name)) walk(path);
      } else if (/\.(?:ts|tsx|js|cjs|mjs)$/u.test(entry.name) && !/\.(?:test|spec)\./u.test(entry.name) && !entry.name.endsWith(".d.ts")) {
        files.push(path);
      }
    }
  };
  walk(join(root, "src"));
  return files;
}

const unwrap = (node: Expression): Expression => {
  let current = node;
  while (isParenthesizedExpression(current) || isAsExpression(current) || isSatisfiesExpression(current) || isNonNullExpression(current) || isTypeAssertion(current)) {
    current = current.expression;
  }
  return current;
};

const literalText = (node: Node | undefined): string | null =>
  node && (isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node)) ? node.text : null;

function keyOf(name: Node): string | null {
  if (isIdentifier(name)) return name.text;
  if (isStringLiteral(name) || isNumericLiteral(name)) return name.text;
  return null;
}

function isElectronLoad(node: Node): "require" | "import" | null {
  const expression = unwrap(node as Expression);
  if (!isCallExpression(expression) || literalText(expression.arguments[0]) !== "electron") return null;
  if (expression.expression.kind === SyntaxKind.ImportKeyword) return "import";
  return isIdentifier(expression.expression) && expression.expression.text === "require" ? "require" : null;
}

// Return both the unwrapped parent and the node through which it is reached.
function usage(node: Node): { child: Node; parent: Node } {
  let child = node;
  let parent = node.parent;
  while (isParenthesizedExpression(parent) || isAsExpression(parent) || isSatisfiesExpression(parent) || isNonNullExpression(parent) || isTypeAssertion(parent)) {
    child = parent;
    parent = parent.parent;
  }
  return { child, parent };
}

class FileAudit {
  readonly windowLocals = new Set<string>();
  readonly electronNamespaces = new Set<string>();
  readonly domWebviews = new Map<string, Site>();
  readonly attributeCalls: { receiver: string | null; node: Node; name: Node | undefined; value: Node | undefined }[] = [];
  readonly propertyWrites: { receiver: string; property: string; node: Node }[] = [];

  constructor(
    readonly root: string,
    readonly rel: string,
    readonly source: SourceFile,
    readonly project: Project,
    readonly table: Table,
    readonly webviewSites: Record<string, string | null>,
    readonly audit: Audit,
  ) {}

  get checker(): Checker {
    return this.project.checker;
  }

  report(node: Node, message: string): void {
    const { line } = this.source.getLineAndCharacterOfPosition(node.getStart(this.source));
    this.audit.problems.push(`${this.rel}:${line + 1}: ${message}`);
  }

  text(node: Node): string {
    return node.getText(this.source).replace(/\s+/gu, " ");
  }

  resolved(node: Node): TsSymbol | undefined {
    const symbol = this.checker.getSymbolAtLocation(node);
    if (symbol && symbol.flags & SymbolFlags.Alias) return this.checker.getAliasedSymbol(symbol);
    return symbol;
  }

  declaredIn(symbol: TsSymbol | undefined, rel: string): boolean {
    const target = toWire(join(this.root, rel)).toLowerCase();
    return !!symbol && symbol.declarations.some((declaration) => toWire(declaration.path).toLowerCase() === target);
  }

  isElectron(symbol: TsSymbol | undefined, names: Set<string>): string | null {
    if (!symbol || !names.has(symbol.name)) return null;
    return symbol.declarations.some((declaration) => toWire(declaration.path).endsWith(ELECTRON_DTS)) ? symbol.name : null;
  }

  tableCall(node: Expression, fn: "preloadPreferences" | "preloadBundlePath"): string | null {
    let expression = unwrap(node);
    if (isIdentifier(expression)) {
      const declaration = this.resolved(expression)?.valueDeclaration?.resolve(this.project);
      if (!declaration || !isVariableDeclaration(declaration) || !declaration.initializer) return null;
      if (!(declaration.parent.flags & NodeFlags.Const)) return null;
      expression = unwrap(declaration.initializer);
    }
    if (!isCallExpression(expression) || expression.arguments.length !== 1) return null;
    const callee = this.resolved(expression.expression);
    if (callee?.name !== fn || !this.declaredIn(callee, PRELOAD_HELPERS)) return null;
    return literalText(expression.arguments[0]);
  }

  collectElectronBindings(): void {
    const isElectronRequire = (node: Expression | undefined): boolean => {
      if (!node) return false;
      const expression = unwrap(node);
      if (isAwaitExpression(expression)) return isElectronLoad(expression.expression) === "import";
      return isElectronLoad(expression) === "require";
    };
    const visit = (node: Node): void => {
      if (isImportDeclaration(node) && literalText(node.moduleSpecifier) === "electron" && node.importClause && node.importClause.phaseModifier !== SyntaxKind.TypeKeyword) {
        const clause = node.importClause;
        if (clause.name) this.electronNamespaces.add(clause.name.text);
        const bindings = clause.namedBindings;
        if (bindings && isNamespaceImport(bindings)) this.electronNamespaces.add(bindings.name.text);
        if (bindings && !isNamespaceImport(bindings)) {
          for (const element of bindings.elements) {
            if (!element.isTypeOnly && WINDOW_CLASSES.has((element.propertyName ?? element.name).text)) this.windowLocals.add(element.name.text);
          }
        }
      }
      if (isVariableDeclaration(node) && node.initializer) {
        const initializer = unwrap(node.initializer);
        const fromElectron = isElectronRequire(initializer) || (isIdentifier(initializer) && this.electronNamespaces.has(initializer.text));
        if (fromElectron && isIdentifier(node.name)) this.electronNamespaces.add(node.name.text);
        if (fromElectron && isObjectBindingPattern(node.name)) {
          for (const element of node.name.elements) {
            const local = element.name && isIdentifier(element.name) ? element.name : null;
            const imported = element.propertyName ? keyOf(element.propertyName) : local ? local.text : null;
            if (imported === null) this.report(element, "computed binding from the electron module");
          }
        }
      }
      if (isVariableDeclaration(node) && node.initializer && isIdentifier(unwrap(node.initializer)) && (unwrap(node.initializer) as { text?: string }).text === "Reflect" && !isIdentifier(node.name)) {
        this.report(node, "Reflect.construct taken out of Reflect, where the test cannot follow it");
      }
      // Follow destructured window classes even through parameters or re-exports.
      if (isBindingElement(node) && node.name && isIdentifier(node.name)) {
        const imported = node.propertyName ? keyOf(node.propertyName) : node.name.text;
        if (imported !== null && WINDOW_CLASSES.has(imported)) this.windowLocals.add(node.name.text);
      }
      node.forEachChild(visit);
    };
    visit(this.source);
  }

  run(): void {
    this.collectElectronBindings();
    const constructions: Node[] = [];
    const visit = (node: Node): void => {
      if (isNewExpression(node)) constructions.push(node);
      else if (isCallExpression(node)) this.call(node);
      if (isPropertyAccessExpression(node) || isElementAccessExpression(node)) this.memberReference(node);
      if (isBinaryExpression(node) && node.operatorToken.kind === SyntaxKind.EqualsToken) this.assignment(node);
      if (isJsxOpeningElement(node) || isJsxSelfClosingElement(node)) this.jsx(node);
      if (isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node) || isTemplateExpression(node)) this.htmlString(node);
      if (isIdentifier(node)) this.electronReference(node);
      if (isHeritageClause(node) && node.token === SyntaxKind.ExtendsKeyword) this.heritage(node);
      node.forEachChild(visit);
    };
    visit(this.source);
    this.constructions(constructions);
    this.domWebviewAttributes();
  }

  constructions(nodes: Node[]): void {
    if (nodes.length === 0) return;
    const types = this.checker.getTypeAtLocation(nodes);
    nodes.forEach((node, index) => {
      if (!isNewExpression(node)) return;
      const type = types[index];
      const windowClass = this.isElectron(type?.getSymbol(), WINDOW_CLASSES);
      if (windowClass) this.window(node, windowClass);
      else if ((!type || type.flags & (TypeFlags.Any | TypeFlags.Unknown) || type.isErrorType()) && /BrowserWindow|BrowserView|WebContentsView/u.test(this.text(node.expression))) {
        this.report(node, `new ${this.text(node.expression)} could not be resolved to a type`);
      }
    });
  }

  window(node: Node, windowClass: string): void {
    if (!isNewExpression(node)) return;
    const site: Site = { file: this.rel, kind: "window", id: null };
    this.audit.sites.push(site);
    const options = node.arguments?.[0];
    if (!options) return;
    const literal = unwrap(options);
    if (!isObjectLiteralExpression(literal)) {
      this.report(options, `${windowClass} options are not an object literal`);
      return;
    }
    let webPreferences: ObjectLiteralExpression | null = null;
    for (const property of literal.properties) {
      if (isSpreadAssignment(property)) {
        const type = this.checker.getTypeAtLocation(property.expression);
        if (!type || type.flags & (TypeFlags.Any | TypeFlags.Unknown) || this.checker.getPropertyOfType(type, "webPreferences")) {
          this.report(property, `spread into the ${windowClass} options may set webPreferences: ${this.text(property)}`);
        }
        continue;
      }
      if (!property.name || keyOf(property.name) === null) {
        this.report(property, `computed key in the ${windowClass} options`);
        continue;
      }
      if (keyOf(property.name) !== "webPreferences") continue;
      const value = isPropertyAssignment(property) ? unwrap(property.initializer) : null;
      if (!value || !isObjectLiteralExpression(value)) {
        this.report(property, `webPreferences is not an object literal: ${this.text(property)}`);
        continue;
      }
      webPreferences = value;
    }
    if (!webPreferences) return;

    const ids: string[] = [];
    const keyed = new Map<string, Node>();
    let webviewTag: boolean | null = false;
    for (const property of webPreferences.properties) {
      if (isSpreadAssignment(property)) {
        const id = this.tableCall(property.expression, "preloadPreferences");
        if (id !== null) {
          if (!this.table[id]) this.report(property, `preloadPreferences("${id}") names no row of the preload table`);
          ids.push(id);
        } else if (!this.onlyClearsPreload(property.expression)) {
          this.report(property, `a spread into webPreferences the test cannot prove: ${this.text(property)}`);
        }
        continue;
      }
      if (!property.name || keyOf(property.name) === null) {
        this.report(property, `computed key in webPreferences: ${this.text(property)}`);
        continue;
      }
      const key = keyOf(property.name) as string;
      if (!isPropertyAssignment(property)) {
        if (["sandbox", "preload", "webviewTag"].includes(key)) this.report(property, `webPreferences.${key} is not a literal value`);
        continue;
      }
      keyed.set(key, property);
      if (key === "webviewTag") {
        const value = unwrap(property.initializer).kind;
        webviewTag = value === SyntaxKind.TrueKeyword ? true : value === SyntaxKind.FalseKeyword ? false : null;
        if (webviewTag === null) this.report(property, "webviewTag must be a boolean literal");
      }
    }
    if (ids.length > 1) this.report(webPreferences, `spreads more than one preload: ${ids.join(", ")}`);
    site.id = ids[0] ?? null;
    const sandbox = keyed.get("sandbox");
    const preload = keyed.get("preload");
    if (preload && isPropertyAssignment(preload) && !(isIdentifier(preload.initializer) && preload.initializer.text === "undefined")) {
      this.report(preload, `names its own preload (${this.text(preload.initializer)}); spread preloadPreferences(id)`);
    }
    if (sandbox && isPropertyAssignment(sandbox)) {
      if (ids.length > 0) this.report(sandbox, `a window running preload ${ids.join(", ")} names its own sandbox; the preload table sets it`);
      else if (unwrap(sandbox.initializer).kind !== SyntaxKind.TrueKeyword) this.report(sandbox, "a window without a preload may only set sandbox: true");
    }
    if (webviewTag === true) {
      site.guard = this.attachGuard(node);
      if (site.guard === null) this.report(node, `${windowClass} has webviewTag: true but no will-attach-webview guard on it that enforces its guests`);
    }
  }

  // A clearing branch may omit preload or set it to undefined.
  onlyClearsPreload(node: Expression): boolean {
    const expression = unwrap(node);
    if (!isConditionalExpression(expression)) return false;
    return [expression.whenTrue, expression.whenFalse].every((branch) => {
      const object = unwrap(branch);
      return isObjectLiteralExpression(object) && object.properties.every((property) =>
        isPropertyAssignment(property) && keyOf(property.name) === "preload" && isIdentifier(property.initializer) && property.initializer.text === "undefined");
    });
  }

  // Accept an imported attach guard or an inline guard that strips preload and enables sandbox.
  attachGuard(node: Node): string | null {
    const declaration = node.parent;
    if (!isVariableDeclaration(declaration) || !isIdentifier(declaration.name)) return null;
    const name = declaration.name.text;
    let guard: string | null = null;
    const visit = (child: Node): void => {
      if (isCallExpression(child) && literalText(child.arguments[0]) === "will-attach-webview" && isPropertyAccessExpression(child.expression) && child.expression.name.text === "on") {
        const receiver = child.expression.expression;
        const handler = child.arguments[1];
        if (isPropertyAccessExpression(receiver) && receiver.name.text === "webContents" && isIdentifier(receiver.expression) && receiver.expression.text === name && handler) {
          guard = this.guardIn(handler) ?? guard;
        }
      }
      child.forEachChild(visit);
    };
    visit(this.source);
    return guard;
  }

  guardIn(handler: Node): string | null {
    let guard: string | null = null;
    let strips = false;
    let sandboxed = false;
    const visit = (child: Node): void => {
      if (isCallExpression(child)) {
        const callee = this.resolved(isPropertyAccessExpression(child.expression) ? child.expression.name : child.expression);
        if (callee && this.declaredIn(callee, ATTACH_GUARDS)) guard = callee.name;
      }
      if (isDeleteExpression(child) && isPropertyAccessExpression(child.expression) && child.expression.name.text === "preload") strips = true;
      if (isBinaryExpression(child) && child.operatorToken.kind === SyntaxKind.EqualsToken && isPropertyAccessExpression(child.left) && child.left.name.text === "sandbox" && unwrap(child.right).kind === SyntaxKind.TrueKeyword) sandboxed = true;
      child.forEachChild(visit);
    };
    visit(handler);
    return guard ?? (strips && sandboxed ? "inline: strips the preload, sandbox true" : null);
  }

  call(node: Node): void {
    if (!isCallExpression(node)) return;
    const callee = node.expression;
    const method = isPropertyAccessExpression(callee) ? callee.name.text : isElementAccessExpression(callee) ? literalText(callee.argumentExpression) : isIdentifier(callee) ? callee.text : null;
    if (method === "setPreloads") this.report(node, "session.setPreloads bypasses the preload table; use registerPreloadScript with preloadBundlePath(id)");
    if (method === "registerPreloadScript") this.sessionPreload(node);
    if (method === "createElement") this.createElement(node);
    if (method === "construct" && (isPropertyAccessExpression(callee) || isElementAccessExpression(callee)) && isIdentifier(callee.expression) && callee.expression.text === "Reflect") this.construct(node);
    if (method !== null && method in HTML_SINK_CALLS) {
      const value = node.arguments[HTML_SINK_CALLS[method]];
      const document = method !== "write" && method !== "writeln" || (isPropertyAccessExpression(callee) && /\bdocument$/u.test(this.text(callee.expression)));
      if (value && document) this.html(value, method);
    }
    const load = isElectronLoad(node);
    if (load) this.electronLoad(node, load);
    if (method === "setAttribute" && isPropertyAccessExpression(callee)) {
      this.attributeCalls.push({ receiver: isIdentifier(callee.expression) ? callee.expression.text : null, node, name: node.arguments[0], value: node.arguments[1] });
    }
  }

  sessionPreload(node: Node): void {
    if (!isCallExpression(node)) return;
    const options = node.arguments[0] ? unwrap(node.arguments[0]) : null;
    let id: string | null = null;
    let proven = !!options && isObjectLiteralExpression(options);
    if (options && isObjectLiteralExpression(options)) {
      for (const property of options.properties) {
        const key = isPropertyAssignment(property) ? keyOf(property.name) : null;
        if (!isPropertyAssignment(property) || key === null) proven = false;
        else if (key === "filePath") id = this.tableCall(property.initializer, "preloadBundlePath");
        else if (literalText(property.initializer) === null) proven = false;
      }
    }
    if (!proven || id === null || !this.table[id]) {
      this.report(node, `registerPreloadScript does not take preloadBundlePath(id) of a table row: ${this.text(node)}`);
      return;
    }
    this.audit.sites.push({ file: this.rel, kind: "session", id });
    if (!this.table[id].sandbox) this.report(node, `session preload ${id} runs in sandboxed <webview> guests, but its row says sandbox: false`);
  }

  memberReference(node: Node): void {
    if (!isPropertyAccessExpression(node) && !isElementAccessExpression(node)) return;
    const name = isPropertyAccessExpression(node) ? node.name.text : literalText(node.argumentExpression);
    if (name === "construct" && isIdentifier(node.expression) && node.expression.text === "Reflect") {
      const { child, parent } = usage(node);
      if (!(isCallExpression(parent) && parent.expression === child)) this.report(node, "Reflect.construct is referenced without being called");
    }
    if ((name === "registerPreloadScript" || name === "setPreloads") && !(isCallExpression(node.parent) && node.parent.expression === node)) {
      this.report(node, `${name} is referenced without being called`);
    }
    if (isElementAccessExpression(node) && literalText(node.argumentExpression) === null) {
      const owner = this.isElectron(this.checker.getTypeAtLocation(node.expression)?.getSymbol(), GUARDED_ELECTRON_TYPES);
      if (owner) this.report(node, `computed access on an Electron ${owner}: ${this.text(node)}`);
    }
  }

  assignment(node: Node): void {
    if (!isBinaryExpression(node)) return;
    const left = node.left;
    const property = isPropertyAccessExpression(left) ? left.name.text : isElementAccessExpression(left) ? literalText(left.argumentExpression) : null;
    if (property !== null && HTML_SINK_PROPERTIES.has(property)) this.html(node.right, property);
    if (isPropertyAccessExpression(left) && isIdentifier(left.expression) && this.domWebviews.has(left.expression.text)) {
      this.propertyWrites.push({ receiver: left.expression.text, property: left.name.text, node });
    }
    if (property !== "sandbox" || !(isPropertyAccessExpression(left) || isElementAccessExpression(left))) return;
    const value = unwrap(node.right);
    if (isPropertyAccessExpression(value) && value.name.text === "sandbox" && isPropertyAccessExpression(value.expression)) {
      const row = value.expression.name.text;
      if (this.declaredIn(this.resolved(value.expression.expression), PRELOAD_TABLE_MODULE) && this.table[row]) return;
    }
    if (value.kind === SyntaxKind.TrueKeyword && this.deletesPreload(node, this.text(left.expression))) return;
    this.report(node, `sets a guest's sandbox to ${this.text(node.right)}, not from the preload table, while leaving its preload in place`);
  }

  deletesPreload(node: Node, object: string): boolean {
    let scope: Node = node;
    while (!isSourceFile(scope) && !isArrowFunction(scope) && !isFunctionExpression(scope) && !isFunctionDeclaration(scope) && !isMethodDeclaration(scope)) scope = scope.parent;
    let found = false;
    const visit = (child: Node): void => {
      if (isDeleteExpression(child) && isPropertyAccessExpression(child.expression) && child.expression.name.text === "preload" && this.text(child.expression.expression) === object) found = true;
      child.forEachChild(visit);
    };
    visit(scope);
    return found;
  }

  jsx(node: Node): void {
    if (!isJsxOpeningElement(node) && !isJsxSelfClosingElement(node)) return;
    for (const attribute of node.attributes.properties) {
      if (!isJsxAttribute(attribute) || attribute.name.getText(this.source) !== "dangerouslySetInnerHTML") continue;
      const value = attribute.initializer && isJsxExpression(attribute.initializer) && attribute.initializer.expression ? unwrap(attribute.initializer.expression) : null;
      const html = value && isObjectLiteralExpression(value) && value.properties.length === 1 && isPropertyAssignment(value.properties[0]) && keyOf(value.properties[0].name) === "__html" ? value.properties[0].initializer : null;
      if (html) this.html(html, "dangerouslySetInnerHTML");
      else this.report(attribute, "dangerouslySetInnerHTML is not { __html: <value> }");
    }
    if (node.tagName.getText(this.source) !== "webview") return;
    const site: Site = { file: this.rel, kind: "webview", id: null, request: null };
    for (const attribute of node.attributes.properties) {
      if (isJsxSpreadAttribute(attribute)) {
        this.report(attribute, "spread attributes on a <webview>");
        continue;
      }
      if (!isJsxAttribute(attribute) || attribute.name.getText(this.source) !== "webpreferences") continue;
      const initializer = attribute.initializer;
      const value = initializer && isJsxExpression(initializer) ? literalText(initializer.expression) : literalText(initializer);
      if (value === null) this.report(attribute, "<webview> webpreferences is not a literal");
      else site.request = value;
    }
    this.webview(node, site);
  }

  createElement(node: Node): void {
    if (!isCallExpression(node)) return;
    const tagNode = node.arguments[0];
    if (!tagNode) return;
    const tag = literalText(tagNode);
    if (tag === null) {
      const type = this.checker.getTypeAtLocation(tagNode);
      if (type && type.flags & (TypeFlags.StringLike | TypeFlags.Any | TypeFlags.Unknown)) {
        const value = type.isLiteralType() ? String(type.value) : null;
        if (value === null || value.toLowerCase() === "webview") this.report(node, `createElement with a tag the test cannot read: ${this.text(tagNode)}`);
      }
      return;
    }
    if (tag.toLowerCase() !== "webview") return;
    const site: Site = { file: this.rel, kind: "webview", id: null, request: null };
    const props = node.arguments[1];
    if (props === undefined) {
      const declaration = node.parent;
      if (!isVariableDeclaration(declaration) || !isIdentifier(declaration.name) || !(declaration.parent.flags & NodeFlags.Const)) {
        this.report(node, "a DOM <webview> that is not held in a const");
      } else {
        this.domWebviews.set(declaration.name.text, site);
      }
      this.webview(node, site);
      return;
    }
    const object = unwrap(props);
    if (!isObjectLiteralExpression(object)) {
      this.report(props, "createElement(\"webview\") props are not an object literal");
    } else {
      for (const property of object.properties) {
        const key = isPropertyAssignment(property) || isShorthandPropertyAssignment(property) ? keyOf(property.name) : null;
        if (key === null) {
          this.report(property, `a <webview> prop the test cannot read: ${this.text(property)}`);
          continue;
        }
        if (key !== "webpreferences") continue;
        const value = isPropertyAssignment(property) ? literalText(unwrap(property.initializer)) : null;
        if (value === null) this.report(property, "<webview> webpreferences is not a literal");
        else site.request = value;
      }
    }
    this.webview(node, site);
  }

  domWebviewAttributes(): void {
    const tied = ["webpreferences", "preload", "partition", "nodeintegration", "disablewebsecurity", "allowpopups"];
    for (const call of this.attributeCalls) {
      const name = literalText(call.name);
      const site = call.receiver === null ? undefined : this.domWebviews.get(call.receiver);
      if (!site) {
        if (name !== null && tied.includes(name.toLowerCase())) this.report(call.node, `sets ${name} on an element the test cannot tie to a <webview>`);
        continue;
      }
      if (name === null) {
        this.report(call.node, `setAttribute(${call.name ? this.text(call.name) : ""}) on a <webview> with a name the test cannot read`);
        continue;
      }
      if (name.toLowerCase() !== "webpreferences") continue;
      const value = literalText(call.value);
      if (value === null) this.report(call.node, "<webview> webpreferences is not a literal");
      else site.request = value;
    }
    for (const write of this.propertyWrites) {
      if (tied.includes(write.property.toLowerCase())) this.report(write.node, `assigns ${write.property} on a <webview> instead of setting its attribute`);
    }
  }

  htmlString(node: Node): void {
    const text = isTemplateExpression(node) ? [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join("") : literalText(node);
    if (text === null || !/<webview\b/iu.test(text)) return;
    if (isTemplateExpression(node.parent) || node.parent.kind === SyntaxKind.TemplateSpan) return;
    this.webview(node, { file: this.rel, kind: "html-webview", id: null });
  }

  webview(node: Node, site: Site): void {
    this.audit.sites.push(site);
    if (!(this.rel in this.webviewSites)) {
      this.report(node, "a <webview> site the preload table does not map; add its file to WEBVIEW_SITES with the row of the preload its guests run");
      return;
    }
    site.id = this.webviewSites[this.rel];
  }

  // Follow bound module imports and single-member reads; other uses escape the audit.
  electronLoad(node: Node, kind: "require" | "import"): void {
    let { child, parent } = usage(node);
    if (kind === "import") {
      if (!isAwaitExpression(parent)) {
        this.report(node, `a dynamic import of electron the test cannot follow: ${this.text(parent)}`);
        return;
      }
      ({ child, parent } = usage(parent));
    }
    if (isVariableDeclaration(parent) && parent.initializer === child) return;
    if (isPropertyAccessExpression(parent) && parent.expression === child) {
      if (WINDOW_CLASSES.has(parent.name.text)) this.windowReference(parent, parent.name.text);
      return;
    }
    this.report(node, `passes the electron module around: ${this.text(parent)}`);
  }

  // Construct targets must be provably outside the audited window classes.
  construct(node: Node): void {
    if (!isCallExpression(node) || !node.arguments[0]) return;
    const target = node.arguments[0];
    // Every construct signature must return a concrete type outside the audited classes.
    const type = this.checker.getTypeAtLocation(target);
    const signatures = type && !(type.flags & (TypeFlags.Any | TypeFlags.Unknown)) ? this.checker.getSignaturesOfType(type, SignatureKind.Construct) : [];
    const provable = signatures.length > 0 && signatures.every((signature) => {
      const instance = this.checker.getReturnTypeOfSignature(signature);
      if (!instance || instance.flags & (TypeFlags.Any | TypeFlags.Unknown | TypeFlags.TypeParameter)) return false;
      const symbol = instance.getSymbol();
      return !symbol?.declarations.some((declaration) => toWire(declaration.path).endsWith(ELECTRON_DTS));
    });
    if (!provable) this.report(node, `construct(${this.text(target)}, …) with a target the test cannot prove is not an Electron window`);
  }

  // HTML sinks may interpolate only values proven unable to carry markup, never tag names.
  html(value: Node, sink: string): void {
    const parts: (string | Node)[] = [];
    const flatten = (node: Node): void => {
      const expression = unwrap(node as Expression);
      const text = literalText(expression);
      if (text !== null) parts.push(text);
      else if (isTemplateExpression(expression)) {
        parts.push(expression.head.text);
        for (const span of expression.templateSpans) {
          flatten(span.expression);
          parts.push(span.literal.text);
        }
      } else if (isBinaryExpression(expression) && expression.operatorToken.kind === SyntaxKind.PlusToken) {
        flatten(expression.left);
        flatten(expression.right);
      } else parts.push(expression);
    };
    flatten(value);
    let markup = "";
    for (const part of parts) {
      if (typeof part === "string") {
        markup += part;
        continue;
      }
      if (/<\/?\s*$/u.test(markup)) {
        this.report(part, `${sink} interpolates a tag name the test cannot read: ${this.text(part)}`);
        return;
      }
      if (!this.cannotCarryMarkup(part)) {
        this.report(part, `${sink} writes HTML that is not a literal or provably free of <webview: ${this.text(part)}`);
        return;
      }
      markup += "\u0000";
    }
    // Literal webview tags are found by the string scan; assembled tags need expression analysis.
    if (parts.some((part) => typeof part !== "string") && /<\s*webview\b/iu.test(markup)) this.webview(value, { file: this.rel, kind: "html-webview", id: null });
  }

  cannotCarryMarkup(node: Node): boolean {
    const type = this.checker.getTypeAtLocation(node);
    if (!type) return false;
    if (type.flags & (TypeFlags.NumberLike | TypeFlags.BooleanLike | TypeFlags.BigIntLike | TypeFlags.Null | TypeFlags.Undefined)) return true;
    const members = type.isUnionType() ? type.getTypes() ?? [] : [type];
    return members.every((member) => member.isLiteralType() && (typeof member.value !== "string" || !member.value.includes("<")));
  }

  electronReference(node: Node): void {
    if (!isIdentifier(node)) return;
    const parent = node.parent;
    if (isImportSpecifier(parent) || isImportClause(parent) || isNamespaceImport(parent) || isBindingElement(parent)) return;
    if (isVariableDeclaration(parent) && parent.name === node) return;
    if (isPropertyAccessExpression(parent) && parent.name === node) return;
    if (this.windowLocals.has(node.text)) this.windowReference(node, node.text);
    if (!this.electronNamespaces.has(node.text)) return;
    if (isQualifiedName(parent) || isTypeQueryNode(parent)) return;
    if (isPropertyAccessExpression(parent) && parent.expression === node) {
      if (WINDOW_CLASSES.has(parent.name.text)) this.windowReference(parent, parent.name.text);
      return;
    }
    if (isElementAccessExpression(parent) && parent.expression === node) {
      this.report(parent, `computed access on the electron module: ${this.text(parent)}`);
      return;
    }
    if (isVariableDeclaration(parent) && parent.initializer === node && isObjectBindingPattern(parent.name)) return;
    this.report(node, `passes the electron module around: ${this.text(parent)}`);
  }

  // Class values escaping construction, member reads, instanceof or types cannot be followed.
  windowReference(node: Node, name: string): void {
    const { child, parent } = usage(node);
    if (isNewExpression(parent) && parent.expression === child) return;
    if (isPropertyAccessExpression(parent) && parent.expression === child) return;
    if (isBinaryExpression(parent) && parent.operatorToken.kind === SyntaxKind.InstanceOfKeyword && parent.right === child) return;
    if (isTypeReferenceNode(parent) || isTypeQueryNode(parent) || isQualifiedName(parent)) return;
    if (isExpressionWithTypeArguments(parent)) return;
    this.report(node, `uses ${name} as a value the test cannot follow: ${this.text(parent)}`);
  }

  heritage(node: Node): void {
    if (!isHeritageClause(node)) return;
    const owner = node.parent;
    if (!isClassDeclaration(owner) && !isClassExpression(owner)) return;
    for (const base of node.types) {
      const name = this.isElectron(this.resolved(base.expression), WINDOW_CLASSES);
      if (name) this.report(base, `subclasses ${name}; construct it directly so its options can be checked`);
    }
  }
}

function auditPreloadSites(root: string, table: Table = TABLE, webviewSites: Record<string, string | null> = WEBVIEW_SITES): Audit {
  const files = listSources(root).map(toWire);
  const audit: Audit = { sites: [], problems: [], files: 0 };
  const api = new API({ cwd: toWire(root) });
  try {
    const snapshot = api.updateSnapshot({ openFiles: files });
    const projects = snapshot.getProjects();
    for (const file of files) {
      const rel = toWire(relative(root, file));
      const project = [snapshot.getDefaultProjectForFile(file), ...projects].find((candidate) => candidate?.program.getSourceFile(file));
      const source = project?.program.getSourceFile(file);
      if (!project || !source) {
        audit.problems.push(`${rel}: the compiler could not load it`);
        continue;
      }
      audit.files += 1;
      new FileAudit(root, rel, source, project, table, webviewSites, audit).run();
    }
  } finally {
    api.close();
  }
  for (const site of audit.sites) {
    if (site.kind !== "webview" || !(site.file in webviewSites)) continue;
    if (site.request === null || site.request === undefined) {
      audit.problems.push(`${site.file}: a <webview> has no webpreferences request`);
      continue;
    }
    const sandboxed = /\bsandbox\s*=\s*(?:yes|true)\b/u.test(site.request);
    const expected = site.id === null ? true : table[site.id]?.sandbox;
    if (sandboxed !== expected) {
      audit.problems.push(`${site.file}: a <webview> requests sandbox=${sandboxed ? "yes" : "no"}, but ${site.id ?? "a guest with no table preload"} runs with sandbox: ${expected}`);
    }
  }
  return audit;
}

// Resolve scratch probes against repository options, helpers and dependencies.
const PROBES: Record<string, { source: string; problem: string }> = {
  "src/probes/computed-sandbox.ts": {
    source: `import { BrowserWindow } from "electron";
import { preloadPreferences } from "../main/preload-bundles.js";
export const open = () => new BrowserWindow({ show: false, webPreferences: { ...preloadPreferences("audioCaptureWindowPreload"), ["sandbox"]: true, contextIsolation: true } });
`,
    problem: "computed key in webPreferences: [\"sandbox\"]: true",
  },
  "src/probes/aliased-import.ts": {
    source: `import { BrowserWindow as Shell } from "electron";
export const open = (target: string) => new Shell({ webPreferences: { preload: target, sandbox: false } });
`,
    problem: "names its own preload (target); spread preloadPreferences(id)",
  },
  "src/probes/namespace-import.ts": {
    source: `import * as electron from "electron";
export const open = () => new electron.BrowserWindow({ webPreferences: { sandbox: false } });
`,
    problem: "a window without a preload may only set sandbox: true",
  },
  "src/probes/helper-prefs.ts": {
    source: `import { BrowserWindow, type WebPreferences } from "electron";
const prefs = (): WebPreferences => ({ preload: "/tmp/x.cjs", sandbox: false });
export const open = () => new BrowserWindow({ width: 10, webPreferences: prefs() });
`,
    problem: "webPreferences is not an object literal: webPreferences: prefs()",
  },
  "src/probes/helper-options.ts": {
    source: `import { BrowserWindow, type BrowserWindowConstructorOptions } from "electron";
const options = (): BrowserWindowConstructorOptions => ({ webPreferences: { preload: "/tmp/x.cjs" } });
export const open = () => new BrowserWindow(options());
`,
    problem: "BrowserWindow options are not an object literal",
  },
  "src/probes/spread-options.ts": {
    source: `import { BrowserWindow, type BrowserWindowConstructorOptions } from "electron";
export const open = (base: BrowserWindowConstructorOptions) => new BrowserWindow({ ...base, width: 10 });
`,
    problem: "spread into the BrowserWindow options may set webPreferences: ...base",
  },
  "src/probes/regex-before-window.ts": {
    source: `import { BrowserWindow } from "electron";
export function open(enabled: boolean, text: string, target: string) {
  if (enabled) /[//]/.test(text); new BrowserWindow({webPreferences:{preload: target,sandbox:true}});
}
`,
    problem: "names its own preload (target); spread preloadPreferences(id)",
  },
  "src/probes/constructor-passed.ts": {
    source: `import { BrowserWindow } from "electron";
const make = <T>(Ctor: new (options: object) => T) => new Ctor({ webPreferences: { preload: "/tmp/x.cjs" } });
export const open = () => make(BrowserWindow);
`,
    problem: "uses BrowserWindow as a value the test cannot follow: make(BrowserWindow)",
  },
  "src/probes/subclass.ts": {
    source: `import { BrowserWindow } from "electron";
export class Shell extends BrowserWindow {}
`,
    problem: "subclasses BrowserWindow",
  },
  "src/probes/webview-tag-unguarded.ts": {
    source: `import { BrowserWindow } from "electron";
export const open = () => { const win = new BrowserWindow({ webPreferences: { webviewTag: true } }); return win; };
`,
    problem: "BrowserWindow has webviewTag: true but no will-attach-webview guard on it that enforces its guests",
  },
  "src/probes/webview-tag-guard-passes.ts": {
    source: `import { BrowserWindow } from "electron";
export const open = () => {
  const win = new BrowserWindow({ webPreferences: { webviewTag: true } });
  win.webContents.on("will-attach-webview", (_event, prefs) => { prefs.nodeIntegration = false; });
  return win;
};
`,
    problem: "BrowserWindow has webviewTag: true but no will-attach-webview guard on it that enforces its guests",
  },
  "src/probes/session-preload.ts": {
    source: `import { session } from "electron";
export const install = (path: string) => session.fromPartition("persist:x").registerPreloadScript({ type: "frame", filePath: path });
`,
    problem: "registerPreloadScript does not take preloadBundlePath(id) of a table row",
  },
  "src/probes/session-computed.ts": {
    source: `import { session } from "electron";
export const install = (method: "setPreloads" | "getPreloads") => (session.defaultSession[method] as (value: string[]) => void)([]);
`,
    problem: "computed access on an Electron Session",
  },
  "src/probes/guest-sandbox.ts": {
    source: `export const attach = (prefs: Record<string, unknown>) => { prefs.sandbox = false; };
`,
    problem: "sets a guest's sandbox to false, not from the preload table, while leaving its preload in place",
  },
  "src/probes/dynamic-webview.tsx": {
    source: `import { createElement } from "react";
export const View = () => createElement("webview", { src: "about:blank", webpreferences: "contextIsolation=yes, sandbox=no" });
`,
    problem: "a <webview> requests sandbox=no, but pluginPreload runs with sandbox: true",
  },
  "src/probes/unmapped-webview.tsx": {
    source: `export const View = () => <webview src="about:blank" webpreferences="sandbox=yes" />;
`,
    problem: "a <webview> site the preload table does not map",
  },
  "src/probes/spread-webview.tsx": {
    source: `export const View = (props: Record<string, string>) => <webview {...props} webpreferences="sandbox=yes" />;
`,
    problem: "spread attributes on a <webview>",
  },
  "src/probes/dom-webview.ts": {
    source: `export const mount = (slot: HTMLElement, prefs: string) => { const view = document.createElement("webview"); view.setAttribute("webpreferences", prefs); slot.appendChild(view); };
`,
    problem: "<webview> webpreferences is not a literal",
  },
  "src/probes/dom-tag-variable.ts": {
    source: `export const mount = (tag: string) => document.createElement(tag);
`,
    problem: "createElement with a tag the test cannot read: tag",
  },
  "src/probes/dynamic-reflect.ts": {
    source: `export const open = async () => {
  const e = await import("electron");
  return Reflect.construct(e.BrowserWindow, [{ webPreferences: { preload: "/tmp/x.cjs", sandbox: false } }]);
};
`,
    problem: "construct(e.BrowserWindow, …) with a target the test cannot prove is not an Electron window",
  },
  "src/probes/reflect-generic.ts": {
    source: `export const make = <T>(Ctor: new (options: object) => T) => Reflect.construct(Ctor, [{ webPreferences: { sandbox: false } }]);
`,
    problem: "construct(Ctor, …) with a target the test cannot prove is not an Electron window",
  },
  "src/probes/reflect-element.ts": {
    source: `declare const Shell: any;
export const open = () => Reflect["construct"](Shell, [{ webPreferences: { sandbox: false } }]);
`,
    problem: "construct(Shell, …) with a target the test cannot prove is not an Electron window",
  },
  "src/probes/reflect-destructured.ts": {
    source: `const { construct } = Reflect;
export const open = (Ctor: new () => object) => construct(Ctor, []);
`,
    problem: "Reflect.construct taken out of Reflect, where the test cannot follow it",
  },
  "src/probes/reflect-alias.ts": {
    source: `const make = Reflect.construct;
export const open = (Ctor: new () => object) => make(Ctor, []);
`,
    problem: "Reflect.construct is referenced without being called",
  },
  "src/probes/import-then.ts": {
    source: `export const open = () => import("electron").then(({ BrowserWindow }) => new BrowserWindow({ webPreferences: { sandbox: false } }));
`,
    problem: "a dynamic import of electron the test cannot follow",
  },
  "src/probes/require-passed.ts": {
    source: `export const open = (use: (module: unknown) => void) => use(require("electron"));
`,
    problem: "passes the electron module around: use(require(\"electron\"))",
  },
  "src/probes/interpolated-tag.ts": {
    source: `export const f = (e: HTMLElement) => { const tag = "webview"; e.innerHTML = \`<\${tag} src="about:blank" webpreferences="sandbox=no"></\${tag}>\`; };
`,
    problem: "innerHTML interpolates a tag name the test cannot read: tag",
  },
  "src/probes/concatenated-tag.ts": {
    source: `export const f = (e: HTMLElement, tag: string) => { e.outerHTML = "<" + tag + " webpreferences=\\"sandbox=no\\">"; };
`,
    problem: "outerHTML interpolates a tag name the test cannot read: tag",
  },
  "src/probes/innerhtml-literal.ts": {
    source: `export const f = (e: HTMLElement) => { e.innerHTML = \`<webview src="about:blank" webpreferences="sandbox=no"></webview>\`; };
`,
    problem: "a <webview> site the preload table does not map",
  },
  "src/probes/innerhtml-variable.ts": {
    source: `export const f = (e: HTMLElement, html: string) => { e.innerHTML = html; };
`,
    problem: "innerHTML writes HTML that is not a literal or provably free of <webview: html",
  },
  "src/probes/insert-adjacent.ts": {
    source: `export const f = (e: HTMLElement, html: string) => e.insertAdjacentHTML("beforeend", html);
`,
    problem: "insertAdjacentHTML writes HTML that is not a literal or provably free of <webview: html",
  },
  "src/probes/document-write.ts": {
    source: `export const f = (name: string) => document.write(\`<div>\${name}</div>\`);
`,
    problem: "write writes HTML that is not a literal or provably free of <webview: name",
  },
  "src/probes/dom-parser.ts": {
    source: `export const f = (html: string) => document.body.append(...new DOMParser().parseFromString(html, "text/html").body.children);
`,
    problem: "parseFromString writes HTML that is not a literal or provably free of <webview: html",
  },
  "src/probes/dangerously.tsx": {
    source: `export const View = ({ html }: { html: string }) => <div dangerouslySetInnerHTML={{ __html: html }} />;
`,
    problem: "dangerouslySetInnerHTML writes HTML that is not a literal or provably free of <webview: html",
  },
};

const CLEAN_PROBE = {
  path: "src/probes/clean.tsx",
  source: `import { BrowserWindow } from "electron";
export const count = () => BrowserWindow.getAllWindows().length;
export const isWindow = (value: unknown) => value instanceof BrowserWindow;
export const map = () => Reflect.construct(Map, []);
export const app = async () => (await import("electron")).app;
export const quit = async () => { const { app: electronApp } = await import("electron"); electronApp.quit(); };
export const label = (e: HTMLElement, total: number, flag: boolean) => { e.innerHTML = \`<b>\${total}</b> \${flag}\`; e.outerHTML = "<span>done</span>"; };
export const Note = () => <div dangerouslySetInnerHTML={{ __html: "<em>static</em>" }} />;
export const plain = () => new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
`,
};

const PROBE_WEBVIEW_SITES: Record<string, string | null> = {
  "src/probes/dynamic-webview.tsx": "pluginPreload",
  "src/probes/spread-webview.tsx": "pluginPreload",
  "src/probes/dom-webview.ts": "pluginPreload",
};

describe("preload sites follow the preload table", () => {
  let real: Audit;
  beforeAll(() => {
    real = auditPreloadSites(ROOT);
  }, 120_000);

  it("reads every source file and finds no site that departs from the table or that it cannot prove", () => {
    expect(real.files).toBe(listSources(ROOT).length);
    expect(real.files).toBeGreaterThan(1000);
    expect(real.problems).toEqual([]);
  });

  it("finds each preload site, each taking its preload and sandbox from the table", () => {
    const preloadSites = real.sites
      .filter((site) => site.kind === "window" || site.kind === "session")
      .filter((site) => site.id !== null)
      .map((site) => `${site.kind} ${site.file} ${site.id}`)
      .sort();
    expect(preloadSites).toEqual([
      "session src/main/html-preview-partition.ts mcpAppPreload",
      "session src/main/html-preview-partition.ts pluginPreload",
      "window src/main/audio-capture-surface.ts audioCaptureWindowPreload",
      "window src/main/floating-dock-surface.ts floatingDockPreload",
      "window src/main/link-window-service.ts preload",
      "window src/main/main-window.ts preload",
    ]);
    const used = new Set(real.sites.map((site) => site.id));
    expect(Object.keys(TABLE).filter((id) => !used.has(id))).toEqual([]);
    expect(real.sites.filter((site) => site.guard !== undefined).map((site) => `${site.file} ${site.guard}`).sort()).toEqual([
      "src/main/auth-window-service.ts configureAuthWebviewAttach",
      "src/main/floating-dock-surface.ts configurePluginWebviewAttach",
      "src/main/link-window-service.ts inline: strips the preload, sandbox true",
      "src/main/main-window.ts configureMainWindowWebviewAttach",
    ]);
    expect(real.sites.filter((site) => site.kind === "window" && site.id === null).map((site) => site.file).sort()).toEqual([
      "src/ipc/domains/window.ts",
      "src/main/auth-partition-viewer-service.ts",
      // Login popup window and its adopted guest view, then the login shell: none runs a host preload.
      "src/main/auth-window-content.ts",
      "src/main/auth-window-content.ts",
      "src/main/auth-window-service.ts",
    ]);
  });

  it("finds every <webview> site in a mapped file, with the request its row's sandbox needs", () => {
    const webviews = real.sites.filter((site) => site.kind === "webview" || site.kind === "html-webview").map((site) => `${site.kind} ${site.file} ${site.id}`).sort();
    expect(webviews).toEqual([
      "html-webview src/main/auth-window-content.ts null",
      "html-webview src/main/link-window-service.ts null",
      "webview src/floating-dock-window.js pluginPreload",
      "webview src/plugin-ui-host.tsx pluginPreload",
      "webview src/ui/renderer/components/ChatSidePanelPreview.tsx null",
      "webview src/ui/renderer/components/McpAppView.tsx mcpAppPreload",
      "webview src/ui/renderer/components/WebSurfaceLayer.tsx null",
    ]);
    expect(Object.keys(WEBVIEW_SITES).filter((file) => !real.sites.some((site) => site.file === file && site.kind.endsWith("webview")))).toEqual([]);
  });

  it("fails when a row's sandbox flips without the sites that request it following", () => {
    const flipped: Table = structuredClone(TABLE);
    flipped.pluginPreload.sandbox = false;
    const audit = auditPreloadSites(ROOT, flipped);
    expect(audit.problems).toContain("src/plugin-ui-host.tsx: a <webview> requests sandbox=yes, but pluginPreload runs with sandbox: false");
    expect(audit.problems).toContain("src/floating-dock-window.js: a <webview> requests sandbox=yes, but pluginPreload runs with sandbox: false");
    expect(audit.problems.some((problem) => problem.startsWith("src/main/html-preview-partition.ts:") && problem.endsWith("session preload pluginPreload runs in sandboxed <webview> guests, but its row says sandbox: false"))).toBe(true);
  }, 120_000);

  describe("the round-5 probes, each refused", () => {
    let scratch: string;
    let probes: Audit;
    beforeAll(() => {
      // Keep probes under .cache so dependency lookup matches src without extra links.
      mkdirSync(resolve(ROOT, ".cache"), { recursive: true });
      scratch = mkdtempSync(join(ROOT, ".cache", "preload-sites-"));
      for (const path of ["tsconfig.json", "package.json", "src/main/preload-bundles.ts", "src/main/main-paths.ts", "src/shared/preload-bundles.ts", "src/shared/preload-bundles.json"]) {
        mkdirSync(dirname(join(scratch, path)), { recursive: true });
        copyFileSync(resolve(ROOT, path), join(scratch, path));
      }
      for (const [path, probe] of [...Object.entries(PROBES), [CLEAN_PROBE.path, CLEAN_PROBE] as const]) {
        mkdirSync(dirname(join(scratch, path)), { recursive: true });
        writeFileSync(join(scratch, path), probe.source, "utf-8");
      }
      probes = auditPreloadSites(scratch, TABLE, PROBE_WEBVIEW_SITES);
    }, 120_000);
    afterAll(() => {
      if (scratch) rmSync(scratch, { recursive: true, force: true });
    });

    it("reads every probe", () => {
      expect(probes.files).toBe(Object.keys(PROBES).length + 4);
      expect(probes.problems.filter((problem) => problem.includes("could not load"))).toEqual([]);
    });

    it.each(Object.entries(PROBES))("refuses %s", (path, probe) => {
      const own = probes.problems.filter((problem) => problem.startsWith(`${path}:`));
      expect(own.join("\n")).toContain(probe.problem);
    });

    it("finds nothing to refuse in the table's own helpers", () => {
      expect(probes.problems.filter((problem) => !problem.startsWith("src/probes/"))).toEqual([]);
    });

    it("accepts the forms it can prove: static members, instanceof, Reflect.construct of a known class, bound dynamic imports, markup-free HTML", () => {
      expect(probes.problems.filter((problem) => problem.startsWith(`${CLEAN_PROBE.path}:`))).toEqual([]);
    });
  });
});
