import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";

import { createZipFixture } from "../../__tests__/support/zip-fixtures.js";
import { PREVIEW_DOCUMENT_LIMITS, type PreviewDocumentLimits } from "../../shared/preview-document.js";
import { TableDocumentError } from "../table-document-error.js";
import { prepareWorkbookContainer } from "../workbook-container.js";

const MIMETYPE = "application/vnd.oasis.opendocument.spreadsheet";
const SPREADSHEET_MAIN_NAMESPACE = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";

function workbook(bookType: XLSX.BookType, bookSST = false): Buffer {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["name", "value"], ["item", 2]]), "Data");
  return XLSX.write(book, { type: "buffer", bookType, bookSST }) as Buffer;
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

function refusal(
  bytes: Buffer,
  format: "xlsx" | "xls" | "ods",
  overrides: Partial<PreviewDocumentLimits> = {},
  sheetIndex = 0,
): TableDocumentError {
  try {
    prepareWorkbookContainer(bytes, format, { ...PREVIEW_DOCUMENT_LIMITS, ...overrides }, sheetIndex);
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
    const checked = prepareWorkbookContainer(original, format, PREVIEW_DOCUMENT_LIMITS, 0);
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
    const checked = prepareWorkbookContainer(archive.toBuffer(), "xlsx", PREVIEW_DOCUMENT_LIMITS, 0);
    expect(XLSX.utils.sheet_to_json(XLSX.read(checked, { type: "buffer" }).Sheets.Data!, { header: 1 }))
      .toEqual([["name", "value"], ["item", 2]]);
  });

  it.each(["xl/sharedStrings.xml", "xl/worksheets/sheet1.xml", "docProps/app.xml"])(
    "refuses XML declarations in decoder-read part %s",
    (part) => {
      const archive = new AdmZip(workbook("xlsx", true));
      expect(prepareWorkbookContainer(archive.toBuffer(), "xlsx", PREVIEW_DOCUMENT_LIMITS, 0)).toBeInstanceOf(Buffer);
      const xml = archive.readAsText(part);
      archive.updateFile(part, Buffer.from(xml.replace("?>", '?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]>')));
      expect(refusal(archive.toBuffer(), "xlsx").code).toBe("corrupt-document");
    },
  );

  it("fully scans the requested worksheet and only byte-checks the others", () => {
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["first"]]), "First");
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["second"]]), "Second");
    const archive = new AdmZip(XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer);
    const part = "xl/worksheets/sheet2.xml";
    const xml = archive.readAsText(part);
    // Duplicate effective attribute names fail only the full tag scan.
    archive.updateFile(part, Buffer.from(xml.replace("</worksheet>", '<x:junk a="1" A="2"/></worksheet>')));
    const bytes = archive.toBuffer();
    expect(XLSX.read(prepareWorkbookContainer(bytes, "xlsx", PREVIEW_DOCUMENT_LIMITS, 0), { type: "buffer", sheets: [0] })
      .Sheets.First).toBeDefined();
    expect(refusal(bytes, "xlsx", {}, 1).code).toBe("corrupt-document");

    archive.updateFile(part, Buffer.from(xml.replace("?>", '?><!DOCTYPE x [<!ENTITY e "e">]>')));
    expect(refusal(archive.toBuffer(), "xlsx", {}, 0).code).toBe("corrupt-document");

    archive.updateFile(part, Buffer.from(xml));
    archive.addFile("xl/comments1.xml", Buffer.from('<comments a="1" A="2"/>'));
    archive.addFile("xl/worksheets/_rels/sheet1.xml.rels", Buffer.from(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="../comments1.xml"/></Relationships>',
    ));
    expect(prepareWorkbookContainer(archive.toBuffer(), "xlsx", PREVIEW_DOCUMENT_LIMITS, 1)).toBeInstanceOf(Buffer);
    expect(refusal(archive.toBuffer(), "xlsx", {}, 0).code).toBe("corrupt-document");
  });

  it("refuses XML parts that a non-XML name would keep from the scan", () => {
    const archive = new AdmZip(workbook("xlsx", true));
    const strings = archive.getEntry("xl/sharedStrings.xml")!.getData();
    archive.deleteFile("xl/sharedStrings.xml");
    archive.addFile("xl/sharedStrings.dat", strings);
    const types = archive.readAsText("[Content_Types].xml");
    archive.updateFile("[Content_Types].xml", Buffer.from(types.replace("/xl/sharedStrings.xml", "/xl/sharedStrings.dat")));
    expect(refusal(archive.toBuffer(), "xlsx").code).toBe("corrupt-document");

    const comments = new AdmZip(workbook("xlsx"));
    comments.addFile("xl/comments1.dat", Buffer.from("<comments/>"));
    comments.addFile("xl/worksheets/_rels/sheet1.xml.rels", Buffer.from(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="../comments1.dat"/></Relationships>',
    ));
    expect(refusal(comments.toBuffer(), "xlsx").code).toBe("corrupt-document");
  });

  it("byte-checks the legacy drawing the decoder reads", () => {
    const vmlDrawing = (target: string, vml: string): Buffer => {
      const archive = new AdmZip(workbook("xlsx"));
      const sheet = archive.readAsText("xl/worksheets/sheet1.xml");
      archive.updateFile("xl/worksheets/sheet1.xml", Buffer.from(sheet.replace(
        "</worksheet>",
        '<legacyDrawing r:id="rId9" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/></worksheet>',
      )));
      archive.addFile(`xl/drawings/${target}`, Buffer.from(vml));
      archive.addFile("xl/worksheets/_rels/sheet1.xml.rels", Buffer.from(
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/vmlDrawing" Target="../drawings/${target}"/></Relationships>`,
      ));
      return archive.toBuffer();
    };
    // Excel's VML is not well-formed, so only the declaration bytes are checked.
    expect(prepareWorkbookContainer(vmlDrawing("vmlDrawing1.vml", "<xml><x:Row>0<br></x:Row></xml>"), "xlsx", PREVIEW_DOCUMENT_LIMITS, 0))
      .toBeInstanceOf(Buffer);
    expect(refusal(vmlDrawing("vmlDrawing1.vml", '<!DOCTYPE x [<!ENTITY e "e">]><xml/>'), "xlsx")).toMatchObject({
      code: "corrupt-document", message: expect.stringContaining("declarations"),
    });
    expect(refusal(vmlDrawing("vmlDrawing1.bin", "<xml/>"), "xlsx")).toMatchObject({
      code: "corrupt-document", message: expect.stringContaining("Legacy drawing"),
    });
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
    const checked = prepareWorkbookContainer(bytes, "xlsx", PREVIEW_DOCUMENT_LIMITS, 0);
    expect(checked.length).toBeLessThan(bytes.length);
    expect(new AdmZip(checked).getEntries().every((entry) => (entry.header.flags & 8) === 0)).toBe(true);
    expect(XLSX.read(checked, { type: "buffer" }).SheetNames).toEqual(["Data"]);
  });
});

