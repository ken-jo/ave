import AdmZip from "adm-zip";
import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { pdfFixture, presentationFixture } from "../../__tests__/support/page-document-fixtures.js";
import { offsetWorkbook } from "../../__tests__/support/table-document-fixtures.js";
import { createZipFixture } from "../../__tests__/support/zip-fixtures.js";
import { PAGE_PREVIEW_LIMITS } from "../../shared/preview-page-document.js";
import { parsePageDocument } from "../page-document-reader.js";
import { readPageDocumentResponse } from "../preview-page-protocol.js";

function pngChunk(kind: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length);
  chunk.write(kind, 4, 4, "ascii");
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, chunk.length - 4)), chunk.length - 4);
  return chunk;
}

describe("page document previews", () => {
  it("follows slide relationships and preserves runs, escapes and breaks", async () => {
    const first = await parsePageDocument(presentationFixture(), "pptx", 0);
    expect(first).toMatchObject({ format: "pptx", totalPages: 2, page: { index: 0, paragraphs: ["First & safe\nNext line"], png: null } });
    expect(readPageDocumentResponse(first)).toBe(first);
    expect((await parsePageDocument(presentationFixture(), "pptx", 1)).page.paragraphs).toEqual(["Last slide"]);
  });

  it("reads slide text without opening embedded workbook packages", async () => {
    const zip = new AdmZip(presentationFixture());
    zip.addFile("ppt/embeddings/data.xlsx", offsetWorkbook("xlsx"));
    expect((await parsePageDocument(zip.toBuffer(), "pptx", 0)).page.paragraphs).toEqual(["First & safe\nNext line"]);
  });

  it("resolves relationship prefixes from their inherited XML namespace scope", async () => {
    const source = new AdmZip(presentationFixture());
    const part = "ppt/presentation.xml";
    const text = source.readAsText(part);
    const declaration = / xmlns:r="([^"]+)"/.exec(text)!;
    for (const changed of [
      text.replace(declaration[0], `${declaration[0]} xmlns:alias="${declaration[1]}"`),
      text.replace(declaration[0], ` xmlns:alias="${declaration[1]}"`).replaceAll("r:id=", "alias:id="),
      text.replace(declaration[0], "").replace("<p:sldIdLst>", `<p:sldIdLst${declaration[0]}>`),
      text.replace(declaration[0], "").replaceAll("<p:sldId ", `<p:sldId${declaration[0]} `),
      text.replace(declaration[0], ' xmlns:r="urn:unrelated"').replace("<p:sldIdLst>", `<p:sldIdLst${declaration[0]}>`),
    ]) {
      const zip = new AdmZip(presentationFixture());
      zip.updateFile(part, Buffer.from(changed));
      expect((await parsePageDocument(zip.toBuffer(), "pptx", 0)).page.paragraphs).toEqual(["First & safe\nNext line"]);
    }
    for (const changed of [
      text.replace("<p:sldIdLst>", '<p:sldIdLst xmlns:r="urn:unrelated">'),
      text.replace(declaration[0], `${declaration[0]} xmlns:alias="${declaration[1]}"`)
        .replace('r:id="second"', 'r:id="second" alias:id="second"'),
    ]) {
      const zip = new AdmZip(presentationFixture());
      zip.updateFile(part, Buffer.from(changed));
      await expect(parsePageDocument(zip.toBuffer(), "pptx", 0)).rejects.toMatchObject({ code: "corrupt-document" });
    }
  });

  it("reports an unavailable page for an empty presentation", async () => {
    for (const replacement of ["", "<p:sldIdLst/>"]) {
      const zip = new AdmZip(presentationFixture());
      const part = "ppt/presentation.xml";
      zip.updateFile(part, Buffer.from(zip.readAsText(part).replace(/<p:sldIdLst>[\s\S]*?<\/p:sldIdLst>/, replacement)));
      await expect(parsePageDocument(zip.toBuffer(), "pptx", 0)).rejects.toMatchObject({ code: "page-not-found" });
    }
  });

  it("renders a real PDF page into a bounded image with extractable text", async () => {
    const first = await parsePageDocument(pdfFixture(), "pdf", 0);
    expect(first).toMatchObject({ format: "pdf", totalPages: 2, page: { index: 0, paragraphs: ["First PDF page"] } });
    expect(first.page.png).toMatch(/^iVBORw0KGgo/);
    expect(first.page.width * first.page.height).toBeLessThanOrEqual(PAGE_PREVIEW_LIMITS.maxPixels);
    expect(readPageDocumentResponse(first)).toBe(first);
    const png = Buffer.from(first.page.png!, "base64");
    const checksumFailure = Buffer.from(png);
    checksumFailure[checksumFailure.length - 1] = checksumFailure[checksumFailure.length - 1]! ^ 1;
    for (const invalidPng of [
      png.subarray(0, 33),
      png.subarray(0, -12),
      checksumFailure,
      Buffer.concat([png.subarray(0, 33), pngChunk("acTL", Buffer.alloc(8)), png.subarray(33)]),
      Buffer.concat([png.subarray(0, 33), pngChunk("iCCP", Buffer.from("profile")), png.subarray(33)]),
      Buffer.concat([png.subarray(0, 33), ...Array.from({ length: PAGE_PREVIEW_LIMITS.maxPngChunks }, () => pngChunk("IDAT", Buffer.alloc(0))), png.subarray(33)]),
    ]) expect(() => readPageDocumentResponse({ ...first, page: { ...first.page, png: invalidPng.toString("base64") } })).toThrow();
    const oversizedHeader = Buffer.from(first.page.png!, "base64");
    oversizedHeader.writeUInt32BE(PAGE_PREVIEW_LIMITS.maxSide + 1, 16);
    expect(() => readPageDocumentResponse({ ...first, page: { ...first.page, png: oversizedHeader.toString("base64") } })).toThrow();
    expect((await parsePageDocument(pdfFixture(), "pdf", 1)).page.paragraphs).toEqual(["Second PDF page"]);
  });

  it("refuses missing pages and corrupt or mislabelled formats", async () => {
    await expect(parsePageDocument(pdfFixture(), "pdf", 2)).rejects.toMatchObject({ code: "page-not-found" });
    await expect(parsePageDocument(presentationFixture(), "pptx", 2)).rejects.toMatchObject({ code: "page-not-found" });
    await expect(parsePageDocument(Buffer.from("%PDF-broken"), "pdf", 0)).rejects.toMatchObject({ code: "corrupt-document" });
    await expect(parsePageDocument(presentationFixture(), "pdf", 0)).rejects.toMatchObject({ code: "corrupt-document" });
    await expect(parsePageDocument(pdfFixture(), "pptx", 0)).rejects.toMatchObject({ code: "corrupt-document" });
  });

  it("rejects external, duplicate and traversing slide relationships", async () => {
    for (const replacement of ['Target="https://example.test/slide.xml" TargetMode="External"', 'Target="../slides/slide2.xml"']) {
      const zip = new AdmZip(presentationFixture());
      const part = "ppt/_rels/presentation.xml.rels";
      zip.updateFile(part, Buffer.from(zip.readAsText(part).replace('Target="slides/slide2.xml"', replacement)));
      await expect(parsePageDocument(zip.toBuffer(), "pptx", 0)).rejects.toMatchObject({ code: "corrupt-document" });
    }
    const zip = new AdmZip(presentationFixture());
    const part = "ppt/_rels/presentation.xml.rels";
    zip.updateFile(part, Buffer.from(zip.readAsText(part).replace('Id="first"', 'Id="second"')));
    await expect(parsePageDocument(zip.toBuffer(), "pptx", 0)).rejects.toMatchObject({ code: "corrupt-document" });
  });

  it("rejects nested archives and entity declarations before outline decoding", async () => {
    const nested = createZipFixture([{ name: "nested.pptx", data: presentationFixture() }]);
    await expect(parsePageDocument(nested, "pptx", 0)).rejects.toMatchObject({ code: "corrupt-document" });
    const zip = new AdmZip(presentationFixture());
    const part = "ppt/slides/slide2.xml";
    zip.updateFile(part, Buffer.from('<!DOCTYPE slide [<!ENTITY read SYSTEM "file:///etc/passwd">]>' + zip.readAsText(part)));
    await expect(parsePageDocument(zip.toBuffer(), "pptx", 0)).rejects.toMatchObject({ code: "corrupt-document" });
  });

  it("clips outline text with an explicit truncation flag", async () => {
    const document = await parsePageDocument(presentationFixture("x".repeat(PAGE_PREVIEW_LIMITS.maxTextChars + 10)), "pptx", 0);
    expect(document.page.paragraphs.join("")).toHaveLength(PAGE_PREVIEW_LIMITS.maxTextChars);
    expect(document.page.textTruncated).toBe(true);
  });

  it("enforces XML depth even when attributes contain tag-like terminators", async () => {
    const zip = new AdmZip(presentationFixture());
    const part = "ppt/slides/slide2.xml";
    const nested = '<a:span value="/>">'.repeat(PAGE_PREVIEW_LIMITS.maxXmlDepth + 1)
      + "text" + "</a:span>".repeat(PAGE_PREVIEW_LIMITS.maxXmlDepth + 1);
    zip.updateFile(part, Buffer.from(zip.readAsText(part).replace("First &amp; safe", nested)));
    await expect(parsePageDocument(zip.toBuffer(), "pptx", 0)).rejects.toMatchObject({ code: "parse-limit" });
  });

  it("refuses malformed and oversized page responses at the host boundary", async () => {
    const document = await parsePageDocument(presentationFixture(), "pptx", 0);
    expect(() => readPageDocumentResponse({ ...document, extra: true })).toThrow();
    expect(() => readPageDocumentResponse({ ...document, page: { ...document.page, index: 2 } })).toThrow();
    expect(() => readPageDocumentResponse({ ...document, page: { ...document.page, paragraphs: ["x".repeat(PAGE_PREVIEW_LIMITS.maxTextChars + 1)] } })).toThrow();
  });
});
