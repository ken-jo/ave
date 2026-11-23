import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript/unstable/ast";
import { expect, it } from "vitest";
import { parseSourceTexts } from "../../../scripts/lib/ts7-ast.mjs";

const SRC = fileURLToPath(new URL("../../", import.meta.url));

function calleeName(call: ts.CallExpression): string | undefined {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return undefined;
}

function timerHelperName(call: ts.CallExpression): string | undefined {
  for (let node = call.parent; node; node = node.parent) {
    if (ts.isFunctionDeclaration(node)) return node.name?.text;
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      const parent = node.parent;
      if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
    }
  }
  return undefined;
}

function pollingLines(source: ts.SourceFile): number[] {
  const timerHelpers = new Set<string>();
  const loopCalls: ts.CallExpression[] = [];
  function visit(node: ts.Node, inLoop = false): void {
    if (ts.isCallExpression(node)) {
      if (inLoop) loopCalls.push(node);
      if (calleeName(node) === "setTimeout") {
        const helper = timerHelperName(node);
        if (helper !== undefined) timerHelpers.add(helper);
      }
    }
    const inside = inLoop || ts.isForStatement(node) || ts.isForInStatement(node) ||
      ts.isForOfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node);
    node.forEachChild(child => visit(child, inside));
  }
  visit(source);
  return loopCalls.filter(call => {
    if (calleeName(call) === "setTimeout") return true;
    return call.parent !== undefined && ts.isAwaitExpression(call.parent) &&
      ts.isIdentifier(call.expression) && timerHelpers.has(call.expression.text);
  }).map(call => source.getLineAndCharacterOfPosition(call.getStart(source)).line + 1);
}

it("waits for work-board changes without polling timers", () => {
  const workBoardFiles = readdirSync(join(SRC, "work-board"), { recursive: true, encoding: "utf8" })
    .map(path => path.replaceAll("\\", "/"))
    .filter(path => /(?:^|\/)__tests__\/.*\.[cm]?[jt]sx?$/.test(path))
    .map(path => `work-board/${path}`);
  const coreFiles = readdirSync(join(SRC, "core", "__tests__"))
    .filter(path => /^work-board-.*\.test\.ts$/.test(path))
    .map(path => `core/__tests__/${path}`);
  const sources = new Map([...workBoardFiles, ...coreFiles].sort()
    .map(path => [path, readFileSync(join(SRC, path), "utf8")] as const)
    .filter(([, text]) => text.includes("setTimeout")));
  const parsed = parseSourceTexts(sources);
  expect([...parsed.keys()]).toEqual([...sources.keys()]);
  const polling = [...parsed].flatMap(([path, source]) =>
    pollingLines(source as ts.SourceFile).map(line => `src/${path}:${line}`));
  expect(polling, "Use a signal or an observed promise to wait for work-board changes").toEqual([]);
});
