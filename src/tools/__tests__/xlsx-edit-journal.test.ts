import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync,
  symlinkSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import * as XLSX from "xlsx";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OBSERVATION_LIMITS } from "../../shared/agent-observation.js";
import { isDocumentEditJournalRecord, type DocumentEditJournalRecord } from "../../shared/document-edit-journal.js";
import { WorkbookEditJournal } from "../../skills/xlsx-edit-journal.js";
import { editWorkbookFile } from "../../skills/xlsx-edit.js";
import { parseTableDocument } from "../table-document-reader.js";

let directory: string;
let journalPath: string;
let path: string;
beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "ave-cell-journal-")));
  mkdirSync(join(directory, "document-observation"));
  journalPath = join(directory, "document-observation", "journal.jsonl");
  path = join(directory, "book.xlsx");
  vi.stubEnv("HOME", directory);
  vi.stubEnv("AVE_DOCUMENT_JOURNAL", journalPath);
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });

function records(): DocumentEditJournalRecord[] {
  return readFileSync(journalPath, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
}
async function fixture(): Promise<JSZip> {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, {
    A1: { t: "s", v: "Revenue" }, B1: { t: "n", v: 12 }, C1: { t: "n", f: "B1*2", v: 24 },
    A2: { t: "b", v: true }, B2: { t: "n", v: 9 }, C2: { t: "s", v: "unchanged" }, "!ref": "A1:C2",
  }, "Budget");
  return JSZip.loadAsync(XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer);
}
async function save(zip: JSZip): Promise<Buffer> {
  for (const entry of Object.values(zip.files)) entry.date = new Date("2020-01-01T00:00:00.000Z");
  const before = await zip.generateAsync({ type: "nodebuffer", compression: "STORE" });
  writeFileSync(path, before);
  return before;
}
function cells(): Array<{ sheet: string; cell: string; before: string; after: string }> {
  return records().filter((record) => record.kind === "cell").map(({ sheet, cell, before, after }) => ({ sheet, cell, before, after }));
}

