import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import * as XLSX from "xlsx";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseTableDocument } from "../table-document-reader.js";

let bundleDirectory: string;
let script: string;
beforeAll(async () => {
  bundleDirectory = mkdtempSync(join(tmpdir(), "ave-journal-open-bundle-"));
  script = join(bundleDirectory, "edit-xlsx.cjs");
  await build({ entryPoints: [resolve("src/skills/xlsx-edit-cli.ts")], outfile: script,
    bundle: true, platform: "node", format: "cjs", target: "node22" });
});
afterAll(() => { rmSync(bundleDirectory, { recursive: true, force: true }); });

let directory: string;
let path: string;
let requestPath: string;
let journalPath: string;
let source: Buffer;
beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "ave-journal-open-")));
  mkdirSync(join(directory, "document-observation"));
  journalPath = join(directory, "document-observation", "journal.jsonl");
  path = join(directory, "book.xlsx");
  requestPath = join(directory, "request.json");
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["Revenue", 12]]), "Budget");
  source = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
  writeFileSync(path, source);
  writeFileSync(requestPath, JSON.stringify({ sheet: 0, edits: [{ cell: "B1", value: 84 }] }));
});
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

const CHILD_BOOTSTRAP = String.raw`
const fs = require('node:fs');
const originalLstat = fs.lstatSync;
const originalOpen = fs.openSync;
const journal = process.env.AVE_DOCUMENT_JOURNAL;
const mode = process.argv[1];
fs.lstatSync = function(path, ...options) {
  if (String(path) === journal && ((mode === 'deny-missing-stat' && !fs.existsSync(path)) || mode === 'deny-existing-stat')) {
    throw Object.assign(new Error('Journal metadata unavailable'), { code: 'EPERM' });
  }
  return originalLstat(path, ...options);
};
fs.openSync = function(path, flags, ...options) {
  if (String(path) === journal && typeof flags === 'number') {
    if (mode.startsWith('deny-create-') && (flags & fs.constants.O_CREAT)) {
      throw Object.assign(new Error('Journal creation unavailable'), { code: mode.slice('deny-create-'.length) });
    }
    if (mode === 'replace-before-append' && !(flags & fs.constants.O_CREAT)) {
      fs.renameSync(path, path + '.previous');
      fs.writeFileSync(path, 'replacement\n');
    }
  }
  return originalOpen(path, flags, ...options);
};
const script = process.argv[2];
process.argv = [process.execPath, script, process.argv[3], process.argv[4]];
require(script);
`;
function run(mode: string) {
  return spawnSync(process.execPath, ["-e", CHILD_BOOTSTRAP, mode, script, path, requestPath], {
    encoding: "utf8",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", HOME: directory, AVE_DOCUMENT_JOURNAL: journalPath },
  });
}

describe("journal creation and append admission", () => {
  it("creates exclusively before querying a missing journal whose metadata probe would be refused", async () => {
    const result = run("deny-missing-stat");
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({ editedCells: 1, needsRecalculation: true, backup: null });
    expect(readFileSync(journalPath, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line).kind))
      .toEqual(["begin", "cell", "commit"]);
    expect((await parseTableDocument(readFileSync(path), "xlsx", 0)).sheet.rows).toEqual([["Revenue", "84"]]);
  });

  it.each(["EPERM", "EACCES", "EIO"])("preserves %s from exclusive creation without treating it as an absent path", (code) => {
    const result = run(`deny-create-${code}`);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("XLSX edit refused: Journal creation unavailable");
    expect(readFileSync(path).equals(source)).toBe(true);
    expect(existsSync(journalPath)).toBe(false);
  });

  it("keeps a refused existing-file metadata probe as a hard failure before append", () => {
    writeFileSync(journalPath, "retained\n");
    const result = run("deny-existing-stat");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("XLSX edit refused: Journal metadata unavailable");
    expect(readFileSync(path).equals(source)).toBe(true);
    expect(readFileSync(journalPath, "utf8")).toBe("retained\n");
  });

  it("refuses an existing journal replaced between metadata admission and append open", () => {
    writeFileSync(journalPath, "retained\n");
    const result = run("replace-before-append");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("XLSX edit refused: Edit journal identity changed.");
    expect(readFileSync(path).equals(source)).toBe(true);
    expect(readFileSync(`${journalPath}.previous`, "utf8")).toBe("retained\n");
    expect(readFileSync(journalPath, "utf8")).toBe("replacement\n");
  });
});
