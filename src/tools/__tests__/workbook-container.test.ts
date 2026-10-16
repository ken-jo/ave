import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";

import { createZipFixture } from "../../__tests__/support/zip-fixtures.js";
import { PREVIEW_DOCUMENT_LIMITS, type PreviewDocumentLimits } from "../../shared/preview-document.js";
import { TableDocumentError } from "../table-document-error.js";
import { prepareWorkbookContainer } from "../workbook-container.js";

const MIMETYPE = "application/vnd.oasis.opendocument.spreadsheet";

function workbook(bookType: XLSX.BookType): Buffer {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["name", "value"], ["item", 2]]), "Data");
  return XLSX.write(book, { type: "buffer", bookType }) as Buffer;
}

function odsContent(tables: string): Buffer {
  return createZipFixture([
    { name: "mimetype", data: MIMETYPE, method: 0 },
    {
      name: "META-INF/manifest.xml",
      data: `<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><manifest:file-entry manifest:full-path="/" manifest:media-type="${MIMETYPE}"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>`,
    },
    {
      name: "content.xml",
      data: `<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:spreadsheet>${tables}</office:spreadsheet></office:body></office:document-content>`,
    },
  ]);
}

function table(rows: string): string {
  return `<table:table table:name="Data">${rows}</table:table>`;
}

function row(attributes = "", cells = '<table:table-cell office:value-type="string"><text:p>x</text:p></table:table-cell>'): string {
  return `<table:table-row${attributes}>${cells}</table:table-row>`;
}

function refusal(bytes: Buffer, format: "xlsx" | "xls" | "ods", overrides: Partial<PreviewDocumentLimits> = {}): TableDocumentError {
  try {
    prepareWorkbookContainer(bytes, format, { ...PREVIEW_DOCUMENT_LIMITS, ...overrides });
  } catch (error) {
    if (error instanceof TableDocumentError) return error;
    throw error;
  }
  throw new Error("Expected a container refusal");
}

