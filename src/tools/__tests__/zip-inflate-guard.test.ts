import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { createZipFixture, zipCentralOffset } from "../../__tests__/support/zip-fixtures.js";
import { PREVIEW_DOCUMENT_LIMITS } from "../../shared/preview-document.js";
import { hasZipMagic, verifyZipInflateLimits } from "../zip-inflate-guard.js";

const LIMITS = PREVIEW_DOCUMENT_LIMITS;

function singleEntry(): Buffer {
  return createZipFixture([{ name: "content.xml", data: "checked content" }]);
}

describe("bounded ZIP verification", () => {
  it("checks stored and compressed entry payloads", () => {
    const bytes = createZipFixture([
      { name: "stored.xml", data: "stored", method: 0 },
      { name: "deflated.xml", data: "deflated" },
    ]);
    expect(verifyZipInflateLimits(bytes, LIMITS)).toMatchObject({ ok: true, entries: 2, uncompressedBytes: 14 });
  });

  it.each([
    ["compression method", 8, 0],
    ["flags", 6, 0],
    ["compressed length", 18, 1],
    ["uncompressed length", 22, 1],
  ] as const)("refuses contradictory local %s", (_field, offset, value) => {
    const bytes = singleEntry();
    if (offset < 10) bytes.writeUInt16LE(value, offset);
    else bytes.writeUInt32LE(value, offset);
    expect(verifyZipInflateLimits(bytes, LIMITS)).toMatchObject({ ok: false, reason: "corrupt" });
  });

  it("refuses contradictory local names", () => {
    const bytes = singleEntry();
    bytes[30] = 0x78;
    expect(verifyZipInflateLimits(bytes, LIMITS)).toMatchObject({ ok: false, reason: "corrupt" });
  });

  it("checks the actual checksum even when both headers agree", () => {
    const bytes = singleEntry();
    bytes.writeUInt32LE(0, 14);
    bytes.writeUInt32LE(0, zipCentralOffset(bytes) + 16);
    expect(verifyZipInflateLimits(bytes, LIMITS)).toMatchObject({ ok: false, reason: "corrupt" });
  });

  it.each(["signed", "unsigned"] as const)("checks %s data descriptors", (descriptor) => {
    const bytes = createZipFixture([{ name: "part.xml", data: "descriptor data", descriptor }]);
    expect(verifyZipInflateLimits(bytes, LIMITS)).toMatchObject({ ok: true, uncompressedBytes: 15 });
    const central = zipCentralOffset(bytes);
    bytes.writeUInt32LE(1, central - 4);
    expect(verifyZipInflateLimits(bytes, LIMITS)).toMatchObject({ ok: false, reason: "corrupt" });
  });

  it("refuses a missing data descriptor", () => {
    const bytes = createZipFixture([{ name: "part.xml", data: "descriptor data", descriptor: "missing" }]);
    expect(verifyZipInflateLimits(bytes, LIMITS)).toMatchObject({ ok: false, reason: "corrupt" });
  });

  it("refuses trailing data inside a compressed payload", () => {
    const data = Buffer.from("bounded");
    const bytes = createZipFixture([{
      name: "part.xml",
      data,
      compressedData: Buffer.concat([deflateRawSync(data), Buffer.from("unread payload")]),
    }]);
    expect(verifyZipInflateLimits(bytes, LIMITS)).toMatchObject({ ok: false, reason: "corrupt" });
  });

  it("refuses duplicate member names", () => {
    const bytes = createZipFixture([{ name: "part.xml", data: "a" }, { name: "part.xml", data: "b" }]);
    expect(verifyZipInflateLimits(bytes, LIMITS)).toMatchObject({ ok: false, reason: "corrupt" });
  });

  it.each(["../part.xml", "part/../part.xml", "/part.xml", "part\\other.xml", "Root Entry/part.xml"])("refuses ambiguous member path %s", (name) => {
    expect(verifyZipInflateLimits(createZipFixture([{ name, data: "x" }]), LIMITS))
      .toMatchObject({ ok: false, reason: "corrupt" });
  });

  it("refuses local offsets outside the member area without throwing", () => {
    const bytes = singleEntry();
    bytes.writeUInt32LE(0xfffffff0, zipCentralOffset(bytes) + 42);
    expect(verifyZipInflateLimits(bytes, LIMITS)).toMatchObject({ ok: false, reason: "corrupt" });
  });

  it("refuses unindexed bytes before or after the members", () => {
    const bytes = singleEntry();
    const end = bytes.length - 22;
    const padded = Buffer.concat([bytes.subarray(0, end), Buffer.from("gap"), bytes.subarray(end)]);
    expect(verifyZipInflateLimits(padded, LIMITS)).toMatchObject({ ok: false, reason: "corrupt" });
    expect(verifyZipInflateLimits(Buffer.concat([bytes, Buffer.from("tail")]), LIMITS))
      .toMatchObject({ ok: false, reason: "corrupt" });
  });

  it("rejects large-offset extra fields even with ordinary declared sizes", () => {
    const extra = Buffer.alloc(4);
    extra.writeUInt16LE(1, 0);
    const bytes = createZipFixture([{ name: "part.xml", data: "x", extra }]);
    expect(verifyZipInflateLimits(bytes, LIMITS)).toMatchObject({ ok: false, reason: "corrupt" });
  });

  it("checks directory payloads and encrypted flags", () => {
    const directory = createZipFixture([{ name: "folder/", data: "hidden" }]);
    expect(verifyZipInflateLimits(directory, LIMITS)).toMatchObject({ ok: false, reason: "corrupt" });
    const encrypted = singleEntry();
    encrypted.writeUInt16LE(0x801, 6);
    encrypted.writeUInt16LE(0x801, zipCentralOffset(encrypted) + 8);
    expect(verifyZipInflateLimits(encrypted, LIMITS)).toMatchObject({ ok: false, reason: "encrypted" });
  });

  it("recognizes the supported archive signature families", () => {
    for (const magic of [0x04034b50, 0x06054b50, 0x08074b50]) {
      const bytes = Buffer.alloc(4);
      bytes.writeUInt32LE(magic);
      expect(hasZipMagic(bytes)).toBe(true);
    }
    expect(hasZipMagic(Buffer.from("not a zip"))).toBe(false);
  });

  it("normalizes verified descriptors and extra fields while preserving payloads", () => {
    const extra = Buffer.from([0xfe, 0xca, 0, 0]);
    const bytes = createZipFixture([{ name: "part.xml", data: "checked", descriptor: "signed", extra }]);
    const seen: string[] = [];
    const verdict = verifyZipInflateLimits(bytes, LIMITS, (name, data) => seen.push(`${name}:${data.toString()}`));
    expect(seen).toEqual(["part.xml:checked"]);
    if (!verdict.ok) throw new Error(verdict.detail);
    expect(verdict.entryNames).toEqual(["part.xml"]);
    expect(verdict.canonicalBytes.length).toBeLessThan(bytes.length);
    expect(verdict.canonicalBytes.readUInt16LE(6) & 8).toBe(0);
    expect(verdict.canonicalBytes.readUInt16LE(28)).toBe(0);
    expect(verifyZipInflateLimits(verdict.canonicalBytes, LIMITS)).toMatchObject({ ok: true, uncompressedBytes: 7 });
  });

  it("refuses an embedded ZIP member", () => {
    const bytes = createZipFixture([{ name: "nested.xlsx", data: singleEntry() }]);
    expect(verifyZipInflateLimits(bytes, LIMITS)).toMatchObject({ ok: false, reason: "corrupt" });
  });

  it("refuses a wrapper whose nested member exceeds the inflate ratio", () => {
    const inner = createZipFixture([{ name: "content.xml", data: Buffer.alloc(4 * 1024 * 1024, 0x41) }]);
    expect(verifyZipInflateLimits(inner, LIMITS)).toMatchObject({ ok: false, reason: "compression-ratio" });
    const outer = createZipFixture([{ name: "Index.zip", data: inner }]);
    expect(verifyZipInflateLimits(outer, LIMITS)).toMatchObject({ ok: false, reason: "corrupt" });
  });

  it("refuses a stored directory view over a large deflated local view", () => {
    const bytes = singleEntry();
    const central = zipCentralOffset(bytes);
    const compressedSize = bytes.readUInt32LE(central + 20);
    bytes.writeUInt16LE(0, central + 10);
    bytes.writeUInt32LE(compressedSize, central + 24);
    bytes.writeUInt32LE(300 * 1024 * 1024, 22);
    expect(verifyZipInflateLimits(bytes, LIMITS)).toMatchObject({ ok: false, reason: "corrupt" });
  });

  it("refuses unsupported large-offset framing", () => {
    const bytes = singleEntry();
    bytes.writeUInt16LE(45, 4);
    bytes.writeUInt16LE(45, zipCentralOffset(bytes) + 6);
    expect(verifyZipInflateLimits(bytes, LIMITS)).toMatchObject({ ok: false, reason: "corrupt" });
  });

  it("preserves size mismatch verdicts for understated payloads", () => {
    const bytes = singleEntry();
    bytes.writeUInt32LE(1, 22);
    bytes.writeUInt32LE(1, zipCentralOffset(bytes) + 24);
    expect(verifyZipInflateLimits(bytes, LIMITS)).toMatchObject({ ok: false, reason: "size-mismatch" });
  });

  it("accounts for declared limits before inflating", () => {
    const bytes = createZipFixture([{ name: "part.xml", data: Buffer.alloc(128, 0x41) }]);
    expect(verifyZipInflateLimits(bytes, { ...LIMITS, maxUncompressedBytes: 64 }))
      .toMatchObject({ ok: false, reason: "too-large" });
    expect(verifyZipInflateLimits(bytes, { ...LIMITS, ratioCheckMinBytes: 1, maxCompressionRatio: 2 }))
      .toMatchObject({ ok: false, reason: "compression-ratio" });
    expect(verifyZipInflateLimits(bytes, { ...LIMITS, maxArchiveEntries: 0 }))
      .toMatchObject({ ok: false, reason: "too-many-entries" });
  });
});
