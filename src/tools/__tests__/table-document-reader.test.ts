import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";

import { PREVIEW_DOCUMENT_LIMITS } from "../../shared/preview-document.js";
import {
  TableDocumentError,
  parseTableDocument,
  type TableDocumentLimits,
} from "../table-document-reader.js";
import { verifyZipInflateLimits } from "../zip-inflate-guard.js";
import { offsetWorkbook } from "../../__tests__/support/table-document-fixtures.js";
import { recalculatedOdsFixture } from "../../__tests__/support/ods-document-fixtures.js";

function limits(overrides: Partial<TableDocumentLimits>): TableDocumentLimits {
  return { ...PREVIEW_DOCUMENT_LIMITS, ...overrides };
}

async function refusal(run: () => unknown): Promise<TableDocumentError> {
  try {
    await run();
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
  it("keeps quoted delimiters, quotes and newlines inside one cell", async () => {
    const csv = 'name,note\n"Lee, J","said ""hi""\nthen left"\nKim,plain\n';
    const doc = await parseTableDocument(Buffer.from(csv), "csv", 0);
    expect(doc.sheet.rows).toEqual([
      ["name", "note"],
      ["Lee, J", 'said "hi"\nthen left'],
      ["Kim", "plain"],
    ]);
    expect(doc.sheet.totalRows).toBe(3);
    expect(doc.sheet.rowsTruncated).toBe(false);
    expect(doc.sheetNames).toEqual(["CSV"]);
  });

  it("strips a UTF-8 BOM so the first header is not polluted", async () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("이름,값\n가,1\n")]);
    const doc = await parseTableDocument(bytes, "csv", 0);
    expect(doc.sheet.rows[0]).toEqual(["이름", "값"]);
    expect(doc.sheet.rows[0]?.[0]?.charCodeAt(0)).not.toBe(0xfeff);
  });

  it("decodes UTF-16LE and UTF-16BE by their byte-order marks", async () => {
    const text = "a,b\n한,2\n";
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
    const beBody = Buffer.from(text, "utf16le").swap16();
    const be = Buffer.concat([Buffer.from([0xfe, 0xff]), beBody]);
    expect((await parseTableDocument(le, "csv", 0)).sheet.rows).toEqual([["a", "b"], ["한", "2"]]);
    expect((await parseTableDocument(be, "csv", 0)).sheet.rows).toEqual([["a", "b"], ["한", "2"]]);
  });

  it("refuses non-UTF-8 text without a BOM instead of showing replacement marks", async () => {
    // "가" in CP949 is 0xB0 0xA1 — invalid as UTF-8.
    const err = await refusal(() => parseTableDocument(Buffer.from([0x61, 0x2c, 0xb0, 0xa1, 0x0a]), "csv", 0));
    expect(err.code).toBe("unsupported-encoding");
  });

  it("splits TSV on tabs only and pads ragged rows", async () => {
    const doc = await parseTableDocument(Buffer.from("a\tb,c\td\n1\n"), "tsv", 0);
    expect(doc.sheet.rows).toEqual([["a", "b,c", "d"], ["1", "", ""]]);
    expect(doc.format).toBe("tsv");
  });

  it("detects a semicolon-delimited CSV", async () => {
    const doc = await parseTableDocument(Buffer.from("a;b\n1;2\n"), "csv", 0);
    expect(doc.sheet.rows).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("caps rows, columns and cell length and reports an inspected lower bound", async () => {
    const line = (r: number) => Array.from({ length: 5 }, (_, c) => `r${r}c${c}`).join(",");
    const csv = [...Array.from({ length: 8 }, (_, r) => line(r)), `x,${"y".repeat(50)}`].join("\n");
    const doc = await parseTableDocument(Buffer.from(csv), "csv", 0, limits({ maxRows: 3, maxColumns: 2, maxCellChars: 10 }));
    expect(doc.sheet.rows).toEqual([["r0c0", "r0c1"], ["r1c0", "r1c1"], ["r2c0", "r2c1"]]);
    expect(doc.sheet.totalRows).toBe(4);
    expect(doc.sheet.totalColumns).toBe(5);
    expect(doc.sheet.rowsTruncated).toBe(true);
    expect(doc.sheet.columnsTruncated).toBe(true);

    const long = await parseTableDocument(Buffer.from(`a,${"z".repeat(30)}`), "csv", 0, limits({ maxCellChars: 10 }));
    expect(long.sheet.rows[0]?.[1]).toBe(`${"z".repeat(10)}…`);
    expect(long.sheet.cellsTruncated).toBe(true);
  });

  it("refuses an over-size file and a second sheet index", async () => {
    expect((await refusal(() => parseTableDocument(Buffer.alloc(11, 0x61), "csv", 0, limits({ maxFileBytes: 10 })))).code)
      .toBe("too-large");
    expect((await refusal(() => parseTableDocument(Buffer.from("a\n"), "csv", 1))).code).toBe("sheet-not-found");
    expect((await refusal(() => parseTableDocument(Buffer.from("a\n"), "csv", -1))).code).toBe("invalid-index");
  });

  it("refuses an unterminated quoted field rather than repairing it", async () => {
    expect((await refusal(() => parseTableDocument(Buffer.from('a,b\n"unterminated,2'), "csv", 0))).code)
      .toBe("corrupt-document");
  });

  it.each(['a,b\nstray"quote,2', 'a,b\n"closed" ,2'])(
    "refuses invalid field quoting without accepting parser repairs: %j", async (text) => {
      expect((await refusal(() => parseTableDocument(Buffer.from(text), "csv", 0))).code)
        .toBe("corrupt-document");
    },
  );

  it.each([
    ['a\tb\n5"\t2', [["a", "b"], ['5"', "2"]]],
    ["a\tb\n\u201c\uc778\uc6a9\u201d \uad6c\uac04\t2", [["a", "b"], ["\u201c\uc778\uc6a9\u201d \uad6c\uac04", "2"]]],
  ])("keeps a literal quote inside an unquoted TSV field: %j", async (text, rows) => {
    const doc = await parseTableDocument(Buffer.from(text), "tsv", 0);
    expect(doc.sheet.rows).toEqual(rows);
  });

  it("parses quoted records across bounded input chunks", async () => {
    const value = "a\n".repeat(40);
    const doc = await parseTableDocument(Buffer.from(`a,b\n1,"${value}"\n2,end`), "csv", 0,
      limits({ delimitedChunkChars: 16 }));
    expect(doc.sheet.rows).toEqual([["a", "b"], ["1", value], ["2", "end"]]);
  });

  it.each(["utf8", "utf16le", "utf16be"] as const)("keeps characters and quoted records across %s byte chunks", async (encoding) => {
    const text = 'a,b\r\n한,"가😀\r\nsaid ""yes"""\r\n끝,2\r\n';
    const body = Buffer.from(text, encoding === "utf8" ? "utf8" : "utf16le");
    const bytes = encoding === "utf8" ? body : Buffer.concat([
      Buffer.from(encoding === "utf16le" ? [0xff, 0xfe] : [0xfe, 0xff]),
      encoding === "utf16le" ? body : body.swap16(),
    ]);
    const doc = await parseTableDocument(bytes, "csv", 0, limits({ delimitedChunkChars: 11 }));
    expect(doc.sheet.rows).toEqual([["a", "b"], ["한", '가😀\r\nsaid "yes"'], ["끝", "2"]]);
    expect(doc.sheet).toMatchObject({ totalRows: 3, rowsTruncated: false });
  });

  it.each(["\n", "\r\n", "\r"])("retains blank records without adding one for a final %j separator", async (separator) => {
    const doc = await parseTableDocument(Buffer.from(`a,b${separator}1,2${separator}${separator}`), "csv", 0,
      limits({ delimitedChunkChars: 5 }));
    expect(doc.sheet.rows).toEqual([["a", "b"], ["1", "2"], ["", ""]]);
    expect(doc.sheet.totalRows).toBe(3);
  });

  it.each(['a,b\n1,"unterminated\nnext', 'a,b\n1,"trailing"x,2'])(
    "refuses malformed quoted records across byte chunks: %j", async (text) => {
      const err = await refusal(() => parseTableDocument(Buffer.from(text), "csv", 0,
        limits({ delimitedChunkChars: 5 })));
      expect(err.code).toBe("corrupt-document");
    },
  );

  it.each([
    Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x2c, 0xff]),
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("a\n", "utf16le"), Buffer.from([0x00, 0xd8])]),
    Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from("a\n", "utf16le").swap16(), Buffer.from([0xd8, 0x00])]),
  ])("refuses invalid inspected bytes even with a byte-order mark: %j", async (bytes) => {
    const err = await refusal(() => parseTableDocument(bytes, "csv", 0, limits({ delimitedChunkChars: 3 })));
    expect(err.code).toBe("unsupported-encoding");
  });

  it("leaves invalid encoding beyond bounded read-ahead uninspected", async () => {
    const bytes = Buffer.concat([Buffer.from("a,b\n1,2\n3,4\n"), Buffer.alloc(1024, 0x0a), Buffer.from([0xff])]);
    const doc = await parseTableDocument(bytes, "csv", 0, limits({ maxRows: 2, delimitedChunkChars: 16 }));
    expect(doc.sheet).toMatchObject({
      rows: [["a", "b"], ["1", "2"]], totalRows: 3, totalColumns: 2, rowsTruncated: true,
    });
  });

  it.each(["csv", "tsv"] as const)("refuses a %s initial record beyond the detection budget", async (format) => {
    const chunkChars = 16;
    const separator = format === "tsv" ? "\t" : ";";
    const text = `${"x".repeat(chunkChars + 1)}${separator}value\r\n1${separator}2\r\n`;
    const err = await refusal(() => parseTableDocument(Buffer.from(text), format, 0,
      limits({ delimitedChunkChars: chunkChars })));
    expect(err.code).toBe("parse-limit");
  });

  it("refuses an initial quoted record whose embedded line breaks fill the sample", async () => {
    const chunkChars = 16;
    const text = `"${"x\n".repeat(chunkChars)}",value\n1,2`;
    const err = await refusal(() => parseTableDocument(Buffer.from(text), "csv", 0,
      limits({ delimitedChunkChars: chunkChars })));
    expect(err.code).toBe("parse-limit");
  });

  it.each([1, PREVIEW_DOCUMENT_LIMITS.delimitedChunkChars])(
    "preserves first-record corruption with %i trailing rows", async (trailingRows) => {
      const bytes = Buffer.from(`a,"trailing"x,2\n${"1,2,3\n".repeat(trailingRows)}`);
      const err = await refusal(() => parseTableDocument(bytes, "csv", 0));
      expect(err.code).toBe("corrupt-document");
    },
  );

  it.each(["utf8", "utf16le"] as const)("refuses an ambiguous initial CRLF sample boundary in %s", async (encoding) => {
    const text = "a,b\r\n1,2\r\n";
    const bytes = encoding === "utf8" ? Buffer.from(text) : Buffer.concat([
      Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le"),
    ]);
    const err = await refusal(() => parseTableDocument(bytes, "csv", 0, limits({ delimitedChunkChars: 4 })));
    expect(err.code).toBe("parse-limit");
  });

  it("shrinks the row window when a wider witness exhausts the cell budget", async () => {
    const doc = await parseTableDocument(Buffer.from('a\nb\nc\nd\ne\n1,2,3,4\n"uninspected'), "csv", 0,
      limits({ maxRows: 10, maxColumns: 3, maxReturnedCells: 12, delimitedChunkChars: 8 }));
    expect(doc.sheet).toMatchObject({
      rows: [["a", "", ""], ["b", "", ""], ["c", "", ""], ["d", "", ""]],
      totalRows: 6, totalColumns: 4, rowsTruncated: true, columnsTruncated: true,
    });
  });

  it("caps a wide grid by total returned cells and stops at the next record", async () => {
    const width = PREVIEW_DOCUMENT_LIMITS.maxColumns;
    const rowLimit = Math.floor(PREVIEW_DOCUMENT_LIMITS.maxReturnedCells / width);
    const row = Array<string>(width).fill("x").join(",");
    const bytes = Buffer.from(`${`${row}\n`.repeat(rowLimit + 2)}"uninspected`);
    const doc = await parseTableDocument(bytes, "csv", 0);
    expect(doc.sheet.rows).toHaveLength(rowLimit);
    expect(doc.sheet.rows.every((cells) => cells.length === width)).toBe(true);
    expect(doc.sheet.rows.flat()).toHaveLength(PREVIEW_DOCUMENT_LIMITS.maxReturnedCells);
    expect(doc.sheet).toMatchObject({ totalRows: rowLimit + 1, totalColumns: width, rowsTruncated: true });
  });

  it("stops before uninspected suffix records and marks the count as a lower bound", async () => {
    const bytes = Buffer.from('a,b\n1,2\n3,4\n"uninspected');
    const doc = await parseTableDocument(bytes, "csv", 0, limits({ maxRows: 2 }));
    expect(doc.sheet).toMatchObject({ totalRows: 3, rowsTruncated: true, rows: [["a", "b"], ["1", "2"]] });
  });
});

