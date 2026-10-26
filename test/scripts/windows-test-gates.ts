/** Unknown calls fail closed when the Windows-only verdict depends on them; unknown values are features.
 * A win32-derived value reached through a transitive import or a non-relative import is not detected. */
type Token = { text: string; start: number; end: number; scope: number };
type Scope = { parent: number; bindings: Map<string, Token[]> };
type Possibilities = { windows: number[]; other: number[] };
type Gate = { line: number; argument: string; classification: "win32-only" | "not-win32-only" | "unclassifiable" };
const FALSE = 1;
const TRUE = 2;
const EITHER = FALSE | TRUE;
const FEATURE = { windows: [EITHER], other: [EITHER] };
const UNKNOWN = { windows: [FALSE, TRUE, EITHER], other: [FALSE, TRUE, EITHER] };
const HELPER_MODELS: Record<string, { target: string; equal: boolean }> = {
  shouldSkipNativeSandboxTests: { target: "win32", equal: true }, // src/__tests__/support/native-sandbox.ts:4-10
  electronControlLauncher: { target: "linux", equal: false }, // src/plugins/isolation/__tests__/adversarial-escapes.test.ts:127-138
};
const FEATURE_CALLS = new Set([
  "canCreateSymlinks", // src/__tests__/support/symlink-capability.ts:32-50
  "existsSync", // Runtime lib/fs.js:276-290: path existence, no platform branch.
  "hasExecutable", // src/hooks/__tests__/test-helpers.ts:7-14
  "canBind", // src/plugins/isolation/__tests__/child-loopback-link.test.ts:72-77
  "sandboxCasesRequired", // src/plugins/isolation/__tests__/sandbox-cases.ts:6-8
]);
export function conditionalGates(source: string): Gate[] {
  const platformFunctions = [...source.matchAll(/import\s*\{([^}]+)\}\s*from\s*["'](?:node:)?os["']/g)]
    .flatMap((match) => match[1]!.split(",").flatMap((entry) => {
      const imported = /^\s*platform(?:\s+as\s+(\w+))?\s*$/.exec(entry);
      return imported ? [imported[1] ?? "platform"] : [];
    }));
  const scopes: Scope[] = [{ parent: -1, bindings: new Map() }];
  let scope = 0;
  const tokens: Token[] = [];
  const scanner = createScanner(true, undefined, source);
  const templates: number[] = [];
  const closes = new Map<Token, number>();
  const opens = new Map<number, number>();
  const stack: number[] = [];
  let braces = 0;
  while (true) {
    scanner.scan();
    let text = scanner.getTokenText();
    if (!text) break;
    if (text === "}" && templates.at(-1) === braces) {
      scanner.reScanTemplateToken(false);
      text = scanner.getTokenText();
      if (!text.endsWith("${")) templates.pop();
      continue;
    }
    if (text.startsWith("`") && text.endsWith("${")) templates.push(braces);
    if (text === "/" && /^(?:|=|\(|\[|\{|,|:|;|return|=>|!|\?|&&|\|\|)$/.test(tokens.at(-1)?.text ?? "")) {
      scanner.reScanSlashToken();
      text = scanner.getTokenText();
    }
    if (text === "}") { braces--; scope = scopes[scope]!.parent; }
    tokens.push({ text, start: scanner.getTokenStart(), end: scanner.getTokenEnd(), scope });
    const i = tokens.length - 1;
    if (["(", "[", "{"].includes(text)) stack.push(i);
    if ([")", "]", "}"].includes(text)) {
      const open = stack.pop();
      if (open !== undefined) { closes.set(tokens[open]!, i); opens.set(i, open); }
    }
    if (text === "{") {
      braces++;
      scope = scopes.push({ parent: scope, bindings: new Map() }) - 1;
    }
  }
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i]!.text !== "const" || !/^[A-Za-z_$][\w$]*$/.test(tokens[i + 1]?.text ?? "")) continue;
    const name = tokens[i + 1]!;
    let start = i + 2;
    if (tokens[start]?.text === ":") while (start < tokens.length && !["=", ";", "{"].includes(tokens[start]!.text)) start++;
    if (tokens[start]?.text !== "=") continue;
    let end = ++start;
    while (end < tokens.length && ![";", ",", ")", "}"].includes(tokens[end]!.text)) end = (closes.get(tokens[end]!) ?? end) + 1;
    const bindings = scopes[name.scope]!.bindings;
    bindings.set(name.text, bindings.has(name.text) ? [] : tokens.slice(start, end));
  }
  function binding(token: Token): Token[] | undefined {
    for (let current = token.scope; current >= 0; current = scopes[current]!.parent) {
      const found = scopes[current]!.bindings.get(token.text);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  function resolved(input: Token[], seen = new Set<Token>()): Token[] {
    while (input[0]?.text === "(" && tokens[closes.get(input[0]) ?? -1] === input.at(-1)) input = input.slice(1, -1);
    const token = input[0];
    const value = input.length === 1 && token && !seen.has(token) ? binding(token) : undefined;
    return value ? resolved(value, new Set([...seen, token!])) : input;
  }
  function platform(input: Token[]): boolean {
    const text = resolved(input).map((token) => token.text).join("");
    return text === "process.platform" || text === "os.platform()" || platformFunctions.some((name) => text === `${name}()`);
  }
  function logic(a: Possibilities, b: Possibilities, and: boolean): Possibilities {
    const combine = (x: number, y: number) => and
      ? ((x & FALSE) || (y & FALSE) ? FALSE : 0) | ((x & TRUE) && (y & TRUE) ? TRUE : 0)
      : ((x & FALSE) && (y & FALSE) ? FALSE : 0) | ((x & TRUE) || (y & TRUE) ? TRUE : 0);
    const merge = (left: number[], right: number[]) => [...new Set(left.flatMap((x) => right.map((y) => combine(x, y))))];
    return { windows: merge(a.windows, b.windows), other: merge(a.other, b.other) };
  }
  function invert(value: Possibilities): Possibilities {
    const flip = (mask: number) => ((mask & FALSE) ? TRUE : 0) | ((mask & TRUE) ? FALSE : 0);
    return { windows: value.windows.map(flip), other: value.other.map(flip) };
  }
  function platformComparison(target: string, equal: boolean): Possibilities {
    return { windows: [(target === "win32") === equal ? TRUE : FALSE], other: [target === "win32" ? (equal ? FALSE : TRUE) : EITHER] };
  }
  function possibilities(input: Token[], seen = new Set<Token>()): Possibilities {
    input = resolved(input);
    if (input.length === 0) return UNKNOWN;
    for (const operator of ["||", "&&", "===", "!==", "==", "!="]) {
      for (let i = 0; i < input.length; i++) {
        const token = input[i]!;
        if (token.text !== operator) {
          const close = closes.get(token);
          if (close !== undefined) i = input.indexOf(tokens[close]!);
          continue;
        }
        const left = input.slice(0, i);
        const right = input.slice(i + 1);
        if (["&&", "||"].includes(operator)) return logic(possibilities(left, seen), possibilities(right, seen), operator === "&&");
        const literal = resolved(platform(left) ? right : left);
        if (platform(left) || platform(right)) {
          if (literal.length !== 1 || !/^["'][a-z0-9]+["']$/.test(literal[0]!.text)) return UNKNOWN;
          return platformComparison(literal[0]!.text.slice(1, -1), operator === "===" || operator === "==");
        }
        const constant = resolved(right);
        if ([resolved(left), constant].every((value) => value.length === 1 && /^["'][^"']*["']$/.test(value[0]!.text))) {
          const result = (resolved(left)[0]!.text.slice(1, -1) === constant[0]!.text.slice(1, -1)) === ["===", "=="].includes(operator) ? TRUE : FALSE;
          return { windows: [result], other: [result] };
        }
        if (constant.length === 1 && ["true", "false", "undefined", "null"].includes(constant[0]!.text)) {
          const value = possibilities(left, seen);
          return (operator === "===" || operator === "==") === (constant[0]!.text === "true") ? value : invert(value);
        }
        break;
      }
    }
    if (input[0]!.text === "!") return invert(possibilities(input.slice(1), seen));
    for (let i = 0; i < input.length; i++) {
      const token = input[i]!;
      const name = token.text;
      if (/^["']win32["']$/.test(name) || platform(input.slice(i, i + 3))) return UNKNOWN;
      const open = input[i + 1]?.text === "?." ? i + 2 : i + 1;
      if (name === "(" && [")", "]"].includes(input[i - 1]?.text ?? "")) return UNKNOWN;
      if (input[open]?.text === "(" && /^[\w$]+$/.test(name) && ![".", "?."].includes(input[i - 1]?.text ?? "") && name !== "Boolean") {
        const model = Object.hasOwn(HELPER_MODELS, name) ? HELPER_MODELS[name] : undefined;
        if (model) {
          const end = input.indexOf(tokens[closes.get(input[open]!)!]!);
          const comma = input.findIndex((token, j) => j > open && token.text === ",");
          const argument = resolved(input.slice(open + 1, comma < 0 ? end : comma));
          const fixed = model.equal && argument.length === 1 && /^["'][a-z0-9]+["']$/.test(argument[0]!.text);
          if (model.equal && argument.length && !fixed && argument[0]!.text !== "undefined" && !platform(argument)) return UNKNOWN;
          const mask = fixed && argument[0]!.text.slice(1, -1) === model.target ? TRUE : FALSE;
          const restriction = fixed ? { windows: [mask], other: [mask] } : platformComparison(model.target, model.equal);
          return i === 0 && end === input.length - 1 ? logic(restriction, FEATURE, false) : UNKNOWN;
        }
        if (!FEATURE_CALLS.has(name)) return UNKNOWN;
        i = input.indexOf(tokens[closes.get(input[open]!)!]!);
      } else if (![".", "?."].includes(input[i - 1]?.text ?? "") && binding(token) && !seen.has(token)) {
        const value = possibilities(binding(token)!, new Set([...seen, token]));
        if ([...value.windows, ...value.other].some((mask) => mask !== EITHER)) return UNKNOWN;
      }
    }
    return FEATURE;
  }
  const gates: Gate[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const gate = tokens[i]!;
    if (!["runIf", "skipIf"].includes(gate.text) || tokens[i - 1]?.text !== "." || tokens[i + 1]?.text !== "(") continue;
    let receiver = i - 2;
    while (true) {
      const open = opens.get(receiver);
      if (open === undefined && tokens[receiver - 1]?.text !== ".") break;
      receiver = open === undefined ? receiver - 2 : open - 1;
    }
    if (!["it", "test", "describe", "suite"].includes(tokens[receiver]?.text ?? "")) continue;
    const end = closes.get(tokens[i + 1]!);
    const argument = source.slice(tokens[i + 1]!.end, end === undefined ? source.length : tokens[end]!.start);
    const value = end === undefined ? UNKNOWN : possibilities(tokens.slice(i + 2, end));
    // Features have both outcomes on every host; unknowns may have any outcome set per host. Fail only if those sets change the Windows-only verdict.
    const runs = gate.text === "runIf" ? TRUE : FALSE;
    const verdicts = new Set(value.windows.flatMap((windows) => value.other.map((other) => !(other & runs) && Boolean(windows & runs))));
    gates.push({ line: source.slice(0, gate.start).split("\n").length, argument, classification: verdicts.size > 1 ? "unclassifiable" : verdicts.has(true) ? "win32-only" : "not-win32-only" });
  }
  return gates;
}
import { createScanner } from "typescript/unstable/ast/scanner";
