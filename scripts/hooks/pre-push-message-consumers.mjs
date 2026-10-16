import { posix } from "node:path";
import * as ast from "typescript/unstable/ast";

const I18N_DIRECTORY = "src/i18n/";
const KEY_CALL_SIGNATURES = Object.freeze({
  "src/i18n/runtime.ts": Object.freeze({ t: Object.freeze({ key: 0, parameters: Object.freeze(["key", "vars"]) }) }),
  "src/i18n/translate.ts": Object.freeze({ translate: Object.freeze({ key: 1, parameters: Object.freeze(["locale", "key", "vars"]) }) }),
  "src/i18n/react.tsx": Object.freeze({ useTranslation: Object.freeze({ factory: true, parameters: Object.freeze([]) }) }),
});
const KEY_TABLE_NAME = /keys?(?:(?:_?table)|(?:_?map))?$/i;
const ORDINARY_CALL_SIGNATURE = Object.freeze({ ordinary: true });
const isStaticString = (node) => node !== undefined && (ast.isStringLiteral(node) || ast.isNoSubstitutionTemplateLiteral(node));
const isExported = (node) => node.modifiers?.some((modifier) => modifier.kind === ast.SyntaxKind.ExportKeyword);

function isLiteralKeyTable(node) {
  if (!node) return false;
  if (isStaticString(node)) return true;
  if (ast.isAsExpression(node) || ast.isSatisfiesExpression(node)) return isLiteralKeyTable(node.expression);
  if (ast.isArrayLiteralExpression(node)) return node.elements.every(isLiteralKeyTable);
  return ast.isObjectLiteralExpression(node) && node.properties.every((property) =>
    ast.isPropertyAssignment(property) && !ast.isComputedPropertyName(property.name) && isLiteralKeyTable(property.initializer));
}

function exportedDeclarations(source) {
  return source.statements.flatMap((statement) => {
    if (!isExported(statement)) return [];
    if (ast.isVariableStatement(statement)) return statement.declarationList.declarations.filter((node) => ast.isIdentifier(node.name));
    if (ast.isFunctionDeclaration(statement) || ast.isClassDeclaration(statement) || ast.isEnumDeclaration(statement)) {
      return statement.name ? [statement] : [];
    }
    return [];
  });
}

function callableDeclarations(source) {
  return source.statements.flatMap((statement) => {
    if (ast.isFunctionDeclaration(statement) && statement.name && statement.body &&
        !statement.modifiers?.some((modifier) => modifier.kind === ast.SyntaxKind.DefaultKeyword)) return [statement];
    if (!ast.isVariableStatement(statement) || statement.declarationList.flags !== ast.NodeFlags.Const) return [];
    return statement.declarationList.declarations.filter((declaration) => ast.isIdentifier(declaration.name) && declaration.initializer &&
      (ast.isArrowFunction(declaration.initializer) || ast.isFunctionExpression(declaration.initializer)));
  });
}

function hasJsx(node) {
  let found = ast.isJsxElement(node) || ast.isJsxSelfClosingElement(node) || ast.isJsxFragment(node);
  if (!found) node.forEachChild((child) => { found ||= hasJsx(child); });
  return found;
}

/**
 * Build a positive proof for catalog consumers. Only named imports from a
 * resolved runtime module and the t binding of a direct context destructure
 * can acquire a callable signature. Every reference to those bindings must
 * then resolve to that exact declaring node and be a literal-key call; an
 * unclassified reference invalidates the proof.
 * Other calls need a direct local function or a resolved non-runtime named
 * import. Indirect calls and member access cannot establish callable identity.
 */
