/** How a template run comes to end, read off the syntax of the non-test source (work-board-run-ending.md): one
 * classifier, which every consumer reads through the store. */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript/unstable/ast";
import { expect, it, vi } from "vitest";
import { boardRunState, type RunRecord } from "../run-state.js";
import type { RunClass } from "../../../main/run-classification.js";
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
  return (ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isElementAccessExpression(callee) && ts.isStringLiteral(callee.argumentExpression) ? callee.argumentExpression.text : undefined) === name;
});
const ENGINE = "work-board/workflow/stage-run-engine.ts";
const RUN_STATE = "work-board/workflow/run-state.ts";
const STORE = "main/work-board-store.ts";
const inFile = (file: string, found: string[]): string[] => found.filter(entry => entry.startsWith(`${file}#`)).map(entry => entry.slice(file.length + 1));

it("classifies a run in one place, which every consumer reads through the store", () => {
  expect(callsOf("classifyRun")).toEqual([`${STORE}#classOn`]);
  expect(callsOf("classOn")).toEqual([`${STORE}#WorkBoardStore>classified>classOf`, `${STORE}#WorkBoardStore>settleRemovedRun`]);
  expect(callsOf("classified")).toEqual([`${STORE}#WorkBoardStore>deleteIntentsOnDisk`, `${STORE}#WorkBoardStore>runClasses`]);
  expect(callsOf("runClasses")).toEqual([`${RUN_STATE}#boardRunState>adoption`, `${RUN_STATE}#boardRunState>classes`]);
  expect(callsOf("deleteIntentsOnDisk")).toEqual([`${STORE}#WorkBoardStore>deletedRuns`, `${RUN_STATE}#boardRunState>deleted`]);
  // No consumer reads where a row stands to decide a run's end.
  expect(callsOf("runRowsOnDisk")).toEqual([]);
  expect(sources.has(ENGINE) && sources.has(RUN_STATE)).toBe(true);
  expect(find(file => file === ENGINE || file === RUN_STATE, node => ts.isStringLiteral(node) && ["gone", "moved", "unnamed"].includes(node.text))).toEqual([]);
});

it("writes how a run ended only in the run store's one settle write, which the store reaches with a cause it checks", () => {
  const runModules = (_: string, text: string): boolean => text.includes("RunRecord");
  const named = (node: ts.Node): boolean => {
    const name = ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node) ? node.name : undefined;
    return name !== undefined && (ts.isIdentifier(name) || ts.isStringLiteral(name)) && name.text === "settled";
  };
  expect(find(runModules, node => ts.isPropertyAssignment(node) && named(node))).toEqual(["main/workflow-run-store.ts#WorkflowRunStore>write"]);
  // A copy of the stored value, never a new one: retention refuses any change of it.
  expect(find(runModules, node => ts.isShorthandPropertyAssignment(node) && named(node))).toEqual([`${STORE}#runSummary`, "main/workflow-run-store.ts#WorkflowRunStore>get"]);
  expect(find(runModules, node => (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken || ts.isDeleteExpression(node))
    && /\.settled\b/.test((ts.isBinaryExpression(node) ? node.left : node.expression).getText()))).toEqual([]);
  expect(callsOf("settleRun")).toEqual([`${STORE}#WorkBoardStore>settleRemovedRun`, `${STORE}#WorkBoardStore>settleUnstarted`, `${STORE}#WorkBoardStore>updateRun`]);
  expect(inFile(RUN_STATE, callsOf("settleRemovedRun"))).toEqual(["boardRunState>update"]);
});

it("ends a run with its row removed only from its class or a due intent", () => {
  expect(inFile(ENGINE, callsOf("classes")).sort()).toEqual(["createStageRunEngine>checkRows", "createStageRunEngine>confirmSettles", "createStageRunEngine>writeRun"]);
  expect(inFile(ENGINE, callsOf("deleted"))).toEqual(["createStageRunEngine>takeOverIntents"]);
  expect(inFile(ENGINE, callsOf("adoption"))).toEqual(["createStageRunEngine>adoptRuns"]);
  expect(inFile(ENGINE, callsOf("rowRemoved"))).toEqual(["createStageRunEngine>byClass", "createStageRunEngine>byClass", "createStageRunEngine>removedHeld", "createStageRunEngine>takeOverDeleted"]);
  expect(inFile(ENGINE, callsOf("byClass"))).toEqual(["createStageRunEngine>checkRows", "createStageRunEngine>writeRun"]);
  expect(inFile(ENGINE, callsOf("removedHeld"))).toEqual(["createStageRunEngine>takeOverDeleted", "createStageRunEngine>takeOverIntents"]);
});

it("never adopts an unsettled named candidate without classifying it", async () => {
  const classes: RunClass[] = ["live", "waiting-delete", "unreadable", "due-delete", "orphan", "lost"];
  const runs = classes.map((_, itemId) => ({ itemId, runId: String(itemId) }) as RunRecord);
  const classified = vi.fn((run: RunRecord) => classes[run.itemId]);
  const store = {
    runs: { list: async () => ({ status: "found", runs }), view: async () => ({ keepWorkspaces: runs.map(run => run.runId) }) },
    list: async () => ({ status: "ok", items: runs.map(run => ({ id: run.itemId, runId: run.runId, templateId: "template" })) }),
    runClasses: async () => classified,
  } as unknown as Parameters<typeof boardRunState>[0];
  const adoption = await boardRunState(store).adoption();
  expect(classified.mock.calls.map(([run]) => run.runId)).toEqual(runs.map(run => run.runId));
  expect(adoption.ok).toBe(true);
  if (!adoption.ok) throw new Error("Adoption refused");
  expect(adoption.named.flatMap(entry => entry.run ? [entry.run.runId] : [])).toEqual(["0"]);
  expect(adoption.kept.map(run => run.runId)).toEqual(["1", "2"]);
  expect(adoption.removed.map(run => run.runId)).toEqual(["3"]);
  expect(adoption.orphans.map(run => run.runId)).toEqual(["4"]);
  expect(adoption.lost.map(run => run.runId)).toEqual(["5"]);
});
