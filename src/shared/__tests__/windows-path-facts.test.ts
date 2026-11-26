import { execFileSync } from "node:child_process";
import { closeSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { configureHostResources } from "../../main/host-resources.js";
import { removeLinksUnder } from "../../__tests__/support/tmp-dir-teardown.js";
import { isWindowsPathKindHelperUnavailable } from "../../main/windows-path-kind-launcher.js";
import { TOOL_TIMEOUT_POLICY } from "../tool-timeout-policy.js";
import { admitWindowsReparse, decodeWindowsPathFacts, evaluateWindowsReadDacl, isOwnerOnlyDacl, leadingWindowsDenies, mapWindowsGenericRights, pinWindowsPaths, readWindowsDacls, readWindowsFileDacls, windowsObjectKey, windowsOwnerRules, windowsPathKey, type WindowsDacl, type WindowsPathFacts } from "../windows-path-facts.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

const SID = "S-1-5-21-100-200-300-1001";
const ORDINARY: WindowsPathFacts = { exists: true, canonical: "\\\\?\\C:\\fixture", volumeSerial: "0x0000000000000001",
  fileId: "0x00000000000000000000000000000001", volumeSerialNumber: "0x0000000000000001", fileIndex: "0x0000000000000001",
  changeTime: "0x0000000000000001", attributes: 16, reparseTag: 0, reparseTarget: null, directory: true, ancestors: [] };

function descriptor(aces: WindowsDacl["aces"]): WindowsDacl {
  return { identity: { volumeSerial: ORDINARY.volumeSerial!, fileId: ORDINARY.fileId! }, owner: SID, group: SID, protected: true, nullDacl: false, aces };
}

describe("Windows path facts admission and evaluation", () => {
  it("keys objects by volume and file ID independently of aliases and case", () => {
    for (const canonical of ["C:\\fixture\\Foo", "C:\\fixture\\foo", "C:\\alias\\FOO~1"]) {
      const alias: WindowsPathFacts = { ...ORDINARY, canonical };
      expect(windowsObjectKey(alias)).toBe(windowsObjectKey(ORDINARY));
    }
    expect(windowsObjectKey({ ...ORDINARY, fileId: "0x00000000000000000000000000000002" })).not.toBe(windowsObjectKey(ORDINARY));
    expect(windowsObjectKey({ ...ORDINARY, volumeSerial: "0x0000000000000002" })).not.toBe(windowsObjectKey(ORDINARY));
    expect(() => windowsObjectKey({ ...ORDINARY, fileId: null })).toThrow(/identity is missing/);
    expect(() => windowsObjectKey({ ...ORDINARY, volumeSerial: null })).toThrow(/identity is missing/);
  });

  it.each([
    ["\\\\?\\D:\\WORK\\allowed\\", "d:/work/allowed"],
    ["\\\\?\\UNC\\SERVER\\Share\\Allowed\\", "\\\\server\\share\\allowed"],
    ["\\\\?\\unc\\server\\Share\\", "//SERVER/share"],
    ["D:\\work\\nested\\..\\allowed\\", "d:\\work\\allowed"],
  ])("normalizes native and requested path spellings %s", (native, requested) => {
    expect(windowsPathKey(native)).toBe(windowsPathKey(requested));
    expect(windowsPathKey(native)).not.toBe(windowsPathKey(`${requested}-sibling`));
  });

  it("admits ordinary grant tags and resolves only supported name surrogates", () => {
    expect(admitWindowsReparse(ORDINARY, "grant")).toBe(true);
    for (const reparseTag of [0x80000015, 0x9000001a, 0x80000042]) {
      const cloud = { ...ORDINARY, reparseTag, attributes: 0x410 };
      expect(admitWindowsReparse(cloud, "grant")).toBe(true);
      expect(admitWindowsReparse(cloud, "evidence")).toBe(false);
    }
    for (const reparseTag of [0xa0000003, 0xa000000c]) {
      const link = { ...ORDINARY, reparseTag, attributes: 0x410 };
      expect(admitWindowsReparse(link, "grant")).toBe("resolve");
      expect(admitWindowsReparse({ ...ORDINARY, exists: null, ancestors: [link] }, "grant")).toBe("resolve");
      expect(admitWindowsReparse(link, "evidence")).toBe(false);
    }
    expect(admitWindowsReparse({ ...ORDINARY, reparseTag: 0xa0000042, attributes: 0x410 }, "grant")).toBe(false);
    expect(admitWindowsReparse({ ...ORDINARY, attributes: 0x410 }, "grant")).toBe(false);
    expect(admitWindowsReparse({ ...ORDINARY, exists: null }, "grant")).toBe(false);
  });

  it("refuses unfamiliar tags and every reparse ancestor through one admission rule", () => {
    expect(admitWindowsReparse(ORDINARY)).toBe(true);
    for (const reparseTag of [0xa0000003, 0xa000000c, 0x80000042]) {
      const link = { ...ORDINARY, reparseTag, attributes: 0x410 };
      expect(admitWindowsReparse(link)).toBe(false);
      expect(admitWindowsReparse({ ...ORDINARY, exists: null, ancestors: [link] })).toBe(false);
    }
    expect(admitWindowsReparse({ ...ORDINARY, attributes: 0x410 })).toBe(false);
  });

  it("admits a proven child below a non-surrogate ancestor only for grants", () => {
    const child = { ...ORDINARY, ancestors: [{ ...ORDINARY, reparseTag: 0x9000001a, attributes: 0x410 }] };
    expect(admitWindowsReparse(child, "grant")).toBe(true);
    expect(admitWindowsReparse(child, "evidence")).toBe(false);
    expect(admitWindowsReparse({ ...child, exists: null }, "grant")).toBe(false);
  });

  it("keeps every migrated consumer on the common reparse admission rule", () => {
    for (const path of ["src/permissions/windows-deny-acl.ts", "src/shared/ave-home.ts", "src/shared/windows-admin-policy.ts", "src/shared/windows-read-deny-evidence.ts", "src/permissions/asrt-sandbox.ts"]) {
      const source = readFileSync(resolve(path), "utf8");
      expect(source).toContain("admitWindowsReparse(");
      expect(source).not.toMatch(/reparseTag|FILE_ATTRIBUTE_REPARSE_POINT|isSymbolicLink|FileAttributes\]::ReparsePoint/);
      expect(source).not.toMatch(/Get-Acl|GetAccessControl|GetSecurityInfo/);
    }
  });

  it("maps generic rights without losing ordinary or standard rights", () => {
    expect(mapWindowsGenericRights(0x80000000)).toBe(0x120089);
    expect(mapWindowsGenericRights(0x40000000)).toBe(0x120116);
    expect(mapWindowsGenericRights(0x20000000)).toBe(0x1200a0);
    expect(mapWindowsGenericRights(0x10000000)).toBe(0x1f01ff);
    expect(mapWindowsGenericRights(0x80040000)).toBe(0x160089);
  });

  it("counts only leading explicit ordinary denies with complete propagation", () => {
    const ace = { type: 1, flags: 3, mask: 0x80000001, sid: SID };
    expect(leadingWindowsDenies(descriptor([ace]), SID)).toEqual({ mask: 0x80000001, inheritable: 0x80000001 });
    for (const flags of [7, 11, 19]) expect(leadingWindowsDenies(descriptor([{ ...ace, flags }]), SID).inheritable).toBe(0);
    for (const first of [{ ...ace, type: 0 }, { ...ace, flags: 16 }, { ...ace, type: 6 }]) {
      expect(leadingWindowsDenies(descriptor([first, ace]), SID)).toEqual({ mask: 0, inheritable: 0 });
    }
    expect(leadingWindowsDenies(descriptor([{ ...ace, sid: "S-1-1-0" }, ace]), SID).mask).toBe(0x80000001);
    expect(leadingWindowsDenies(descriptor([{ ...ace, sid: "S-1-5-18" }]), "S-1-5-00018").mask).toBe(0x80000001);
    for (const sid of ["invalid", "S-1-5-4294967296", "S-1-281474976710656-1"]) {
      expect(() => leadingWindowsDenies(null, sid)).toThrow("Invalid deny DACL SID");
    }
  });

  it("preserves owner-only rules and elevated administrator ownership", () => {
    const dacl = descriptor([{ type: 0, flags: 3, mask: 0x1f01ff, sid: SID }]);
    const value = { ownerSid: SID, rules: windowsOwnerRules(dacl) };
    expect(isOwnerOnlyDacl(value, SID)).toBe(true);
    expect(isOwnerOnlyDacl({ ...value, ownerSid: "S-1-5-18" }, SID)).toBe(false);
    expect(isOwnerOnlyDacl({ ...value, ownerSid: "S-1-5-32-544", elevated: true }, SID)).toBe(true);
    expect(isOwnerOnlyDacl({ ...value, rules: windowsOwnerRules({ ...dacl, aces: [{ ...dacl.aces[0]!, flags: 19 }] }) }, SID)).toBe(false);
  });
});

