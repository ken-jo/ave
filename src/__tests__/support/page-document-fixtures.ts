import { createZipFixture } from "./zip-fixtures.js";
import { deflateSync } from "node:zlib";

/** Complete two-slide package with relationship order different from filenames. */
export function presentationFixture(slideText = "First &amp; safe"): Buffer {
  const namespace = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/";
  return createZipFixture([
    { name: "[Content_Types].xml", data: '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/><Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>' },
    { name: "_rels/.rels", data: `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="root" Type="${namespace}officeDocument" Target="ppt/presentation.xml"/></Relationships>` },
    { name: "ppt/presentation.xml", data: `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="${namespace.slice(0, -1)}"><p:sldIdLst><p:sldId id="256" r:id="second"/><p:sldId id="257" r:id="first"/></p:sldIdLst></p:presentation>` },
    { name: "ppt/_rels/presentation.xml.rels", data: `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="first" Type="${namespace}slide" Target="slides/slide1.xml"/><Relationship Id="second" Type="${namespace}slide" Target="slides/slide2.xml"/></Relationships>` },
    { name: "ppt/slides/slide1.xml", data: '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="Text"/></p:nvSpPr><p:txBody><a:p><a:r><a:t>Last slide</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>' },
    { name: "ppt/slides/slide2.xml", data: `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="Text"/></p:nvSpPr><p:txBody><a:p><a:r><a:t>${slideText}</a:t></a:r><a:br/><a:r><a:t>Next line</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>` },
  ]);
}

export interface PdfFixtureOptions {
  /** Adds a gray image XObject of these dimensions to every page. */
  image?: { width: number; height: number };
  /** Save/restore pairs drawn before the image, so operators stream in more than one chunk. */
  leadingSaveRestore?: number;
  /** Adds a standard security handler whose user password is not empty. */
  encrypted?: boolean;
}

/** Small PDF with real cross-reference offsets, vector marks and page text. */
export function pdfFixture({ image, leadingSaveRestore = 0, encrypted = false }: PdfFixtureOptions = {}): Buffer {
  const imageResources = image ? " /XObject << /Im1 8 0 R >>" : "";
  const pageStream = (text: string) => `0 0 1 rg 10 10 50 25 re f ${"q Q ".repeat(leadingSaveRestore)}${image ? "q 50 0 0 25 70 10 cm /Im1 Do Q " : ""}BT /F1 14 Tf 10 70 Td (${text}) Tj ET`;
  const stream = (text: string, dictionary = "") => `<< /Length ${Buffer.byteLength(text)} ${dictionary} >>\nstream\n${text}\nendstream`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 5 0 R >>${imageResources} >> /Contents 6 0 R >>`,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 5 0 R >>${imageResources} >> /Contents 7 0 R >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    stream(pageStream("First PDF page")), stream(pageStream("Second PDF page")),
  ];
  if (image) {
    const pixels = Buffer.alloc(image.width * image.height);
    objects.push(stream(`${deflateSync(pixels).toString("hex")}>`,
      `/Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter [/ASCIIHexDecode /FlateDecode]`));
  }
  const securityHandler = encrypted ? objects.push(`<< /Filter /Standard /V 1 /R 2 /O <${"11".repeat(32)}> /U <${"22".repeat(32)}> /P -4 >>`) : 0;
  let result = "%PDF-1.7\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(result));
    result += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(result);
  result += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  result += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  const encryption = securityHandler ? ` /Encrypt ${securityHandler} 0 R /ID [<${"33".repeat(16)}> <${"33".repeat(16)}>]` : "";
  result += `trailer\n<< /Size ${offsets.length} /Root 1 0 R${encryption} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(result);
}
