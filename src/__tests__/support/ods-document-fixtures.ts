import { createZipFixture } from "./zip-fixtures.js";

export function odsDocumentFixture(tables: string): Buffer {
  const mimetype = "application/vnd.oasis.opendocument.spreadsheet";
  return createZipFixture([
    { name: "mimetype", data: mimetype, method: 0 },
    { name: "META-INF/manifest.xml", data: `<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><manifest:file-entry manifest:full-path="/" manifest:media-type="${mimetype}"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/></manifest:manifest>` },
    { name: "styles.xml", data: '<office:document-styles xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"><office:styles/></office:document-styles>' },
    { name: "content.xml", data: `<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:spreadsheet>${tables}</office:spreadsheet></office:body></office:document-content>` },
  ]);
}

/** Formula cache plus distinct standard and extension value-type attributes. */
export function recalculatedOdsFixture(): Buffer {
  return odsDocumentFixture('<table:table table:name="Data"><table:table-row><table:table-cell office:value-type="float" office:value="2"><text:p>2</text:p></table:table-cell><table:table-cell office:value-type="float" office:value="5"><text:p>5</text:p></table:table-cell><table:table-cell xmlns:calcext="urn:org:documentfoundation:names:experimental:calc:xmlns:calcext:1.0" office:value-type="float" calcext:value-type="float" office:value="7" xmlns:of="urn:oasis:names:tc:opendocument:xmlns:of:1.2" table:formula="of:=SUM([.A1:.B1])"><text:p>7</text:p></table:table-cell></table:table-row></table:table>');
}
