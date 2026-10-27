import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, symlinkSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import JSZip from "jszip";
import * as XLSX from "xlsx";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { editWorkbookFile } from "../../skills/xlsx-edit.js";
import { parseTableDocument } from "../table-document-reader.js";
import { readDocumentResponse } from "../preview-document-protocol.js";
import { formatDocumentToolOutput } from "../document-tool-output.js";

let commandDirectory: string;
let script: string;
beforeAll(async () => {
  commandDirectory = mkdtempSync(join(tmpdir(), "ave-workbook-command-"));
  script = join(commandDirectory, "edit-xlsx.cjs");
  await build({ entryPoints: [resolve("src/skills/xlsx-edit-cli.ts")], outfile: script,
    bundle: true, platform: "node", format: "cjs", target: "node22" });
});
afterAll(() => { rmSync(commandDirectory, { recursive: true, force: true }); });
let directory: string;

beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "ave-xlsx-edit-")); });
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

async function fixture(): Promise<JSZip> {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, {
    A1: { t: "s", v: "Revenue" }, B1: { t: "n", v: 12 }, C1: { t: "n", f: "B1*2", v: 24 },
    A2: { t: "b", v: true }, B2: { t: "n", v: 9 }, C2: { t: "s", v: "unchanged" },
    "!ref": "A1:C2",
  }, "Budget");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["Other", 77]]), "Notes");
  const zip = await JSZip.loadAsync(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer);
  const sheet = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
  zip.file("xl/worksheets/sheet1.xml", sheet.replace('r="B1"', 'r="B1" s="0"'));
  zip.file("xl/media/opaque.bin", Buffer.from([1, 3, 5, 7, 9]));
  zip.file("xl/charts/chart1.xml", '<chart xmlns="urn:opaque">keep exact bytes</chart>');
  zip.file("xl/pivotTables/pivotTable1.xml", '<pivot xmlns="urn:opaque" name="Retained"/>');
  return zip;
}

async function save(zip: JSZip, name = "book.xlsx"): Promise<string> {
  const path = join(directory, name);
  writeFileSync(path, await zip.generateAsync({ type: "nodebuffer", compression: "STORE" }));
  return path;
}

function run(path: string, edits: unknown, sheet = 0) {
  const request = join(directory, "edits.json");
  writeFileSync(request, JSON.stringify({ sheet, edits }));
  return spawnSync(process.execPath, [script, path, request], { encoding: "utf8" });
}

