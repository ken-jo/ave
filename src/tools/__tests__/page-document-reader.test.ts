import AdmZip from "adm-zip";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { pdfFixture, presentationFixture } from "../../__tests__/support/page-document-fixtures.js";
import { offsetWorkbook } from "../../__tests__/support/table-document-fixtures.js";
import { createZipFixture, zipCentralOffset } from "../../__tests__/support/zip-fixtures.js";
import { PREVIEW_DOCUMENT_LIMITS } from "../../shared/preview-document.js";
import { PAGE_PREVIEW_LIMITS } from "../../shared/preview-page-document.js";
import { parsePageDocument, pdfAssetDirectory } from "../page-document-reader.js";
import { CFB_MAGIC } from "../workbook-container.js";
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
  it("terminates asset directories with one forward slash across path styles", () => {
    expect(pdfAssetDirectory("D:\\assets\\cmaps\\")).toBe("D:\\assets\\cmaps/");
    expect(pdfAssetDirectory("D:\\assets\\standard_fonts\\/\\")).toBe("D:\\assets\\standard_fonts/");
    expect(pdfAssetDirectory("/assets/wasm///")).toBe("/assets/wasm/");
    expect(pdfAssetDirectory("/assets/iccs")).toBe("/assets/iccs/");
    expect(pdfAssetDirectory("/assets/cmaps/")).toBe("/assets/cmaps/");
  });

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

  it("shows slide text only when the package also carries images and speaker notes", async () => {
    const namespace = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/";
    const zip = new AdmZip(presentationFixture());
    zip.addFile("ppt/media/image1.png", readFileSync(join(process.cwd(), "build", "icon.png")));
    zip.addFile("ppt/notesSlides/notesSlide1.xml", Buffer.from('<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Private speaker note</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>'));
    zip.addFile("ppt/slides/_rels/slide2.xml.rels", Buffer.from(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="img" Type="${namespace}image" Target="../media/image1.png"/><Relationship Id="notes" Type="${namespace}notesSlide" Target="../notesSlides/notesSlide1.xml"/></Relationships>`));
    const slide = "ppt/slides/slide2.xml";
    zip.updateFile(slide, Buffer.from(zip.readAsText(slide).replace("</p:spTree>",
      '<p:pic><p:nvPicPr><p:cNvPr id="4" name="Picture" descr="Alt text"/></p:nvPicPr><p:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="img"/></p:blipFill></p:pic></p:spTree>')));
    const document = await parsePageDocument(zip.toBuffer(), "pptx", 0);
    expect(document.page.paragraphs).toEqual(["First & safe\nNext line"]);
    expect(JSON.stringify(document)).not.toContain("Private speaker note");
    expect(document.page.png).toBeNull();
  });

  it("refuses packages with missing required parts", async () => {
    for (const missing of ["[Content_Types].xml", "_rels/.rels", "ppt/presentation.xml", "ppt/_rels/presentation.xml.rels", "ppt/slides/slide2.xml"]) {
      const zip = new AdmZip(presentationFixture());
      zip.deleteFile(missing);
      await expect(parsePageDocument(zip.toBuffer(), "pptx", 0), missing).rejects.toMatchObject({ code: "corrupt-document" });
    }
    const zip = new AdmZip(presentationFixture());
    const types = "[Content_Types].xml";
    zip.updateFile(types, Buffer.from(zip.readAsText(types).replace(/<Override PartName="\/ppt\/slides\/slide2\.xml"[^>]*\/>/, "")));
    await expect(parsePageDocument(zip.toBuffer(), "pptx", 0)).rejects.toMatchObject({ code: "corrupt-document" });
  });

  it("enforces the XML part byte budget and lists at most the page limit", async () => {
    const oversizedXml = new AdmZip(presentationFixture());
    const slide = "ppt/slides/slide2.xml";
    oversizedXml.updateFile(slide, Buffer.from(oversizedXml.readAsText(slide).replace("</p:sld>",
      `<!--${randomBytes(PAGE_PREVIEW_LIMITS.maxXmlBytes).toString("base64")}--></p:sld>`)));
    await expect(parsePageDocument(oversizedXml.toBuffer(), "pptx", 0)).rejects.toMatchObject({ code: "parse-limit" });

    const count = PAGE_PREVIEW_LIMITS.maxPages + 1;
    const many = new AdmZip(presentationFixture());
    const namespace = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/";
    const ids = Array.from({ length: count }, (_, position) => `<p:sldId id="${300 + position}" r:id="s${position}"/>`).join("");
    const presentation = "ppt/presentation.xml";
    many.updateFile(presentation, Buffer.from(many.readAsText(presentation).replace(/<p:sldIdLst>[\s\S]*<\/p:sldIdLst>/, `<p:sldIdLst>${ids}</p:sldIdLst>`)));
    const rels = Array.from({ length: count }, (_, position) => `<Relationship Id="s${position}" Type="${namespace}slide" Target="slides/slide${position % 2 + 1}.xml"/>`).join("");
    many.updateFile("ppt/_rels/presentation.xml.rels", Buffer.from(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`));
    const first = await parsePageDocument(many.toBuffer(), "pptx", 0);
    expect(first).toMatchObject({ totalPages: count, pagesTruncated: true });
    expect(readPageDocumentResponse(first)).toBe(first);
    await expect(parsePageDocument(many.toBuffer(), "pptx", PAGE_PREVIEW_LIMITS.maxPages)).rejects.toMatchObject({ code: "page-not-found" });
  });

  it("refuses expansion bombs and encrypted presentation containers", async () => {
    const bomb = new AdmZip(presentationFixture());
    bomb.addFile("ppt/media/filler.bin", Buffer.alloc(PREVIEW_DOCUMENT_LIMITS.ratioCheckMinBytes * 8));
    await expect(parsePageDocument(bomb.toBuffer(), "pptx", 0)).rejects.toMatchObject({ code: "archive-too-large" });
    const encrypted = presentationFixture();
    const central = zipCentralOffset(encrypted);
    encrypted.writeUInt16LE(encrypted.readUInt16LE(6) | 1, 6);
    encrypted.writeUInt16LE(encrypted.readUInt16LE(central + 8) | 1, central + 8);
    await expect(parsePageDocument(encrypted, "pptx", 0)).rejects.toMatchObject({ code: "encrypted" });
  });

  it("refuses an Office password-protected presentation stored as a compound file", async () => {
    const compound = Buffer.alloc(1024);
    Buffer.from(CFB_MAGIC).copy(compound);
    compound.write("EncryptedPackage", 512, "utf16le");
    await expect(parsePageDocument(compound, "pptx", 0)).rejects.toMatchObject({ code: "encrypted" });
  });

  it("decodes numeric character references once in slide text", async () => {
    const document = await parsePageDocument(presentationFixture("A&#8211;B&#x2014;C &amp;#8211; &lt;tag&gt;"), "pptx", 0);
    expect(document.page.paragraphs).toEqual(["A\u2013B\u2014C &#8211; <tag>\nNext line"]);
  });

  it("maps the parser's reserved-name refusal to a corrupt document", async () => {
    for (const name of ["__proto__", "constructor"]) {
      const zip = new AdmZip(presentationFixture());
      const slide = "ppt/slides/slide2.xml";
      zip.updateFile(slide, Buffer.from(zip.readAsText(slide).replace("<p:cSld>", `<p:cSld><a:${name}>x</a:${name}>`)));
      await expect(parsePageDocument(zip.toBuffer(), "pptx", 0), name).rejects.toMatchObject({ code: "corrupt-document" });
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
    const { createCanvas, loadImage } = await import("@napi-rs/canvas");
    const bitmap = createCanvas(first.page.width, first.page.height);
    const pixels = bitmap.getContext("2d");
    pixels.drawImage(await loadImage(png), 0, 0);
    expect([...pixels.getImageData(30, 120, 1, 1).data]).toEqual([0, 0, 255, 255]);
    // Glyph ink occupies the upper half, above the vector rectangle.
    const textPixels = pixels.getImageData(0, 0, first.page.width, Math.floor(first.page.height / 2)).data;
    let blueTextPixels = 0;
    for (let offset = 0; offset < textPixels.length; offset += 4) {
      if (textPixels[offset] === 0 && textPixels[offset + 1] === 0
          && textPixels[offset + 2] === 255 && textPixels[offset + 3] === 255) blueTextPixels += 1;
    }
    expect(blueTextPixels).toBeGreaterThan(10);
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

  it("refuses excessive image resources instead of silently omitting them", async () => {
    const withinBudget = await parsePageDocument(pdfFixture({ image: { width: 16, height: 16 } }), "pdf", 0);
    expect(withinBudget.page.paragraphs).toEqual(["First PDF page"]);
    expect(readPageDocumentResponse(withinBudget)).toBe(withinBudget);
    const image = { width: 2000, height: Math.floor(PAGE_PREVIEW_LIMITS.maxPixels / 2000) + 1 };
    await expect(parsePageDocument(pdfFixture({ image }), "pdf", 0)).rejects.toMatchObject({ code: "parse-limit" });
    // Operators already delivered in an earlier chunk must not turn the refusal into a partial page.
    await expect(parsePageDocument(pdfFixture({ image, leadingSaveRestore: 1500 }), "pdf", 0))
      .rejects.toMatchObject({ code: "parse-limit" });
    const manyOperators = await parsePageDocument(pdfFixture({ image: { width: 16, height: 16 }, leadingSaveRestore: 1500 }), "pdf", 0);
    expect(manyOperators.page.paragraphs).toEqual(["First PDF page"]);
  });

  it("refuses password-protected PDFs explicitly", async () => {
    await expect(parsePageDocument(pdfFixture({ encrypted: true }), "pdf", 0)).rejects.toMatchObject({ code: "encrypted" });
  });

  it("refuses oversized input before opening either format", async () => {
    const oversized = Buffer.alloc(PREVIEW_DOCUMENT_LIMITS.maxFileBytes + 1);
    pdfFixture().copy(oversized);
    await expect(parsePageDocument(oversized, "pdf", 0)).rejects.toMatchObject({ code: "too-large" });
    await expect(parsePageDocument(oversized, "pptx", 0)).rejects.toMatchObject({ code: "too-large" });
    await expect(parsePageDocument(pdfFixture(), "pdf", -1)).rejects.toMatchObject({ code: "invalid-index" });
    await expect(parsePageDocument(presentationFixture(), "pptx", 0.5)).rejects.toMatchObject({ code: "invalid-index" });
  });

  it("refuses truncated PDF streams", async () => {
    const bytes = pdfFixture();
    await expect(parsePageDocument(bytes.subarray(0, Math.floor(bytes.length / 3)), "pdf", 0))
      .rejects.toMatchObject({ code: "corrupt-document" });
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