describe("workbook calculation state", () => {
  function calculationState(
    children: string,
    rootAttributes = `xmlns="${SPREADSHEET_MAIN_NAMESPACE}"`,
    rootName = "workbook",
  ): boolean {
    const archive = new AdmZip(workbook("xlsx"));
    archive.updateFile("xl/workbook.xml", Buffer.from(
      `<${rootName} ${rootAttributes} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`
      + `<sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets>${children}</${rootName}>`,
    ));
    let state: boolean | undefined;
    prepareWorkbookContainer(archive.toBuffer(), "xlsx", PREVIEW_DOCUMENT_LIMITS, 0, (value) => { state = value; });
    expect(state).toBeDefined();
    return state!;
  }

  it.each([
    ['fullCalcOnLoad="1"', true],
    ['fullCalcOnLoad="true"', true],
    ['fullCalcOnLoad="&#49;"', true],
    ['fullCalcOnLoad="&#x31;"', true],
    ['fullCalcOnLoad="&#x74;rue"', true],
    ['forceFullCalc="&#49;"', true],
    ['calcCompleted="&#48;"', true],
    ['calcCompleted="&#x66;alse"', true],
    ['fullCalcOnLoad=" \ttrue\r\n "', true],
    ['fullCalcOnLoad="&#x9;1&#xA;"', true],
    ['fullCalcOnLoad="0" forceFullCalc="false" calcCompleted="1"', false],
    ['fullCalcOnLoad="tr\nue"', false],
    ['fullCalcOnLoad="&amp;#49;"', false],
    ['fullCalcOnLoad="&lt;1&gt;"', false],
    ['fullCalcOnLoad="&apos;1&quot;"', false],
    ['fullCalcOnLoad="&custom;"', false],
    ['fullCalcOnLoad="&#0;1"', false],
    ['fullCalcOnLoad="&#xD800;1"', false],
    ['fullCalcOnLoad="&#x110000;1"', false],
    ['fullCalcOnLoad="&#xA0;1"', false],
    ['fullcalconload="1"', false],
    ['other:fullCalcOnLoad="1" xmlns:other="urn:other"', false],
  ] as const)("normalizes calculation attributes %s", (attributes, expected) => {
    expect(calculationState(`<calcPr ${attributes}/>`)).toBe(expected);
  });

  it("accepts a prefixed workbook and calculation element", () => {
    expect(calculationState('<s:calcPr fullCalcOnLoad="1"/>', `xmlns:s="${SPREADSHEET_MAIN_NAMESPACE}"`, "s:workbook"))
      .toBe(true);
  });

  it("accepts inherited and locally declared calculation prefixes", () => {
    expect(calculationState('<s:calcPr forceFullCalc="true"/>', `xmlns="${SPREADSHEET_MAIN_NAMESPACE}" xmlns:s="${SPREADSHEET_MAIN_NAMESPACE}"`))
      .toBe(true);
    expect(calculationState(`<s:calcPr xmlns:s="${SPREADSHEET_MAIN_NAMESPACE}" calcCompleted="false"/>`)).toBe(true);
  });

  it("accepts a default namespace on a child of a prefixed workbook", () => {
    expect(calculationState(`<calcPr xmlns="${SPREADSHEET_MAIN_NAMESPACE}" fullCalcOnLoad="1"/>`,
      `xmlns:s="${SPREADSHEET_MAIN_NAMESPACE}"`, "s:workbook")).toBe(true);
  });

  it("keeps a prefixed workbook namespace separate from its default namespace", () => {
    expect(calculationState('<calcPr fullCalcOnLoad="1"/>', `xmlns:s="${SPREADSHEET_MAIN_NAMESPACE}"`, "s:workbook"))
      .toBe(false);
    expect(calculationState('<s:calcPr fullCalcOnLoad="1"/>',
      `xmlns="urn:other" xmlns:s="${SPREADSHEET_MAIN_NAMESPACE}"`, "s:workbook")).toBe(true);
  });

  it("decodes numeric references in namespace attributes", () => {
    expect(calculationState('<calcPr fullCalcOnLoad="1"/>', `xmlns="${SPREADSHEET_MAIN_NAMESPACE.replaceAll("/", "&#47;")}"`))
      .toBe(true);
  });

  it("accepts the strict main namespace", () => {
    expect(calculationState('<calcPr fullCalcOnLoad="1"/>', 'xmlns="http://purl.oclc.org/ooxml/spreadsheetml/main"')).toBe(true);
  });

  it.each([
    [SPREADSHEET_MAIN_NAMESPACE, "http://purl.oclc.org/ooxml/spreadsheetml/main"],
    ["http://purl.oclc.org/ooxml/spreadsheetml/main", SPREADSHEET_MAIN_NAMESPACE],
  ])("ignores calculation properties mixing root namespace %s with child namespace %s", (rootNamespace, childNamespace) => {
    expect(calculationState(`<calcPr xmlns="${childNamespace}" fullCalcOnLoad="1"/>`, `xmlns="${rootNamespace}"`))
      .toBe(false);
  });

  it("ignores a foreign calculation element inside an extension list", () => {
    expect(calculationState('<extLst><ext uri="urn:extension"><other:calcPr xmlns:other="urn:other" fullCalcOnLoad="1"/></ext></extLst>'))
      .toBe(false);
  });

  it.each([
    '<extLst><calcPr fullCalcOnLoad="1"/></extLst>',
    '<workbook><calcPr fullCalcOnLoad="1"/></workbook>',
    '<calcPr xmlns="urn:other" fullCalcOnLoad="1"/>',
    '<calcPr xmlns="" fullCalcOnLoad="1"/>',
    '<other:calcPr xmlns:other="urn:other" fullCalcOnLoad="1"/>',
    '<other:calcPr fullCalcOnLoad="1"/>',
    '<!-- <calcPr fullCalcOnLoad="1"/> -->',
  ])("ignores calculation properties outside the direct main-namespace child: %s", (children) => {
    expect(calculationState(children)).toBe(false);
  });

  it("requires the workbook root to use the main namespace", () => {
    expect(calculationState(`<calcPr xmlns="${SPREADSHEET_MAIN_NAMESPACE}" fullCalcOnLoad="1"/>`, 'xmlns="urn:other"')).toBe(false);
    expect(calculationState(`<calcPr xmlns="${SPREADSHEET_MAIN_NAMESPACE}" fullCalcOnLoad="1"/>`, "")).toBe(false);
  });

  it("resolves prefix shadowing and restores sibling namespace scope", () => {
    const rootAttributes = `xmlns="${SPREADSHEET_MAIN_NAMESPACE}" xmlns:s="${SPREADSHEET_MAIN_NAMESPACE}"`;
    expect(calculationState('<s:calcPr xmlns:s="urn:other" fullCalcOnLoad="1"/>', rootAttributes)).toBe(false);
    expect(calculationState('<extLst xmlns="urn:other" xmlns:s="urn:other"/><s:calcPr fullCalcOnLoad="1"/>', rootAttributes)).toBe(true);
    expect(calculationState('<extLst xmlns="urn:other"><ext/></extLst><calcPr fullCalcOnLoad="1"/>')).toBe(true);
  });

  it("still refuses custom entity declarations before calculation inspection", () => {
    expect(() => calculationState('<!DOCTYPE workbook [<!ENTITY flag "1">]><calcPr fullCalcOnLoad="&flag;"/>'))
      .toThrow("Package XML declarations and text sections are unsupported");
  });
});

describe("expanded spreadsheet bounds", () => {
  it("accepts bounded repeated rows and cells", () => {
    const bytes = odsContent(table(row(' table:number-rows-repeated="3"', '<table:table-cell table:number-columns-repeated="2"><text:p>x</text:p></table:table-cell>')));
    expect(prepareWorkbookContainer(bytes, "ods", PREVIEW_DOCUMENT_LIMITS, 0)).toBeInstanceOf(Buffer);
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
    expect(prepareWorkbookContainer(bytes, "ods", PREVIEW_DOCUMENT_LIMITS, 0)).toBeInstanceOf(Buffer);
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