export function createMessageConsumerReader(sources, trackedFiles, resolveDeclarations) {
  const tracked = new Set(trackedFiles);
  const runtimeNames = new Set(Object.values(KEY_CALL_SIGNATURES).flatMap(Object.keys));
  for (const [path, source] of sources) {
    if (!path.startsWith(I18N_DIRECTORY)) continue;
    for (const declaration of exportedDeclarations(source)) runtimeNames.add(declaration.name.text);
    for (const statement of source.statements) {
      if (ast.isExportDeclaration(statement) && !statement.isTypeOnly && statement.exportClause && ast.isNamedExports(statement.exportClause)) {
        for (const specifier of statement.exportClause.elements) if (!specifier.isTypeOnly) runtimeNames.add(specifier.name.text);
      }
    }
  }

  function resolveModule(from, specifier) {
    if (!specifier.startsWith("./") && !specifier.startsWith("../")) return null;
    const base = posix.normalize(posix.join(posix.dirname(from), specifier));
    const stem = base.replace(/\.js$/, "");
    const candidates = /\.js$/.test(base)
      ? [base, ...[".ts", ".tsx", ".d.ts"].map((extension) => stem + extension)]
      : /\.[^/]+$/.test(base) ? [base]
        : [base, ...[".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", "/index.ts", "/index.tsx", "/index.js"].map((extension) => base + extension)];
    const matches = [...new Set(candidates)].filter((path) => tracked.has(path));
    return matches.length === 1 ? { path: matches[0] } : null;
  }

  function readDeclaredType(module, node, seen = new Set()) {
    if (!node) return null;
    if (!ast.isTypeReferenceNode(node)) return { module, node };
    if (!ast.isIdentifier(node.typeName) || node.typeArguments) return null;
    const name = node.typeName.text;
    const identity = `${module}:${name}`;
    if (seen.has(identity)) return null;
    seen.add(identity);
    const source = sources.get(module);
    if (!source) return null;
    const declarations = source.statements.filter((statement) =>
      (ast.isInterfaceDeclaration(statement) || ast.isTypeAliasDeclaration(statement)) && statement.name.text === name);
    const imports = source.statements.flatMap((statement) => {
      if (!ast.isImportDeclaration(statement) || !statement.importClause?.namedBindings ||
          !ast.isNamedImports(statement.importClause.namedBindings) || !isStaticString(statement.moduleSpecifier)) return [];
      return statement.importClause.namedBindings.elements.filter((specifier) => specifier.name.text === name)
        .map((specifier) => ({ module: statement.moduleSpecifier.text, name: (specifier.propertyName ?? specifier.name).text }));
    });
    if (declarations.length + imports.length !== 1) return null;
    let declaration = declarations[0];
    if (!declaration) {
      const target = resolveModule(module, imports[0].module);
      if (!target?.path) return null;
      module = target.path;
      const matches = sources.get(module)?.statements.filter((statement) => isExported(statement) &&
        (ast.isInterfaceDeclaration(statement) || ast.isTypeAliasDeclaration(statement)) && statement.name.text === imports[0].name);
      if (matches?.length !== 1) return null;
      declaration = matches[0];
    }
    if (declaration.typeParameters || ast.isInterfaceDeclaration(declaration) && declaration.heritageClauses) return null;
    return ast.isTypeAliasDeclaration(declaration) ? readDeclaredType(module, declaration.type, seen) : { module, node: declaration };
  }

  function matchesParameters(parameters, signature) {
    return parameters.length === signature.parameters.length && parameters.every((parameter, index) =>
      ast.isIdentifier(parameter.name) && parameter.name.text === signature.parameters[index] &&
      !parameter.dotDotDotToken && !parameter.initializer && Boolean(parameter.questionToken) === (index > signature.key)) &&
      (signature.factory || parameters[signature.key].type?.kind === ast.SyntaxKind.StringKeyword);
  }

  function signatureFor(module, name) {
    const signature = KEY_CALL_SIGNATURES[module]?.[name];
    const source = sources.get(module);
    if (!signature || !source) return null;
    const declarations = exportedDeclarations(source).filter((node) => node.name.text === name);
    if (declarations.length !== 1 || !ast.isFunctionDeclaration(declarations[0]) || !declarations[0].body || declarations[0].typeParameters ||
        declarations[0].modifiers?.some((modifier) => modifier.kind === ast.SyntaxKind.DefaultKeyword) ||
        !matchesParameters(declarations[0].parameters, signature)) return null;
    if (signature.factory) {
      const context = readDeclaredType(module, declarations[0].type);
      if (!context || !ast.isTypeLiteralNode(context.node) && !ast.isInterfaceDeclaration(context.node)) return null;
      if (context.node.members.some((member) => member.kind !== ast.SyntaxKind.PropertySignature || !member.name || !ast.isIdentifier(member.name))) return null;
      const members = context.node.members.filter((member) => member.name && ast.isIdentifier(member.name) && member.name.text === "t");
      if (members.length !== 1 || members[0].kind !== ast.SyntaxKind.PropertySignature || members[0].questionToken) return null;
      const callable = readDeclaredType(context.module, members[0].type);
      if (!callable || !ast.isFunctionTypeNode(callable.node) || callable.node.typeParameters ||
          !matchesParameters(callable.node.parameters, KEY_CALL_SIGNATURES["src/i18n/runtime.ts"].t)) return null;
    }
    return signature;
  }

  return function readMessageConsumers(path, namespaces) {
    const source = sources.get(path);
    const named = new Set();
    if (!source || typeof resolveDeclarations !== "function") return { named, unresolved: true };
    // Lowering JSX inserts runtime imports and calls absent from this AST.
    // No JSX runtime is certified here; JSX and any @jsx text require full.
    if (typeof source.text !== "string" || /@jsx/i.test(source.text) || hasJsx(source)) return { named, unresolved: true };
    const approved = new Set();
    const bindings = new Map();
    const bindingNames = new Set();
    const parents = new Map();
    const nodes = [];
    let unresolved = false;
    function collect(node, parent) {
      // Erased types have no runtime references. Expression instantiations
      // still contain values; callable signatures are validated separately.
      if (ast.isTypeNode(node) && !ast.isExpressionWithTypeArguments(node) || ast.isInterfaceDeclaration(node) || ast.isTypeAliasDeclaration(node) ||
          (ast.isImportClause(node) || ast.isImportSpecifier(node) || ast.isExportDeclaration(node) || ast.isExportSpecifier(node)) && node.isTypeOnly) return;
      nodes.push(node);
      parents.set(node, parent);
      node.forEachChild((child) => collect(child, node));
    }
    collect(source, undefined);
    const declarations = resolveDeclarations(path, nodes.filter(ast.isIdentifier));

    function signatureForReference(identifier) {
      return ast.isIdentifier(identifier) ? bindings.get(declarations.get(identifier)) : undefined;
    }

    function register(identifier, signature) {
      const declaration = declarations.get(identifier);
      // Names only expand rejection for reused or unknown references. They
      // never grant a signature; approval belongs to this declaring AST node.
      if (!declaration || declaration.name !== identifier || bindingNames.has(identifier.text)) { unresolved = true; return; }
      bindings.set(declaration, signature);
      bindingNames.add(identifier.text);
      approved.add(identifier);
    }

    // Export definitions declare the runtime API; they are not consumer uses.
    if (path.startsWith(I18N_DIRECTORY)) {
      for (const declaration of exportedDeclarations(source)) approved.add(declaration.name);
    }
    for (const declaration of callableDeclarations(source)) {
      if (!runtimeNames.has(declaration.name.text)) register(declaration.name, ORDINARY_CALL_SIGNATURE);
    }
    for (const statement of source.statements) {
      if (!ast.isImportDeclaration(statement) || statement.importClause?.isTypeOnly) continue;
      if (!isStaticString(statement.moduleSpecifier)) { unresolved = true; continue; }
      const target = resolveModule(path, statement.moduleSpecifier.text);
      if (!target) { unresolved = true; continue; }
      // A tracked dependency outside the parsed tree could hide a runtime
      // re-export. Its identity alone is not a proof of its exports.
      if (target.path && !sources.has(target.path)) { unresolved = true; continue; }
      const clause = statement.importClause;
      if (!clause || clause.name || !clause.namedBindings || !ast.isNamedImports(clause.namedBindings) || statement.attributes) {
        unresolved = true;
        continue;
      }
      for (const specifier of clause.namedBindings.elements) {
        if (specifier.isTypeOnly) continue;
        const name = (specifier.propertyName ?? specifier.name).text;
        const runtime = target.path?.startsWith(I18N_DIRECTORY);
        const ordinary = !runtime && !runtimeNames.has(name) && !runtimeNames.has(specifier.name.text) &&
          callableDeclarations(sources.get(target.path)).some((declaration) => declaration.name.text === name &&
            exportedDeclarations(sources.get(target.path)).includes(declaration));
        const signature = runtime ? signatureFor(target.path, name) : ordinary ? ORDINARY_CALL_SIGNATURE : null;
        if (!signature) { unresolved = true; continue; }
        register(specifier.name, signature);
        if (specifier.propertyName) approved.add(specifier.propertyName);
      }
    }

    for (const node of nodes) {
      if (!ast.isCallExpression(node) || !ast.isIdentifier(node.expression) || !signatureForReference(node.expression)?.factory) continue;
      const declaration = parents.get(node);
      const list = declaration && parents.get(declaration);
      const statement = list && parents.get(list);
      const element = declaration && ast.isVariableDeclaration(declaration) && ast.isObjectBindingPattern(declaration.name) &&
        declaration.name.elements.length === 1 ? declaration.name.elements[0] : null;
      if (node.questionDotToken || node.typeArguments || node.arguments.length !== 0 || !declaration ||
          !ast.isVariableDeclaration(declaration) || declaration.initializer !== node || !list ||
          !ast.isVariableDeclarationList(list) || list.flags !== ast.NodeFlags.Const || !statement ||
          !ast.isVariableStatement(statement) || isExported(statement) || !element ||
          !ast.isIdentifier(element.name) || element.initializer || element.dotDotDotToken ||
          (element.propertyName ? !ast.isIdentifier(element.propertyName) || element.propertyName.text !== "t" : element.name.text !== "t")) {
        unresolved = true;
        continue;
      }
      approved.add(node.expression);
      if (element.propertyName) approved.add(element.propertyName);
      register(element.name, KEY_CALL_SIGNATURES["src/i18n/runtime.ts"].t);
    }

    for (const node of nodes) {
      const parent = parents.get(node);
      if (isStaticString(node)) {
        for (const namespace of namespaces) if (node.text === namespace || node.text.startsWith(`${namespace}.`)) named.add(namespace);
      }
      if ((ast.isIdentifier(node) || isStaticString(node)) &&
          (runtimeNames.has(node.text) || ast.isIdentifier(node) && bindingNames.has(node.text)) && !approved.has(node)) {
        // A spelled property in an object literal defines a name, not a value
        // reference. Member accesses and shorthand properties get no exception.
        if (parent && ast.isPropertyAssignment(parent) && parent.name === node) continue;
        const signature = signatureForReference(node);
        if (!ast.isIdentifier(node) || !signature || signature.factory || !parent || !ast.isCallExpression(parent) || parent.expression !== node ||
            parent.questionDotToken || parent.typeArguments || parent.arguments.some(ast.isSpreadElement) || !signature.ordinary &&
            (parent.arguments.length <= signature.key ||
             parent.arguments.length > signature.parameters.length || !isStaticString(parent.arguments[signature.key]))) unresolved = true;
        else if (!signature.ordinary) approved.add(parent.arguments[signature.key]);
      }
      // Calls and value transfers need a proven binding. A member, reflective
      // lookup or dynamically loaded namespace cannot acquire that proof.
      if (ast.isCallExpression(node) && (!ast.isIdentifier(node.expression) || !signatureForReference(node.expression))) unresolved = true;
      if (ast.isPropertyAccessExpression(node) || ast.isElementAccessExpression(node) || ast.isComputedPropertyName(node) ||
          ast.isNewExpression(node) || ast.isTaggedTemplateExpression(node) || ast.isDecorator(node) || ast.isWithStatement(node)) unresolved = true;
      if (ast.isExportDeclaration(node) && !node.isTypeOnly) unresolved = true;
      if (ast.isImportEqualsDeclaration(node) && !node.isTypeOnly) unresolved = true;
      if ((ast.isVariableDeclaration(node) || ast.isPropertyAssignment(node)) &&
          (ast.isIdentifier(node.name) || isStaticString(node.name)) && KEY_TABLE_NAME.test(node.name.text) &&
          !isLiteralKeyTable(node.initializer)) unresolved = true;
    }
    return { named, unresolved };
  };
}
