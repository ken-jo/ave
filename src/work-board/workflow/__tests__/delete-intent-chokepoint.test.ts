/** Where a template run can end from a user's delete of its row, read off the source: delete intents are read in one place, which alone
 * applies the store's one rule (deleteLanded), and only rowRemoved marks a run as ended with its row removed. */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../../../", import.meta.url));
const read = (path: string): string => readFileSync(join(SRC, path), "utf8");
const count = (text: string, pattern: RegExp): number => text.match(pattern)?.length ?? 0;
const sources = readdirSync(SRC, { recursive: true, encoding: "utf8" })
  .filter(path => /\.tsx?$/.test(path) && !/__tests__|\.test\.tsx?$/.test(path))
  .map(path => ({ path: path.replaceAll("\\", "/"), text: read(path) }));
const calling = (pattern: RegExp): Record<string, number> =>
  Object.fromEntries(sources.flatMap(({ path, text }) => count(text, pattern) > 0 ? [[path, count(text, pattern)]] : []));

it("reads the run file's delete intents only in the store, through the one rule", () => {
  expect(calling(/\.deleteIntents\(/g)).toEqual({ "main/work-board-store.ts": 1 });
  expect(calling(/\bdeleteLanded\(/g)).toEqual({ "main/work-board-store.ts": 2 });
  const store = read("main/work-board-store.ts");
  const split = store.slice(store.indexOf("async deleteIntentsOnDisk("), store.indexOf("async deletedRuns("));
  expect([count(split, /\.deleteIntents\(/g), count(split, /\bdeleteLanded\(/g)]).toEqual([1, 1]);
  expect(calling(/\.(deleteIntentsOnDisk|deletedRuns)\(/g)).toEqual({ "main/work-board-store.ts": 1, "work-board/workflow/run-state.ts": 2 });
});

it("ends a run with its row removed only through rowRemoved: from the board on disk, a row-gone write, or the due intents", () => {
  const engine = read("work-board/workflow/stage-run-engine.ts");
  expect(count(engine, /\browGone = true/g)).toBe(2);
  expect(count(engine, /state\.rowGone = true/g)).toBe(1);
  expect(count(engine, /"item-removed"/g)).toBe(count(engine, /rowGone \? (\{ status: "cancelled", reason: )?"item-removed"/g));
  expect(count(engine, /\browRemoved\(state\)/g)).toBe(4);
  expect(count(engine, /\brecords\.deleted\(\)/g)).toBe(1);
  const rowRemoved = (fn: string) => {
    const body = engine.slice(engine.indexOf(`function ${fn}(`));
    return body.slice(0, body.indexOf("\n  }\n")).includes("rowRemoved(state)");
  };
  expect(["checkRows", "removedHeld", "takeOverDeleted", "writeRun"].map(rowRemoved)).toEqual([true, true, true, true]);
});
