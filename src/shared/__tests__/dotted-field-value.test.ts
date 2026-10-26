/** Exercise both consumers so reviewer and pipeline cannot silently diverge from shared field selection. */
import { describe, expect, it } from "vitest";
import { join, resolve } from "node:path";
import { getDottedFieldValue } from "../dotted-field-value.js";
import { extractTargetFilePaths } from "../../tools/pipeline/path-extraction.js";
import type { Tool } from "../../tools/base.js";

function toolWith(pathFields: readonly string[]): Tool {
  return { pathFields } as unknown as Tool;
}

describe("getDottedFieldValue", () => {
  it("walks a dotted path into nested objects", () => {
    expect(getDottedFieldValue({ a: { b: { c: "hit" } } }, "a.b.c")).toBe("hit");
  });

  it("returns the array itself when the field holds one", () => {
    expect(getDottedFieldValue({ files: ["x", "y"] }, "files")).toEqual(["x", "y"]);
  });

  it("refuses to index INTO an array", () => {
    // Array indexes must not resolve to a single path when the declared field represents several.
    expect(getDottedFieldValue({ files: ["x", "y"] }, "files.0")).toBeUndefined();
  });

  it("returns undefined for an empty segment rather than the container", () => {
    expect(getDottedFieldValue({ a: { b: "v" } }, "a..b")).toBeUndefined();
    expect(getDottedFieldValue({ a: { b: "v" } }, ".a")).toBeUndefined();
    expect(getDottedFieldValue({ a: "v" }, "")).toBeUndefined();
  });

  it("returns undefined when an intermediate segment is a non-object", () => {
    expect(getDottedFieldValue({ a: "string" }, "a.b")).toBeUndefined();
    expect(getDottedFieldValue({ a: null }, "a.b")).toBeUndefined();
  });

  it("does not reach a prototype-only key through a declared field", () => {
    // Manifest-supplied field names are untrusted; prototype keys must not yield usable values.
    expect(getDottedFieldValue({}, "toString")).toBe(Object.prototype.toString);
    expect(typeof getDottedFieldValue({}, "toString")).not.toBe("string");
  });
});

describe("the pipeline extractor selects through the shared helper", () => {
  const cwd = "/work/project";

  it("enumerates every element of an array-valued path field", () => {
    const paths = extractTargetFilePaths(
      toolWith(["files"]),
      { files: ["/a/one.txt", "/a/two.txt"] },
      cwd,
    );
    expect(paths).toHaveLength(2);
  });

  it("selects a nested path field and drops one that is not reachable", () => {
    const reachable = extractTargetFilePaths(
      toolWith(["target.path"]),
      { target: { path: "/a/one.txt" } },
      cwd,
    );
    expect(reachable).toHaveLength(1);

    const unreachable = extractTargetFilePaths(
      toolWith(["files.0"]),
      { files: ["/a/one.txt"] },
      cwd,
    );
    expect(unreachable).toEqual([]);
  });

  it("selects nothing for an empty-segment declaration", () => {
    expect(
      extractTargetFilePaths(toolWith(["a..b"]), { a: { b: "/a/one.txt" } }, cwd),
    ).toEqual([]);
  });
});

describe("patch-envelope path fields", () => {
  const patch = [
    "*** Begin Patch",
    "*** Update File: src/a.ts",
    "*** Move to: src/b.ts",
    "-x",
    "+y",
    "*** Delete File: .env",
    "*** End Patch",
  ].join("\n");

  it("selects the files the patch names for the pipeline's target paths", () => {
    // Use native absolute paths so expectations preserve this platform’s root and separators.
    const work = resolve("/work");
    expect(extractTargetFilePaths(toolWith(["patch#patch-envelope"]), { patch }, work)).toEqual([
      join(work, "src", "a.ts"),
      join(work, "src", "b.ts"),
      join(work, ".env"),
    ]);
  });

  it("fails clearly for an unparseable patch instead of declaring no path", () => {
    expect(() => extractTargetFilePaths(toolWith(["patch#patch-envelope"]), { patch: "not a patch" }, "/work"))
      .toThrow("invalid patch");
  });
});
