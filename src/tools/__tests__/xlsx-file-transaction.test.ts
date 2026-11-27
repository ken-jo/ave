import { randomBytes } from "node:crypto";
import { constants, copyFileSync, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import JSZip from "jszip";
import * as XLSX from "xlsx";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { editWorkbookFile } from "../../skills/xlsx-edit.js";
import { publishWorkbookEdit, readWorkbookSnapshot } from "../../skills/xlsx-file-transaction.js";
import { parseTableDocument } from "../table-document-reader.js";
import { configureHostResources } from "../../main/host-resources.js";
import * as windowsPathFacts from "../../shared/windows-path-facts.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, fstatSync: vi.fn(actual.fstatSync), linkSync: vi.fn((source: string, target: string) => {
    if (process.platform === "win32") throw Object.assign(new Error("Hard link refused"), { code: "EPERM" });
    return actual.linkSync(source, target);
  }) };
});

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "ave-workbook-transaction-"));
  configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
});
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
    else {
      expect(lstatSync(backup).isSymbolicLink()).toBe(true);
      expect(existsSync(join(directory, "absent.xlsx"))).toBe(false);
    }
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

  it.skipIf(process.platform !== "win32")("publishes a verified recovery copy without a hard link", async () => {
    const { path, before, output } = await workbook(true);
    const snapshot = readWorkbookSnapshot(path);
    expect(publishWorkbookEdit(path, snapshot, output, 1)).toEqual({ editedCells: 1, needsRecalculation: true, backup: `${path}.ave-bak` });
    expect(readFileSync(`${path}.ave-bak`).equals(before)).toBe(true);
    expect(readFileSync(path).equals(output)).toBe(true);
    expect(temporaryNames()).toEqual([]);
  });

  it.each(["darwin", "linux"])("publishes the recovery name only after staging without a descriptor stat on %s", async (platform) => {
    const path = join(directory, "book.xlsx");
    const before = Buffer.alloc(8 * 1024 * 1024 + 1, 0x61);
    const output = Buffer.from("validated output");
    const backup = `${path}.ave-bak`;
    writeFileSync(path, before);
    const snapshot = readWorkbookSnapshot(path);
    const publish = vi.mocked(linkSync).mockImplementationOnce((source, target) => {
      expect(target).toBe(backup);
      expect(existsSync(backup)).toBe(false);
      expect(readFileSync(source).equals(before)).toBe(true);
      copyFileSync(source, target, constants.COPYFILE_EXCL);
    });
    publish.mockClear();
    const stat = vi.mocked(fstatSync);
    const actualStat = stat.getMockImplementation();
    if (!actualStat) throw new Error("Expected a descriptor stat implementation");
    stat.mockImplementation(((...args: Parameters<typeof fstatSync>) => {
      const identity = actualStat(...args);
      if (identity.size === 0n) throw new Error("Unexpected stat of an empty staging descriptor");
      return identity;
    }) as typeof fstatSync);
    vi.stubGlobal("process", Object.create(process, { platform: { value: platform } }));
    try {
      expect(publishWorkbookEdit(path, snapshot, output, 1, { write(descriptor, bytes, offset, length) {
        if (bytes === snapshot.data) expect(existsSync(backup)).toBe(false);
        return writeSync(descriptor, bytes, offset, length);
      } })).toEqual({ editedCells: 1, needsRecalculation: true, backup });
      expect(publish).toHaveBeenCalledOnce();
      expect(readFileSync(backup).equals(before)).toBe(true);
      expect(readFileSync(path)).toEqual(output);
      expect(temporaryNames()).toEqual([]);
    } finally {
      publish.mockReset();
      stat.mockImplementation(actualStat);
      vi.unstubAllGlobals();
    }
  });

  it.each(["darwin", "linux"])("uses the original snapshot behavior with a Windows handoff on %s", async platform => {
    const { path, before } = await workbook();
    vi.stubGlobal("process", Object.create(process, { platform: { value: platform } }));
    try {
      expect(readWorkbookSnapshot(path, "invalid Windows identity").data).toEqual(before);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each(["darwin", "linux"])("removes the output staging name with Unix cleanup on %s", (platform) => {
    const path = join(directory, "book.xlsx");
    const before = Buffer.from("original bytes");
    writeFileSync(path, before);
    const snapshot = readWorkbookSnapshot(path);
    vi.stubGlobal("process", Object.create(process, { platform: { value: platform } }));
    try {
      expect(() => publishWorkbookEdit(path, snapshot, Buffer.from("validated output"), 1, { write() {
        const [temporary] = temporaryNames();
        if (temporary === undefined) throw new Error("Expected an output staging file");
        const staged = join(directory, temporary);
        renameSync(staged, join(directory, "retired-staging"));
        writeFileSync(staged, "rebound staging name");
        throw new Error("Interrupted staging");
      } })).toThrow("Interrupted staging");
      expect(temporaryNames()).toEqual([]);
      expect(readFileSync(path)).toEqual(before);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.skipIf(process.platform === "win32")("creates the recovery copy owner-only", async () => {
    const { path, output } = await workbook(true);
    publishWorkbookEdit(path, readWorkbookSnapshot(path), output, 1);
    expect(statSync(`${path}.ave-bak`).mode & 0o777).toBe(0o600);
  });

  it("removes a recovery copy whose write fails", async () => {
    const { path, before, output } = await workbook(true);
    const snapshot = readWorkbookSnapshot(path);
    expect(() => publishWorkbookEdit(path, snapshot, output, 1, { write(descriptor, bytes, offset, length) {
      if (offset > 0) throw Object.assign(new Error("No space left"), { code: "ENOSPC" });
      return writeSync(descriptor, bytes, offset, length);
    } })).toThrow("No space left");
    expect(existsSync(`${path}.ave-bak`)).toBe(false);
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(temporaryNames()).toEqual([]);
  });

  it("removes a recovery copy that fails verification", async () => {
    const { path, before, output } = await workbook(true);
    const snapshot = readWorkbookSnapshot(path);
    expect(() => publishWorkbookEdit(path, snapshot, output, 1, { write(descriptor, bytes, offset, length) {
      return writeSync(descriptor, bytes === snapshot.data ? Buffer.alloc(bytes.length) : bytes, offset, length);
    } })).toThrow("Backup verification failed");
    expect(existsSync(`${path}.ave-bak`)).toBe(false);
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(temporaryNames()).toEqual([]);
  });

  describe.runIf(process.platform === "win32")("Windows access rules", () => {
    const aces = (path: string) => {
      const list = windowsPathFacts.readWindowsDacls([path])[0]?.dacl?.aces;
      if (!list?.length) throw new Error("No access list was read");
      return list.map(({ type, flags, mask, sid }) => ({ type, flags, mask, sid }));
    };
    it("gives the recovery copy and the edited workbook the inherited access list", async () => {
      const { path, before, output } = await workbook(true);
      const original = aces(path);
      publishWorkbookEdit(path, readWorkbookSnapshot(path), output, 1);
      expect(readFileSync(`${path}.ave-bak`).equals(before)).toBe(true);
      expect(aces(`${path}.ave-bak`)).toEqual(original);
      expect(aces(path)).toEqual(original);
    });

    it("keeps the inherited access list on a small edit", async () => {
      const { path, output } = await workbook();
      const original = aces(path);
      publishWorkbookEdit(path, readWorkbookSnapshot(path), output, 1);
      expect(readFileSync(path).equals(output)).toBe(true);
      expect(aces(path)).toEqual(original);
      expect(temporaryNames()).toEqual([]);
    });
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

  it("keeps recovery publication bound to the canonical parent when a supplied alias changes", async () => {
    const { path, before, output } = await workbook(true);
    const alias = `${directory}-alias`;
    const other = join(directory, "other");
    mkdirSync(other);
    symlinkSync(directory, alias, "junction");
    const requested = join(alias, "book.xlsx");
    const snapshot = readWorkbookSnapshot(requested);
    let replaced = false;
    try {
      expect(() => publishWorkbookEdit(requested, snapshot, output, 1, { write(descriptor, bytes, offset, length) {
        if (!replaced) { replaced = true; unlinkSync(alias); symlinkSync(other, alias, "junction"); }
        return writeSync(descriptor, bytes, offset, length);
      } })).toThrow("Workbook changed");
      expect(existsSync(`${path}.ave-bak`)).toBe(false);
      expect(existsSync(join(other, "book.xlsx.ave-bak"))).toBe(false);
      expect(readFileSync(path).equals(before)).toBe(true);
    } finally { unlinkSync(alias); }
  });
});
