import { ShellAnalysisError, parseShellSyntax, type ShellSyntaxNode, type ShellParserLimits } from "./shell-parser.js";

export interface ShellSpan { start: number; end: number; raw: string }
export type ShellWordPart =
  | { kind: "literal"; value: string }
  | { kind: "unicode-escaped"; value: string }
  | { kind: "parameter"; name: string; quoted: boolean; index?: number | "@" }
  | { kind: "parameter-choice"; name: string; operator: "-" | ":-" | "+" | ":+"; operand: ShellWord; quoted: boolean }
  | { kind: "arithmetic-data"; variables: readonly string[] }
  | { kind: "pattern"; value: string }
  | { kind: "substitution"; body: ShellStatement; process: boolean; backquotes: boolean; quoted: boolean }
  | { kind: "unknown"; reason: string };
export interface ShellWord { source: ShellSpan; parts: readonly ShellWordPart[]; preservesEmpty: boolean }
export interface ShellAssignment { name: string; value: ShellWord; elements?: readonly ShellWord[]; append: boolean; declarationOnly?: boolean; source: ShellSpan }
export interface ShellRedirect {
  source: ShellSpan;
  effect: "read" | "write";
  target?: ShellWord;
  data?: ShellWord;
  descriptor: boolean;
  heredocQuoted?: boolean;
  literalDataBytes?: number;
}
export interface ShellCommand {
  kind: "command";
  source: ShellSpan;
  words: readonly ShellWord[];
  assignments: readonly ShellAssignment[];
  assignmentScope: "current" | "command";
  redirects: readonly ShellRedirect[];
  /** Preserves the semantic origin when Bash `[[ ... ]]` lowers to a command. */
  testForm?: "double-bracket";
}
export type ShellStatement =
  | ShellCommand
  | { kind: "sequence"; source: ShellSpan; statements: readonly ShellStatement[] }
  | { kind: "and" | "or"; source: ShellSpan; left: ShellStatement; right: ShellStatement }
  | { kind: "subshell" | "background" | "negate"; source: ShellSpan; body: ShellStatement }
  | { kind: "redirected"; source: ShellSpan; body: ShellStatement; redirects: readonly ShellRedirect[] }
  | { kind: "pipeline"; source: ShellSpan; statements: readonly ShellStatement[] }
  | { kind: "for"; source: ShellSpan; name: string; values: readonly ShellWord[] | null; body: ShellStatement }
  | { kind: "if"; source: ShellSpan; condition: ShellStatement; consequent: ShellStatement; alternate: ShellStatement }
  | { kind: "while"; source: ShellSpan; condition: ShellStatement; body: ShellStatement; until: boolean }
  | { kind: "function"; source: ShellSpan; name: string; body: ShellStatement }
  | { kind: "unsupported"; source: ShellSpan; reason: string };

export type ShellAnalysis = { ok: true; program: ShellStatement; totalTokens?: number } | { ok: false; reason: string };

export function literalWord(value: string, source: ShellSpan): ShellWord {
  return { source, parts: [{ kind: "literal", value }], preservesEmpty: true };
}
export function staticShellWord(word: ShellWord): string | undefined {
  return word.parts.every((part) => part.kind === "literal") ? word.parts.map((part) => part.kind === "literal" ? part.value : "").join("") : undefined;
}
export function displayShellWord(word: ShellWord): string {
  if (word.parts.some((part) => part.kind === "unknown" || part.kind === "substitution" || part.kind === "unicode-escaped" || part.kind === "parameter-choice" || part.kind === "arithmetic-data")) return word.source.raw;
  return word.parts.map((part) => part.kind === "literal" || part.kind === "pattern" ? part.value : part.kind === "parameter" ? `$${part.name}` : "").join("");
}

/** Keep single-argv-slot proof with the word AST so policies cannot invent conflicting quote or field-splitting rules. */
export function shellWordHasSingleField(word: ShellWord): boolean {
  return word.parts.every((part) => {
    if (part.kind === "literal" || part.kind === "unicode-escaped" || part.kind === "arithmetic-data") return true;
    if (part.kind === "parameter") return part.quoted && part.index !== "@" && part.name !== "@";
    if (part.kind === "substitution") return part.quoted && !part.process;
    if (part.kind === "parameter-choice") return part.quoted && shellWordHasSingleField(part.operand);
    return false;
  });
}
type LoweredWordPart = ShellWordPart | { kind: "unquoted-bracket"; value: "[" | "]" };

