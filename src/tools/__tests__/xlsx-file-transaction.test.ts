import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
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

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

// Confined shells refuse hard links; every case here runs without that right.
vi.mock("node:fs", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs")>(),
  linkSync: () => { throw Object.assign(new Error("EPERM: operation not permitted, link"), { code: "EPERM" }); },
}));

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

  it("publishes a verified recovery copy without a hard link", async () => {
    const { path, before, output } = await workbook(true);
    const snapshot = readWorkbookSnapshot(path);
    expect(publishWorkbookEdit(path, snapshot, output, 1)).toEqual({ editedCells: 1, needsRecalculation: true, backup: `${path}.ave-bak` });
    expect(readFileSync(`${path}.ave-bak`).equals(before)).toBe(true);
    expect(readFileSync(path).equals(output)).toBe(true);
    expect(temporaryNames()).toEqual([]);
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
    const grantOwnRule = (path: string) => {
      execFileSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe"), [path, "/grant", "*S-1-1-0:(R)"], { stdio: "ignore" });
    };
    it.each([true, false])("refuses when the installed access-list reader is unavailable (large: %s)", async (large) => {
      const { path, before, output } = await workbook(large);
      const snapshot = readWorkbookSnapshot(path);
      const scope = large ? "backup" : "workbook";
      const write = vi.fn((descriptor: number, bytes: Buffer, offset: number, length: number) => writeSync(descriptor, bytes, offset, length));
      configureHostResources({ resourcePath: join(directory, "missing-resources"), isPackaged: true });

      expect(() => publishWorkbookEdit(path, snapshot, output, 1, { write }))
        .toThrow(`[${scope}-acl-unreadable]`);
      expect(write).not.toHaveBeenCalled();
      expect(existsSync(`${path}.ave-bak`)).toBe(false);
      expect(readFileSync(path)).toEqual(before);
      expect(temporaryNames()).toEqual([]);
    });

    it.each([
      { damage: "cut header", aceCount: 1, aclHex: "0200", large: false },
      { damage: "cut body", aceCount: 1, aclHex: "020000140089001200", large: true },
      { damage: "missing whole ACE", aceCount: 2, aclHex: "020000140089001200010100000000000100000000", large: false },
      { damage: "header-only ACE", aceCount: 1, aclHex: "0200000400", large: false },
      { damage: "mask without a SID", aceCount: 1, aclHex: "020000080089001200", large: true },
    ])("refuses a native DACL reply with a $damage before writing", async ({ aceCount, aclHex, large }) => {
      const { path, before, output } = await workbook(large);
      const snapshot = readWorkbookSnapshot(path);
      const scope = large ? "backup" : "workbook";
      const write = vi.fn((descriptor: number, bytes: Buffer, offset: number, length: number) => writeSync(descriptor, bytes, offset, length));
      const nativeCall = vi.mocked(execFileSync).mockImplementationOnce((_helper, args) =>
        Buffer.from(JSON.stringify(args?.slice(2).map((file) => {
          const { dev, ino } = lstatSync(file, { bigint: true });
          return { volumeSerialNumber: `0x${dev.toString(16).padStart(16, "0")}`,
            fileIndex: `0x${ino.toString(16).padStart(16, "0")}`, control: 4, aceCount, aclHex };
        }))));

      expect(() => publishWorkbookEdit(path, snapshot, output, 1, { write }))
        .toThrow(expect.objectContaining({ code: `${scope}-acl-unreadable` }));
      expect(nativeCall.mock.lastCall?.[1]?.slice(0, 3)).toEqual(["--dacl", "--file-access", path]);
      expect(write).not.toHaveBeenCalled();
      expect(existsSync(`${path}.ave-bak`)).toBe(false);
      expect(readFileSync(path)).toEqual(before);
      expect(temporaryNames()).toEqual([]);
    });

    it("refuses a native DACL reply bound to the wrong files", async () => {
      const { path, before, output } = await workbook();
      const snapshot = readWorkbookSnapshot(path);
      const read = windowsPathFacts.readWindowsFileDacls;
      const swap = vi.spyOn(windowsPathFacts, "readWindowsFileDacls")
        .mockImplementationOnce((paths) => [...read(paths)].reverse());
      try {
        expect(() => publishWorkbookEdit(path, snapshot, output, 1)).toThrow("[workbook-acl-unreadable]");
      } finally {
        swap.mockRestore();
      }
      expect(readFileSync(path)).toEqual(before);
      expect(temporaryNames()).toEqual([]);
    });

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

    const allow = "0000140089001200010100000000000100000000";
    const audit = "0200140089001200010100000000000100000000";
    function nativeFileDacls(aclFor: (file: string) => { aceCount: number; aclHex: string }) {
      const passthrough = vi.mocked(execFileSync).getMockImplementation();
      vi.mocked(execFileSync).mockImplementation(((helper: string, args: readonly string[] | undefined, options: unknown) => {
        if (args?.[0] !== "--dacl" || args[1] !== "--file-access") return passthrough?.(helper, args, options as never);
        return Buffer.from(JSON.stringify(args.slice(2).map((file) => {
          const { dev, ino } = lstatSync(file, { bigint: true });
          return { volumeSerialNumber: `0x${dev.toString(16).padStart(16, "0")}`,
            fileIndex: `0x${ino.toString(16).padStart(16, "0")}`, control: 4, ...aclFor(file) };
        })));
      }) as typeof execFileSync);
      return () => { vi.mocked(execFileSync).mockImplementation(passthrough as typeof execFileSync); };
    }

    it.each([
      { form: "a revision 3 allow ACE", acl: { aceCount: 1, aclHex: `03${allow}` }, large: false },
      { form: "allow and audit ACEs", acl: { aceCount: 2, aclHex: `02${allow}${audit}` }, large: true },
    ])("publishes when every file keeps $form", async ({ acl, large }) => {
      const { path, output } = await workbook(large);
      const snapshot = readWorkbookSnapshot(path);
      const restore = nativeFileDacls(() => acl);
      try { publishWorkbookEdit(path, snapshot, output, 1); } finally { restore(); }
      expect(readFileSync(path).equals(output)).toBe(true);
    });

    it.each([[true, "backup"], [false, "workbook"]])("refuses a copy that drops the source's audit ACE (large: %s)", async (large, scope) => {
      const { path, before, output } = await workbook(large);
      const snapshot = readWorkbookSnapshot(path);
      const restore = nativeFileDacls((file) => file === path
        ? { aceCount: 2, aclHex: `02${allow}${audit}` } : { aceCount: 1, aclHex: `02${allow}` });
      try {
        expect(() => publishWorkbookEdit(path, snapshot, output, 1)).toThrow(`[${scope}-acl-differs]`);
      } finally {
        restore();
      }
      expect(readFileSync(path).equals(before)).toBe(true);
      expect(temporaryNames()).toEqual([]);
    });

    it.each([[true, "backup"], [false, "workbook"]])("refuses an edit of a workbook with its own access rules (large: %s)", async (large, scope) => {
      const { path, before, output } = await workbook(large);
      grantOwnRule(path);
      const snapshot = readWorkbookSnapshot(path);
      expect(() => publishWorkbookEdit(path, snapshot, output, 1)).toThrow(`[${scope}-acl-differs]`);
      expect(existsSync(`${path}.ave-bak`)).toBe(false);
      expect(readFileSync(path).equals(before)).toBe(true);
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
