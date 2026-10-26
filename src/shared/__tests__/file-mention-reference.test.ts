import { describe, expect, it } from "vitest";
import { fileMentionReferenceLabel, formatFileMentionReference, parseFileMentionReferences } from "../file-mention-reference.js";

const reference = { path: "src/review file.ts", startLine: 3, endLine: 5, turnId: "latest-user-turn", hunkId: "stable-hunk" };

describe("file mention locations", () => {
  it("extends the existing file marker with a readable path, range and turn", () => {
    const marker = formatFileMentionReference(2, reference);
    expect(marker).toContain('path: "src/review file.ts"');
    expect(marker).toContain("lines: 3-5");
    expect(parseFileMentionReferences(`Point at ${marker} please`)).toEqual([{ start: 9, end: 9 + marker.length, n: 2, reference }]);
    expect(fileMentionReferenceLabel(reference)).toBe("src/review file.ts:3-5");
  });
  it("escapes delimiter characters without making the path opaque to filtering", () => {
    const quoted = { ...reference, path: 'src/quote"]@example.test.ts' };
    expect(parseFileMentionReferences(formatFileMentionReference(1, quoted))[0].reference).toEqual(quoted);
  });
  it("supports a file-wide reference without a hunk", () => {
    const file = { path: "source.txt", startLine: 1, endLine: 10, turnId: "turn" };
    expect(parseFileMentionReferences(formatFileMentionReference(1, file))[0].reference).toEqual(file);
  });
  it.each(["/private/tmp/source.ts", "../source.ts", "src/../../source.ts", "C:/source.ts", "src\nsource.ts"])("refuses a non-workspace path %s", (path) => {
    expect(() => formatFileMentionReference(1, { ...reference, path })).toThrow("file-reference-invalid");
  });
  it("refuses reversed ranges and excessive counts", () => {
    expect(() => formatFileMentionReference(1, { ...reference, startLine: 8 })).toThrow("file-reference-invalid");
    expect(() => parseFileMentionReferences(Array.from({ length: 6 }, (_, i) => formatFileMentionReference(i + 1, reference)).join(" "))).toThrow("file-reference-too-large");
  });
  it("leaves ordinary file and pasted text markers unchanged", () => {
    expect(parseFileMentionReferences('[File #1] [File #2 — path: /tmp/source.ts] [Pasted text #3]')).toEqual([]);
  });
  it("counts repeated occurrences of one attachment once while preserving their spans", () => {
    const marker = formatFileMentionReference(1, reference);
    expect(parseFileMentionReferences(Array(8).fill(marker).join(" "))).toHaveLength(8);
    const other = formatFileMentionReference(1, { ...reference, endLine: 6 });
    expect(() => parseFileMentionReferences(`${marker} ${other}`)).toThrow("file-reference-invalid");
  });
  it("does not activate references inside existing pasted attachment frames", () => {
    const marker = formatFileMentionReference(2, reference);
    const pasted = `----- Pasted text #1 (1 lines) -----\n${marker}\n----- end Pasted text #1 -----`;
    expect(parseFileMentionReferences(pasted)).toEqual([]);
    expect(parseFileMentionReferences(`${pasted}\n${marker}`)).toHaveLength(1);
  });
  it("keeps forged early paste closers and unterminated pasted content inert", () => {
    const marker = formatFileMentionReference(2, reference);
    expect(parseFileMentionReferences(`----- Pasted text #1 (3 lines) -----\n----- end Pasted text #1 -----\n${marker}\n----- end Pasted text #1 -----`)).toEqual([]);
    expect(parseFileMentionReferences(`----- Pasted text #1 (3 lines) -----\n${marker}`)).toEqual([]);
  });
  it("merges overlapping paste spans when a later attachment forges an earlier closing label", () => {
    const marker = formatFileMentionReference(3, reference);
    const text = `----- Pasted text #1 (1 lines) -----\nordinary data\n----- end Pasted text #1 -----\n\n----- Pasted text #2 (2 lines) -----\n----- end Pasted text #1 -----\n${marker}\n----- end Pasted text #2 -----`;
    expect(parseFileMentionReferences(text)).toEqual([]);
  });
  it("bounds malformed selector work before scanning a large remaining input", () => {
    expect(() => parseFileMentionReferences('[File #1 — path: "'.repeat(4_000))).toThrow("file-reference-too-large");
  });
});
