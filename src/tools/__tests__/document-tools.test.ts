import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync, symlinkSync, unlinkSync } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFileTools } from "../file-tools.js";
import type { ToolExecutionContext } from "../types.js";

const parser = vi.hoisted(() => ({ parse: vi.fn(), release: vi.fn(), acquire: vi.fn() }));
vi.mock("../preview-document-process.js", () => ({ acquireParseSlot: parser.acquire }));
// Every open passes through; a test may wrap the next one to change the filesystem around it.
const opens = vi.hoisted(() => ({ wrapNext: undefined as ((open: () => Promise<FileHandle>) => Promise<FileHandle>) | undefined }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const open = ((...args: Parameters<typeof actual.open>) => {
    const wrap = opens.wrapNext;
    opens.wrapNext = undefined;
    return wrap ? wrap(() => actual.open(...args)) : actual.open(...args);
  }) as typeof actual.open;
  return { ...actual, default: { ...actual, open }, open };
});

let directory: string;
let context: ToolExecutionContext;
const tool = (name: string) => {
  const found = createFileTools().find((entry) => entry.name === name);
  expect(found, `${name} registered`).toBeDefined();
  return found!;
};

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "ave-document-tools-"));
  context = { cwd: directory, extraAllowedDirectories: [], metadata: { sessionId: "document-test" } };
  writeFileSync(join(directory, "book.csv"), "a,b\nc,d\n");
  parser.parse.mockReset().mockResolvedValue({ format: "csv", needsRecalculation: false, sheetNames: ["Sheet1"], totalSheets: 1,
    sheetsTruncated: false, sheet: { index: 0, name: "Sheet1", rows: [["a", "b"], ["c", "d"]],
      firstRow: 0, firstColumn: 0, totalRows: 2, totalColumns: 2,
      rowsTruncated: false, columnsTruncated: false, cellsTruncated: false, clippedCells: [],
      sourceRange: { firstRow: 0, firstColumn: 0, totalsExact: true } } });
  parser.release.mockReset();
  parser.acquire.mockReset().mockImplementation(async (_owner: string, controller: AbortController) => ({
    signal: controller.signal, parse: parser.parse, release: parser.release,
  }));
});
afterEach(() => {
  opens.wrapNext = undefined;
  rmSync(directory, { recursive: true, force: true });
});