function classifyBracketParts(parts: readonly LoweredWordPart[]): ShellWordPart[] {
  // Pair brackets across the whole word; quoted members do not hide expansions, and only unmatched unquoted openings are literal.
  const lastCloser = parts.findLastIndex((part) => part.kind === "unquoted-bracket" && part.value === "]");
  return parts.map((part, index) => part.kind === "unquoted-bracket"
    ? { kind: part.value === "[" && index < lastCloser ? "pattern" : "literal", value: part.value }
    : part);
}

function decodeLiteral(text: string, context: WordContext): LoweredWordPart[] {
  const parts: LoweredWordPart[] = [];
  let value = "";
  const flush = (): void => { if (value) parts.push({ kind: "literal", value }); value = ""; };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === "\\" && index + 1 < text.length) {
      const next = text[index + 1]!;
      const escaped = context === "unquoted" || context === "assignment"
        || (context === "heredoc" ? "$`\\\n" : "$`\"\\\n").includes(next);
      if (escaped) { if (next !== "\n") value += next; index += 1; continue; }
    }
    if (context === "unquoted" && "*?".includes(char)) { flush(); parts.push({ kind: "pattern", value: char }); }
    else if (context === "unquoted" && (char === "[" || char === "]")) { flush(); parts.push({ kind: "unquoted-bracket", value: char }); }
    else value += char;
  }
  flush();
  return parts.length ? parts : [{ kind: "literal", value: "" }];
}

