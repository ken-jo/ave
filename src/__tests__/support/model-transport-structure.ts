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
/** Files whose fetches sit between a provider config and the network send. One that waits before sending must declare it. */
const FETCH_CHAIN_FILES = new Set([
  "src/engine/llm/marketplace-provider-fetch.ts",
  "src/main/chatgpt-plan/responses-fetch.ts",
  "src/main/chatgpt-plan/egress.ts",
  "src/main/safe-llm-fetch.ts",
]);
/** The reviewed constructors of a fetch a provider config may carry. All live in the fetch chain files. */
const REVIEWED_FETCH_CONSTRUCTORS = new Set([
  "selectProviderRuntimeFetch",
  "createPublicModelProviderFetch",
  "createGuardedModelProviderFetch",
  "createGuardedMarketplaceProviderFetch",
  "createChatGptPlanResponsesFetch",
]);
/** The SDK's gateway resolves a model by string and sends on its own transport. */
const GATEWAY_BINDINGS = new Set(["gateway", "createGateway"]);
const DISPATCH_CALLS = new Set(["streamText", "generateText", "streamObject", "generateObject"]);
const FACTORY = "src/engine/llm/provider-factory.ts";
/** Wrappers in the adapter that observe or project a response and send through the fetch they are given. */
const FETCH_WRAPPERS = new Set(["observeRequestControls", "observeServedRequest", "projectNativeOutput"]);
const WIRE_FETCH_BODY = "{ return gateModelFetch(this.customFetch, () => this.extras.getRetiredModelId(modelId)); }";

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

/** The same lookup through each enclosing function, innermost first. */
function outerConstInitializer(node: ts.Node, name: string): ts.Expression | undefined {
  for (let scope = enclosingFunction(node); scope && !ts.isSourceFile(scope); scope = enclosingFunction(scope)) {
    const initializer = constInitializer(scope, name);
    if (initializer) return initializer;
  }
  return undefined;
}

/** Whether a fetch expression can only be the adapter's gated wire fetch, possibly behind a response wrapper. */
function isGateDerived(expression: ts.Expression, scope: ts.Node | undefined, aliasDepth = 0): boolean {
  if (aliasDepth > 8) return false;
  if (ts.isParenthesizedExpression(expression)) return isGateDerived(expression.expression, scope, aliasDepth);
  if (ts.isConditionalExpression(expression)) {
    return isGateDerived(expression.whenTrue, scope, aliasDepth) && isGateDerived(expression.whenFalse, scope, aliasDepth);
  }
  if (ts.isCallExpression(expression)) {
    if (compact(expression.expression.getText()) === "this.wireFetch") return true;
    const [first] = expression.arguments;
    return ts.isIdentifier(expression.expression) && FETCH_WRAPPERS.has(expression.expression.text)
      && first !== undefined && isGateDerived(first, scope, aliasDepth);
  }
  if (ts.isIdentifier(expression)) {
    const initializer = constInitializer(scope, expression.text);
    return initializer !== undefined && isGateDerived(initializer, scope, aliasDepth + 1);
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

/** Whether a function awaits, or enters the address-validating guard, in its own body rather than in a nested function. */
function waitsBeforeSend(fn: ts.Node): boolean {
  let waits = false;
  const visit = (node: ts.Node): void => {
    if (node !== fn && ts.isFunctionLike(node)) return;
    if (ts.isAwaitExpression(node)) waits = true;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "fetchPublicHttpResponse") waits = true;
    node.forEachChild(visit);
  };
  visit(fn);
  return waits;
}

/** The `const` a function expression is assigned to, through parentheses and casts. */
function assignedName(fn: ts.Node): string | undefined {
  let current = fn.parent;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current)) current = current.parent;
  return ts.isVariableDeclaration(current) && ts.isIdentifier(current.name) ? current.name.text : undefined;
}

/** Whether a config's fetch can only come from a reviewed constructor. */
function isReviewedFetch(expression: ts.Expression, scope: ts.Node | undefined, depth = 0): boolean {
  if (depth > 8) return false;
  if (ts.isParenthesizedExpression(expression)) return isReviewedFetch(expression.expression, scope, depth + 1);
  if (ts.isConditionalExpression(expression)) {
    return isReviewedFetch(expression.whenTrue, scope, depth + 1) && isReviewedFetch(expression.whenFalse, scope, depth + 1);
  }
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
    return isReviewedFetch(expression.left, scope, depth + 1) && isReviewedFetch(expression.right, scope, depth + 1);
  }
  if (ts.isCallExpression(expression)) {
    return ts.isIdentifier(expression.expression) && REVIEWED_FETCH_CONSTRUCTORS.has(expression.expression.text);
  }
  if (ts.isIdentifier(expression)) {
    const initializer = constInitializer(scope, expression.text);
    return initializer !== undefined && isReviewedFetch(initializer, scope, depth + 1);
  }
  return false;
}

