import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";

import { PREVIEW_DOCUMENT_LIMITS } from "../../shared/preview-document.js";
import {
  TableDocumentError,
  decodeDelimitedText,
  parseTableDocument,
  type TableDocumentLimits,
} from "../table-document-reader.js";
import { verifyZipInflateLimits } from "../zip-inflate-guard.js";

function limits(overrides: Partial<TableDocumentLimits>): TableDocumentLimits {
  return { ...PREVIEW_DOCUMENT_LIMITS, ...overrides };
}

function refusal(run: () => unknown): TableDocumentError {
  try {
    run();
  } catch (err) {
    if (err instanceof TableDocumentError) return err;
    throw err;
  }
  throw new Error("expected a TableDocumentError");
}

function workbook(sheets: Record<string, unknown[][]>, bookType: XLSX.BookType): Buffer {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
  }
  return XLSX.write(wb, { type: "buffer", bookType }) as Buffer;
}

describe("CSV / TSV", () => {
  it("keeps quoted delimiters, quotes and newlines inside one cell", () => {
    const csv = 'name,note\n"Lee, J","said ""hi""\nthen left"\nKim,plain\n';
    const doc = parseTableDocument(Buffer.from(csv), "csv", 0);
    expect(doc.sheet.rows).toEqual([
      ["name", "note"],
      ["Lee, J", 'said "hi"\nthen left'],
      ["Kim", "plain"],
    ]);
    expect(doc.sheet.totalRows).toBe(3);
    expect(doc.sheet.rowsTruncated).toBe(false);
    expect(doc.sheetNames).toEqual(["CSV"]);
  });

  it("strips a UTF-8 BOM so the first header is not polluted", () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("이름,값\n가,1\n")]);
    const doc = parseTableDocument(bytes, "csv", 0);
    expect(doc.sheet.rows[0]).toEqual(["이름", "값"]);
    expect(doc.sheet.rows[0]?.[0]?.charCodeAt(0)).not.toBe(0xfeff);
  });

  it("decodes UTF-16LE and UTF-16BE by their byte-order marks", () => {
    const text = "a,b\n한,2\n";
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
    const beBody = Buffer.from(text, "utf16le").swap16();
    const be = Buffer.concat([Buffer.from([0xfe, 0xff]), beBody]);
    expect(parseTableDocument(le, "csv", 0).sheet.rows).toEqual([["a", "b"], ["한", "2"]]);
    expect(decodeDelimitedText(be)).toBe(text);
  });

  it("refuses non-UTF-8 text without a BOM instead of showing replacement marks", () => {
    // "가" in CP949 is 0xB0 0xA1 — invalid as UTF-8.
    const err = refusal(() => parseTableDocument(Buffer.from([0x61, 0x2c, 0xb0, 0xa1, 0x0a]), "csv", 0));
    expect(err.code).toBe("unsupported-encoding");
  });

  it("splits TSV on tabs only and pads ragged rows", () => {
    const doc = parseTableDocument(Buffer.from("a\tb,c\td\n1\n"), "tsv", 0);
    expect(doc.sheet.rows).toEqual([["a", "b,c", "d"], ["1", "", ""]]);
    expect(doc.format).toBe("tsv");
  });

  it("detects a semicolon-delimited CSV", () => {
    const doc = parseTableDocument(Buffer.from("a;b\n1;2\n"), "csv", 0);
    expect(doc.sheet.rows).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("caps rows, columns and cell length with truncation flags and true totals", () => {
    const line = (r: number) => Array.from({ length: 5 }, (_, c) => `r${r}c${c}`).join(",");
    const csv = [...Array.from({ length: 8 }, (_, r) => line(r)), `x,${"y".repeat(50)}`].join("\n");
    const doc = parseTableDocument(Buffer.from(csv), "csv", 0, limits({ maxRows: 3, maxColumns: 2, maxCellChars: 10 }));
    expect(doc.sheet.rows).toEqual([["r0c0", "r0c1"], ["r1c0", "r1c1"], ["r2c0", "r2c1"]]);
    expect(doc.sheet.totalRows).toBe(9);
    expect(doc.sheet.totalColumns).toBe(5);
    expect(doc.sheet.rowsTruncated).toBe(true);
    expect(doc.sheet.columnsTruncated).toBe(true);

    const long = parseTableDocument(Buffer.from(`a,${"z".repeat(30)}`), "csv", 0, limits({ maxCellChars: 10 }));
    expect(long.sheet.rows[0]?.[1]).toBe(`${"z".repeat(10)}…`);
    expect(long.sheet.cellsTruncated).toBe(true);
  });

  it("refuses an over-size file and a second sheet index", () => {
    expect(refusal(() => parseTableDocument(Buffer.alloc(11, 0x61), "csv", 0, limits({ maxFileBytes: 10 }))).code)
      .toBe("too-large");
    expect(refusal(() => parseTableDocument(Buffer.from("a\n"), "csv", 1)).code).toBe("sheet-not-found");
    expect(refusal(() => parseTableDocument(Buffer.from("a\n"), "csv", -1)).code).toBe("sheet-not-found");
  });
});