describe("workbooks", () => {
  const sheets = {
    Summary: [["Region", "Total"], ["North", 120], ["South", 80]],
    Detail: [["id", "formula?"], [1, "=1+1"]],
  };

  it("lists every sheet and returns only the requested one (xlsx)", async () => {
    const bytes = workbook(sheets, "xlsx");
    const first = await parseTableDocument(bytes, "xlsx", 0);
    expect(first.sheetNames).toEqual(["Summary", "Detail"]);
    expect(first.totalSheets).toBe(2);
    expect(first.sheet).toMatchObject({ index: 0, name: "Summary", totalRows: 3, totalColumns: 2 });
    expect(first.sheet.rows).toEqual([["Region", "Total"], ["North", "120"], ["South", "80"]]);

    const second = await parseTableDocument(bytes, "xlsx", 1);
    expect(second.sheet.name).toBe("Detail");
    // A string that looks like a formula stays text.
    expect(second.sheet.rows[1]).toEqual(["1", "=1+1"]);
    expect((await refusal(() => parseTableDocument(bytes, "xlsx", 2))).code).toBe("sheet-not-found");
  });

  it("shows a formula's cached value, never its source or a re-evaluation", async () => {
    const ws = XLSX.utils.aoa_to_sheet([["a"]]);
    ws.B1 = { t: "n", v: 7, f: "SUM(1,2)" };
    ws["!ref"] = "A1:B1";
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "F");
    const doc = await parseTableDocument(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer, "xlsx", 0);
    expect(doc.sheet.rows).toEqual([["a", "7"]]);
  });

  it("reads ODS and legacy XLS workbooks", async () => {
    expect((await parseTableDocument(workbook(sheets, "ods"), "ods", 1)).sheet.rows[0]).toEqual(["id", "formula?"]);
    const xls = await parseTableDocument(workbook(sheets, "biff8"), "xls", 0);
    expect(xls.sheetNames).toEqual(["Summary", "Detail"]);
    expect(xls.sheet.rows[1]).toEqual(["North", "120"]);
  });

  it("caps rows, columns and sheet tabs with flags and keeps the source offsets", async () => {
    const grid = Array.from({ length: 30 }, (_, r) => Array.from({ length: 12 }, (_, c) => `${r}:${c}`));
    const many: Record<string, unknown[][]> = { Big: grid };
    for (let i = 0; i < 4; i += 1) many[`S${i}`] = [["x"]];
    const doc = await parseTableDocument(workbook(many, "xlsx"), "xlsx", 0, limits({ maxRows: 5, maxColumns: 4, maxSheets: 3 }));
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
    expect((await refusal(() => parseTableDocument(workbook(many, "xlsx"), "xlsx", 3, limits({ maxSheets: 3 })))).code)
      .toBe("sheet-not-found");

    const ws: XLSX.WorkSheet = { C3: { t: "s", v: "c3" }, D3: { t: "s", v: "d3" }, "!ref": "C3:D3" };
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Offset");
    const offset = await parseTableDocument(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer, "xlsx", 0);
    expect(offset.sheet).toMatchObject({ firstRow: 2, firstColumn: 2, rows: [["c3", "d3"]] });
  });

  it.each(["ods", "biff8"] as const)("reports row truncation with the true total for %s", async (bookType) => {
    const rows = Array.from({ length: 20 }, (_, r) => [`r${r}`, r]);
    const format = bookType === "ods" ? "ods" : "xls";
    const doc = await parseTableDocument(workbook({ S: rows, T: [["x"]] }, bookType), format, 0, limits({ maxRows: 5 }));
    expect(doc.sheet.rows).toHaveLength(5);
    expect(doc.sheet).toMatchObject({ totalRows: 20, rowsTruncated: true });
    expect(doc.sheetNames).toEqual(["S", "T"]);
  });

  it("returns an empty grid for an empty sheet", async () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([]), "Empty");
    const doc = await parseTableDocument(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer, "xlsx", 0);
    expect(doc.sheet).toMatchObject({ rows: [], totalRows: 0, totalColumns: 0, rowsTruncated: false });
  });

  it.each(["xlsx", "biff8"] as const)("keeps data beyond the absolute row cap for %s", async (bookType) => {
    const doc = await parseTableDocument(offsetWorkbook(bookType), bookType === "biff8" ? "xls" : "xlsx", 0);
    expect(doc.sheet).toMatchObject({
      firstRow: 10_000, firstColumn: 0, totalRows: 2, totalColumns: 2,
      rows: [["late value", ""], ["", "42"]], rowsTruncated: false,
    });
  });

  it("applies the total cell budget relative to a wide offset used range", async () => {
    const width = PREVIEW_DOCUMENT_LIMITS.maxColumns;
    const rowLimit = Math.floor(PREVIEW_DOCUMENT_LIMITS.maxReturnedCells / width);
    const first = { r: PREVIEW_DOCUMENT_LIMITS.maxRows, c: 2 };
    const last = { r: first.r + rowLimit * 2 - 1, c: first.c + width - 1 };
    const ws: XLSX.WorkSheet = {
      [XLSX.utils.encode_cell(first)]: { t: "s", v: "start" },
      [XLSX.utils.encode_cell(last)]: { t: "s", v: "end" },
      "!ref": XLSX.utils.encode_range(first, last),
    };
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Wide");
    const doc = await parseTableDocument(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer, "xlsx", 0);
    expect(doc.sheet.rows).toHaveLength(rowLimit);
    expect(doc.sheet.rows[0]?.[0]).toBe("start");
    expect(doc.sheet.rows.flat()).toHaveLength(PREVIEW_DOCUMENT_LIMITS.maxReturnedCells);
    expect(doc.sheet).toMatchObject({
      firstRow: first.r, firstColumn: first.c, totalRows: rowLimit * 2, totalColumns: width,
      rowsTruncated: true, columnsTruncated: false,
    });
  });

  it("refuses corrupt and mislabelled workbooks", async () => {
    expect((await refusal(() => parseTableDocument(Buffer.from("a,b\n1,2\n"), "xlsx", 0))).code).toBe("corrupt-document");
    expect((await refusal(() => parseTableDocument(Buffer.from("PK\u0003\u0004 not really a zip"), "xlsx", 0))).code)
      .toBe("corrupt-document");
    const truncated = workbook(sheets, "xlsx").subarray(0, 200);
    expect((await refusal(() => parseTableDocument(Buffer.from(truncated), "xlsx", 0))).code).toBe("corrupt-document");
    expect((await refusal(() => parseTableDocument(workbook(sheets, "biff8"), "ods", 0))).code).toBe("corrupt-document");
  });
});

