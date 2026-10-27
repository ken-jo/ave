import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import JSZip from "jszip";
import * as XLSX from "xlsx";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { editWorkbookFile } from "../../skills/xlsx-edit.js";
import { createWorkbookFileSnapshot, publishWorkbookEdit, readWorkbookSnapshot } from "../../skills/xlsx-file-transaction.js";
import { parseTableDocument } from "../table-document-reader.js";

let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "ave-workbook-transaction-")); });
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

async function workbook(large = false): Promise<{ path: string; before: Buffer; output: Buffer }> {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["Revenue", 12]]), "Budget");
  const zip = await JSZip.loadAsync(XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer);
  if (large) zip.file("xl/media/generated.bin", randomBytes(8 * 1024 * 1024));
  const path = join(directory, "book.xlsx");
  const before = await zip.generateAsync({ type: "nodebuffer", compression: "STORE" });
  writeFileSync(path, before);
  const staging = join(directory, "output.xlsx");
  writeFileSync(staging, before);
  await editWorkbookFile(staging, { sheet: 0, edits: [{ cell: "B1", value: 84 }] });
  return { path, before, output: readFileSync(staging) };
}
function temporaryNames(parent = directory): string[] {
  return readdirSync(parent).filter((name) => name.startsWith(".ave-xlsx-"));
}