interface ShellSource { text: string; bytes: Buffer; offsets: ReadonlyMap<number, number>; literalHeredocs: ReadonlyMap<number, readonly number[]>; dialect: "bash" | "posix"; braceWords: ReadonlySet<string>; escapedStrings: Readonly<Record<string, string>> }
function object(value: unknown): ShellSyntaxNode {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Missing typed shell syntax node");
  return value as ShellSyntaxNode;
}
function children(node: ShellSyntaxNode, key: string): ShellSyntaxNode[] {
  const value = node[key];
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`Invalid shell syntax collection: ${key}`);
  return value.map(object);
}
function child(node: ShellSyntaxNode, key: string): ShellSyntaxNode { return object(node[key]); }
function value(node: ShellSyntaxNode, key: string): string {
  const result = node[key];
  if (typeof result !== "string") throw new Error(`Invalid shell syntax string: ${key}`);
  return result;
}
function span(node: ShellSyntaxNode, source: ShellSource): ShellSpan {
  const start = node.Pos?.Offset ?? 0;
  const end = node.End?.Offset ?? start;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > source.bytes.length) throw new Error("Invalid shell syntax source span");
  const from = source.offsets.get(start), to = source.offsets.get(end);
  if (from === undefined || to === undefined) throw new Error("Invalid shell syntax text span");
  return { start, end, raw: source.text.slice(from, to) };
}
function unsupported(node: ShellSyntaxNode, source: ShellSource): ShellStatement {
  return { kind: "unsupported", source: span(node, source), reason: `Unsupported shell syntax: ${node.Type ?? "statement"}` };
}
export function analyzeShell(command: string, dialect: "bash" | "posix" = "bash", workLimits?: ShellParserLimits): ShellAnalysis {
  try {
    const file = parseShellSyntax(command, workLimits);
    const braceWords = file.BraceWords;
    if (!Array.isArray(braceWords) || braceWords.some((range) => !Array.isArray(range)
      || range.length !== 2 || !range.every((offset) => Number.isSafeInteger(offset)))) throw new Error("Invalid shell brace annotations");
    const escapedStrings = file.EscapedStrings;
    if (!escapedStrings || typeof escapedStrings !== "object" || Array.isArray(escapedStrings)
      || Object.values(escapedStrings).some((item) => typeof item !== "string")) throw new Error("Invalid shell string annotations");
    const literalHeredocs = new Map((file.LiteralHeredocs as readonly (readonly number[])[]).map((range) => [range[0]!, range]));
    const offsets = sourceOffsets(command, [...literalHeredocs.values()]);
    const source = { text: command, bytes: Buffer.from(command, "utf8"), offsets, literalHeredocs, dialect, braceWords: new Set(braceWords.map((range) => `${range[0]}:${range[1]}`)), escapedStrings: escapedStrings as Record<string, string> };
    return { ok: true, program: sequence(children(file, "Stmts"), source, { start: 0, end: source.bytes.length, raw: command }), totalTokens: file.TotalTokens as number };
  } catch (error) {
    if (error instanceof ShellAnalysisError) return { ok: false, reason: error.message };
    throw error;
  }
}
// Convert positions only in executable text. Literal body widths come from the native terminator reader.
function sourceOffsets(text: string, bodies: readonly (readonly number[])[]): ReadonlyMap<number, number> {
  const ranges = bodies;
  const offsets = new Map<number, number>();
  let byte = 0, index = 0, body = 0;
  while (index < text.length) {
    offsets.set(byte, index);
    const range = ranges[body];
    if (range !== undefined && byte === range[0]) {
      if (index !== range[2]) throw new Error("Invalid shell literal data text position");
      byte = range[1]!; index = range[3]!; body += 1;
      continue;
    }
    const point = text.codePointAt(index)!;
    byte += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    index += point > 0xffff ? 2 : 1;
  }
  offsets.set(byte, index);
  return offsets;
}
function sequence(nodes: readonly ShellSyntaxNode[], source: ShellSource, location: ShellSpan): ShellStatement {
  return { kind: "sequence", source: location, statements: nodes.map((node) => lowerStatement(node, source)) };
}
function lowerStatement(node: ShellSyntaxNode, source: ShellSource): ShellStatement {
  const location = span(node, source);
  if (node.Coprocess) return unsupported(node, source);
  const raw = node.Cmd ? child(node, "Cmd") : undefined;
  let statement: ShellStatement = raw ? lowerCommandNode(raw, source) : { kind: "command", source: location, words: [], assignments: [], assignmentScope: "current", redirects: [] };
  const redirects = children(node, "Redirs");
  if (redirects.length > 0) {
    if (statement.kind === "command") {
      statement = { ...statement, source: location, redirects: redirects.map((redirect) => lowerRedirect(redirect, source)) };
    } else {
      // Inherited input needs descriptor and consumption provenance; support only fixed output descriptors until execution owns that proof.
      if (redirects.some((redirect) => ![">", ">>", ">|", ">&", "&>", "&>>"].includes(value(redirect, "Op"))
        || (redirect.N && !/^0*[1-9][0-9]*$/.test(value(child(redirect, "N"), "Value"))))) {
        return { kind: "unsupported", source: location, reason: "Unsupported compound input or dynamic descriptor redirection" };
      }
      statement = { kind: "redirected", source: location, body: statement, redirects: redirects.map((redirect) => lowerRedirect(redirect, source)) };
    }
  }
  if (node.Negated) statement = { kind: "negate", source: location, body: statement };
  if (node.Background) statement = { kind: "background", source: location, body: statement };
  return statement;
}
function lowerCommandNode(node: ShellSyntaxNode, source: ShellSource): ShellStatement {
  const location = span(node, source);
  switch (node.Type) {
    case "CallExpr":
      return { kind: "command", source: location, words: children(node, "Args").map((word) => lowerWord(word, source)),
        assignments: children(node, "Assigns").map((assignment) => lowerAssignment(assignment, source)),
        assignmentScope: children(node, "Args").length ? "command" : "current", redirects: [] };
    case "Block": return sequence(children(node, "Stmts"), source, location);
    case "Subshell": return { kind: "subshell", source: location, body: sequence(children(node, "Stmts"), source, location) };
    case "BinaryCmd": {
      const operator = value(node, "Op");
      if (operator === "|&" && source.dialect !== "bash") return unsupported(node, source);
      if (operator === "|" || operator === "|&") {
        const statements: ShellStatement[] = [];
        const pending = [child(node, "Y"), child(node, "X")];
        while (pending.length > 0) {
          const statement = pending.pop()!;
          const command = statement.Cmd ? child(statement, "Cmd") : undefined;
          const nestedOperator = command?.Type === "BinaryCmd" ? value(command, "Op") : undefined;
          const transparent = !statement.Negated && !statement.Background && !statement.Coprocess && children(statement, "Redirs").length === 0;
          if (transparent && command && (nestedOperator === "|" || (nestedOperator === "|&" && source.dialect === "bash"))) {
            pending.push(child(command, "Y"), child(command, "X"));
          } else {
            statements.push(lowerStatement(statement, source));
          }
        }
        return { kind: "pipeline", source: location, statements };
      }
      const left = lowerStatement(child(node, "X"), source);
      const right = lowerStatement(child(node, "Y"), source);
      if (operator === "&&" || operator === "||") return { kind: operator === "&&" ? "and" : "or", source: location, left, right };
      return unsupported(node, source);
    }
    case "ForClause": {
      const loop = child(node, "Loop");
      if (node.Select || loop.Type !== "WordIter") return unsupported(node, source);
      return { kind: "for", source: location, name: value(child(loop, "Name"), "Value"),
        values: loop.InPos ? children(loop, "Items").map((word) => lowerWord(word, source)) : null,
        body: sequence(children(node, "Do"), source, location) };
    }
    case "IfClause": return lowerConditional(node, source);
    case "WhileClause": return { kind: "while", source: location, until: node.Until === true,
      condition: sequence(children(node, "Cond"), source, location), body: sequence(children(node, "Do"), source, location) };
    case "FuncDecl":
      if (node.RsrvWord && source.dialect !== "bash") return unsupported(node, source);
      return { kind: "function", source: location, name: value(child(node, "Name"), "Value"), body: lowerStatement(child(node, "Body"), source) };
    case "DeclClause": {
      const variant = value(child(node, "Variant"), "Value");
      if (!["export", "readonly"].includes(variant)) return unsupported(node, source);
      const assignments = children(node, "Args");
      if (assignments.some((assignment) => !assignment.Name || (assignment.Naked && assignment.Value))) return unsupported(node, source);
      return { kind: "command", source: location, words: [literalWord(variant, location)],
        assignments: assignments.map((assignment) => assignment.Naked
          ? { name: value(child(assignment, "Name"), "Value"), value: literalWord("", span(assignment, source)), append: false, declarationOnly: true, source: span(assignment, source) }
          : lowerAssignment(assignment, source)), assignmentScope: "current", redirects: [] };
    }
    case "TestClause": {
      if (source.dialect !== "bash") return unsupported(node, source);
      const words: ShellWord[] = [literalWord("test", location)];
      const lowerTest = (part: ShellSyntaxNode): void => {
        switch (part.Type) {
          case "Word": words.push(lowerWord(part, source, "assignment")); return;
          case "UnaryTest": words.push(literalWord(value(part, "Op"), span(part, source))); lowerTest(child(part, "X")); return;
          case "BinaryTest": lowerTest(child(part, "X")); words.push(literalWord(value(part, "Op"), span(part, source))); lowerTest(child(part, "Y")); return;
          case "ParenTest": lowerTest(child(part, "X")); return;
          default: throw new ShellAnalysisError("Unsupported shell test expression");
        }
      };
      lowerTest(child(node, "X"));
      return { kind: "command", source: location, words, assignments: [], assignmentScope: "current", redirects: [], testForm: "double-bracket" };
    }
    case "TimeClause": return lowerStatement(child(node, "Stmt"), source);
    default: return unsupported(node, source);
  }
}
function lowerConditional(node: ShellSyntaxNode, source: ShellSource): ShellStatement {
  const location = span(node, source);
  if (!node.Cond) return sequence(children(node, "Then"), source, location);
  return { kind: "if", source: location, condition: sequence(children(node, "Cond"), source, location),
    consequent: sequence(children(node, "Then"), source, location),
    alternate: node.Else ? lowerConditional(child(node, "Else"), source) : sequence([], source, location) };
}
function lowerAssignment(node: ShellSyntaxNode, source: ShellSource): ShellAssignment {
  if (source.dialect !== "bash" && (node.Array || node.Append)) throw new ShellAnalysisError("Unsupported non-POSIX assignment");
  if (node.Index || node.Naked) throw new ShellAnalysisError("Unsupported indexed or attribute assignment");
  const elements = node.Array ? children(child(node, "Array"), "Elems").map((element) => {
    if (element.Index) throw new ShellAnalysisError("Unsupported indexed array assignment");
    return lowerWord(child(element, "Value"), source);
  }) : undefined;
  return { name: value(child(node, "Name"), "Value"), append: node.Append === true, source: span(node, source),
    ...(elements ? { elements } : {}),
    value: node.Value ? lowerWord(child(node, "Value"), source, "assignment") : literalWord("", span(node, source)) };
}
function lowerRedirect(node: ShellSyntaxNode, source: ShellSource): ShellRedirect {
  const location = span(node, source);
  const operator = value(node, "Op");
  const word = lowerWord(child(node, "Word"), source);
  if (operator === "<<" || operator === "<<-") {
    const quoted = children(child(node, "Word"), "Parts").some((part) => part.Type !== "Lit" || value(part, "Value").includes("\\"));
    const body = node.Hdoc ? child(node, "Hdoc") : undefined;
    const range = body ? source.literalHeredocs.get(body.Pos?.Offset ?? -1) : undefined;
    const data = range === undefined ? (body ? lowerWord(body, source, quoted ? "literal" : "heredoc") : literalWord("", location))
      : literalWord(source.text.slice(range[2], range[3]), { start: range[0]!, end: range[1]!, raw: source.text.slice(range[2], range[3]) });
    return { source: location, effect: "read", descriptor: false, heredocQuoted: quoted, data,
      ...(range ? { literalDataBytes: range[1]! - range[0]! } : {}) };
  }
  if (operator === "<<<") {
    if (source.dialect !== "bash") throw new ShellAnalysisError("Unsupported non-POSIX here-string");
    return { source: location, effect: "read", descriptor: false, data: word };
  }
  const target = staticShellWord(word);
  const descriptor = [">&", "<&"].includes(operator) && target !== undefined && /^(?:\d+-?|-)$/.test(target);
  if ([">&", "<&"].includes(operator) && target === undefined) throw new ShellAnalysisError("Unresolved descriptor redirect");
  return { source: location, effect: operator.startsWith("<") && operator !== "<>" ? "read" : "write",
    descriptor, ...(descriptor ? {} : { target: word }) };
}
type WordContext = "unquoted" | "double" | "assignment" | "heredoc" | "literal";
function lowerWord(node: ShellSyntaxNode, source: ShellSource, context: WordContext = "unquoted"): ShellWord {
  const location = span(node, source);
  if (context === "unquoted" && source.braceWords.has(`${location.start}:${location.end}`)) {
    return { source: location, parts: [{ kind: "unknown", reason: "Unsupported brace expansion" }], preservesEmpty: true };
  }
  const syntaxParts = children(node, "Parts");
  const parts = classifyBracketParts(syntaxParts.flatMap((part, index) => lowerWordPart(part, source, context, index === 0)));
  const preservesEmpty = context !== "unquoted" || syntaxParts.some((part) => part.Type === "SglQuoted" || part.Type === "DblQuoted");
  return { source: location, parts: parts.length ? parts : [{ kind: "literal", value: "" }], preservesEmpty };
}
function lowerWordPart(node: ShellSyntaxNode, source: ShellSource, context: WordContext, first: boolean): LoweredWordPart[] {
  switch (node.Type) {
    case "Lit": {
      const text = typeof node.Value === "string" ? node.Value : "";
      if (context === "literal") return [{ kind: "literal", value: text }];
      if (first && (context === "unquoted" || context === "assignment") && text.startsWith("~")) {
        if (text === "~" || text.startsWith("~/")) return [{ kind: "parameter", name: "HOME", quoted: true }, ...decodeLiteral(text.slice(1), context)];
        return [{ kind: "unknown", reason: "Unsupported named-home expansion" }];
      }
      return decodeLiteral(text, context);
    }
    case "SglQuoted": {
      if (!node.Dollar) return [{ kind: "literal", value: node.Value === undefined ? "" : value(node, "Value") }];
      if (source.dialect !== "bash") return [{ kind: "unknown", reason: "Escaped-string semantics are not established for the nested shell" }];
      const location = span(node, source);
      const cooked = source.escapedStrings[JSON.stringify([location.start, location.end])];
      if (cooked === undefined) return [{ kind: "unknown", reason: "Unsupported escaped-string bytes" }];
      // Unicode escapes depend on interpreter and locale; control escapes lack static-expander support, so both require native proof.
      const raw = node.Value === undefined ? "" : value(node, "Value");
      let unicode = false;
      for (let index = 0; index < raw.length; index += 1) {
        if (raw[index] !== "\\") continue;
        const escape = raw[++index];
        if (escape === "c") return [{ kind: "unknown", reason: "Unsupported control-character escape" }];
        if (escape === "u" || escape === "U") unicode = true;
      }
      return [{ kind: unicode ? "unicode-escaped" : "literal", value: cooked }];
    }
    case "DblQuoted":
      return node.Dollar ? [{ kind: "unknown", reason: "Unsupported localized-string expansion" }]
        : children(node, "Parts").flatMap((part) => lowerWordPart(part, source, "double", false));
    case "ParamExp": {
      const plain = !["Excl", "Length", "Width", "Slice", "Repl", "Names", "Exp"].some((key) => node[key]);
      const name = value(child(node, "Param"), "Value");
      let index: number | "@" | undefined;
      if (node.Index) {
        if (source.dialect !== "bash") return [{ kind: "unknown", reason: "Unsupported non-POSIX array expansion" }];
        const syntaxIndex = child(node, "Index");
        const raw = syntaxIndex.Type === "Word" ? staticShellWord(lowerWord(syntaxIndex, source, "assignment")) : undefined;
        if (raw === "@"){ index = "@"; }
        else if (raw !== undefined && /^(?:0|[1-9][0-9]*)$/.test(raw) && Number.isSafeInteger(Number(raw))) index = Number(raw);
        else return [{ kind: "unknown", reason: "Unsupported array index expansion" }];
      }
      if (node.Exp && !["Excl", "Length", "Width", "Slice", "Repl", "Names", "Index"].some((key) => node[key])) {
        const expansion = child(node, "Exp");
        const operator = value(expansion, "Op");
        if (operator === "-" || operator === ":-" || operator === "+" || operator === ":+") {
          return [{ kind: "parameter-choice", name, operator, quoted: context !== "unquoted",
            operand: expansion.Word ? lowerWord(child(expansion, "Word"), source, context) : literalWord("", span(node, source)) }];
        }
      }
      return plain ? [{ kind: "parameter", name, quoted: context !== "unquoted", ...(index !== undefined ? { index } : {}) }]
        : [{ kind: "unknown", reason: "Unsupported parameter expansion" }];
    }
    case "ArithmExp": {
      const variables = pureArithmeticVariables(child(node, "X"));
      return variables === undefined ? [{ kind: "unknown", reason: "Unsupported arithmetic effects" }]
        : [{ kind: "arithmetic-data", variables }];
    }
    case "CmdSubst": case "ProcSubst":
      if (node.Type === "ProcSubst" && source.dialect !== "bash") return [{ kind: "unknown", reason: "Unsupported non-POSIX process substitution" }];
      return [{ kind: "substitution", body: sequence(children(node, "Stmts"), source, span(node, source)), process: node.Type === "ProcSubst", backquotes: node.Backquotes === true, quoted: context !== "unquoted" }];
    default: return [{ kind: "unknown", reason: `Unsupported shell word: ${node.Type}` }];
  }
}

