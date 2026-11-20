import { describe, expect, it } from "vitest";
import { decodeEditableText, EDITABLE_TEXT_MAX_BYTES, encodeEditableText } from "../editable-text.js";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

function roundTrip(source: Uint8Array): Uint8Array {
  const decoded = decodeEditableText(source);
  if (!decoded.ok) throw new Error(decoded.error);
  return encodeEditableText(decoded.text, decoded.shape);
}

describe("editable text", () => {
  it.each([
    ["LF", "a\nb\n"],
    ["CRLF", "a\r\nb\r\n"],
    ["no final newline", "a\r\nb"],
    ["a byte order mark", "﻿a\nb\n"],
    ["a byte order mark with CRLF", "﻿a\r\nb\r\n"],
    ["empty", ""],
    ["non-ASCII", "가나다\n日本語 ✓\n"],
  ])("rebuilds a file with %s byte for byte when nothing was edited", (_name, text) => {
    expect([...roundTrip(bytes(text))]).toEqual([...bytes(text)]);
  });

  it("hands the text box LF only and writes the file's own ending back around an edit", () => {
    const decoded = decodeEditableText(bytes("one\r\ntwo\r\nthree\r\n"));
    if (!decoded.ok) throw new Error(decoded.error);
    expect(decoded.text).toBe("one\ntwo\nthree\n");
    const saved = encodeEditableText(decoded.text.replace("two", "2\nnew"), decoded.shape);
    expect(new TextDecoder().decode(saved)).toBe("one\r\n2\r\nnew\r\nthree\r\n");
  });

  it("writes one ending even when the text box returns pasted CRLF", () => {
    expect(new TextDecoder().decode(encodeEditableText("a\r\nb\rc\n", { eol: "\n", bom: false }))).toBe("a\nb\nc\n");
    expect(new TextDecoder().decode(encodeEditableText("a\r\nb\n", { eol: "\r\n", bom: false }))).toBe("a\r\nb\r\n");
  });

  it.each([
    ["both endings", "a\r\nb\n"],
    ["a lone carriage return", "a\rb\n"],
  ])("refuses a file with %s, which a text box would rewrite", (_name, text) => {
    expect(decodeEditableText(bytes(text))).toEqual({ ok: false, error: "mixed-line-endings" });
  });

  it("refuses bytes that are not UTF-8 text", () => {
    expect(decodeEditableText(new Uint8Array([0x61, 0xff, 0xfe]))).toEqual({ ok: false, error: "not-text" });
    expect(decodeEditableText(bytes("a\0b"))).toEqual({ ok: false, error: "not-text" });
  });

  it("refuses a file over the size a text box handles", () => {
    expect(decodeEditableText(new Uint8Array(EDITABLE_TEXT_MAX_BYTES + 1).fill(0x61))).toEqual({ ok: false, error: "too-large" });
    expect(decodeEditableText(new Uint8Array(EDITABLE_TEXT_MAX_BYTES).fill(0x61)).ok).toBe(true);
  });
});