describe("workbook edit journal", () => {
  it("appends exact begin, cell and commit records with known content digests", () => {
    writeFileSync(path, "source workbook");
    const journal = new WorkbookEditJournal(journalPath, path, Buffer.from("source workbook"));
    journal.cell("Budget", "B1", "12", "84");
    journal.commit(Buffer.from("saved workbook"));
    journal.close();
    const written = records();
    const editId = written[0]!.editId;
    expect(editId).toMatch(/^[a-f0-9-]{36}$/);
    expect(written).toEqual([
      { v: 1, kind: "begin", editId, target: path, beforeHash: "4ddf17a5791d10248a4088f652d7a40df9b9cb38ba22af05beb3a2498da41fab" },
      { v: 1, kind: "cell", editId, sheet: "Budget", cell: "B1", before: "12", after: "84" },
      { v: 1, kind: "commit", editId, afterHash: "33f6dc374496df563a9b38593500d8f4775a34792875047d271029d462e130a4" },
    ]);
    expect(written.every(isDocumentEditJournalRecord)).toBe(true);
  });

  it("streams one record per replacement before atomic publication, then commits the published digest", async () => {
    const before = await save(await fixture());
    let observedStaging = false;
    const result = await editWorkbookFile(path, { sheet: 0, edits: [
      { cell: "A1", value: "Net" }, { cell: "B1", value: 84 }, { cell: "C1", value: 99 },
      { cell: "A2", value: false }, { cell: "B2", value: null },
    ] }, { write(descriptor, bytes, offset, length) {
      observedStaging = true;
      expect(readFileSync(path).equals(before)).toBe(true);
      expect(records().map((record) => record.kind)).toEqual(["begin", "cell", "cell", "cell", "cell", "cell"]);
      return writeSync(descriptor, bytes, offset, length);
    } });
    expect(result).toEqual({ editedCells: 5, needsRecalculation: true, backup: null });
    expect(observedStaging).toBe(true);
    expect(cells()).toEqual([
      { sheet: "Budget", cell: "A1", before: "Revenue", after: "Net" },
      { sheet: "Budget", cell: "B1", before: "12", after: "84" },
      { sheet: "Budget", cell: "C1", before: "24", after: "99" },
      { sheet: "Budget", cell: "A2", before: "TRUE", after: "FALSE" },
      { sheet: "Budget", cell: "B2", before: "9", after: "" },
    ]);
    expect(records()[0]).toEqual({ v: 1, kind: "begin", editId: records()[0]!.editId, target: path,
      beforeHash: "8f7b6b6156038cece122987506690d3199d8993a6a87509db72d88652b141101" });
    expect(records().at(-1)).toEqual({ v: 1, kind: "commit", editId: records()[0]!.editId,
      afterHash: "56c2ae6b7afe7e1906545b7a13f66a55162c2c3113e1cb3fad66ae043baa7c6d" });
    expect((await parseTableDocument(readFileSync(path), "xlsx", 0)).sheet.rows)
      .toEqual([["Net", "84", "99"], ["FALSE", "", "unchanged"]]);
  });

  it("decodes raw text, escaped rich runs, booleans and scientific values for advisory cells", async () => {
    const zip = await fixture();
    const xml = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
    zip.file("xl/worksheets/sheet1.xml", xml
      .replace(/<c r="A1"[\s\S]*?<\/c>/u, '<c r="A1" t="inlineStr"><is><r><t xml:space="preserve">  raw&amp;</t></r><r><t>_x0041__x005F_x0042_<![CDATA[<end>]]></t></r><r><t>_x00</t></r><r><t>41_</t></r></is></c>')
      .replace(/<c r="B1"[\s\S]*?<\/c>/u, '<c r="B1"><v>1.2500e+2</v></c>'));
    await save(zip);
    await editWorkbookFile(path, { sheet: 0, edits: [{ cell: "A1", value: "done" }, { cell: "B1", value: 4 }] });
    expect(cells()).toEqual([
      { sheet: "Budget", cell: "A1", before: "  raw&A_x0042_<end>_x0041_", after: "done" },
      { sheet: "Budget", cell: "B1", before: "125", after: "4" },
    ]);
  });

  it("resolves shared string runs without a formatted preview as its source", async () => {
    const zip = await fixture();
    zip.file("xl/_rels/workbook.xml.rels", (await zip.file("xl/_rels/workbook.xml.rels")!.async("string"))
      .replace("</Relationships>", '<Relationship Id="strings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>'));
    zip.file("xl/sharedStrings.xml", '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><r><rPr><b/></rPr><t>  raw&amp;</t></r><r><t>_x0041__x005F_x0042_  </t></r></si></sst>');
    zip.file("xl/worksheets/sheet1.xml", (await zip.file("xl/worksheets/sheet1.xml")!.async("string"))
      .replace(/<c r="A1"[\s\S]*?<\/c>/u, '<c r="A1" t="s"><v>0</v></c>'));
    await save(zip);
    await editWorkbookFile(path, { sheet: 0, edits: [{ cell: "A1", value: "done" }] });
    expect(cells()).toEqual([{ sheet: "Budget", cell: "A1", before: "  raw&A_x0042_  ", after: "done" }]);
  });

  it.each([
    ["inline", "plain"], ["inline", "rich"], ["shared", "plain"], ["shared", "rich"],
  ])("keeps %s %s phonetic decorations from adding a journal-only edit refusal", async (storage, structure) => {
    const zip = await fixture();
    const value = structure === "plain" ? "<t>東京</t>" : "<r><rPr><b/></rPr><t>東</t></r><r><t>京</t></r>";
    const decorated = `${value}<rPh sb="0" eb="2"><t>とうきょう</t></rPh><phoneticPr fontId="0" type="Hiragana"/>`;
    const originalSheet = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
    if (storage === "shared") {
      zip.file("xl/_rels/workbook.xml.rels", (await zip.file("xl/_rels/workbook.xml.rels")!.async("string"))
        .replace("</Relationships>", '<Relationship Id="strings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>'));
      zip.file("[Content_Types].xml", (await zip.file("[Content_Types].xml")!.async("string"))
        .replace("</Types>", '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>'));
      zip.file("xl/sharedStrings.xml", `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si>${decorated}</si></sst>`);
    }
    zip.file("xl/worksheets/sheet1.xml", originalSheet.replace(/<c r="A1"[\s\S]*?<\/c>/u,
      storage === "shared" ? '<c r="A1" t="s"><v>0</v></c>' : `<c r="A1" t="inlineStr"><is>${decorated}</is></c>`));
    const before = await save(zip);
    expect((await parseTableDocument(before, "xlsx", 0)).sheet.rows[0]).toEqual(["東京", "12", "24"]);
    const standalone = join(directory, "standalone.xlsx");
    writeFileSync(standalone, before);
    delete process.env.AVE_DOCUMENT_JOURNAL;
    expect(await editWorkbookFile(standalone, { sheet: 0, edits: [{ cell: "A1", value: "replaced" }] }))
      .toEqual({ editedCells: 1, needsRecalculation: true, backup: null });
    vi.stubEnv("AVE_DOCUMENT_JOURNAL", journalPath);
    expect(await editWorkbookFile(path, { sheet: 0, edits: [{ cell: "A1", value: "replaced" }] }))
      .toEqual({ editedCells: 1, needsRecalculation: true, backup: null });
    expect(cells()).toEqual([{ sheet: "Budget", cell: "A1", before: "東京", after: "replaced" }]);
    for (const edited of [standalone, path]) expect((await parseTableDocument(readFileSync(edited), "xlsx", 0)).sheet.rows)
      .toEqual([["replaced", "12", "24"], ["TRUE", "9", "unchanged"]]);
  });

  it("records formula edits as empty provisional caches while values beginning with equals stay literal", async () => {
    await save(await fixture());
    await editWorkbookFile(path, { sheet: 0, edits: [{ cell: "C1", formula: "B1*3" }, { cell: "A1", value: "=B1" }] });
    expect(cells()).toEqual([
      { sheet: "Budget", cell: "C1", before: "24", after: "" },
      { sheet: "Budget", cell: "A1", before: "Revenue", after: "=B1" },
    ]);
    expect((await parseTableDocument(readFileSync(path), "xlsx", 0)).needsRecalculation).toBe(true);
  });

  it("bounds Unicode and escaped display strings without clipping the saved value", async () => {
    await save(await fixture());
    const value = "😀".repeat(2000);
    await editWorkbookFile(path, { sheet: 0, edits: [{ cell: "A1", value }] });
    expect(cells()[0]!.after).toBe("😀".repeat(1000));
    const saved = await JSZip.loadAsync(readFileSync(path));
    expect(await saved.file("xl/worksheets/sheet1.xml")!.async("string")).toContain(value);
    expect(readFileSync(journalPath, "utf8").trimEnd().split("\n").every((line) => Buffer.byteLength(`${line}\n`) <= 16_384)).toBe(true);
  });

  it("bounds JSON escaping and refuses more than 500 cell records in one edit", () => {
    writeFileSync(path, "source workbook");
    const journal = new WorkbookEditJournal(journalPath, path, Buffer.from("source workbook"));
    try {
      journal.cell("Budget", "A1", "\u0000".repeat(2000), "\u0000".repeat(2000));
      expect(cells()[0]).toEqual({ sheet: "Budget", cell: "A1", before: "\u0000".repeat(1232), after: "\u0000".repeat(1360) });
      expect(Buffer.byteLength(readFileSync(journalPath, "utf8").trimEnd().split("\n")[1]!)).toBeLessThanOrEqual(16_384);
      for (let index = 1; index < 500; index += 1) journal.cell("Budget", "B1", "12", "84");
      expect(() => journal.cell("Budget", "C1", "24", "99")).toThrow("cell limit");
      journal.commit(Buffer.from("saved workbook"));
      expect(records().length).toBe(502);
    } finally { journal.close(); }
  });

  it("does not append completion or modify the target after a later edit is refused", async () => {
    const before = await save(await fixture());
    await expect(editWorkbookFile(path, { sheet: 0, edits: [{ cell: "B1", value: 84 }, { cell: "D9", value: 1 }] }))
      .rejects.toThrow("existing cell");
    expect(records().map((record) => record.kind)).toEqual(["begin", "cell"]);
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  it("refuses a full or partially written journal before changing the workbook", async () => {
    const before = await save(await fixture());
    writeFileSync(journalPath, `${" ".repeat(OBSERVATION_LIMITS.journalBytes - 1)}\n`);
    await expect(editWorkbookFile(path, { sheet: 0, edits: [{ cell: "B1", value: 84 }] })).rejects.toThrow("size limit");
    expect(readFileSync(path).equals(before)).toBe(true);
    writeFileSync(journalPath, '{"v":1');
    await expect(editWorkbookFile(path, { sheet: 0, edits: [{ cell: "B1", value: 84 }] })).rejects.toThrow("incomplete record");
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  it("reports a lost completion after a successful publication without another document write", async () => {
    await save(await fixture());
    let renamed = false;
    await expect(editWorkbookFile(path, { sheet: 0, edits: [{ cell: "B1", value: 84 }] }, {
      write(descriptor, bytes, offset, length) {
        if (!renamed) { renamed = true; renameSync(journalPath, `${journalPath}.old`); writeFileSync(journalPath, ""); }
        return writeSync(descriptor, bytes, offset, length);
      },
    })).rejects.toThrow("Workbook was saved, but the edit journal could not be completed.");
    expect((await parseTableDocument(readFileSync(path), "xlsx", 0)).sheet.rows[0]).toEqual(["Revenue", "84", "24"]);
    expect(readFileSync(`${journalPath}.old`, "utf8")).not.toContain('"kind":"commit"');
  });

  it.each(["symlink", "hard-link", "outside-directory"])("refuses a %s journal without changing source", async (kind) => {
    const before = await save(await fixture());
    const other = join(directory, "outside.jsonl");
    writeFileSync(other, "private\n");
    if (kind === "symlink") symlinkSync(other, journalPath);
    else if (kind === "hard-link") linkSync(other, journalPath);
    else vi.stubEnv("AVE_DOCUMENT_JOURNAL", other);
    await expect(editWorkbookFile(path, { sheet: 0, edits: [{ cell: "B1", value: 84 }] })).rejects.toThrow("journal");
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(readFileSync(other, "utf8")).toBe("private\n");
  });

  it("keeps standalone editing available when no observation journal was configured", async () => {
    await save(await fixture());
    delete process.env.AVE_DOCUMENT_JOURNAL;
    expect(await editWorkbookFile(path, { sheet: 0, edits: [{ cell: "B1", value: 84 }] }))
      .toEqual({ editedCells: 1, needsRecalculation: true, backup: null });
    expect(existsSync(journalPath)).toBe(false);
  });
});

const BEGIN_RECORD = { v: 1, kind: "begin", editId: "edit-1", target: "/workspace/book.xlsx", beforeHash: "a".repeat(64) };
const CELL_RECORD = { v: 1, kind: "cell", editId: "edit-1", sheet: "Budget", cell: "B1", before: "12", after: "84" };
describe("document edit journal records", () => {
  it.each([
    BEGIN_RECORD, { ...BEGIN_RECORD, target: "C:\\workspace\\book.xlsx" }, { ...BEGIN_RECORD, target: "\\\\host\\share\\book.xlsx" },
    CELL_RECORD, { ...CELL_RECORD, cell: "XFD1048576" }, { v: 1, kind: "commit", editId: "edit-1", afterHash: "b".repeat(64) },
  ])("accepts bounded exact-shape record %j", (record) => { expect(isDocumentEditJournalRecord(record)).toBe(true); });
  it.each([
    null, [], { ...BEGIN_RECORD, v: 2 }, { ...BEGIN_RECORD, actor: "agent" }, { ...BEGIN_RECORD, sessionId: "claimed" },
    { ...BEGIN_RECORD, target: "relative.xlsx" }, { ...BEGIN_RECORD, beforeHash: "A".repeat(64) },
    { ...BEGIN_RECORD, editId: "../edit" }, { ...CELL_RECORD, cell: "XFE1" }, { ...CELL_RECORD, cell: "A1048577" },
    { ...CELL_RECORD, cell: "a1" }, { ...CELL_RECORD, sheet: "" }, { ...CELL_RECORD, after: "x".repeat(2001) },
    { ...CELL_RECORD, before: 12 }, { v: 1, kind: "commit", editId: "edit-1", afterHash: "short" },
  ])("refuses malformed or authority-bearing record %j", (record) => { expect(isDocumentEditJournalRecord(record)).toBe(false); });
});
