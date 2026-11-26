import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript/unstable/ast";
import { parseSourceTexts } from "../../../scripts/lib/ts7-ast.mjs";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../..", import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__tests__" || name === "node_modules" ? [] : sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.(test|d)\.tsx?$/.test(name) ? [path] : [];
  });
}

function nameOf(node: ts.Node): string | undefined {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) return node.name?.getText();
  if (ts.isVariableDeclaration(node) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) return node.name.getText();
  if (ts.isPropertyAssignment(node) && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) return node.name.getText();
  return undefined;
}

describe("authority from a person's answer", () => {
  // The epoch form judges no fresh check while the policy stands still and honors no same-card receipt. It is left to cards
  // that grant no shell, terminal or effect authority; a new caller fails here.
  it("leaves the epoch form only to cards without shell, terminal or effect authority", () => {
    const legacy: string[] = [];
    for (const path of sourceFiles(SRC)) {
      const text = readFileSync(path, "utf8");
      if (!text.includes("personAnswerStands(")) continue;
      const file = relative(SRC, path).split("\\").join("/");
      const source = parseSourceTexts(new Map([[file, text]])).get(file) as ts.SourceFile | undefined;
      if (!source) throw new Error(`${file} did not parse`);
      const visit = (node: ts.Node, owner: string): void => {
        const here = nameOf(node) ?? owner;
        if (ts.isCallExpression(node) && node.expression.getText() === "personAnswerStands" && node.arguments.length === 4) legacy.push(`${file}#${here}`);
        node.forEachChild((child) => visit(child, here));
      };
      visit(source, "<module>");
    }
    expect(legacy.sort()).toEqual([
      "permissions/egress-approval.ts#createApprovalGateEgressRequester",
      // The write fence: it judges the check it has just run.
      "permissions/host-terminal-write-authority.ts#refusal",
      "tools/invocation-execution.ts#authorizeBrowserSite",
      "tools/invocation-execution.ts#authorizeBrowserSite",
      "tools/invocation-execution.ts#authorizeBrowserSite",
      "tools/invocation-execution.ts#lateApprovalStands",
    ]);
  });
});