// Decode wire output without invoking native code.
describe("Windows path facts decoder", () => {
  const decode = (rows: unknown[]): readonly WindowsPathFacts[] => decodeWindowsPathFacts(JSON.stringify(rows), 1, "--pin");

  it("decodes a hex changeTime for targets and ancestors", () => {
    const component = { ...ORDINARY, changeTime: "0x0123456789abcdef" };
    const row = { ...component, ancestors: [component] };
    expect(decode([row])).toEqual([row]);
    const changed = { ...component, changeTime: "0x0000000000000002" };
    expect(windowsObjectKey(component)).toBe(windowsObjectKey(changed));
    const missing = { ...component, exists: false, canonical: null, volumeSerial: null, fileId: null,
      volumeSerialNumber: null, fileIndex: null, changeTime: null, attributes: 0, directory: false, ancestors: [] };
    expect(decode([missing])).toEqual([missing]);
  });

  it.each(["NTFS", "ReFS", null, undefined])("keeps the optional filesystem fact %s for targets and ancestors", fileSystemName => {
    const component = { ...ORDINARY, ...(fileSystemName === undefined ? {} : { fileSystemName }) };
    const row = { ...component, ancestors: [component] };
    expect(decode([row])).toEqual([row]);
  });

  it.each(["target", "ancestor"])("refuses malformed filesystem facts on a %s", position => {
    for (const fileSystemName of [42, "", "NTFS\0", {}, "x".repeat(256)]) {
      const component = { ...ORDINARY, fileSystemName };
      expect(() => decode([position === "target" ? component : { ...ORDINARY, ancestors: [component] }])).toThrow();
    }
  });

  it.each(["target", "ancestor"])("refuses malformed changeTime on a %s and names the field", (position) => {
    const component = { ...ORDINARY, changeTime: "0x0123456789abcdef" };
    const { changeTime: omitted, ...absent } = component;
    expect(omitted).toBeDefined();
    const invalid = [absent, ...["not-hex", "0x1", "0x0123456789ABCDEF", null].map(changeTime => ({ ...component, changeTime })),
      { ...component, exists: false, canonical: null, volumeSerial: null, fileId: null, volumeSerialNumber: null,
        fileIndex: null, attributes: 0, directory: false }];
    for (const value of invalid) {
      expect(() => decode([position === "target" ? { ...value, ancestors: [] } : { ...component, ancestors: [value] }])).toThrow(/changeTime/);
    }
  });
});