describe("workbook file transaction", () => {
  it("publishes the same validated output and recalculation signal used by the command", async () => {
    const { path, output } = await workbook();
    const snapshot = readWorkbookSnapshot(path);
    expect(publishWorkbookEdit(path, snapshot, output, 1)).toEqual({ editedCells: 1, needsRecalculation: true, backup: null });
    const document = await parseTableDocument(readFileSync(path), "xlsx", 0);
    expect(document.sheet.rows[0]).toEqual(["Revenue", "84"]);
    expect(document.needsRecalculation).toBe(true);
    expect(temporaryNames()).toEqual([]);
  });

  it("binds a descriptor-verified asynchronous reader snapshot without changing its public shape", async () => {
    const { path, before, output } = await workbook();
    const snapshot = createWorkbookFileSnapshot(path, before, lstatSync(path, { bigint: true }),
      lstatSync(realpathSync(dirname(path)), { bigint: true }));
    expect(Object.keys(snapshot).sort()).toEqual(["data", "identity"]);
    expect(publishWorkbookEdit(path, snapshot, output, 1).editedCells).toBe(1);
    expect(readFileSync(path).equals(output)).toBe(true);
  });

  it("refuses a stale identity before creating a recovery copy", async () => {
    const { path, before, output } = await workbook(true);
    expect(before.length).toBeGreaterThan(8 * 1024 * 1024);
    const snapshot = readWorkbookSnapshot(path);
    const replacement = join(directory, "replacement.xlsx");
    writeFileSync(replacement, before);
    renameSync(replacement, path);
    expect(() => publishWorkbookEdit(path, snapshot, output, 1)).toThrow("Workbook changed");
    expect(existsSync(`${path}.ave-bak`)).toBe(false);
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(temporaryNames()).toEqual([]);
  });

  it("checks source bytes even when the snapshot identity still matches", async () => {
    const { path, before, output } = await workbook();
    const snapshot = readWorkbookSnapshot(path);
    snapshot.data = Buffer.from(snapshot.data);
    snapshot.data[0] = snapshot.data[0]! ^ 1;
    expect(() => publishWorkbookEdit(path, snapshot, output, 1)).toThrow("Workbook changed");
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(temporaryNames()).toEqual([]);
  });

  it("refuses another destination and an unbound reconstructed snapshot", async () => {
    const { path, before, output } = await workbook();
    const snapshot = readWorkbookSnapshot(path);
    const other = join(directory, "other.xlsx");
    copyFileSync(path, other);
    expect(() => publishWorkbookEdit(other, snapshot, output, 1)).toThrow("Workbook changed");
    expect(() => publishWorkbookEdit(path, { ...snapshot }, output, 1)).toThrow("no bound parent");
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(readFileSync(other).equals(before)).toBe(true);
  });

  it("refuses a replaced canonical parent before writing into its replacement", async () => {
    const { path, before, output } = await workbook();
    const snapshot = readWorkbookSnapshot(path);
    const moved = `${directory}-moved`;
    renameSync(directory, moved);
    mkdirSync(directory);
    writeFileSync(path, before);
    try {
      expect(() => publishWorkbookEdit(path, snapshot, output, 1)).toThrow("Workbook changed");
      expect(readFileSync(path).equals(before)).toBe(true);
      expect(temporaryNames()).toEqual([]);
      expect(temporaryNames(moved)).toEqual([]);
    } finally { rmSync(moved, { recursive: true, force: true }); }
  });

  it.each(["file", "dangling-link"])("refuses an existing %s recovery path without replacement", async (kind) => {
    const { path, before, output } = await workbook(true);
    const snapshot = readWorkbookSnapshot(path);
    const backup = `${path}.ave-bak`;
    if (kind === "file") writeFileSync(backup, "incomplete");
    else symlinkSync(join(directory, "absent.xlsx"), backup);
    expect(() => publishWorkbookEdit(path, snapshot, output, 1)).toThrow();
    expect(readFileSync(path).equals(before)).toBe(true);
    if (kind === "file") expect(readFileSync(backup, "utf8")).toBe("incomplete");
    else expect(lstatSync(backup).isSymbolicLink()).toBe(true);
    expect(temporaryNames()).toEqual([]);
  });

  it("verifies source again after backup staging and before publishing recovery bytes", async () => {
    const { path, before, output } = await workbook(true);
    const snapshot = readWorkbookSnapshot(path);
    let changed = false;
    expect(() => publishWorkbookEdit(path, snapshot, output, 1, { write(descriptor, bytes, offset, length) {
      if (!changed) { changed = true; writeFileSync(path, output); }
      return writeSync(descriptor, bytes, offset, length);
    } })).toThrow("Workbook changed");
    expect(existsSync(`${path}.ave-bak`)).toBe(false);
    expect(readFileSync(path).equals(output)).toBe(true);
    expect(snapshot.data.equals(before)).toBe(true);
    expect(temporaryNames()).toEqual([]);
  });

  it("retains a verified recovery copy when source changes during output staging", async () => {
    const { path, before, output } = await workbook(true);
    const snapshot = readWorkbookSnapshot(path);
    let changed = false;
    expect(() => publishWorkbookEdit(path, snapshot, output, 1, { write(descriptor, bytes, offset, length) {
      if (bytes === output && !changed) { changed = true; writeFileSync(path, "concurrent writer"); }
      return writeSync(descriptor, bytes, offset, length);
    } })).toThrow("Workbook changed");
    expect(readFileSync(`${path}.ave-bak`).equals(before)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("concurrent writer");
    expect(temporaryNames()).toEqual([]);
  });

  it("removes failed output staging and leaves source unchanged", async () => {
    const { path, before, output } = await workbook();
    const snapshot = readWorkbookSnapshot(path);
    expect(() => publishWorkbookEdit(path, snapshot, output, 1, { write() {
      throw Object.assign(new Error("No space left"), { code: "ENOSPC" });
    } })).toThrow("No space left");
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(temporaryNames()).toEqual([]);
  });

  it("refuses a completed but corrupted staged output", async () => {
    const { path, before, output } = await workbook();
    const snapshot = readWorkbookSnapshot(path);
    expect(() => publishWorkbookEdit(path, snapshot, output, 1, { write(descriptor, bytes, offset, length) {
      return writeSync(descriptor, Buffer.alloc(bytes.length), offset, length);
    } })).toThrow("Output verification failed");
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(temporaryNames()).toEqual([]);
  });

  it.each([1, 2, 3])("rechecks host authority at publication boundary %i", async (boundary) => {
    const { path, before, output } = await workbook();
    const snapshot = readWorkbookSnapshot(path);
    let checks = 0;
    expect(() => publishWorkbookEdit(path, snapshot, output, 1, { assertCurrent() {
      checks += 1;
      if (checks === boundary) throw new Error("Authority expired");
    } })).toThrow("Authority expired");
    expect(checks).toBe(boundary);
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(temporaryNames()).toEqual([]);
  });

  it("rechecks host authority before a recovery copy becomes visible", async () => {
    const { path, before, output } = await workbook(true);
    const snapshot = readWorkbookSnapshot(path);
    let checks = 0;
    expect(() => publishWorkbookEdit(path, snapshot, output, 1, { assertCurrent() {
      checks += 1;
      if (checks === 2) throw new Error("Authority expired");
    } })).toThrow("Authority expired");
    expect(existsSync(`${path}.ave-bak`)).toBe(false);
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(temporaryNames()).toEqual([]);
  });

  it("keeps recovery publication bound to the canonical parent when a supplied alias changes", async () => {
    const { path, before, output } = await workbook(true);
    const alias = `${directory}-alias`;
    const other = join(directory, "other");
    mkdirSync(other);
    symlinkSync(directory, alias, "junction");
    const requested = join(alias, "book.xlsx");
    const snapshot = readWorkbookSnapshot(requested);
    let checks = 0;
    try {
      expect(() => publishWorkbookEdit(requested, snapshot, output, 1, { assertCurrent() {
        checks += 1;
        if (checks === 2) { unlinkSync(alias); symlinkSync(other, alias, "junction"); }
      } })).toThrow("Workbook changed");
      expect(existsSync(`${path}.ave-bak`)).toBe(false);
      expect(existsSync(join(other, "book.xlsx.ave-bak"))).toBe(false);
      expect(readFileSync(path).equals(before)).toBe(true);
    } finally { unlinkSync(alias); }
  });
});