// Only the typed arithmetic tree proves writes or nested execution; its numeric result grants no path authority.
function pureArithmeticVariables(node: ShellSyntaxNode): string[] | undefined {
  switch (node.Type) {
    case "Word": {
      const parts = children(node, "Parts");
      if (parts.some((part) => part.Type !== "Lit")) return undefined;
      const text = parts.map((part) => value(part, "Value")).join("");
      if (/^[0-9]+$/.test(text)) return [];
      return /^[A-Za-z_][A-Za-z0-9_]*$/.test(text) ? [text] : undefined;
    }
    case "UnaryArithm":
      if (node.Post || !["+", "-", "!", "~"].includes(value(node, "Op"))) return undefined;
      return pureArithmeticVariables(child(node, "X"));
    case "BinaryArithm": {
      if (!["+", "-", "*", "/", "%", "**", "<<", ">>", "<", ">", "<=", ">=", "==", "!=", "&", "^", "|", "&&", "||", "?", ":", ","].includes(value(node, "Op"))) return undefined;
      const left = pureArithmeticVariables(child(node, "X")), right = pureArithmeticVariables(child(node, "Y"));
      return left && right ? [...left, ...right] : undefined;
    }
    case "ParenArithm": return pureArithmeticVariables(child(node, "X"));
    default: return undefined;
  }
}
