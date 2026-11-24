import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useScratchLinks, useTempDirs } from "../../__tests__/test-helpers.js";
import { useVerifiedAveHomePrivacy } from "../../__tests__/support/ave-home-privacy.js";

useVerifiedAveHomePrivacy();
const scratch = useTempDirs("stamp-admission-");
const link = useScratchLinks();
afterEach(() => { vi.restoreAllMocks(); });

describe.runIf(process.platform === "win32")("Windows stamp path admission", () => {
  it("refuses replacement that changes the canonical path case", async () => {
    const facts = await import("../../shared/windows-path-facts.js");
    const { pinWindowsFilesystemConfig } = await import("../windows-stamp-targets.js");
    const path = resolve(scratch(), "entry");
    writeFileSync(path, "original");
    const nativePin = facts.pinWindowsPaths;
    let observations = 0;
    vi.spyOn(facts, "pinWindowsPaths").mockImplementation(paths => nativePin(paths).map(row => {
      if (row.canonical === null || facts.windowsPathKey(row.canonical) !== facts.windowsPathKey(path)) return row;
      if (++observations === 1) return row;
      return { ...row, canonical: row.canonical.replace(/entry$/, "ENTRY"), fileId: "0xffffffffffffffffffffffffffffffff" };
    }));
    expect(() => pinWindowsFilesystemConfig({ allowRead: [path] })).toThrow(/identity changed/);
  });

  it.each(["allowRead", "allowWrite"] as const)("refuses unsupported %s grant grammar before either native facts boundary", async list => {
    const facts = await import("../../shared/windows-path-facts.js");
    const { pinWindowsFilesystemConfig } = await import("../windows-stamp-targets.js");
    const pin = vi.spyOn(facts, "pinWindowsPaths");
    const dacl = vi.spyOn(facts, "readWindowsDacls");
    for (const path of ["relative", "C:\\single", "\\\\host\\share\\folder", "\\\\?\\C:\\fixture\\folder", "\\\\.\\C:\\fixture\\folder"]) {
      expect(() => pinWindowsFilesystemConfig({ [list]: [path] })).toThrow(/literal|absolute|root|component/);
      expect(pin).not.toHaveBeenCalled();
      expect(dacl).not.toHaveBeenCalled();
    }
  });

  it("refuses a supported junction chain beyond the shared grant hop limit", async () => {
    const { pinWindowsFilesystemConfig } = await import("../windows-stamp-targets.js");
    const directory = scratch();
    let target = scratch();
    for (let index = 0; index < 41; index++) target = link(target, resolve(directory, `link-${index}`));
    expect(() => pinWindowsFilesystemConfig({ allowRead: [target] })).toThrow(/link resolution limit/);
  });

  it("refuses an unproven resolved child below a cloud non-surrogate target", async () => {
    const facts = await import("../../shared/windows-path-facts.js");
    const { pinWindowsFilesystemConfig } = await import("../windows-stamp-targets.js");
    const target = scratch();
    const alias = link(target, resolve(scratch(), "alias"));
    const nativePin = facts.pinWindowsPaths;
    const parent = nativePin([target])[0]!;
    const child = resolve(target, "unproven");
    vi.spyOn(facts, "pinWindowsPaths").mockImplementation(paths => paths.map(path => {
      if (path !== child) return nativePin([path])[0]!;
      return { exists: null, canonical: null, volumeSerial: null, fileId: null,
        volumeSerialNumber: null, fileIndex: null, changeTime: null, attributes: 0, reparseTag: 0, reparseTarget: null, directory: false,
        ancestors: [...parent.ancestors, { ...parent, attributes: 0x410, reparseTag: 0x9000001a }],
      };
    }));
    expect(() => pinWindowsFilesystemConfig({ allowRead: [resolve(alias, "unproven")] }))
      .toThrow(/identity is unproven/);
  });

  it("refuses policy evidence carrying a foreign ownership ACE on a resolved grant target", async () => {
    const facts = await import("../../shared/windows-path-facts.js");
    const { pinWindowsFilesystemConfig } = await import("../windows-stamp-targets.js");
    const { readWindowsAdminPolicy } = await import("../../shared/windows-admin-policy.js");
    const target = scratch();
    const path = resolve(target, "policy.json");
    writeFileSync(path, '{"version":1}');
    const alias = link(target, resolve(scratch(), "alias"));
    const pinned = pinWindowsFilesystemConfig({ allowRead: [resolve(alias, "policy.json")] });
    expect(pinned.allowRead).toEqual([{ path, literal: true }]);
    const row = facts.readWindowsDacls([path], { parent: true, content: true })[0]!;
    const foreign = "S-1-5-21-100-200-300-9999";
    vi.spyOn(facts, "readWindowsDacls").mockReturnValue([{
      ...row,
      dacl: { ...row.dacl!, owner: "S-1-5-32-544", aces: [{ type: 0, flags: 0, mask: 0x80000, sid: foreign }] },
      parent: { ...row.parent!, owner: "S-1-5-32-544", aces: [] },
    }]);
    await expect(readWindowsAdminPolicy(path)).rejects.toThrow(`file writable by ${foreign}`);
  });

  it("refuses a stamp target with an unadmitted reparse ancestor through the shared admission rule", async () => {
    const source = readFileSync(resolve(__dirname, "../windows-stamp-targets.ts"), "utf8");
    expect(source).toContain("../shared/windows-path-facts.js");
    const facts = await import("../../shared/windows-path-facts.js");
    const target = scratch();
    const ordinary = {
      exists: true, canonical: target, volumeSerial: "0x0000000000000001",
      fileId: "0x00000000000000000000000000000001", volumeSerialNumber: "0x0000000000000001",
      fileIndex: "0x0000000000000001", changeTime: "0x0000000000000001", attributes: 16, reparseTag: 0, reparseTarget: null, directory: true,
    };
    const ancestor = { ...ordinary, attributes: 0x410, reparseTag: 0xa0000042 };
    vi.spyOn(facts, "pinWindowsPaths").mockImplementation(paths => paths.map(() => ({ ...ordinary, ancestors: [ancestor] })));
    const admission = vi.spyOn(facts, "admitWindowsReparse");
    const { pinWindowsFilesystemConfig } = await import("../windows-stamp-targets.js");
    expect(() => pinWindowsFilesystemConfig({ allowRead: [target] })).toThrow(/reparse point|identity is unproven/);
    expect(admission).toHaveBeenCalledWith(expect.objectContaining({ ancestors: [ancestor] }), "grant");
    expect(admission.mock.results.some(result => result.value === false)).toBe(true);
  });
});
