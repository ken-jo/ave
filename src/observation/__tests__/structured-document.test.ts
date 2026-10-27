import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import { wordDocumentFixture, textDocumentFixture } from "../../__tests__/support/structured-document-fixtures.js";
import { pdfFixture, presentationFixture } from "../../__tests__/support/page-document-fixtures.js";
import { createZipFixture } from "../../__tests__/support/zip-fixtures.js";
import { PAGE_PREVIEW_LIMITS, previewPageFormatOf } from "../../shared/preview-page-document.js";
import { PREVIEW_DOCUMENT_LIMITS } from "../../shared/preview-document.js";
import { readStructuredDocumentElements, readStructuredPageDocument } from "../structured-document.js";
import { readPageDocumentResponse } from "../../tools/preview-page-protocol.js";
import { parsePageDocument } from "../../tools/page-document-reader.js";

function replacePart(bytes: Buffer, path: string, change: (xml: string) => string): Buffer {
  const zip = new AdmZip(bytes);
  zip.updateFile(path, Buffer.from(change(zip.readAsText(path))));
  return zip.toBuffer();
}

describe("structured document source", () => {
  it("classifies the optional engine formats through the existing page route", () => {
    for (const format of ["docx", "odt", "pptx", "hwp", "hwpx", "pdf"] as const) {
      expect(previewPageFormatOf(`C:\\preview\\report.${format.toUpperCase()}`)).toBe(format);
    }
    expect(previewPageFormatOf("notes.docx.exe")).toBeNull();
  });

  it("preserves paragraph and run identities, text entities, tabs and line breaks", () => {
    const document = readStructuredPageDocument(wordDocumentFixture(), "docx", 0);
    expect(document.page.paragraphs).toEqual(["First & safe\tnext\nline", "Last paragraph"]);
    expect(document.elements).toEqual([
      { element: { kind: "paragraph", paragraph: 0 }, text: "First & safe\tnext\nline" },
      { element: { kind: "paragraph", paragraph: 0, run: 0 }, text: "First & safe" },
      { element: { kind: "paragraph", paragraph: 0, run: 1 }, text: "\tnext\nline" },
      { element: { kind: "paragraph", paragraph: 1 }, text: "Last paragraph" },
      { element: { kind: "paragraph", paragraph: 1, run: 0 }, text: "Last paragraph" },
    ]);
    expect(readPageDocumentResponse(document)).toBe(document);
    expect(readStructuredDocumentElements(wordDocumentFixture(), "docx")).toEqual(document.elements);
  });

  it("keeps empty paragraphs in source positions and decodes numeric references only once", () => {
    const document = readStructuredPageDocument(wordDocumentFixture('<w:p/><w:p><w:r><w:t>A&#8211;B &amp;#8211;</w:t></w:r></w:p>'), "docx", 0);
    expect(document.page.paragraphs).toEqual(["", "A–B &#8211;"]);
    expect(document.elements?.[1]?.element).toEqual({ kind: "paragraph", paragraph: 1 });
  });

  it("handles default namespaces and ignores unrelated namespace text", () => {
    const defaultNamespace = replacePart(wordDocumentFixture(), "word/document.xml", (text) => text.replaceAll("w:", "").replace("xmlns:w=", "xmlns="));
    expect(readStructuredPageDocument(defaultNamespace, "docx", 0).page.paragraphs).toEqual(["First & safe\tnext\nline", "Last paragraph"]);
    const foreign = wordDocumentFixture('<foreign:p xmlns:foreign="urn:unrelated"><foreign:r><foreign:t>unrelated</foreign:t></foreign:r></foreign:p><w:p><w:r><w:t>visible</w:t></w:r></w:p>');
    expect(readStructuredPageDocument(foreign, "docx", 0).page.paragraphs).toEqual(["visible"]);
  });

  it("treats hyperlinks as inert text and does not include field instructions", () => {
    const source = wordDocumentFixture('<w:p><w:hyperlink><w:r><w:t>label</w:t></w:r></w:hyperlink><w:r><w:instrText>FETCH remote</w:instrText><w:t>value</w:t></w:r></w:p>');
    expect(readStructuredPageDocument(source, "docx", 0).page.paragraphs).toEqual(["labelvalue"]);
  });

  it("excludes deleted revisions from visible run addresses", () => {
    const source = wordDocumentFixture('<w:p><w:r><w:t>first</w:t></w:r><w:del><w:r><w:delText>removed</w:delText></w:r></w:del><w:r><w:t>next</w:t></w:r></w:p>');
    const document = readStructuredPageDocument(source, "docx", 0);
    expect(document.page.paragraphs).toEqual(["firstnext"]);
    expect(document.elements).toEqual([
      { element: { kind: "paragraph", paragraph: 0 }, text: "firstnext" },
      { element: { kind: "paragraph", paragraph: 0, run: 0 }, text: "first" },
      { element: { kind: "paragraph", paragraph: 0, run: 1 }, text: "next" },
    ]);
  });

  it("extracts bounded text paragraphs and explicit spacing", () => {
    const document = readStructuredPageDocument(textDocumentFixture(), "odt", 0);
    expect(document.page.paragraphs).toEqual(["Heading", "First & safe   next\t\nline"]);
    expect(document.elements).toEqual([
      { element: { kind: "paragraph", paragraph: 0 }, text: "Heading" },
      { element: { kind: "paragraph", paragraph: 1 }, text: "First & safe   next\t\nline" },
    ]);
    expect(readPageDocumentResponse(document)).toBe(document);
  });

  it("bounds expanded spaces before constructing outline content", () => {
    const body = '<text:p>' + '<text:s text:c="50000"/>'.repeat(1000) + '</text:p>';
    const document = readStructuredPageDocument(textDocumentFixture(body), "odt", 0);
    expect(document.page.paragraphs.join("")).toHaveLength(PAGE_PREVIEW_LIMITS.maxTextChars);
    expect(document.page.textTruncated).toBe(true);
    expect(() => readStructuredPageDocument(textDocumentFixture('<text:p><text:s text:c="999999999999999999"/></text:p>'), "odt", 0))
      .toThrow(expect.objectContaining({ code: "parse-limit" }));
  });

  it("identifies shapes by declared IDs and keeps relationship slide order", () => {
    const source = replacePart(presentationFixture(), "ppt/slides/slide2.xml", (text) => text.replace('id="2" name="Text"', 'id="17" name="Title"'));
    const first = readStructuredPageDocument(source, "pptx", 0);
    expect(first.elements).toEqual([{ element: { kind: "shape", slide: 0, shapeId: "17" }, text: "First & safe\nNext line" }]);
    expect(readStructuredPageDocument(source, "pptx", 1).elements).toEqual([
      { element: { kind: "shape", slide: 1, shapeId: "2" }, text: "Last slide" },
    ]);
    expect(readStructuredDocumentElements(source, "pptx")).toHaveLength(2);
    expect(readPageDocumentResponse(first)).toBe(first);
  });

  it("refuses duplicate shape identities instead of coalescing unrelated shapes", () => {
    const source = replacePart(presentationFixture(), "ppt/slides/slide2.xml", (text) => text.replace('id="2" name="Text"', 'id="7" name="Title"')
      .replace("</p:spTree>", '<p:sp><p:nvSpPr><p:cNvPr id="7" name="Second"/></p:nvSpPr></p:sp></p:spTree>'));
    expect(() => readStructuredPageDocument(source, "pptx", 0)).toThrow(expect.objectContaining({ code: "corrupt-document" }));
  });

  it("keeps declared shape addresses stable through insertion and reordering", () => {
    const original = presentationFixture();
    const extra = '<p:sp><p:nvSpPr><p:cNvPr id="9" name="Inserted"/></p:nvSpPr><p:txBody><a:p><a:r><a:t>Inserted text</a:t></a:r></a:p></p:txBody></p:sp>';
    const first = readStructuredPageDocument(original, "pptx", 0).elements!;
    const before = replacePart(original, "ppt/slides/slide2.xml", (text) => text.replace("<p:spTree>", `<p:spTree>${extra}`));
    const after = replacePart(original, "ppt/slides/slide2.xml", (text) => text.replace("</p:spTree>", `${extra}</p:spTree>`));
    for (const source of [before, after]) {
      const elements = readStructuredPageDocument(source, "pptx", 0).elements!;
      expect(elements.find((entry) => entry.element.kind === "shape" && entry.element.shapeId === "2")).toEqual(first[0]);
      expect(elements.find((entry) => entry.element.kind === "shape" && entry.element.shapeId === "9")?.text).toBe("Inserted text");
    }
  });

  it("refuses missing shape IDs and duplicate identities across group boundaries", () => {
    const original = presentationFixture();
    for (const change of [
      (text: string) => text.replace(' id="2"', ""),
      (text: string) => text.replace(/<p:nvSpPr>[\s\S]*?<\/p:nvSpPr>/, ""),
      (text: string) => text.replace("<p:spTree>", '<p:spTree><p:grpSp><p:nvGrpSpPr><p:cNvPr id="2" name="Group"/></p:nvGrpSpPr>')
        .replace("</p:spTree>", "</p:grpSp></p:spTree>"),
      (text: string) => text.replace("</p:spTree>", '<p:sp><p:nvSpPr><p:cNvPr id="02" name="Duplicate"/></p:nvSpPr></p:sp></p:spTree>'),
    ]) expect(() => readStructuredPageDocument(replacePart(original, "ppt/slides/slide2.xml", change), "pptx", 0))
      .toThrow(expect.objectContaining({ code: "corrupt-document" }));
    const grouped = replacePart(original, "ppt/slides/slide2.xml", (text) => text.replace("<p:spTree>", '<p:spTree><p:grpSp><p:nvGrpSpPr><p:cNvPr id="8" name="Group"/></p:nvGrpSpPr>')
      .replace("</p:spTree>", "</p:grpSp></p:spTree>"));
    expect(readStructuredPageDocument(grouped, "pptx", 0).elements).toEqual([
      { element: { kind: "shape", slide: 0, shapeId: "8" }, text: "" },
      { element: { kind: "shape", slide: 0, shapeId: "2" }, text: "First & safe\nNext line" },
    ]);
  });

  it("fails explicitly when import requires the absent engine", async () => {
    for (const format of ["hwp", "hwpx"] as const) await expect(parsePageDocument(Buffer.from("input"), format, 0))
      .rejects.toMatchObject({ code: "engine-unavailable" });
  });

  it("provides deterministic bounded outlines through the page parser", async () => {
    for (const [format, input] of [["docx", wordDocumentFixture()], ["odt", textDocumentFixture()]] as const) {
      const document = await parsePageDocument(input, format, 0);
      expect(document).toEqual(readStructuredPageDocument(input, format, 0));
      expect(document.page.png).toBeNull();
      await expect(parsePageDocument(input, format, 1)).rejects.toMatchObject({ code: "page-not-found" });
    }
  });

  it("refuses missing required parts, mismatched media types and external roots", () => {
    for (const missing of ["[Content_Types].xml", "_rels/.rels", "word/document.xml"]) {
      const zip = new AdmZip(wordDocumentFixture());
      zip.deleteFile(missing);
      expect(() => readStructuredPageDocument(zip.toBuffer(), "docx", 0), missing).toThrow(expect.objectContaining({ code: "corrupt-document" }));
    }
    const external = replacePart(wordDocumentFixture(), "_rels/.rels", (text) => text.replace('Target="word/document.xml"', 'Target="https://example.test/document.xml" TargetMode="External"'));
    expect(() => readStructuredPageDocument(external, "docx", 0)).toThrow(expect.objectContaining({ code: "corrupt-document" }));
    const otherType = replacePart(wordDocumentFixture(), "[Content_Types].xml", (text) => text.replace("wordprocessingml.document.main+xml", "wordprocessingml.template.main+xml"));
    expect(() => readStructuredPageDocument(otherType, "docx", 0)).toThrow(expect.objectContaining({ code: "corrupt-document" }));
    const otherMime = replacePart(textDocumentFixture(), "mimetype", () => "application/vnd.oasis.opendocument.spreadsheet");
    expect(() => readStructuredPageDocument(otherMime, "odt", 0)).toThrow(expect.objectContaining({ code: "corrupt-document" }));
  });

  it("rejects encrypted native text packages before parsing their content", () => {
    const encrypted = replacePart(textDocumentFixture(), "META-INF/manifest.xml", (text) => text.replace("</manifest:manifest>", "<manifest:encryption-data/></manifest:manifest>"));
    expect(() => readStructuredPageDocument(encrypted, "odt", 0)).toThrow(expect.objectContaining({ code: "encrypted" }));
  });

  it("refuses entity declarations, unbound namespaces, reserved parser names and excessive depth", () => {
    for (const body of [
      '<!DOCTYPE document [<!ENTITY contents SYSTEM "file:///private/value">]><w:p/>',
      '<unknown:p><unknown:r>text</unknown:r></unknown:p>',
      '<w:__proto__>text</w:__proto__>',
      '<w:span attr="/>">'.repeat(PAGE_PREVIEW_LIMITS.maxXmlDepth + 1) + "text" + '</w:span>'.repeat(PAGE_PREVIEW_LIMITS.maxXmlDepth + 1),
    ]) expect(() => readStructuredPageDocument(wordDocumentFixture(body), "docx", 0)).toThrow();
  });

  it("rejects nested packages, excessive inflation and oversized input", () => {
    expect(() => readStructuredPageDocument(createZipFixture([{ name: "nested.docx", data: wordDocumentFixture() }]), "docx", 0))
      .toThrow(expect.objectContaining({ code: "corrupt-document" }));
    const inflated = new AdmZip(wordDocumentFixture());
    inflated.addFile("word/media/large.bin", Buffer.alloc(PREVIEW_DOCUMENT_LIMITS.ratioCheckMinBytes * 8));
    expect(() => readStructuredPageDocument(inflated.toBuffer(), "docx", 0)).toThrow(expect.objectContaining({ code: "archive-too-large" }));
    expect(() => readStructuredPageDocument(Buffer.alloc(PREVIEW_DOCUMENT_LIMITS.maxFileBytes + 1), "docx", 0))
      .toThrow(expect.objectContaining({ code: "too-large" }));
  });

  it("carries paragraph and element clipping through the existing truncation signal", () => {
    const document = readStructuredPageDocument(wordDocumentFixture(`<w:p><w:r><w:t>${"😀".repeat(PAGE_PREVIEW_LIMITS.maxTextChars)}</w:t></w:r></w:p>`), "docx", 0);
    expect(document.page.paragraphs.join("")).toHaveLength(PAGE_PREVIEW_LIMITS.maxTextChars);
    expect(document.page.paragraphs[0]?.endsWith("😀")).toBe(true);
    expect(document.page.textTruncated).toBe(true);
    expect(readPageDocumentResponse(document)).toBe(document);
    const many = readStructuredPageDocument(wordDocumentFixture('<w:p><w:r><w:t>x</w:t></w:r></w:p>'.repeat(PAGE_PREVIEW_LIMITS.maxParagraphs + 1)), "docx", 0);
    expect(many.page.paragraphs).toHaveLength(PAGE_PREVIEW_LIMITS.maxParagraphs);
    expect(many.elements?.length).toBeLessThanOrEqual(PAGE_PREVIEW_LIMITS.maxParagraphs);
    expect(many.page.textTruncated).toBe(true);
  });

  it("validates element shapes, format consistency, selection and byte ceilings", () => {
    const word = readStructuredPageDocument(wordDocumentFixture(), "docx", 0);
    const shape = { element: { kind: "shape", slide: 0, shapeId: "a" }, text: "text" };
    for (const elements of [
      [shape], [{ element: { kind: "paragraph", paragraph: -1 }, text: "text" }],
      [{ element: { kind: "paragraph", paragraph: 0, run: "0" }, text: "text" }],
      [{ element: { kind: "paragraph", paragraph: 0, extra: true }, text: "text" }],
      [{ element: { kind: "paragraph", paragraph: 0 }, text: "x".repeat(PAGE_PREVIEW_LIMITS.maxTextChars + 1) }],
      [word.elements![0], word.elements![0]],
    ]) expect(() => readPageDocumentResponse({ ...word, elements })).toThrow();
    const slide = readStructuredPageDocument(presentationFixture(), "pptx", 0);
    expect(() => readPageDocumentResponse({ ...slide, elements: [{ ...shape, element: { ...shape.element, slide: 1 } }] })).toThrow();
    expect(() => readPageDocumentResponse({ ...slide, elements: [{ ...shape, element: { ...shape.element, shapeId: "bad\0id" } }] })).toThrow();
    expect(() => readPageDocumentResponse({ ...word, elements: undefined })).toThrow();
    expect(() => readPageDocumentResponse({ ...word, another: true })).toThrow();
  });

  it("accepts a validated rendered page together with its original structured source", async () => {
    const source = readStructuredPageDocument(wordDocumentFixture(), "docx", 0);
    const rendered = await parsePageDocument(pdfFixture(), "pdf", 0);
    const document = { ...rendered, format: "docx" as const, elements: source.elements };
    expect(readPageDocumentResponse(document)).toBe(document);
    expect(() => readPageDocumentResponse({ ...rendered, elements: source.elements })).toThrow();
  });
});
