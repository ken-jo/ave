/** Validate digest shape in the primitive so callers need not preserve upstream checks forever. */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { SHA256_HEX, sha256Hex, timingSafeEqualHexDigest } from "../hex-digest-equal.js";

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

describe("timingSafeEqualHexDigest", () => {
  it("matches a digest against itself and refuses a different one", () => {
    expect(timingSafeEqualHexDigest(sha256("a"), sha256("a"))).toBe(true);
    expect(timingSafeEqualHexDigest(sha256("a"), sha256("b"))).toBe(false);
  });

  it("refuses two wholly non-hex strings that decode to nothing", () => {
    // Invalid hex can decode to empty buffers that compare equal.
    expect(timingSafeEqualHexDigest("zz", "zz")).toBe(false);
    expect(timingSafeEqualHexDigest("not-hex-at-all", "also-not-hex")).toBe(false);
    expect(timingSafeEqualHexDigest("", "")).toBe(false);
  });

  it("refuses two DIFFERENT strings that share a decodable prefix", () => {
    // Hex decoding truncates at invalid pairs, allowing different malformed strings to compare equal.
    expect(timingSafeEqualHexDigest("abXX", "abYY")).toBe(false);
    expect(timingSafeEqualHexDigest(`${sha256("a").slice(0, 8)}!!tail`, `${sha256("a").slice(0, 8)}??other`)).toBe(false);
  });

  it("refuses anything that is not exactly 64 lowercase hex characters", () => {
    const good = sha256("a");
    expect(timingSafeEqualHexDigest(good.toUpperCase(), good.toUpperCase())).toBe(false);
    expect(timingSafeEqualHexDigest(good.slice(0, 62), good.slice(0, 62))).toBe(false);
    expect(timingSafeEqualHexDigest(`${good}00`, `${good}00`)).toBe(false);
    expect(timingSafeEqualHexDigest(` ${good.slice(1)}`, ` ${good.slice(1)}`)).toBe(false);
  });

  it("refuses non-strings without throwing", () => {
    const good = sha256("a");
    expect(timingSafeEqualHexDigest(undefined, good)).toBe(false);
    expect(timingSafeEqualHexDigest(good, null)).toBe(false);
    expect(timingSafeEqualHexDigest(Buffer.from(good, "hex"), good)).toBe(false);
    expect(timingSafeEqualHexDigest({ toString: () => good }, good)).toBe(false);
  });

  it("never throws on a length mismatch the way timingSafeEqual does", () => {
    expect(timingSafeEqualHexDigest(sha256("a"), "ab")).toBe(false);
  });
});

describe("SHA256_HEX", () => {
  it("is the one strict shape: 64 lowercase hex characters, nothing else", () => {
    const good = sha256("a");
    expect(SHA256_HEX.test(good)).toBe(true);
    expect(SHA256_HEX.test(good.toUpperCase())).toBe(false);
    expect(SHA256_HEX.test(good.slice(0, 63))).toBe(false);
    expect(SHA256_HEX.test(`${good}0`)).toBe(false);
    expect(SHA256_HEX.test(`${good.slice(0, 63)}g`)).toBe(false);
  });
});

describe("sha256Hex", () => {
  it("hashes a string as UTF-8 and bytes as-is, to 64 lowercase hex characters", () => {
    const text = "héllo";
    const expected = createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
    expect(sha256Hex(text)).toBe(expected);
    expect(sha256Hex(Buffer.from(text, "utf8"))).toBe(expected);
    expect(sha256Hex(new TextEncoder().encode(text))).toBe(expected);
    expect(sha256Hex(text)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces the digest the comparator accepts", () => {
    expect(timingSafeEqualHexDigest(sha256Hex("a"), sha256Hex("a"))).toBe(true);
    expect(timingSafeEqualHexDigest(sha256Hex("a"), sha256Hex("b"))).toBe(false);
  });
});
