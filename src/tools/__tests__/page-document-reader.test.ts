import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import { pdfFixture, presentationFixture } from "../../__tests__/support/page-document-fixtures.js";
import { createZipFixture } from "../../__tests__/support/zip-fixtures.js";
import { PAGE_PREVIEW_LIMITS } from "../../shared/preview-page-document.js";
import { parsePageDocument } from "../page-document-reader.js";
import { readPageDocumentResponse } from "../preview-page-protocol.js";

describe("page document previews", () => {
  it("follows slide relationships and preserves runs, escapes and breaks", async () => {
    const first = await parsePageDocument(presentationFixture(), "pptx", 0);
    expect(first).toMatchObject({ format: "pptx", totalPages: 2, page: { index: 0, paragraphs: ["First & safe\nNext line"], png: null } });
    expect(readPageDocumentResponse(first)).toBe(first);
    expect((await parsePageDocument(presentationFixture(), "pptx", 1)).page.paragraphs).toEqual(["Last slide"]);
  });

  it("renders a real PDF page into a bounded image with extractable text", async () => {
    const first = await parsePageDocument(pdfFixture(), "pdf", 0);
    expect(first).toMatchObject({ format: "pdf", totalPages: 2, page: { index: 0, paragraphs: ["First PDF page"] } });
    expect(first.page.png).toMatch(/^iVBORw0KGgo/);
    expect(first.page.width * first.page.height).toBeLessThanOrEqual(PAGE_PREVIEW_LIMITS.maxPixels);
    expect(readPageDocumentResponse(first)).toBe(first);
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
