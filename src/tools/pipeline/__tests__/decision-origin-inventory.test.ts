// A permission row's trust origin records who decided, not when the row is written. The host's own refusal at the quit seal carries
// "unknown", or the host's provenance, in the object that names it, and no origin is read off the seal or an abort, so a person's earlier answer is never
// relabeled. Checked on the compiler's syntax tree of every source file that mentions either.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript/unstable/ast";
import { describe, expect, it } from "vitest";

import { parseSourceFiles, parseSourceTexts } from "../../../../scripts/lib/ts7-ast.mjs";

const SRC = fileURLToPath(new URL("../../../", import.meta.url));
type Node = ts.Node;

/** Names that read the seal or an abort: an origin computed from them is inferred from when the row is written. */
const SEAL_STATE = new Set(["isHostExitAbort", "hostShutdown", "toolInvocationsSealed", "aborted"]);

const strip = (node: Node): Node => {
  let current = node;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current)) current = current.expression;
  return current;
};
const keyOf = (node: Node): string | undefined => {
  if (!ts.isPropertyAssignment(node)) return undefined;
  const name = node.name;
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;
};
const trustOriginOf = (object: Node): Node | undefined => {
  if (!ts.isObjectLiteralExpression(object)) return undefined;
  const property = object.properties.find((member) => keyOf(member) === "trustOrigin" || keyOf(member) === "provenance");
  return property && ts.isPropertyAssignment(property) ? property.initializer : undefined;
};
const isHostOrigin = (origin: Node): boolean =>
  ts.isStringLiteral(origin) && origin.text === "unknown" || ts.isIdentifier(origin) && origin.text === "HOST_PROVENANCE";
const readsSealState = (node: Node): boolean => {
  let found = false;
  const visit = (current: Node) => {
    if (ts.isIdentifier(current) && SEAL_STATE.has(current.text)) found = true;
    current.forEachChild(visit);
  };
  visit(node);
  return found;
};

/** Each finding is a host-shutdown deny reason without the host's origin beside it, or an origin computed from the seal. */
function findings(source: Node): string[] {
  const out: string[] = [];
  const visit = (node: Node, ancestors: Node[]) => {
    if (keyOf(node) === "trustOrigin" && ts.isPropertyAssignment(node) && readsSealState(node.initializer)) {
      out.push("an origin read off the seal or an abort");
    }
    if (ts.isStringLiteral(node) && node.text === "host-shutdown") {
      // A deny reason: the value of a `reason` key, directly or as one branch of a choice.
      const index = ancestors.findLastIndex((ancestor) =>
        !ts.isConditionalExpression(ancestor) && !ts.isParenthesizedExpression(ancestor) && !ts.isBinaryExpression(ancestor));
      const holder = ancestors[index];
      if (holder !== undefined && keyOf(holder) === "reason") {
        const owner = ancestors.slice(0, index).reverse().find((ancestor) => trustOriginOf(ancestor) !== undefined);
        const origin = owner && trustOriginOf(owner);
        const literal = origin && strip(origin);
        if (!(literal && isHostOrigin(literal))) {
          out.push("a host-shutdown deny without the host's origin");
        }
      }
    }
    const next = [...ancestors, node];
    node.forEachChild((child) => visit(child, next));
  };
  visit(source, []);
  return out;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : sourceFiles(path);
    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name) || entry.name.endsWith(".d.ts")) return [];
    const text = readFileSync(path, "utf8");
    return text.includes("\"host-shutdown\"") || text.includes("trustOrigin") ? [path] : [];
  });
}

const findingsOfText = (text: string): string[] => {
  const source = parseSourceTexts(new Map([["fixture.ts", text]])).get("fixture.ts");
  if (source === undefined) throw new Error("fixture did not parse");
  return findings(source as unknown as Node);
};

describe("permission rows record who decided", () => {
  it.each([
    ["a shutdown deny with no origin of its own", `declare const shut: boolean; const p = { decision: "deny", reason: shut ? "host-shutdown" : "user aborted turn" };`],
    ["a shutdown deny keeping the invocation origin", `declare const o: string; const row = { trustOrigin: o, denyReasons: [{ reason: "host-shutdown", source: "x" }] };`],
    ["a shutdown deny under the policy's provenance", `declare const RULE_PROVENANCE: object; const p = { decision: "deny", reason: "host-shutdown", provenance: RULE_PROVENANCE };`],
    ["an origin chosen by the seal", `declare const hostShutdown: boolean; const row = { trustOrigin: hostShutdown ? "unknown" : "user-keyboard" };`],
    ["an origin chosen by an abort", `declare const signal: AbortSignal; const row = { trustOrigin: signal.aborted ? "unknown" : "user-keyboard" };`],
  ])("flags %s", (_name, text) => {
    expect(findingsOfText(text)).toHaveLength(1);
  });

  it.each([
    ["the host's shutdown deny", `const p = { decision: "deny", reason: "host-shutdown", trustOrigin: "unknown" };`],
    ["the host's shutdown deny by provenance", `declare const HOST_PROVENANCE: object; const p = { decision: "deny", reason: "host-shutdown", provenance: HOST_PROVENANCE };`],
    ["a row whose deny reason sits under the host's origin", `declare const base: object; const row = { ...base, denyReasons: [{ reason: "host-shutdown", source: "x" }], trustOrigin: "unknown" as const };`],
    ["a termination reason, which is no decision", `declare function audit(reason: string): void; audit("host-shutdown");`],
  ])("accepts %s", (_name, text) => {
    expect(findingsOfText(text)).toEqual([]);
  });

  it("holds for every source file", () => {
    const files = sourceFiles(SRC);
    const parsed = parseSourceFiles(files);
    // Every file must parse: an unparsed file would hide its rows.
    expect(files.filter((file) => !parsed.has(file))).toEqual([]);
    const offending = files.flatMap((file) =>
      findings(parsed.get(file) as unknown as Node).map((finding) => `${relative(SRC, file).split(sep).join("/")}: ${finding}`));
    expect(offending).toEqual([]);
  });
});