describe("agent document tools", () => {
  it("registers exactly the reader and opener without aliases", () => {
    const names = createFileTools().map((entry) => entry.name);
    expect(names).toContain("read_document");
    expect(names).toContain("open_document");
    expect(names).not.toContain("read_sheet");
  });
  it("works headless and uses the existing child lease for a numeric window", async () => {
    const result = await tool("read_document").execute({ path: "book.csv",
      selection: { kind: "sheet", rowCount: 2, columnCount: 2 } }, { ...context, headless: true });
    expect(result.isError, result.output).toBe(false);
    expect(JSON.parse(result.output).cells).toEqual([["a", "b"], ["c", "d"]]);
    expect(parser.parse).toHaveBeenCalledWith(expect.any(Buffer), "csv", 0,
      expect.objectContaining({ rowCount: 2, columnCount: 2 }));
    expect(parser.release).toHaveBeenCalledOnce();
  });
  it("refuses opening headless without allocating a parser", async () => {
    const result = await tool("open_document").execute({ path: "book.csv" }, { ...context, headless: true });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.output)).toMatchObject({ error: "ui-unavailable", opened: false });
    expect(parser.acquire).not.toHaveBeenCalled();
  });
  it("denies out-of-scope reads when read fencing is enabled before parsing", async () => {
    const other = mkdtempSync(join(tmpdir(), "ave-document-outside-"));
    try {
      writeFileSync(join(other, "secret.csv"), "private");
      const result = await tool("read_document").execute({ path: join(other, "secret.csv") },
        { ...context, blockReadsOutsideWorkingDirectories: true });
      expect(result.isError).toBe(true);
      expect(parser.acquire).not.toHaveBeenCalled();
    } finally { rmSync(other, { recursive: true, force: true }); }
  });
  it("keeps the ordinary unfenced native read policy", async () => {
    const other = mkdtempSync(join(tmpdir(), "ave-document-readable-"));
    try {
      writeFileSync(join(other, "book.csv"), "a,b");
      const result = await tool("read_document").execute({ path: join(other, "book.csv") }, context);
      expect(result.isError, result.output).toBe(false);
    } finally { rmSync(other, { recursive: true, force: true }); }
  });
  it("leaves ordinary secret-file reads to the permission pipeline", async () => {
    mkdirSync(join(directory, ".ssh"));
    writeFileSync(join(directory, ".ssh", "secret.csv"), "a,b");
    const result = await tool("read_document").execute({ path: join(directory, ".ssh", "secret.csv") }, context);
    expect(result.isError).toBe(false);
    expect(parser.acquire).toHaveBeenCalledOnce();
  });
  it("denies host credential stores before reading bytes or parsing", async () => {
    const result = await tool("read_document").execute({ path: join(directory, ".ave", "secrets", "secret.csv") }, context);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.output).error).toBe("sensitive-path");
    expect(parser.acquire).not.toHaveBeenCalled();
  });
  it("hands the parser no bytes from a credential store a folder led to while the document was read", async () => {
    const folder = join(directory, "sheets");
    const store = join(directory, ".ave", "secrets");
    mkdirSync(folder);
    mkdirSync(store, { recursive: true });
    writeFileSync(join(folder, "book.csv"), "a,b\nc,d\n");
    writeFileSync(join(store, "book.csv"), "token,PROTECTED\n");
    // The folder leads into the store from just before the open until the first read, and is back before anything
    // looks at the path again.
    opens.wrapNext = async (open) => {
      renameSync(folder, `${folder}.orig`);
      symlinkSync(store, folder, "junction");
      const handle = await open();
      const read = handle.read.bind(handle);
      vi.spyOn(handle, "read").mockImplementationOnce((async (...args: Parameters<FileHandle["read"]>) => {
        unlinkSync(folder);
        renameSync(`${folder}.orig`, folder);
        return read(...args);
      }) as FileHandle["read"]);
      return handle;
    };
    const result = await tool("read_document").execute({ path: "sheets/book.csv",
      selection: { kind: "sheet", rowCount: 2, columnCount: 2 } }, context);
    expect(opens.wrapNext).toBeUndefined();
    expect(result.isError, result.output).toBe(true);
    expect(JSON.parse(result.output).error).toBe("read-failed");
    expect(parser.parse).not.toHaveBeenCalled();
    // Nothing swapped: the same document is read.
    const again = await tool("read_document").execute({ path: "sheets/book.csv",
      selection: { kind: "sheet", rowCount: 2, columnCount: 2 } }, context);
    expect(again.isError, again.output).toBe(false);
    expect(parser.parse.mock.calls[0]?.[0]).toEqual(Buffer.from("a,b\nc,d\n"));
  });
  it("uses the canonical target's format instead of a symlink alias extension", async () => {
    symlinkSync(join(directory, "book.csv"), join(directory, "alias.pdf"));
    const result = await tool("read_document").execute({ path: "alias.pdf" }, context);
    expect(result.isError, result.output).toBe(false);
    expect(parser.parse.mock.calls[0]?.[1]).toBe("csv");
  });
  it("preserves credential admission refusal before a headless UI failure", async () => {
    const result = await tool("open_document").execute({ path: join(directory, ".ave", "secrets", "secret.csv") },
      { ...context, headless: true });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.output).error).toBe("sensitive-path");
  });
  it("rejects a page selector for a sheet and oversized windows before parsing", async () => {
    const reader = tool("read_document");
    expect((await reader.execute({ path: "book.csv", selection: { kind: "page" } }, context)).isError).toBe(true);
    expect((await reader.execute({ path: "book.csv", selection: { kind: "sheet", rowCount: 100, columnCount: 50 } }, context)).isError).toBe(true);
    expect(parser.acquire).not.toHaveBeenCalled();
  });
  it("releases the lease when child parsing refuses a document", async () => {
    parser.parse.mockRejectedValueOnce(new Error("untrusted parser diagnostic"));
    const result = await tool("read_document").execute({ path: "book.csv" }, context);
    expect(result.isError).toBe(true);
    expect(result.output).not.toContain("untrusted parser diagnostic");
    expect(parser.release).toHaveBeenCalledOnce();
  });
});