describe("workbook container validation", () => {
  it.each([
    ["xlsx", "xlsx"], ["ods", "ods"], ["xls", "biff8"],
  ] as const)("preserves ordinary %s workbook data", (format, bookType) => {
    const original = workbook(bookType);
    const checked = prepareWorkbookContainer(original, format, PREVIEW_DOCUMENT_LIMITS);
    const parsed = XLSX.read(checked, { type: "buffer" });
    expect(XLSX.utils.sheet_to_json(parsed.Sheets.Data!, { header: 1 })).toEqual([["name", "value"], ["item", 2]]);
    if (format !== "xls") expect(checked).not.toBe(original);
  });

  it("requires compound binary framing for the legacy extension", () => {
    expect(refusal(Buffer.from("a,b\n1,2\n"), "xls").code).toBe("corrupt-document");
    expect(refusal(workbook("xlsx"), "xls").code).toBe("corrupt-document");
    const descriptorMagic = workbook("xlsx");
    descriptorMagic.writeUInt32LE(0x08074b50, 0);
    expect(refusal(descriptorMagic, "xls").code).toBe("corrupt-document");
    const prefixed = Buffer.concat([Buffer.from([0x50, 0x4b, 0x07, 0x08]), workbook("xlsx")]);
    expect(refusal(prefixed, "xls").code).toBe("corrupt-document");
  });

  it("requires package parts that match the declared extension", () => {
    expect(refusal(workbook("ods"), "xlsx").code).toBe("corrupt-document");
    expect(refusal(workbook("xlsx"), "ods").code).toBe("corrupt-document");
    expect(refusal(workbook("biff8"), "xlsx").code).toBe("corrupt-document");
    expect(refusal(createZipFixture([{ name: "other.txt", data: "text" }]), "xlsx").code).toBe("corrupt-document");
  });

  it("requires the declared workbook relationship and content type", () => {
    for (const part of ["[Content_Types].xml", "_rels/.rels", "xl/_rels/workbook.xml.rels"]) {
      const archive = new AdmZip(workbook("xlsx"));
      archive.deleteFile(part);
      expect(refusal(archive.toBuffer(), "xlsx").code).toBe("corrupt-document");
    }
    const archive = new AdmZip(workbook("xlsx"));
    const types = archive.readAsText("[Content_Types].xml");
    archive.updateFile("[Content_Types].xml", Buffer.from(types.replace("spreadsheetml.sheet.main+xml", "spreadsheetml.template.main+xml")));
    expect(refusal(archive.toBuffer(), "xlsx").code).toBe("corrupt-document");
  });

  it.each([
    ["chartsheet", "worksheets/sheet1.xml", "Internal"],
    ["hyperlink", "https://example.test/other", "External"],
    ["worksheet", "https://example.test/other", "External"],
  ])("rejects duplicate worksheet IDs shadowed by %s relationships", (kind, target, mode) => {
    const archive = new AdmZip(workbook("xlsx"));
    const path = "xl/_rels/workbook.xml.rels";
    const xml = archive.readAsText(path);
    const id = /<Relationship\b[^>]*\bId="([^"]+)"/.exec(xml)?.[1];
    expect(id).toBeDefined();
    const duplicate = `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${kind}" Target="${target}" TargetMode="${mode}"/>`;
    archive.updateFile(path, Buffer.from(xml.replace("</Relationships>", `${duplicate}</Relationships>`)));
    expect(refusal(archive.toBuffer(), "xlsx").code).toBe("corrupt-document");
  });

  it.each(["Internal", "External"])("rejects duplicate root relationship IDs in %s mode", (mode) => {
    const archive = new AdmZip(workbook("xlsx"));
    const path = "_rels/.rels";
    const xml = archive.readAsText(path);
    const id = /<Relationship\b[^>]*\bId="([^"]+)"/.exec(xml)?.[1];
    expect(id).toBeDefined();
    const duplicate = `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.test/other" TargetMode="${mode}"/>`;
    archive.updateFile(path, Buffer.from(xml.replace("</Relationships>", `${duplicate}</Relationships>`)));
    expect(refusal(archive.toBuffer(), "xlsx").code).toBe("corrupt-document");
  });

  it.each([
    ["xl/_rels/workbook.xml.rels", "worksheet"],
    ["_rels/.rels", "officeDocument"],
  ])("rejects arbitrary relationship URI suffixes in %s", (path, kind) => {
    const archive = new AdmZip(workbook("xlsx"));
    const xml = archive.readAsText(path);
    archive.updateFile(path, Buffer.from(xml.replace(
      `http://schemas.openxmlformats.org/officeDocument/2006/relationships/${kind}`,
      `urn:unsupported/${kind}`,
    )));
    expect(refusal(archive.toBuffer(), "xlsx").code).toBe("corrupt-document");
  });

  it("checks duplicate IDs even when no sheet references them", () => {
    const archive = new AdmZip(workbook("xlsx"));
    const path = "xl/_rels/workbook.xml.rels";
    const xml = archive.readAsText(path);
    const duplicate = '<Relationship Id="unused" Type="urn:other" Target="other.xml"/>';
    archive.updateFile(path, Buffer.from(xml.replace("</Relationships>", `${duplicate}${duplicate}</Relationships>`)));
    expect(refusal(archive.toBuffer(), "xlsx").code).toBe("corrupt-document");
  });

  it("accepts the exact supported strict relationship URIs", () => {
    const archive = new AdmZip(workbook("xlsx"));
    for (const path of ["_rels/.rels", "xl/_rels/workbook.xml.rels"]) {
      archive.updateFile(path, Buffer.from(archive.readAsText(path).replaceAll(
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships/",
        "http://purl.oclc.org/ooxml/officeDocument/relationships/",
      )));
    }
    const checked = prepareWorkbookContainer(archive.toBuffer(), "xlsx", PREVIEW_DOCUMENT_LIMITS);
    expect(XLSX.utils.sheet_to_json(XLSX.read(checked, { type: "buffer" }).Sheets.Data!, { header: 1 }))
      .toEqual([["name", "value"], ["item", 2]]);
  });

  it("refuses archive wrappers and nested members", () => {
    const archive = new AdmZip(workbook("xlsx"));
    archive.addFile("embedded.bin", workbook("xlsx"));
    expect(refusal(archive.toBuffer(), "xlsx").code).toBe("corrupt-document");
    expect(refusal(createZipFixture([{ name: "wrapped.ods", data: workbook("ods") }]), "ods").code).toBe("corrupt-document");
  });

  it("rejects mixed document families before decoder selection", () => {
    const archive = new AdmZip(workbook("xlsx"));
    const ods = new AdmZip(odsContent(table(row(' table:number-rows-repeated="1000000000"'))));
    for (const entry of ods.getEntries()) archive.addFile(entry.entryName, entry.getData());
    expect(refusal(archive.toBuffer(), "xlsx").code).toBe("corrupt-document");
    expect(refusal(archive.toBuffer(), "ods").code).toBe("corrupt-document");
  });

  it("returns descriptor-free checked bytes for the parser", () => {
    const archive = new AdmZip(workbook("xlsx"));
    const bytes = createZipFixture(archive.getEntries().map((entry) => ({
      name: entry.entryName,
      data: entry.getData(),
      descriptor: "signed" as const,
    })));
    const checked = prepareWorkbookContainer(bytes, "xlsx", PREVIEW_DOCUMENT_LIMITS);
    expect(checked.length).toBeLessThan(bytes.length);
    expect(new AdmZip(checked).getEntries().every((entry) => (entry.header.flags & 8) === 0)).toBe(true);
    expect(XLSX.read(checked, { type: "buffer" }).SheetNames).toEqual(["Data"]);
  });
});