describe("XLSX skill command", () => {
  it("runs the bundled command without package resolution", async () => {
    const path = await save(await fixture());
    expect(run(path, [{ cell: "B1", value: 21 }]).status).toBe(0);
    expect(readFileSync(script, "utf8")).not.toMatch(/require\(["'](?:jszip|fast-xml-parser)["']\)/);
  });

  it("round-trips literal values and preserves styles and every untouched part", async () => {
    const original = await fixture();
    const path = await save(original, "budget with spaces.xlsx");
    const result = run(path, [{ cell: "A1", value: "  A&B <Q> 한글  " }, { cell: "B1", value: 150 },
      { cell: "A2", value: false }, { cell: "B2", value: null }]);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ editedCells: 4, needsRecalculation: true, backup: null });
    expect(existsSync(`${path}.ave-bak`)).toBe(false);
    const edited = await JSZip.loadAsync(readFileSync(path));
    expect(Object.keys(edited.files).sort()).toEqual(Object.keys(original.files).sort());
    for (const [name, entry] of Object.entries(original.files)) {
      if (entry.dir || ["xl/worksheets/sheet1.xml", "xl/workbook.xml"].includes(name)) continue;
      expect((await edited.file(name)!.async("nodebuffer")).equals(await entry.async("nodebuffer")), name).toBe(true);
    }
    expect(await edited.file("xl/worksheets/sheet1.xml")!.async("string")).toContain('<c r="B1" s="0"><v>150</v></c>');
    const document = readDocumentResponse(await parseTableDocument(readFileSync(path), "xlsx", 0));
    expect(document.sheet.rows).toEqual([["  A&B <Q> 한글  ", "150", "24"], ["FALSE", "", "unchanged"]]);
    expect(document.needsRecalculation).toBe(true);
    const output = JSON.parse(formatDocumentToolOutput(path, document).output);
    expect(output.cells).toEqual([["  A&B <Q> 한글  ", "150", "24"], ["FALSE", "", "unchanged"]]);
  });

  it("allows formula overwrite and removes the obsolete calculation chain", async () => {
    const zip = await fixture();
    const rels = await zip.file("xl/_rels/workbook.xml.rels")!.async("string");
    zip.file("xl/_rels/workbook.xml.rels", rels.replace("</Relationships>", '<Relationship Id="calc" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/calcChain" Target="calcChain.xml"/></Relationships>'));
    const types = await zip.file("[Content_Types].xml")!.async("string");
    zip.file("[Content_Types].xml", types.replace("</Types>", '<Override PartName="/xl/calcChain.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml"/></Types>'));
    zip.file("xl/calcChain.xml", '<calcChain xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><c r="C1" i="1"/></calcChain>');
    const path = await save(zip);
    expect(run(path, [{ cell: "C1", value: 99 }]).status).toBe(0);
    const result = await JSZip.loadAsync(readFileSync(path));
    expect(result.file("xl/calcChain.xml")).toBeNull();
    expect(await result.file("xl/_rels/workbook.xml.rels")!.async("string")).not.toContain("calcChain");
    expect(await result.file("[Content_Types].xml")!.async("string")).not.toContain("calcChain");
    expect(await result.file("xl/workbook.xml")!.async("string")).toContain('fullCalcOnLoad="1" forceFullCalc="1" calcCompleted="0" calcMode="auto"');
    expect((await parseTableDocument(readFileSync(path), "xlsx", 0)).sheet.rows[0]).toEqual(["Revenue", "12", "99"]);
  });

  it("writes formulas without stale target caches and keeps equals-prefixed values as text", async () => {
    const path = await save(await fixture());
    expect(run(path, [{ cell: "C1", formula: "B1*3" }, { cell: "A1", value: "=B1" }]).status).toBe(0);
    const zip = await JSZip.loadAsync(readFileSync(path));
    expect(await zip.file("xl/worksheets/sheet1.xml")!.async("string")).toContain('<c r="C1"><f>B1*3</f></c>');
    const document = await parseTableDocument(readFileSync(path), "xlsx", 0);
    expect(document.needsRecalculation).toBe(true);
    expect(document.sheet.rows[0]).toEqual(["=B1", "12", ""]);
  });

  it("preserves a cell-local namespace binding in a prefixed worksheet", async () => {
    const zip = await fixture();
    zip.file("xl/worksheets/sheet1.xml", '<s:worksheet xmlns:s="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><s:sheetData><s:row r="1"><c xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" r="A1"><v>12</v></c></s:row></s:sheetData></s:worksheet>');
    const path = await save(zip);
    expect(run(path, [{ cell: "A1", value: 88 }]).status).toBe(0);
    const edited = await JSZip.loadAsync(readFileSync(path));
    expect(await edited.file("xl/worksheets/sheet1.xml")!.async("string"))
      .toContain('<c r="A1" xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><v>88</v></c>');
  });

  it("refuses XML declaring a different encoding before replacing bytes", async () => {
    const zip = await fixture();
    zip.file("xl/worksheets/sheet1.xml", (await zip.file("xl/worksheets/sheet1.xml")!.async("string")).replace('encoding="UTF-8"', 'encoding="ISO-8859-1"'));
    const path = await save(zip);
    const before = readFileSync(path);
    const result = run(path, [{ cell: "A1", value: "한글" }]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Only UTF-8 XML is supported.");
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  it.each([[8 * 1024 * 1024, false], [8 * 1024 * 1024 + 1, true]])("enforces the exact backup boundary at %i bytes", async (bytes, backupExpected) => {
    const zip = await fixture();
    zip.file("xl/media/generated.bin", Buffer.alloc(0));
    const base = await zip.generateAsync({ type: "nodebuffer", compression: "STORE" });
    zip.file("xl/media/generated.bin", randomBytes(bytes - base.length));
    const path = await save(zip);
    expect(readFileSync(path).length).toBe(bytes);
    expect(run(path, [{ cell: "B1", value: 33 }]).status).toBe(0);
    expect(existsSync(`${path}.ave-bak`)).toBe(backupExpected);
  });

  it("creates an exact pre-edit backup above 8 MiB and never replaces that recovery copy", async () => {
    const zip = await fixture();
    zip.file("xl/media/generated.bin", randomBytes(8 * 1024 * 1024));
    const path = await save(zip);
    const before = readFileSync(path);
    expect(before.length).toBeGreaterThan(8 * 1024 * 1024);
    const result = run(path, [{ cell: "B1", value: 42 }]);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(readFileSync(`${path}.ave-bak`).equals(before)).toBe(true);
    const edited = readFileSync(path);
    expect((await parseTableDocument(edited, "xlsx", 0)).sheet.rows[0]).toEqual(["Revenue", "42", "24"]);
    expect(run(path, [{ cell: "B1", value: 43 }]).status).toBe(1);
    expect(readFileSync(path).equals(edited)).toBe(true);
    expect(readFileSync(`${path}.ave-bak`).equals(before)).toBe(true);
  });

  it("removes an incomplete backup after a write failure and permits retry", async () => {
    const zip = await fixture();
    zip.file("xl/media/generated.bin", randomBytes(8 * 1024 * 1024));
    const path = await save(zip);
    const before = readFileSync(path);
    let written = 0;
    const { writeSync } = await import("node:fs");
    const request = { sheet: 0, edits: [{ cell: "B1", value: 44 }] };
    await expect(editWorkbookFile(path, request, { write(descriptor, bytes, offset, length) {
      if (written >= 1024) throw Object.assign(new Error("No space left"), { code: "ENOSPC" });
      const count = writeSync(descriptor, bytes, offset, Math.min(length, 1024 - written));
      written += count;
      return count;
    } })).rejects.toMatchObject({ code: "ENOSPC" });
    expect(written).toBe(1024);
    expect(existsSync(path + ".ave-bak")).toBe(false);
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(readdirSync(directory).filter((name) => name.startsWith(".ave-xlsx-"))).toEqual([]);
    await expect(editWorkbookFile(path, request)).resolves.toEqual({ editedCells: 1, needsRecalculation: true, backup: path + ".ave-bak" });
    expect(readFileSync(path + ".ave-bak").equals(before)).toBe(true);
  });

  it("refuses an existing incomplete recovery copy without changing either file", async () => {
    const zip = await fixture();
    zip.file("xl/media/generated.bin", randomBytes(8 * 1024 * 1024));
    const path = await save(zip);
    const before = readFileSync(path);
    const partial = before.subarray(0, 1024);
    writeFileSync(path + ".ave-bak", partial);
    await expect(editWorkbookFile(path, { sheet: 0, edits: [{ cell: "B1", value: 55 }] })).rejects.toMatchObject({ code: "EEXIST" });
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(readFileSync(path + ".ave-bak").equals(partial)).toBe(true);
    expect(readdirSync(directory).filter((name) => name.startsWith(".ave-xlsx-"))).toEqual([]);
  });

  it.each([
    ["shared formula", '<f t="shared" si="0">B1*2</f>', "<f>B1*2</f>"],
    ["cell extension", '<v>12</v><extLst/>', "<v>12</v>"],
    ["protected sheet", '<sheetProtection sheet="1"/></worksheet>', "</worksheet>"],
    ["table-managed sheet", '<tableParts count="1"/></worksheet>', "</worksheet>"],
    ["merged target", '<mergeCells count="1"><mergeCell ref="B1:C1"/></mergeCells></worksheet>', "</worksheet>"],
  ])("refuses %s without changing the workbook", async (_label, replacement, search) => {
    const zip = await fixture();
    zip.file("xl/worksheets/sheet1.xml", (await zip.file("xl/worksheets/sheet1.xml")!.async("string")).replace(search, replacement));
    const path = await save(zip);
    const before = readFileSync(path);
    expect(run(path, [{ cell: "B1", value: 20 }]).status).toBe(1);
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  it.each([[{ cell: "D1", value: 4 }], [{ cell: "B1", value: 4, formula: "1+1" }],
    [{ cell: "B1", value: 4 }, { cell: "B1", value: 5 }]])("refuses unsupported requests without mutation", async (...edits) => {
    const path = await save(await fixture());
    const before = readFileSync(path);
    expect(run(path, edits).status).toBe(1);
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  it.each(["macro", "declaration", "entity", "expansion", "member-link"])("refuses unsafe %s packages without mutation", async (kind) => {
    const zip = await fixture();
    if (kind === "macro") zip.file("xl/vbaProject.bin", Buffer.from([1, 2, 3]));
    if (kind === "member-link") zip.file("xl/media/link", "outside", { unixPermissions: 0o120777 });
    if (kind === "expansion") zip.file("xl/media/expanded.bin", Buffer.alloc(2 * 1024 * 1024));
    if (kind === "declaration" || kind === "entity") {
      const xml = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
      zip.file("xl/worksheets/sheet1.xml", kind === "declaration"
        ? xml.replace(/<worksheet/, '<!DOCTYPE worksheet [<!ENTITY injected "value">]><worksheet')
        : xml.replace("Revenue", "&injected;"));
    }
    const path = join(directory, "unsafe.xlsx");
    writeFileSync(path, await zip.generateAsync({ type: "nodebuffer", platform: "UNIX", compression: kind === "expansion" ? "DEFLATE" : "STORE" }));
    const before = readFileSync(path);
    expect(run(path, [{ cell: "B1", value: 10 }]).status).toBe(1);
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  it("retains compressed opaque members within the output budget", async () => {
    const zip = await fixture();
    zip.file("xl/media/compressed.bin", randomBytes(1024 * 1024));
    const path = join(directory, "compressed.xlsx");
    writeFileSync(path, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
    expect(run(path, [{ cell: "B1", value: 99 }]).status).toBe(0);
    const result = await JSZip.loadAsync(readFileSync(path));
    expect((await result.file("xl/media/compressed.bin")!.async("nodebuffer")).equals(await zip.file("xl/media/compressed.bin")!.async("nodebuffer"))).toBe(true);
  });

  it("refuses linked workbook paths", async () => {
    const path = await save(await fixture());
    const linked = join(directory, "linked.xlsx");
    symlinkSync(path, linked);
    const before = readFileSync(path);
    expect(run(linked, [{ cell: "B1", value: 42 }]).status).toBe(1);
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  it.each([['fullCalcOnLoad="true"', true], ['forceFullCalc="1"', true], ['calcCompleted="false"', true],
    ['fullCalcOnLoad="0" forceFullCalc="false" calcCompleted="1"', false]])("reads explicit calculation properties %s", async (attributes, expected) => {
    const zip = await fixture();
    const workbook = await zip.file("xl/workbook.xml")!.async("string");
    zip.file("xl/workbook.xml", workbook.replace(/<calcPr\b[^>]*\/>/, "").replace("</workbook>", `<calcPr ${attributes}/></workbook>`));
    const path = await save(zip);
    expect((await parseTableDocument(readFileSync(path), "xlsx", 0)).needsRecalculation).toBe(expected);
  });
});
