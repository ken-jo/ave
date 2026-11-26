import { ts } from "ts-morph";

/**
 * Structural rules that keep every model transport behind the retirement gate. The checker is a pure function over a
 * path → source map, so a test can prove each rule against an in-memory mutation.
 */

/** The only production files that may hold a value import of the model SDK, and which bindings of `ai` they may take. */
const SDK_FILES: Readonly<Record<string, readonly string[] | "any">> = {
  "src/engine/llm/vercel/adapter.ts": "any",
  // Embedding dispatch: its model still comes from the gated adapter through `createEmbeddingModel`.
  "src/main/memory-map/provider-embeddings.ts": ["embedMany"],
};
/** Tracing registers the SDK's telemetry hook. It may load the SDK lazily and must never name a dispatch function. */
const TELEMETRY_FILE = "src/engine/telemetry/tracing.ts";
const TELEMETRY_SPECIFIERS = new Set(["ai", "@ai-sdk/otel"]);
const SDK_DISPATCH = /\b(?:streamText|generateText|streamObject|generateObject|embed|embedMany|generateImage|generateSpeech|transcribe|rerank)\b/;
/** Only a source that can touch one of the rules is parsed. */
const RELEVANT = /@ai-sdk\/|["'`]ai(?:\/[^"'`]*)?["'`]|getRetiredModelId|VercelUnifiedProvider/;
const ADAPTER = "src/engine/llm/vercel/adapter.ts";
const FACTORY = "src/engine/llm/provider-factory.ts";
/** Wrappers in the adapter that observe or project a response and send through the fetch they are given. */
const FETCH_WRAPPERS = new Set(["observeRequestControls", "projectNativeOutput"]);
const WIRE_FETCH_BODY = "{ return gateModelFetch(this.customFetch, () => this.extras.getRetiredModelId?.(modelId)); }";

function isModelSdk(specifier: string): boolean {
  return specifier === "ai" || specifier.startsWith("ai/") || specifier.startsWith("@ai-sdk/");
}

function compact(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function each(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => each(child, visit));
}

function enclosingFunction(node: ts.Node): ts.Node | undefined {
  let current = node.parent;
  while (current && !ts.isFunctionLike(current) && !ts.isSourceFile(current)) current = current.parent;
  return current;
}

/** The initializer of the `const` a name refers to inside one function. */
function constInitializer(scope: ts.Node | undefined, name: string): ts.Expression | undefined {
  let found: ts.Expression | undefined;
  if (!scope) return undefined;
  each(scope, (node) => {
    if (
      ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer
      && (node.parent.flags & ts.NodeFlags.Const) !== 0
    ) {
      found = node.initializer;
    }
  });
  return found;
}

/** Whether a fetch expression can only be the adapter's gated wire fetch, possibly behind a response wrapper. */
function isGateDerived(expression: ts.Expression, scope: ts.Node | undefined, depth = 0): boolean {
  if (depth > 8) return false;
  if (ts.isParenthesizedExpression(expression)) return isGateDerived(expression.expression, scope, depth + 1);
  if (ts.isConditionalExpression(expression)) {
    return isGateDerived(expression.whenTrue, scope, depth + 1) && isGateDerived(expression.whenFalse, scope, depth + 1);
  }
  if (ts.isCallExpression(expression)) {
    if (compact(expression.expression.getText()) === "this.wireFetch") return true;
    const [first] = expression.arguments;
    return ts.isIdentifier(expression.expression) && FETCH_WRAPPERS.has(expression.expression.text)
      && first !== undefined && isGateDerived(first, scope, depth + 1);
  }
  if (ts.isIdentifier(expression)) {
    const initializer = constInitializer(scope, expression.text);
    return initializer !== undefined && isGateDerived(initializer, scope, depth + 1);
  }
  return false;
}

/** Whether an SDK factory's options carry a gated fetch: named directly, or inherited from a spread options object. */
function optionsCarryGatedFetch(options: ts.Expression | undefined, scope: ts.Node | undefined, depth = 0): boolean {
  if (!options || depth > 4) return false;
  if (ts.isIdentifier(options)) return optionsCarryGatedFetch(constInitializer(scope, options.text), scope, depth + 1);
  if (!ts.isObjectLiteralExpression(options)) return false;
  let gated = false;
  for (const property of options.properties) {
    if (ts.isSpreadAssignment(property)) {
      if (ts.isIdentifier(property.expression)) {
        gated = optionsCarryGatedFetch(property.expression, scope, depth + 1);
      } else if (!spreadsNoFetch(property.expression)) {
        // A spread that could carry a fetch of its own would replace the gated one.
        return false;
      }
    } else if (ts.isPropertyAssignment(property) && property.name.getText() === "fetch") {
      gated = isGateDerived(property.initializer, scope);
    } else if (ts.isShorthandPropertyAssignment(property) && property.name.text === "fetch") {
      gated = isGateDerived(property.name, scope);
    }
  }
  return gated;
}

/** A spread of literal option objects, possibly conditional, none of which names a fetch. */
function spreadsNoFetch(expression: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(expression)) return spreadsNoFetch(expression.expression);
  if (ts.isConditionalExpression(expression)) return spreadsNoFetch(expression.whenTrue) && spreadsNoFetch(expression.whenFalse);
  return ts.isObjectLiteralExpression(expression) && expression.properties.every((property) =>
    (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) && property.name.getText() !== "fetch");
}

function returnsNothing(expression: ts.Expression): boolean {
  if (!ts.isArrowFunction(expression) && !ts.isFunctionExpression(expression)) return false;
  const { body } = expression;
  const isUndefined = (node: ts.Expression | undefined) =>
    node === undefined || compact(node.getText()) === "undefined" || ts.isVoidExpression(node);
  if (!ts.isBlock(body)) return isUndefined(body);
  return body.statements.every((statement) => ts.isReturnStatement(statement) && isUndefined(statement.expression));
}

interface RetirementProbeSite {
  file: string;
  /** The expression a production object literal supplies as its route's retirement evidence. */
  probe: string;
}

interface ModelTransportStructure {
  violations: string[];
  /** Every place production code supplies retirement evidence, for comparison with the reviewed inventory. */
  probeSites: RetirementProbeSite[];
}

export function isProductionSource(path: string): boolean {
  return /^src\/.*\.tsx?$/.test(path) && !path.endsWith(".d.ts") && !/(^|\/)__tests__\//.test(path) && !/\.test\.tsx?$/.test(path);
}

export function inspectModelTransportStructure(sources: ReadonlyMap<string, string>): ModelTransportStructure {
  const violations: string[] = [];
  const probeSites: RetirementProbeSite[] = [];

  for (const [file, text] of [...sources].sort(([a], [b]) => a.localeCompare(b))) {
    if (!isProductionSource(file) || !RELEVANT.test(text)) continue;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const sdkFactories = new Set<string>();

    each(source, (node) => {
      // Rule 1: the model SDK is reachable only from the gated transport files.
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && isModelSdk(node.moduleSpecifier.text)) {
        const clause = node.importClause;
        if (!clause || clause.isTypeOnly) return;
        const allowed = SDK_FILES[file];
        const bindings = clause.namedBindings;
        const named = bindings && ts.isNamedImports(bindings) ? bindings.elements.filter((element) => !element.isTypeOnly) : [];
        if (allowed === undefined) {
          violations.push(`${file}: imports the model SDK (${node.moduleSpecifier.text}) outside the gated transport`);
        } else if (clause.name || (bindings && ts.isNamespaceImport(bindings))) {
          violations.push(`${file}: takes a default or namespace import of ${node.moduleSpecifier.text}; name each binding`);
        } else if (allowed !== "any") {
          for (const element of named) {
            const imported = (element.propertyName ?? element.name).text;
            if (!allowed.includes(imported)) violations.push(`${file}: imports ${imported} from ${node.moduleSpecifier.text}`);
          }
        }
        if (node.moduleSpecifier.text.startsWith("@ai-sdk/")) for (const element of named) sdkFactories.add(element.name.text);
      }
      if (ts.isCallExpression(node)) {
        const [argument] = node.arguments;
        const dynamic = node.expression.kind === ts.SyntaxKind.ImportKeyword
          || (ts.isIdentifier(node.expression) && node.expression.text === "require");
        if (dynamic && argument && ts.isStringLiteralLike(argument) && isModelSdk(argument.text)) {
          if (file !== TELEMETRY_FILE || !TELEMETRY_SPECIFIERS.has(argument.text)) {
            violations.push(`${file}: loads the model SDK (${argument.text}) dynamically`);
          } else if (SDK_DISPATCH.test(text)) {
            violations.push(`${file}: names an SDK dispatch function beside its telemetry registration`);
          }
        }
      }
      if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
        && isModelSdk(node.moduleSpecifier.text) && !node.isTypeOnly) {
        violations.push(`${file}: re-exports the model SDK (${node.moduleSpecifier.text})`);
      }

      // Rule 3: the adapter is constructed only by the factory, which forwards the caller's evidence.
      if (ts.isIdentifier(node) && node.text === "VercelUnifiedProvider" && file !== ADAPTER) {
        const parent = node.parent;
        const imported = ts.isImportSpecifier(parent) || ts.isBindingElement(parent);
        const constructed = ts.isNewExpression(parent) && parent.expression === node;
        const typeOnly = ts.isTypeReferenceNode(parent) || ts.isTypeQueryNode(parent);
        if (file !== FACTORY) {
          if (!typeOnly) violations.push(`${file}: reaches VercelUnifiedProvider outside the provider factory`);
        } else if (constructed) {
          const scope = enclosingFunction(parent);
          const forwards = scope !== undefined && /getRetiredModelId: (cfg|config)\.getRetiredModelId\b/.test(compact(scope.getText()));
          if (!forwards) violations.push(`${file}: constructs VercelUnifiedProvider without the config's getRetiredModelId`);
        } else if (!imported && !typeOnly) {
          violations.push(`${file}: uses VercelUnifiedProvider other than by constructing it`);
        }
      }

      // Rule 4: evidence is never an inline function that answers nothing.
      const probeName = (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) && node.name.getText() === "getRetiredModelId";
      if (probeName && ts.isObjectLiteralExpression(node.parent)) {
        const initializer = ts.isPropertyAssignment(node) ? node.initializer : node.name;
        probeSites.push({ file, probe: compact(initializer.getText()) });
        if (returnsNothing(initializer)) violations.push(`${file}: supplies a getRetiredModelId that answers nothing; name noRetirementEvidence`);
      }
    });

    if (file !== ADAPTER) continue;

    // Rule 2: inside the adapter, an SDK factory is only ever called directly with a gated fetch.
    each(source, (node) => {
      if (!ts.isIdentifier(node) || !sdkFactories.has(node.text) || ts.isImportSpecifier(node.parent)) return;
      const call = node.parent;
      if (!ts.isCallExpression(call) || call.expression !== node) {
        violations.push(`${file}: ${node.text} is aliased or passed around instead of being called with a gated fetch`);
        return;
      }
      if (!optionsCarryGatedFetch(call.arguments[0], enclosingFunction(call))) {
        violations.push(`${file}: ${node.text}(…) is not given the gated wire fetch`);
      }
    });
    let wireFetchBody: string | undefined;
    each(source, (node) => {
      if (ts.isMethodDeclaration(node) && node.name.getText() === "wireFetch" && node.body) wireFetchBody = compact(node.body.getText());
    });
    if (wireFetchBody !== WIRE_FETCH_BODY) {
      violations.push(`${file}: wireFetch must be exactly ${WIRE_FETCH_BODY}`);
    }
    if (!/import \{[^}]*\bgateModelFetch\b[^}]*\} from "\.\.\/model-wire-gate\.js";/.test(text)) {
      violations.push(`${file}: gateModelFetch must come from ../model-wire-gate.js`);
    }
  }
  return { violations: [...new Set(violations)], probeSites };
}
