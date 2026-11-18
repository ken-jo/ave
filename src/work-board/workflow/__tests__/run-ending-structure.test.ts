/** How a template run comes to end, read off the syntax of the non-test source (work-board-run-ending.md): one
 * classifier, which every consumer reads through the store. */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript/unstable/ast";
import { expect, it } from "vitest";
import { parseSourceTexts } from "../../../../scripts/lib/ts7-ast.mjs";

const SRC = fileURLToPath(new URL("../../../", import.meta.url));
const sources = new Map(readdirSync(SRC, { recursive: true, encoding: "utf8" })
  .filter(path => /\.tsx?$/.test(path) && !/__tests__|\.test\.tsx?$/.test(path))
  .map(path => [path.replaceAll("\\", "/"), readFileSync(join(SRC, path), "utf8")] as const));

const isFunction = (node: ts.Node | undefined): boolean => node !== undefined && (ts.isArrowFunction(node) || ts.isFunctionExpression(node));

/** The named class, function, method or function-valued property or variable a node sits in, outermost first. */
function ownerOf(node: ts.Node): string {
  const names: string[] = [];
  for (let at = node.parent; at; at = at.parent) {
    if ((ts.isClassDeclaration(at) || ts.isFunctionDeclaration(at) || ts.isMethodDeclaration(at)) && at.name) names.unshift(at.name.getText());
    else if ((ts.isPropertyAssignment(at) || ts.isVariableDeclaration(at)) && isFunction(at.initializer)) names.unshift(at.name.getText());
  }
  return names.join(">");
}

/** Every node that `pick` matches in the non-test files `where` takes, as "file#owner". */
function find(where: (file: string, text: string) => boolean, pick: (node: ts.Node) => boolean): string[] {
  const files = new Map([...sources].filter(([file, text]) => where(file, text)));
  const parsed = parseSourceTexts(files);
  expect([...parsed.keys()].sort()).toEqual([...files.keys()].sort());
  const found: string[] = [];
  for (const [file, syntax] of parsed) {
    const visit = (node: ts.Node): void => {
      if (pick(node)) found.push(`${file}#${ownerOf(node)}`);
      node.forEachChild(visit);
    };
    visit(syntax as ts.SourceFile);
  }
  return found.sort();
}

/** Every call of `name`, as `name(...)` or `x.name(...)`. */
const callsOf = (name: string): string[] => find((_, text) => text.includes(name), (node) => {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  return (ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined) === name;
});
const ENGINE = "work-board/workflow/stage-run-engine.ts";
const RUN_STATE = "work-board/workflow/run-state.ts";
const STORE = "main/work-board-store.ts";
const inFile = (file: string, found: string[]): string[] => found.filter(entry => entry.startsWith(`${file}#`)).map(entry => entry.slice(file.length + 1));

it("classifies a run in one place, which every consumer reads through the store", () => {
  expect(callsOf("classifyRun")).toEqual([`${STORE}#WorkBoardStore>classified>classOf`]);
  expect(callsOf("classified")).toEqual([`${STORE}#WorkBoardStore>deleteIntentsOnDisk`, `${STORE}#WorkBoardStore>runClasses`]);
  expect(callsOf("runClasses")).toEqual([`${RUN_STATE}#boardRunState>adoption`, `${RUN_STATE}#boardRunState>classes`]);
  expect(callsOf("deleteIntentsOnDisk")).toEqual([`${STORE}#WorkBoardStore>deletedRuns`, `${RUN_STATE}#boardRunState>deleted`]);
  // No consumer reads where a row stands to decide a run's end.
  expect(callsOf("runRowsOnDisk")).toEqual([]);
  expect(sources.has(ENGINE) && sources.has(RUN_STATE)).toBe(true);
  expect(find(file => file === ENGINE || file === RUN_STATE, node => ts.isStringLiteral(node) && ["gone", "moved", "unnamed"].includes(node.text))).toEqual([]);
});

it("ends a run with its row removed only from its class or a due intent", () => {
  expect(inFile(ENGINE, callsOf("classes")).sort()).toEqual(["createStageRunEngine>checkRows", "createStageRunEngine>writeRun"]);
  expect(inFile(ENGINE, callsOf("deleted"))).toEqual(["createStageRunEngine>takeOverIntents"]);
  expect(inFile(ENGINE, callsOf("adoption"))).toEqual(["createStageRunEngine>adoptRuns"]);
  expect(inFile(ENGINE, callsOf("rowRemoved"))).toEqual(["createStageRunEngine>byClass", "createStageRunEngine>removedHeld", "createStageRunEngine>takeOverDeleted"]);
  expect(inFile(ENGINE, callsOf("byClass"))).toEqual(["createStageRunEngine>checkRows", "createStageRunEngine>writeRun"]);
  expect(inFile(ENGINE, callsOf("removedHeld"))).toEqual(["createStageRunEngine>takeOverDeleted", "createStageRunEngine>takeOverIntents"]);
});