describe("workbooks", () => {
  const sheets = {
    Summary: [["Region", "Total"], ["North", 120], ["South", 80]],
    Detail: [["id", "formula?"], [1, "=1+1"]],
  };

  it("lists every sheet and returns only the requested one (xlsx)", () => {
    const bytes = workbook(sheets, "xlsx");
    const first = parseTableDocument(bytes, "xlsx", 0);
    expect(first.sheetNames).toEqual(["Summary", "Detail"]);
    expect(first.totalSheets).toBe(2);
    expect(first.sheet).toMatchObject({ index: 0, name: "Summary", totalRows: 3, totalColumns: 2 });
    expect(first.sheet.rows).toEqual([["Region", "Total"], ["North", "120"], ["South", "80"]]);

    const second = parseTableDocument(bytes, "xlsx", 1);
    expect(second.sheet.name).toBe("Detail");
    // A string that looks like a formula stays text.
    expect(second.sheet.rows[1]).toEqual(["1", "=1+1"]);
    expect(refusal(() => parseTableDocument(bytes, "xlsx", 2)).code).toBe("sheet-not-found");
  });

  it("shows a formula's cached value, never its source or a re-evaluation", () => {
    const ws = XLSX.utils.aoa_to_sheet([["a"]]);
    ws.B1 = { t: "n", v: 7, f: "SUM(1,2)" };
    ws["!ref"] = "A1:B1";
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "F");
    const doc = parseTableDocument(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer, "xlsx", 0);
    expect(doc.sheet.rows).toEqual([["a", "7"]]);
  });

  it("reads ODS and legacy XLS workbooks", () => {
    expect(parseTableDocument(workbook(sheets, "ods"), "ods", 1).sheet.rows[0]).toEqual(["id", "formula?"]);
    const xls = parseTableDocument(workbook(sheets, "biff8"), "xls", 0);
    expect(xls.sheetNames).toEqual(["Summary", "Detail"]);
    expect(xls.sheet.rows[1]).toEqual(["North", "120"]);
  });

  it("caps rows, columns and sheet tabs with flags and keeps the source offsets", () => {
    const grid = Array.from({ length: 30 }, (_, r) => Array.from({ length: 12 }, (_, c) => `${r}:${c}`));
    const many: Record<string, unknown[][]> = { Big: grid };
    for (let i = 0; i < 4; i += 1) many[`S${i}`] = [["x"]];
    const doc = parseTableDocument(workbook(many, "xlsx"), "xlsx", 0, limits({ maxRows: 5, maxColumns: 4, maxSheets: 3 }));
    expect(doc.sheetNames).toEqual(["Big", "S0", "S1"]);
    expect(doc.totalSheets).toBe(5);
    expect(doc.sheetsTruncated).toBe(true);
    expect(doc.sheet.rows).toHaveLength(5);
    expect(doc.sheet.rows[4]).toEqual(["4:0", "4:1", "4:2", "4:3"]);
    expect(doc.sheet).toMatchObject({
      totalRows: 30,
      totalColumns: 12,
      rowsTruncated: true,
      columnsTruncated: true,
    });
    expect(refusal(() => parseTableDocument(workbook(many, "xlsx"), "xlsx", 3, limits({ maxSheets: 3 }))).code)
      .toBe("sheet-not-found");

    const ws: XLSX.WorkSheet = { C3: { t: "s", v: "c3" }, D3: { t: "s", v: "d3" }, "!ref": "C3:D3" };
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Offset");
    const offset = parseTableDocument(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer, "xlsx", 0);
    expect(offset.sheet).toMatchObject({ firstRow: 2, firstColumn: 2, rows: [["c3", "d3"]] });
  });

  it("returns an empty grid for an empty sheet", () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([]), "Empty");
    const doc = parseTableDocument(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer, "xlsx", 0);
    expect(doc.sheet).toMatchObject({ rows: [], totalRows: 0, totalColumns: 0, rowsTruncated: false });
  });

  it("refuses corrupt and mislabelled workbooks", () => {
    expect(refusal(() => parseTableDocument(Buffer.from("a,b\n1,2\n"), "xlsx", 0)).code).toBe("corrupt-document");
    expect(refusal(() => parseTableDocument(Buffer.from("PK\u0003\u0004 not really a zip"), "xlsx", 0)).code)
      .toBe("corrupt-document");
    const truncated = workbook(sheets, "xlsx").subarray(0, 200);
    expect(refusal(() => parseTableDocument(Buffer.from(truncated), "xlsx", 0)).code).toBe("corrupt-document");
    expect(refusal(() => parseTableDocument(workbook(sheets, "biff8"), "ods", 0)).code).toBe("corrupt-document");
  });
});