describe("expanded spreadsheet bounds", () => {
  it("accepts bounded repeated rows and cells", () => {
    const bytes = odsContent(table(row(' table:number-rows-repeated="3"', '<table:table-cell table:number-columns-repeated="2"><text:p>x</text:p></table:table-cell>')));
    expect(prepareWorkbookContainer(bytes, "ods", PREVIEW_DOCUMENT_LIMITS)).toBeInstanceOf(Buffer);
  });

  it.each([
    [' table:number-rows-repeated="1000000000"', '<table:table-cell/>'],
    ["", '<table:table-cell table:number-columns-repeated="1000000000"><text:p>x</text:p></table:table-cell>'],
    ["", '<table:covered-table-cell table:number-columns-repeated="1000000000"/>'],
  ])("refuses billion-fold expansion before a workbook parse", (attributes, cells) => {
    expect(refusal(odsContent(table(row(attributes, cells))), "ods").code).toBe("archive-too-large");
  });

  it("checks the product of repeated rows and columns", () => {
    const bytes = odsContent(table(row(' table:number-rows-repeated="2000"', '<table:table-cell table:number-columns-repeated="2000"/>')));
    expect(refusal(bytes, "ods").code).toBe("archive-too-large");
  });

  it("accumulates cells and rows across all tables", () => {
    const bytes = odsContent(table(row(' table:number-rows-repeated="3"')) + table(row(' table:number-rows-repeated="3"')));
    expect(refusal(bytes, "ods", { maxOdsExpandedRows: 5 }).code).toBe("archive-too-large");
    expect(refusal(bytes, "ods", { maxOdsExpandedCells: 5 }).code).toBe("archive-too-large");
  });

  it("counts repeated empty rows and column definitions", () => {
    expect(refusal(odsContent(table('<table:table-row table:number-rows-repeated="100001"/>')), "ods").code)
      .toBe("archive-too-large");
    expect(refusal(odsContent(table('<table:table-column table:number-columns-repeated="1000000000"/>')), "ods").code)
      .toBe("archive-too-large");
  });

  it.each(["0", "-1", "1e9", "Infinity", "1.5", "&#49;000000000"])("refuses ambiguous repeat value %s", (value) => {
    const bytes = odsContent(table(row(` table:number-rows-repeated="${value}"`)));
    expect(refusal(bytes, "ods").code).toBe("corrupt-document");
  });

  it("rejects conflicting effective repeat attributes", () => {
    const bytes = odsContent(table(row(' table:number-rows-repeated="1" other:number-rows-repeated="1000000000"')));
    expect(refusal(bytes, "ods").code).toBe("corrupt-document");
  });

  it("rejects element aliases that a permissive decoder could reinterpret", () => {
    const bytes = odsContent(table(row(' table:number-rows-repeated="1000000000"').replaceAll("table-row", "table-row_alias")));
    expect(refusal(bytes, "ods").code).toBe("corrupt-document");
  });

  it("ignores comments and refuses unsupported XML declarations", () => {
    const bytes = odsContent(table(`<!--${row(' table:number-rows-repeated="1000000000"')}-->${row()}`));
    expect(prepareWorkbookContainer(bytes, "ods", PREVIEW_DOCUMENT_LIMITS)).toBeInstanceOf(Buffer);
    const archive = new AdmZip(bytes);
    archive.updateFile("content.xml", Buffer.from(`<!DOCTYPE x [<!ENTITY n "1000000000">]>${archive.readAsText("content.xml")}`));
    expect(refusal(archive.toBuffer(), "ods").code).toBe("corrupt-document");
  });

  it("requires the spreadsheet mimetype and manifest entries", () => {
    const archive = new AdmZip(odsContent(table(row())));
    archive.updateFile("mimetype", Buffer.from("application/octet-stream"));
    expect(refusal(archive.toBuffer(), "ods").code).toBe("corrupt-document");
    archive.updateFile("mimetype", Buffer.from(MIMETYPE));
    archive.deleteFile("META-INF/manifest.xml");
    expect(refusal(archive.toBuffer(), "ods").code).toBe("corrupt-document");
  });
});
