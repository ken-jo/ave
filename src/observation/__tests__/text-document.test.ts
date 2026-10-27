import { describe, expect, it } from "vitest";
import { parseObservedTextDocument, readObservedTextDocument } from "../text-document.js";

describe("observed text documents", () => {
  it("keeps source separators while excluding the final line separator", () => {
    expect(parseObservedTextDocument(Buffer.from("first\r\n\rsecond\n"))).toEqual({
      format: "text", content: "first\r\n\rsecond", lines: ["first", "", "second"], totalLines: 3, truncated: false,
    });
    expect(parseObservedTextDocument(Buffer.from(""))).toEqual({ format: "text", content: "", lines: [], totalLines: 0, truncated: false });
    expect(parseObservedTextDocument(Buffer.from("\n"))).toEqual({ format: "text", content: "", lines: [""], totalLines: 1, truncated: false });
  });

  it("caps visible lines while retaining the exact total and a truncation notice", () => {
    const result = parseObservedTextDocument(Buffer.from("row\n".repeat(5_001)));
    expect(result.lines).toHaveLength(5_000);
    expect(result.lines[4_999]).toBe("row");
    expect(result.content.endsWith("row\nrow")).toBe(true);
    expect(result.totalLines).toBe(5_001);
    expect(result.truncated).toBe(true);
  });

  it("rejects binary and oversized text rather than silently changing engines", () => {
    expect(() => parseObservedTextDocument(Buffer.from([97, 0, 98]))).toThrow("Invalid observed text document.");
    expect(() => parseObservedTextDocument(Buffer.alloc(2_000_001, 97))).toThrow("Invalid observed text document.");
    expect(parseObservedTextDocument(Buffer.alloc(2_000_000, 97)).totalLines).toBe(1);
  });

  it("validates replacement-engine output shape and consistent displayed lines", () => {
    const valid = { format: "text", content: "first\nsecond", lines: ["first", "second"], totalLines: 2, truncated: false };
    expect(readObservedTextDocument(valid)).toBe(valid);
    expect(() => readObservedTextDocument({ ...valid, actor: "agent" })).toThrow("Invalid observed text result.");
    expect(() => readObservedTextDocument({ ...valid, lines: ["different"] })).toThrow("Invalid observed text result.");
    expect(() => readObservedTextDocument({ ...valid, totalLines: 1 })).toThrow("Invalid observed text result.");
    expect(() => readObservedTextDocument({ ...valid, truncated: true })).toThrow("Invalid observed text result.");
    expect(() => readObservedTextDocument({ ...valid, lines: ["first\nsecond"] })).toThrow("Invalid observed text result.");
  });

  it("requires a plain record with exactly the required own fields", () => {
    const valid = { format: "text", content: "first", lines: ["first"], totalLines: 1, truncated: false };
    const inherited = Object.assign(Object.create(valid), { one: 1, two: 2, three: 3, four: 4, five: 5 });
    class EngineDocument { constructor() { Object.assign(this, valid); } }
    expect(() => readObservedTextDocument(inherited)).toThrow("Invalid observed text result.");
    expect(() => readObservedTextDocument(new EngineDocument())).toThrow("Invalid observed text result.");
    expect(() => readObservedTextDocument(Object.assign([], valid))).toThrow("Invalid observed text result.");
    expect(() => readObservedTextDocument({ ...valid, lines: undefined })).toThrow("Invalid observed text result.");
    const plain = Object.assign(Object.create(null), valid);
    expect(readObservedTextDocument(plain)).toBe(plain);
  });
});
