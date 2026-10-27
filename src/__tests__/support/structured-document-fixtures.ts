import { createZipFixture } from "./zip-fixtures.js";

export function wordDocumentFixture(body = '<w:p><w:r><w:t>First &amp; safe</w:t></w:r><w:r><w:tab/><w:t>next</w:t><w:br/><w:t>line</w:t></w:r></w:p><w:p><w:r><w:t>Last paragraph</w:t></w:r></w:p>'): Buffer {
  return createZipFixture([
    { name: "[Content_Types].xml", data: '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>' },
    { name: "_rels/.rels", data: '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="root" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
    { name: "word/document.xml", data: `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>` },
  ]);
}

export function textDocumentFixture(body = '<text:h>Heading</text:h><text:p>First &amp; safe<text:s text:c="3"/><text:span>next</text:span><text:tab/><text:line-break/>line</text:p>'): Buffer {
  return createZipFixture([
    { name: "mimetype", data: "application/vnd.oasis.opendocument.text" },
    { name: "META-INF/manifest.xml", data: '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>' },
    { name: "content.xml", data: `<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:text>${body}</office:text></office:body></office:document-content>` },
  ]);
}