describe("zip-bomb guard", () => {
  function zipOf(entries: Record<string, Buffer>): Buffer {
    const zip = new AdmZip();
    for (const [name, data] of Object.entries(entries)) zip.addFile(name, data);
    return zip.toBuffer();
  }

  it("refuses an archive whose inflated size exceeds the cap before parsing", async () => {
    const bomb = zipOf({ "[Content_Types].xml": Buffer.alloc(3 * 1024 * 1024, 0x20) });
    expect(bomb.length).toBeLessThan(64 * 1024);
    const err = await refusal(() => parseTableDocument(bomb, "xlsx", 0, limits({ maxUncompressedBytes: 2 * 1024 * 1024 })));
    expect(err.code).toBe("archive-too-large");
  });

  it("refuses an entry whose compression ratio is implausible", async () => {
    const bomb = zipOf({ "xl/sharedStrings.xml": Buffer.alloc(4 * 1024 * 1024, 0x41) });
    const err = await refusal(() => parseTableDocument(bomb, "xlsx", 0));
    expect(err.code).toBe("archive-too-large");
    expect(err.message).toContain("compression-ratio");
  });

  it("refuses an archive that understates an entry's real size in its headers", async () => {
    const zip = zipOf({ "xl/workbook.xml": Buffer.alloc(64 * 1024, 0x42) });
    // Patch the declared uncompressed size (local header @22, central header @24) to 10 bytes.
    const forged = Buffer.from(zip);
    forged.writeUInt32LE(10, 22);
    const central = forged.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    forged.writeUInt32LE(10, central + 24);
    const verdict = verifyZipInflateLimits(forged, PREVIEW_DOCUMENT_LIMITS);
    expect(verdict).toMatchObject({
      ok: false, reason: "size-mismatch", detail: "xl/workbook.xml inflates beyond its declared 10 bytes",
    });
    expect((await refusal(() => parseTableDocument(forged, "xlsx", 0))).code).toBe("archive-too-large");
  });

  it("refuses too many entries", async () => {
    const zip = zipOf({ a: Buffer.from("1"), b: Buffer.from("2"), c: Buffer.from("3") });
    expect(verifyZipInflateLimits(zip, { ...PREVIEW_DOCUMENT_LIMITS, maxArchiveEntries: 2 }))
      .toMatchObject({ ok: false, reason: "too-many-entries" });
  });

  it("passes a real workbook", async () => {
    const verdict = verifyZipInflateLimits(workbook({ A: [["x"]] }, "xlsx"), PREVIEW_DOCUMENT_LIMITS);
    expect(verdict.ok).toBe(true);
  });
});


describe("recalculated spreadsheet namespace attributes", () => {
  it("reads cached ODS values while retaining the source format", async () => {
    const document = await parseTableDocument(recalculatedOdsFixture(), "ods", 0);
    expect(document.format).toBe("ods");
    expect(document.sheet.rows).toEqual([["2", "5", "7"]]);
    expect(document.needsRecalculation).toBe(false);
  });
});
