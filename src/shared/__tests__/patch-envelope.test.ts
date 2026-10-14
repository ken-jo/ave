import { describe, expect, it } from "vitest";

import {
  applyPatchChunks,
  parsePatchEnvelope,
  patchOperationPaths,
  type PatchChunk,
} from "../patch-envelope.js";

function envelope(...body: string[]): string {
  return ["*** Begin Patch", ...body, "*** End Patch"].join("\n");
}

function chunksOf(text: string): readonly PatchChunk[] {
  const parsed = parsePatchEnvelope(text);
  if (!parsed.ok) throw new Error(parsed.error);
  const operation = parsed.operations[0];
  if (operation?.kind !== "update") throw new Error("expected an update section");
  return operation.chunks;
}

describe("parsePatchEnvelope", () => {
  it("parses add, update with move, and delete sections", () => {
    const parsed = parsePatchEnvelope(envelope(
      "*** Add File: a.txt",
      "+one",
      "+",
      "*** Update File: b.txt",
      "*** Move to: c.txt",
      "@@ def main():",
      " keep",
      "-old",
      "+new",
      "*** Delete File: d.txt",
    ));
    expect(parsed).toEqual({
      ok: true,
      operations: [
        { kind: "add", path: "a.txt", content: "one\n\n" },
        {
          kind: "update",
          path: "b.txt",
          moveTo: "c.txt",
          chunks: [{ anchor: "def main():", oldLines: ["keep", "old"], newLines: ["keep", "new"], endOfFile: false }],
        },
        { kind: "delete", path: "d.txt" },
      ],
    });
  });

  it("accepts CRLF patch text and a surrounding code fence", () => {
    const text = ["```diff", envelope("*** Delete File: a.txt"), "```"].join("\r\n");
    expect(parsePatchEnvelope(text)).toEqual({ ok: true, operations: [{ kind: "delete", path: "a.txt" }] });
  });

  it("splits chunks on bare @@ lines and marks end-of-file chunks", () => {
    const chunks = chunksOf(envelope(
      "*** Update File: a.txt",
      "-one",
      "+ONE",
      "@@",
      "-two",
      "+TWO",
      "*** End of File",
    ));
    expect(chunks).toEqual([
      { anchor: null, oldLines: ["one"], newLines: ["ONE"], endOfFile: false },
      { anchor: null, oldLines: ["two"], newLines: ["TWO"], endOfFile: true },
    ]);
  });

  it.each([
    ["a missing begin marker", "*** Delete File: a.txt\n*** End Patch", "first line"],
    ["a missing end marker", "*** Begin Patch\n*** Delete File: a.txt", "last line"],
    ["no sections", envelope(), "names no files"],
    ["an unknown header", envelope("*** Rename File: a.txt"), "expected"],
    ["an add line without +", envelope("*** Add File: a.txt", "oops"), "must start with '+'"],
    ["a chunk without changes", envelope("*** Update File: a.txt", " context only"), "at least one"],
    ["an update without chunks", envelope("*** Update File: a.txt"), "has no changes"],
    ["a chunk line with a bad marker", envelope("*** Update File: a.txt", "*bad"), "must start with"],
  ])("rejects %s", (_label, text, message) => {
    const parsed = parsePatchEnvelope(text);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain(message);
  });

  it("lists every path once, including move destinations", () => {
    const parsed = parsePatchEnvelope(envelope(
      "*** Update File: a.txt",
      "*** Move to: b.txt",
      "-x",
      "+y",
      "*** Delete File: a.txt",
    ));
    if (!parsed.ok) throw new Error(parsed.error);
    expect(patchOperationPaths(parsed.operations)).toEqual(["a.txt", "b.txt"]);
  });
});

describe("applyPatchChunks", () => {
  it("replaces lines located after the anchor and keeps the final newline", () => {
    const chunks = chunksOf(envelope(
      "*** Update File: a.txt",
      "@@ second",
      "-x",
      "+X",
    ));
    expect(applyPatchChunks("first\nx\nsecond\nx\n", chunks)).toEqual({ ok: true, content: "first\nx\nsecond\nX\n" });
  });

  it("preserves CRLF separators and a missing final newline", () => {
    const chunks = chunksOf(envelope("*** Update File: a.txt", " a", "-b", "+B"));
    expect(applyPatchChunks("a\r\nb", chunks)).toEqual({ ok: true, content: "a\r\nB" });
  });

  it("falls back to whitespace-insensitive line matching", () => {
    const chunks = chunksOf(envelope("*** Update File: a.txt", "-value = 1", "+value = 2"));
    expect(applyPatchChunks("  value = 1   \n", chunks)).toEqual({ ok: true, content: "value = 2\n" });
  });

  it("inserts after the anchor for a chunk without old lines", () => {
    const chunks = chunksOf(envelope("*** Update File: a.txt", "@@ head", "+inserted"));
    expect(applyPatchChunks("head\ntail\n", chunks)).toEqual({ ok: true, content: "head\ninserted\ntail\n" });
  });

  it("matches an end-of-file chunk only at the end", () => {
    const chunks = chunksOf(envelope("*** Update File: a.txt", "-x", "+X", "*** End of File"));
    expect(applyPatchChunks("x\ny\nx\n", chunks)).toEqual({ ok: true, content: "x\ny\nX\n" });
  });

  it("applies chunks in order and reports a chunk it cannot place", () => {
    const chunks = chunksOf(envelope("*** Update File: a.txt", "-two", "+2", "@@", "-one", "+1"));
    const result = applyPatchChunks("one\ntwo\n", chunks);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("chunk 2: expected lines not found");
  });

  it("reports a missing anchor", () => {
    const chunks = chunksOf(envelope("*** Update File: a.txt", "@@ nowhere", "-a", "+b"));
    const result = applyPatchChunks("a\n", chunks);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("anchor line not found");
  });
});
