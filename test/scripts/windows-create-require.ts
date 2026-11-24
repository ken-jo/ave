import * as ast from "typescript/unstable/ast";
import { withParsedSourceTexts } from "../../scripts/lib/ts7-ast.mjs";

type Load = { anchor: string; specifier: string };
type Loads = { loads: Load[]; uncertain: boolean; reanchored: Set<string> };
type Binding = { kind: "module" | "factory" } | { kind: "loader"; anchor?: string };

function text(node: ast.Node | undefined): string | undefined {
  return node && (ast.isStringLiteral(node) || ast.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;
}

function moduleId(id: string | undefined): boolean {
  return id === "module" || id === "node:module";
}

function importsRuntimeModule(clause: ast.Node): boolean {
  return ast.isImportClause(clause) && clause.phaseModifier !== ast.SyntaxKind.TypeKeyword
    && ast.isImportDeclaration(clause.parent) && moduleId(text(clause.parent.moduleSpecifier));
}

function property(node: ast.Expression): { receiver: ast.Expression; name: string | undefined } | undefined {
  if (ast.isPropertyAccessExpression(node)) return { receiver: node.expression, name: node.name.text };
  if (ast.isElementAccessExpression(node)) return { receiver: node.expression, name: text(node.argumentExpression) };
  return undefined;
}

function wrapsExpression(node: ast.Node): node is ast.ParenthesizedExpression | ast.AsExpression | ast.NonNullExpression {
  return ast.isParenthesizedExpression(node) || ast.isAsExpression(node) || ast.isNonNullExpression(node);
}

function findLoads(file: string, source: ast.SourceFile, resolve: (ids: ast.Identifier[]) => Map<ast.Identifier, ast.Node | undefined>): Loads {
  const identifiers: ast.Identifier[] = [];
  const expressions: ast.Expression[] = [];
  function visit(node: ast.Node) {
    if (ast.isIdentifier(node)) identifiers.push(node);
    if (ast.isIdentifier(node) || ast.isCallExpression(node) || ast.isPropertyAccessExpression(node)
      || ast.isElementAccessExpression(node) || wrapsExpression(node)) {
      expressions.push(node);
    }
    node.forEachChild(visit);
  }
  visit(source);
  const declarations = resolve(identifiers);

  function anchorOf(node: ast.Expression | undefined, seen = new Set<ast.Node>()): string | undefined {
    if (!node || seen.has(node)) return undefined;
    seen.add(node);
    if (ast.isParenthesizedExpression(node)) return anchorOf(node.expression, seen);
    if (ast.isIdentifier(node)) {
      const declaration = declarations.get(node);
      if (declaration && ast.isVariableDeclaration(declaration) && (declaration.parent.flags & ast.NodeFlags.Const)) {
        return anchorOf(declaration.initializer, seen);
      }
    }
    if (ast.isPropertyAccessExpression(node) && node.name.text === "url" && ast.isMetaProperty(node.expression)
      && node.expression.keywordToken === ast.SyntaxKind.ImportKeyword) return file;
    if (!ast.isNewExpression(node) || !ast.isIdentifier(node.expression) || node.expression.text !== "URL"
      || declarations.get(node.expression)?.getSourceFile() === source) return undefined;
    const relative = text(node.arguments?.[0]);
    const base = anchorOf(node.arguments?.[1], seen);
    if (!base || !relative?.startsWith(".")) return undefined;
    try {
      const url = new URL(relative, new URL(`file:///${base}`));
      const path = decodeURIComponent(url.pathname.slice(1));
      return path.endsWith("/") ? `${path}.anchor.cjs` : path;
    } catch { return undefined; }
  }

  function binding(node: ast.Expression | undefined, seen = new Set<ast.Node>()): Binding | undefined {
    if (!node || seen.has(node)) return undefined;
    seen.add(node);
    if (wrapsExpression(node) || ast.isAwaitExpression(node)) {
      return binding(node.expression, seen);
    }
    if (ast.isIdentifier(node)) {
      const declaration = declarations.get(node);
      if (!declaration) return undefined;
      if (ast.isImportSpecifier(declaration) && !declaration.isTypeOnly
        && (declaration.propertyName ?? declaration.name).text === "createRequire"
        && importsRuntimeModule(declaration.parent.parent)) return { kind: "factory" };
      if (ast.isNamespaceImport(declaration) && importsRuntimeModule(declaration.parent)) return { kind: "module" };
      if (importsRuntimeModule(declaration)) return { kind: "module" };
      if (ast.isVariableDeclaration(declaration)) {
        const value = binding(declaration.initializer, seen);
        return value?.kind === "loader" && !(declaration.parent.flags & ast.NodeFlags.Const) ? { kind: "loader" } : value;
      }
      if (ast.isBindingElement(declaration) && ast.isObjectBindingPattern(declaration.parent)
        && ast.isVariableDeclaration(declaration.parent.parent)) {
        const name = declaration.propertyName ?? declaration.name;
        if (name && (ast.isIdentifier(name) ? name.text : text(name)) === "createRequire"
          && binding(declaration.parent.parent.initializer, seen)?.kind === "module") return { kind: "factory" };
      }
      return undefined;
    }
    const member = property(node);
    if (member?.name === "createRequire" && binding(member.receiver, seen)?.kind === "module") return { kind: "factory" };
    if (!ast.isCallExpression(node)) return undefined;
    if ((node.expression.kind === ast.SyntaxKind.ImportKeyword
      || (ast.isIdentifier(node.expression) && node.expression.text === "require" && !declarations.get(node.expression)))
      && moduleId(text(node.arguments[0]))) return { kind: "module" };
    if (binding(node.expression, seen)?.kind === "factory") {
      const anchor = anchorOf(node.arguments[0]);
      return anchor === undefined ? { kind: "loader" } : { kind: "loader", anchor };
    }
    return undefined;
  }

  const loads: Load[] = [];
  const reanchored = new Set<string>();
  const ordinary = new Set<string>();
  let uncertain = false;
  for (const node of expressions) {
    if (ast.isCallExpression(node)) {
      const loader = binding(node.expression);
      const specifier = text(node.arguments[0]);
      const namedRequire = ast.isIdentifier(node.expression) && node.expression.text === "require";
      if (loader?.kind === "loader") {
        if (loader.anchor !== undefined && specifier !== undefined) loads.push({ anchor: loader.anchor, specifier });
        else uncertain = true;
        if (namedRequire && specifier !== undefined && loader.anchor !== file) reanchored.add(specifier);
      } else if (specifier !== undefined && (namedRequire || property(node.expression)?.name === "require")) {
        ordinary.add(specifier);
      }
    }
    const parent = node.parent;
    // Track plain aliases and calls. A loader passed into another expression
    // can be called later through a binding this file cannot prove.
    if (ast.isImportSpecifier(parent) || ast.isImportClause(parent) || ast.isNamespaceImport(parent)
      || ast.isBindingElement(parent) || ast.isPropertyAccessExpression(parent) && parent.name === node
      || ast.isVariableDeclaration(parent) && parent.name === node
      || ast.isCallExpression(parent) && parent.expression === node
      || wrapsExpression(parent)) continue;
    const access = ast.isPropertyAccessExpression(parent) || ast.isElementAccessExpression(parent) ? property(parent) : undefined;
    if (access?.name && ["resolve", "cache", "main", "extensions"].includes(access.name)) continue;
    if (ast.isVariableDeclaration(parent) && parent.initializer === node) {
      const statement = parent.parent.parent;
      if (!ast.isVariableStatement(statement) || !statement.modifiers?.some(modifier => modifier.kind === ast.SyntaxKind.ExportKeyword)) continue;
    }
    const kind = binding(node)?.kind;
    if (kind === "loader" || kind === "factory") uncertain = true;
  }
  for (const specifier of ordinary) reanchored.delete(specifier);
  return { loads, uncertain, reanchored };
}

export function windowsCreateRequireLoads(sources: ReadonlyMap<string, string>): Map<string, Loads> {
  const candidates = new Map([...sources].filter(([, source]) => source.includes("createRequire")));
  return withParsedSourceTexts(candidates, (parsed, resolveDeclarations) =>
    new Map([...candidates.keys()].map(file => {
      const source = parsed.get(file);
      return [file, source ? findLoads(file, source, identifiers => resolveDeclarations(file, identifiers, { shorthandValues: true }))
        : { loads: [], uncertain: true, reanchored: new Set<string>() }];
    })));
}
