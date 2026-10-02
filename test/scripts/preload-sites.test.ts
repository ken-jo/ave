import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import {
  isArrowFunction,
  isAsExpression,
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
import { API, SymbolFlags, TypeFlags, type Checker, type Project, type Symbol as TsSymbol } from "typescript/unstable/sync";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Every place the app hands a frame a preload, or says what sandbox a preload
 * runs in, takes both from the one table (`src/shared/preload-bundles.json`).
 * `scripts/check-sandboxed-preloads.mjs` checks each built preload against the
 * table's sandbox, so a site that named its own `sandbox` or preload could run
 * a preload in a sandbox the gate never checked it for.
 *
 * Read with the TypeScript compiler (`typescript/unstable/sync`), so a site is
 * found however it is spelled: an aliased `BrowserWindow` import, the electron
 * module under another name, a constructor passed around. Each site must take
 * one recognized form, and anything the audit cannot prove is a problem rather
 * than a pass — a computed key, a helper-built object, a non-literal value:
 *   - `new BrowserWindow` / `BrowserView` / `WebContentsView` with a preload
 *     spreads `preloadPreferences(id)` (directly or through a `const`) into a
 *     literal `webPreferences`, and names neither `sandbox` nor `preload`; one
 *     without a preload names no `preload` and at most `sandbox: true`; one
 *     with `webviewTag: true` registers a `will-attach-webview` guard on itself;
 *   - `registerPreloadScript` takes `preloadBundlePath(id)`; `setPreloads` is
 *     refused;
 *   - a guest's `sandbox` is assigned from `PRELOAD_BUNDLES.<id>.sandbox`, or
 *     `true` beside a `delete` of its preload;
 *   - every `<webview>` (JSX, `createElement`, or `document.createElement`
 *     with `setAttribute`, or inside an HTML string) is in a file mapped to the
 *     table row of the preload its guest runs, and its literal `webpreferences`
 *     request agrees with that row's sandbox.
 */

type Row = { entry: string; file: string; build: "webpack" | "copy"; sandbox: boolean; runsIn: string };
type Table = Record<string, Row>;
type Site = { file: string; kind: "window" | "session" | "webview" | "html-webview"; id: string | null; request?: string | null; guard?: string | null };
type Audit = { sites: Site[]; problems: string[]; files: number };

const ROOT = process.cwd();
const TABLE: Table = JSON.parse(readFileSync(resolve(ROOT, "src/shared/preload-bundles.json"), "utf-8"));

/**
 * The files that create a `<webview>`, by the table row of the preload their
 * guests run (null: no table preload — main's guard strips it — and sandboxed).
 */
const WEBVIEW_SITES: Record<string, string | null> = {
  "src/plugin-ui-host.tsx": "pluginPreload",
  "src/floating-dock-window.js": "pluginPreload",
  "src/ui/renderer/components/McpAppView.tsx": "mcpAppPreload",
  "src/ui/renderer/components/ChatSidePanelPreview.tsx": null,
  "src/main/link-window-service.ts": null,
  "src/main/auth-window-service.ts": null,
};

const WINDOW_CLASSES = new Set(["BrowserWindow", "BrowserView", "WebContentsView"]);
const GUARDED_ELECTRON_TYPES = new Set([...WINDOW_CLASSES, "Session", "WebContents"]);
const ELECTRON_DTS = "/node_modules/electron/electron.d.ts";
const PRELOAD_HELPERS = "src/main/preload-bundles.ts";
const PRELOAD_TABLE_MODULE = "src/shared/preload-bundles.ts";
const ATTACH_GUARDS = "src/main/plugin-webview-attach.ts";

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

/** A property's key, or null when it is computed. */
function keyOf(name: Node): string | null {
  if (isIdentifier(name)) return name.text;
  if (isStringLiteral(name) || isNumericLiteral(name)) return name.text;
  return null;
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
    const target = join(this.root, rel).toLowerCase();
    return !!symbol && symbol.declarations.some((declaration) => declaration.path.toLowerCase() === target);
  }

  isElectron(symbol: TsSymbol | undefined, names: Set<string>): string | null {
    if (!symbol || !names.has(symbol.name)) return null;
    return symbol.declarations.some((declaration) => declaration.path.endsWith(ELECTRON_DTS)) ? symbol.name : null;
  }

  /** The table id `fn("<id>")` names, through one `const` alias at most; null when it is not that form. */
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

  /** Imports and requires of electron: window-class locals and module namespaces. */
  collectElectronBindings(): void {
    const isElectronRequire = (node: Expression | undefined): boolean => {
      if (!node) return false;
      const expression = unwrap(node);
      return isCallExpression(expression) && isIdentifier(expression.expression) && expression.expression.text === "require" && literalText(expression.arguments[0]) === "electron";
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
            else if (WINDOW_CLASSES.has(imported) && local) this.windowLocals.add(local.text);
          }
        }
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

  /** `cond ? {} : { preload: undefined }`: a branch that only ever clears the preload. */
  onlyClearsPreload(node: Expression): boolean {
    const expression = unwrap(node);
    if (!isConditionalExpression(expression)) return false;
    return [expression.whenTrue, expression.whenFalse].every((branch) => {
      const object = unwrap(branch);
      return isObjectLiteralExpression(object) && object.properties.every((property) =>
        isPropertyAssignment(property) && keyOf(property.name) === "preload" && isIdentifier(property.initializer) && property.initializer.text === "undefined");
    });
  }

  /**
   * The guard a `<const>.webContents.on("will-attach-webview", handler)` on
   * this window runs: a guard function from `plugin-webview-attach.ts`, or an
   * inline handler that strips the guest's preload and sets `sandbox = true`.
   * Null when there is no such handler, or it does neither.
   */
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

  /** Whether the function around `node` deletes `<object>.preload`. */
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

  /** A window class used anywhere but `new X(…)`, `X.member`, `instanceof X` or a type is a value the audit cannot follow. */
  windowReference(node: Node, name: string): void {
    const parent = node.parent;
    if (isNewExpression(parent) && parent.expression === node) return;
    if (isPropertyAccessExpression(parent) && parent.expression === node) return;
    if (isBinaryExpression(parent) && parent.operatorToken.kind === SyntaxKind.InstanceOfKeyword && parent.right === node) return;
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

/** Every preload site under `root/src`, and every way one departs from the table or cannot be proven. */
function auditPreloadSites(root: string, table: Table = TABLE, webviewSites: Record<string, string | null> = WEBVIEW_SITES): Audit {
  const files = listSources(root);
  const audit: Audit = { sites: [], problems: [], files: 0 };
  const api = new API({ cwd: root });
  try {
    const snapshot = api.updateSnapshot({ openFiles: files });
    const projects = snapshot.getProjects();
    for (const file of files) {
      const rel = relative(root, file);
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

/**
 * Codex's round-5 probes, kept: each is a site the earlier text scan passed.
 * Written into a scratch tree that holds this repo's tsconfig, the table and
 * its helpers, and a link to `node_modules`, so they resolve the way `src` does.
 */
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
};

/** The probes that must sit in a file WEBVIEW_SITES maps, and to which row. */
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
      "window src/main/auth-window-service.ts preload",
      "window src/main/floating-dock-surface.ts floatingDockPreload",
      "window src/main/link-window-service.ts preload",
      "window src/main/main-window.ts preload",
    ]);
    const used = new Set(real.sites.map((site) => site.id));
    expect(Object.keys(TABLE).filter((id) => !used.has(id))).toEqual([]);
    expect(real.sites.filter((site) => site.guard !== undefined).map((site) => `${site.file} ${site.guard}`).sort()).toEqual([
      "src/main/auth-window-service.ts inline: strips the preload, sandbox true",
      "src/main/floating-dock-surface.ts configurePluginWebviewAttach",
      "src/main/link-window-service.ts inline: strips the preload, sandbox true",
      "src/main/main-window.ts configureMainWindowWebviewAttach",
    ]);
    expect(real.sites.filter((site) => site.kind === "window" && site.id === null).map((site) => site.file).sort()).toEqual([
      "src/ipc/domains/window.ts",
      "src/main/auth-partition-viewer-service.ts",
    ]);
  });

  it("finds every <webview> site in a mapped file, with the request its row's sandbox needs", () => {
    const webviews = real.sites.filter((site) => site.kind === "webview" || site.kind === "html-webview").map((site) => `${site.kind} ${site.file} ${site.id}`).sort();
    expect(webviews).toEqual([
      "html-webview src/main/auth-window-service.ts null",
      "html-webview src/main/link-window-service.ts null",
      "webview src/floating-dock-window.js pluginPreload",
      "webview src/plugin-ui-host.tsx pluginPreload",
      "webview src/ui/renderer/components/ChatSidePanelPreview.tsx null",
      "webview src/ui/renderer/components/McpAppView.tsx mcpAppPreload",
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
      scratch = mkdtempSync(join(tmpdir(), "ave-preload-sites-"));
      for (const path of ["tsconfig.json", "package.json", "src/main/preload-bundles.ts", "src/main/main-paths.ts", "src/shared/preload-bundles.ts", "src/shared/preload-bundles.json"]) {
        mkdirSync(dirname(join(scratch, path)), { recursive: true });
        copyFileSync(resolve(ROOT, path), join(scratch, path));
      }
      symlinkSync(resolve(ROOT, "node_modules"), join(scratch, "node_modules"), "dir");
      for (const [path, probe] of Object.entries(PROBES)) {
        mkdirSync(dirname(join(scratch, path)), { recursive: true });
        writeFileSync(join(scratch, path), probe.source, "utf-8");
      }
      probes = auditPreloadSites(scratch, TABLE, PROBE_WEBVIEW_SITES);
    }, 120_000);
    afterAll(() => {
      // The link first, on its own: a recursive removal must never walk into the real node_modules.
      if (scratch) {
        unlinkSync(join(scratch, "node_modules"));
        rmSync(scratch, { recursive: true, force: true });
      }
    });

    it("reads every probe", () => {
      expect(probes.files).toBe(Object.keys(PROBES).length + 3);
      expect(probes.problems.filter((problem) => problem.includes("could not load"))).toEqual([]);
    });

    it.each(Object.entries(PROBES))("refuses %s", (path, probe) => {
      const own = probes.problems.filter((problem) => problem.startsWith(`${path}:`));
      expect(own.join("\n")).toContain(probe.problem);
    });

    it("finds nothing to refuse in the table's own helpers", () => {
      expect(probes.problems.filter((problem) => !problem.startsWith("src/probes/"))).toEqual([]);
    });
  });
});