function insideReviewedConstructor(node: ts.Node): boolean {
  for (let current = node.parent; current && !ts.isSourceFile(current); current = current.parent) {
    if (ts.isCallExpression(current) && ts.isIdentifier(current.expression) && REVIEWED_FETCH_CONSTRUCTORS.has(current.expression.text)) {
      return true;
    }
  }
  return false;
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
  const parsed = new Map<string, ts.SourceFile>();

  for (const [file, text] of [...sources].sort(([a], [b]) => a.localeCompare(b))) {
    if (!isProductionSource(file) || !(RELEVANT.test(text) || FETCH_CHAIN_FILES.has(file))) continue;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const sdkFactories = new Set<string>();
    const sdkDispatch = new Set<string>();
    parsed.set(file, source);

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
        if (node.moduleSpecifier.text === "@ai-sdk/gateway") violations.push(`${file}: imports the SDK gateway, which sends on its own transport`);
        for (const element of named) {
          const imported = (element.propertyName ?? element.name).text;
          if (GATEWAY_BINDINGS.has(imported)) violations.push(`${file}: imports ${imported}, which sends on its own transport`);
          if (node.moduleSpecifier.text === "ai" && DISPATCH_CALLS.has(imported)) sdkDispatch.add(element.name.text);
        }
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

    // Rule 5: a fetch in the chain that waits before sending declares it, so the gate's check moves after the wait.
    if (FETCH_CHAIN_FILES.has(file)) {
      each(source, (node) => {
        if (!(ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)) || !waitsBeforeSend(node)) return;
        const name = assignedName(node);
        const scope = enclosingFunction(node);
        const declared = name !== undefined && scope !== undefined
          && new RegExp(`\\bdeclareDeferredSend\\(${name},`).test(scope.getText());
        if (!declared) violations.push(`${file}: a fetch that waits before its send is not declared with declareDeferredSend`);
      });
    }

    if (file !== ADAPTER) continue;

    // Rule 6: a dispatch call takes its model only from resolveModel, never a string the SDK would route itself.
    each(source, (node) => {
      // A `typeof` in a type position names the function without calling it.
      if (!ts.isIdentifier(node) || !sdkDispatch.has(node.text) || ts.isImportSpecifier(node.parent) || ts.isTypeQueryNode(node.parent)) return;
      const call = node.parent;
      const [options] = ts.isCallExpression(call) && call.expression === node ? call.arguments : [];
      const model = options && ts.isObjectLiteralExpression(options)
        ? options.properties.find((property) => property.name?.getText() === "model")
        : undefined;
      const value = model && ts.isPropertyAssignment(model) ? model.initializer
        : model && ts.isShorthandPropertyAssignment(model) ? outerConstInitializer(call, model.name.text)
        : undefined;
      const resolved = value !== undefined && ts.isCallExpression(value) && compact(value.expression.getText()) === "this.resolveModel";
      if (!resolved) violations.push(`${file}: ${node.text}(…) must take its model from this.resolveModel(…)`);
    });

    // Rule 7: the gate is asked about the same model id the factory is given.
    each(source, (node) => {
      if (!ts.isMethodDeclaration(node) || node.name.getText() === "wireFetch" || !node.body) return;
      const gateArguments: ts.Expression[] = [];
      const providers = new Set<string>();
      each(node.body, (inner) => {
        if (ts.isCallExpression(inner) && compact(inner.expression.getText()) === "this.wireFetch") gateArguments.push(inner.arguments[0]);
        if (ts.isVariableDeclaration(inner) && ts.isIdentifier(inner.name) && inner.initializer && ts.isCallExpression(inner.initializer)
          && ts.isIdentifier(inner.initializer.expression) && sdkFactories.has(inner.initializer.expression.text)) {
          providers.add(inner.name.text);
        }
      });
      if (gateArguments.length === 0) return;
      const method = node.name.getText();
      const parameters = new Set(node.parameters.map((parameter) => parameter.name.getText()));
      const [first] = gateArguments;
      const modelId = first && ts.isIdentifier(first) && parameters.has(first.text) ? first.text : undefined;
      if (modelId === undefined || gateArguments.some((argument) => !ts.isIdentifier(argument) || argument.text !== modelId)) {
        violations.push(`${file}: ${method} must gate on its own model id parameter`);
        return;
      }
      let selections = 0;
      each(node.body, (inner) => {
        if (!ts.isCallExpression(inner)) return;
        const callee = inner.expression;
        const root = ts.isPropertyAccessExpression(callee) ? callee.expression : callee;
        const fromProvider = (ts.isIdentifier(root) && providers.has(root.text))
          || (ts.isPropertyAccessExpression(callee) && ts.isCallExpression(root) && ts.isIdentifier(root.expression) && sdkFactories.has(root.expression.text));
        if (!fromProvider) return;
        selections += 1;
        const [selected] = inner.arguments;
        if (!selected || !ts.isIdentifier(selected) || selected.text !== modelId) {
          violations.push(`${file}: ${method} selects a model other than the one its gate checks`);
        }
      });
      if (selections === 0) violations.push(`${file}: ${method} gates a fetch but selects no model`);
    });

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
  // Rule 8: where production code supplies evidence, the fetch beside it comes from a reviewed constructor.
  const siteFiles = new Set(probeSites.map((site) => site.file));
  for (const file of siteFiles) {
    if (file === ADAPTER || file === FACTORY) continue;
    const source = parsed.get(file);
    if (!source) continue;
    each(source, (node) => {
      const named = (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) && node.name.getText() === "fetch";
      if (!named || !ts.isObjectLiteralExpression(node.parent) || insideReviewedConstructor(node)) return;
      const initializer = ts.isPropertyAssignment(node) ? node.initializer : node.name;
      if (!isReviewedFetch(initializer, enclosingFunction(node))) {
        violations.push(`${file}: a provider config carries a fetch that no reviewed constructor built`);
      }
    });
  }
  return { violations: [...new Set(violations)], probeSites };
}