describe.runIf(process.platform === "win32")("Windows path facts native boundary", () => {
  let fixture: string;
  beforeAll(() => {
    configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
    fixture = mkdtempSync(join(tmpdir(), "ave-path-facts-"));
    mkdirSync(join(fixture, "directory"));
    writeFileSync(join(fixture, "directory", "file"), "pinned policy bytes");
    symlinkSync(join(fixture, "directory"), join(fixture, "junction"), "junction");
  });
  afterAll(() => { if (fixture) { removeLinksUnder(fixture); rmSync(fixture, { recursive: true, force: true }); } });

  it("proves Node dev and ino use the legacy serial and file index for files and directories", () => {
    for (const path of [join(fixture, "directory"), join(fixture, "directory", "file")]) {
      const [pin] = pinWindowsPaths([path]);
      const stat = lstatSync(path, { bigint: true });
      expect(BigInt(pin!.volumeSerialNumber!)).toBe(stat.dev);
      expect(BigInt(pin!.fileIndex!)).toBe(stat.ino);
      expect(pin!.fileId).toMatch(/^0x[0-9a-f]{32}$/);
      for (const component of [pin!, ...pin!.ancestors]) expect(component.fileSystemName).toMatch(/^[A-Za-z0-9_-]{1,255}$/);
      const handle = openSync(path, "r");
      try {
        const opened = fstatSync(handle, { bigint: true });
        expect(BigInt(pin!.volumeSerialNumber!)).toBe(opened.dev);
        expect(BigInt(pin!.fileIndex!)).toBe(opened.ino);
      } finally { closeSync(handle); }
    }
  });

  it("reports target tags and never opens a descendant through them", () => {
    const [target, child] = pinWindowsPaths([join(fixture, "junction"), join(fixture, "junction", "file")]);
    expect(target!.reparseTag).toBe(0xa0000003);
    expect(target!.exists).toBe(true);
    expect(child!.exists).toBeNull();
    expect(child!.canonical).toBeNull();
    expect(admitWindowsReparse(target!)).toBe(false);
    expect(admitWindowsReparse(child!)).toBe(false);
  });

  it("reports the grant link target from the pinned handle", () => {
    const [link] = pinWindowsPaths([join(fixture, "junction")]);
    expect(link).toHaveProperty("reparseTarget", join(fixture, "directory"));
  });

  it("reads raw DACL and bounded bytes from one pinned file without writing", () => {
    const file = join(fixture, "directory", "file");
    const icacls = join(process.env.SystemRoot!, "System32", "icacls.exe");
    const before = execFileSync(icacls, [fixture, "/T"], { encoding: "utf8", windowsHide: true });
    const [row] = readWindowsDacls([file], { parent: true, content: true });
    expect(row!.dacl!.identity).toEqual({ volumeSerial: row!.volumeSerial, fileId: row!.fileId });
    expect(Buffer.from(row!.contentHex!, "hex").toString()).toBe("pinned policy bytes");
    expect(row!.parent).toBeTruthy();
    expect(evaluateWindowsReadDacl(row!).status).toMatch(/private|readable/);
    expect(execFileSync(icacls, [fixture, "/T"], { encoding: "utf8", windowsHide: true })).toBe(before);
  });

  it("reads a writable file's DACL with identity, inheritance flags and ordered ACE bytes", () => {
    const file = join(fixture, "directory", "file with spaces [é]");
    const opened = openSync(file, "wx");
    try {
      const expected = fstatSync(opened, { bigint: true });
      const [row] = readWindowsFileDacls([file]);
      if (!row?.aclHex) throw new Error("No file access list was read");
      expect(vi.mocked(execFileSync).mock.lastCall?.[1]).toEqual(["--dacl", "--file-access", file]);
      expect(BigInt(row.volumeSerialNumber)).toBe(expected.dev);
      expect(BigInt(row.fileIndex)).toBe(expected.ino);
      expect(row.control & 0x1000).toBe(0);

      const bytes = Buffer.from(row.aclHex, "hex");
      const aceHeaders = [];
      for (let offset = 1; offset < bytes.length;) {
        aceHeaders.push({ type: bytes.readUInt8(offset), flags: bytes.readUInt8(offset + 1), mask: bytes.readUInt32LE(offset + 4) });
        const size = bytes.readUInt16LE(offset + 2);
        expect(size).toBeGreaterThanOrEqual(8);
        offset += size;
      }
      const [facts] = readWindowsDacls([file]);
      expect(aceHeaders).toEqual(facts?.dacl?.aces.map(({ type, flags, mask }) => ({ type, flags, mask })));
    } finally {
      closeSync(opened);
    }

    const [inherited] = readWindowsFileDacls([file]);
    const systemRoot = process.env.SystemRoot;
    if (!systemRoot) throw new Error("No Windows system directory");
    const icacls = join(systemRoot, "System32", "icacls.exe");
    execFileSync(icacls, [file, "/inheritance:d"], { stdio: "ignore" });
    const [protectedDacl] = readWindowsFileDacls([file]);
    if (!protectedDacl || !inherited) throw new Error("No file access list was read");
    expect(protectedDacl.control & 0x1000).toBe(0x1000);
    expect(protectedDacl.aclHex).not.toBe(inherited.aclHex);
    expect(() => readWindowsFileDacls([file, join(fixture, "missing")])).toThrow(/helper failed/);
    expect(() => readWindowsFileDacls([join(fixture, "junction")])).toThrow(/helper failed/);
  });

  it("rejects incomplete or malformed file DACL replies", () => {
    const file = join(fixture, "directory", "file");
    const identity = { volumeSerialNumber: ORDINARY.volumeSerialNumber, fileIndex: ORDINARY.fileIndex };
    for (const rows of [[], [identity], [{ ...identity, control: 4, aclHex: "abc" }], [{ ...identity, control: 2, aclHex: null }]]) {
      vi.mocked(execFileSync).mockReturnValueOnce(Buffer.from(JSON.stringify(rows)));
      expect(() => readWindowsFileDacls([file])).toThrow("Invalid Windows file DACL response");
    }
  });

  it("distinguishes missing paths from native failures and returns no partial batch", () => {
    expect(readWindowsDacls([join(fixture, "missing")])[0]!.exists).toBe(false);
    expect(() => readWindowsDacls([join(fixture, "directory"), join(fixture, "invalid|target")])).toThrow();
    expect(pinWindowsPaths([])).toEqual([]);
    expect(readWindowsDacls([])).toEqual([]);
    expect(() => pinWindowsPaths(["relative"])).toThrow(/absolute/);
  });
  it.each([1048576, 1048577])("bounds pinned content reads of %i bytes with a distinct size error", (size) => {
    const file = join(fixture, `content-${size}`);
    writeFileSync(file, Buffer.alloc(size, 120));
    if (size === 1048576) {
      const [row] = readWindowsDacls([file], { content: true });
      expect(row?.contentHex).toBe(Buffer.alloc(size, 120).toString("hex"));
    } else {
      expect(() => readWindowsDacls([file], { content: true })).toThrowError(expect.objectContaining({
        code: "EFBIG", cause: expect.objectContaining({ status: 5 }),
      }));
    }
  });
  it("reports a helper's non-zero exit by its status alone and a timed-out helper by its cause and code, never its path", () => {
    const leaked = String.raw`D:\example\alice\ave-path-kind.exe`;
    vi.mocked(execFileSync).mockImplementationOnce(() => {
      throw Object.assign(new Error(`Command failed: ${leaked} --dacl\n${leaked}`), { status: 3, signal: null, stderr: Buffer.from(leaked) });
    });
    let failure: unknown;
    try { readWindowsDacls([join(fixture, "directory")]); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("Windows path facts helper failed (exit 3)");
    expect((failure as Error).cause).toBeUndefined();
    expect(Object.values(failure as object).map(String).join("\n")).not.toContain("alice");
    const system = Object.assign(new Error(`spawnSync ${leaked} ETIMEDOUT`), { code: "ETIMEDOUT", syscall: `spawnSync ${leaked}`, status: null });
    vi.mocked(execFileSync).mockImplementationOnce(() => { throw system; });
    let timedOut: unknown;
    try { readWindowsDacls([join(fixture, "directory")]); } catch (error) { timedOut = error; }
    expect(timedOut).toMatchObject({ message: `Windows path facts helper did not answer within ${TOOL_TIMEOUT_POLICY.windowsAclRequestMs} ms`, code: "ETIMEDOUT" });
    expect(isWindowsPathKindHelperUnavailable(timedOut)).toBe(true);
    expect(Object.values(timedOut as object).map(String).join("\n")).not.toContain("alice");
  });
});