describe("zip-bomb guard", () => {
  function zipOf(entries: Record<string, Buffer>): Buffer {
    const zip = new AdmZip();
    for (const [name, data] of Object.entries(entries)) zip.addFile(name, data);
    return zip.toBuffer();
  }

  it("refuses an archive whose inflated size exceeds the cap before parsing", () => {
    const bomb = zipOf({ "[Content_Types].xml": Buffer.alloc(3 * 1024 * 1024, 0x20) });
    expect(bomb.length).toBeLessThan(64 * 1024);
    const err = refusal(() => parseTableDocument(bomb, "xlsx", 0, limits({ maxUncompressedBytes: 2 * 1024 * 1024 })));
    expect(err.code).toBe("archive-too-large");
  });

  it("refuses an entry whose compression ratio is implausible", () => {
    const bomb = zipOf({ "xl/sharedStrings.xml": Buffer.alloc(4 * 1024 * 1024, 0x41) });
    const err = refusal(() => parseTableDocument(bomb, "xlsx", 0));
    expect(err.code).toBe("archive-too-large");
    expect(err.message).toContain("compression-ratio");
  });

  it("refuses an archive that understates an entry's real size in its headers", () => {
    const zip = zipOf({ "xl/workbook.xml": Buffer.alloc(64 * 1024, 0x42) });
    // Patch the declared uncompressed size (local header @22, central header @24) to 10 bytes.
    const forged = Buffer.from(zip);
    forged.writeUInt32LE(10, 22);
    const central = forged.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    forged.writeUInt32LE(10, central + 24);
    const verdict = verifyZipInflateLimits(forged, PREVIEW_DOCUMENT_LIMITS);
    expect(verdict).toMatchObject({ ok: false, reason: "size-mismatch" });
    expect(refusal(() => parseTableDocument(forged, "xlsx", 0)).code).toBe("archive-too-large");
  });

  it("refuses too many entries", () => {
    const zip = zipOf({ a: Buffer.from("1"), b: Buffer.from("2"), c: Buffer.from("3") });
    expect(verifyZipInflateLimits(zip, { ...PREVIEW_DOCUMENT_LIMITS, maxArchiveEntries: 2 }))
      .toMatchObject({ ok: false, reason: "too-many-entries" });
  });

  it("passes a real workbook", () => {
    const verdict = verifyZipInflateLimits(workbook({ A: [["x"]] }, "xlsx"), PREVIEW_DOCUMENT_LIMITS);
    expect(verdict.ok).toBe(true);
  });
});
