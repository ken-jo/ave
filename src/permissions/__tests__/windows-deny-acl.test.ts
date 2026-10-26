import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { win32SystemBinary } from "../../shared/ave-home.js";
import { windowsPowerShellEnv } from "../../shared/windows-powershell-env.js";
import { configureHostResources } from "../../main/host-resources.js";
import { readWindowsDenyAcls, WINDOWS_READ_DENY_MASK } from "../windows-deny-acl.js";

const SANDBOX_SID = "S-1-5-21-101-102-103-1001";

describe.runIf(process.platform === "win32")("Windows deny DACL proof", () => {
  let container: string;
  let parent: string;
  let target: string;

  beforeEach(() => {
    configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
    container = mkdtempSync(join(tmpdir(), "deny-acl-"));
    parent = join(container, "root");
    mkdirSync(parent);
    target = join(parent, "secret");
    writeFileSync(target, "fixture");
  });

  afterEach(() => { rmSync(container, { recursive: true, force: true }); });

  function setDacl(path: string, dacl: string): void {
    execFileSync(win32SystemBinary("WindowsPowerShell/v1.0/powershell"), ["-NoProfile", "-NonInteractive", "-Command",
      `$ErrorActionPreference='Stop'; $p='${path.replace(/'/g, "''")}'; $acl=Get-Acl -LiteralPath $p;
       $acl.SetSecurityDescriptorSddlForm('${dacl}', [Security.AccessControl.AccessControlSections]::Access);
       Set-Acl -LiteralPath $p -AclObject $acl;`], { env: windowsPowerShellEnv(), windowsHide: true });
  }

  it("does not count an inherited deny after an explicit broad allow", async () => {
    setDacl(parent, `D:P(D;OICI;FA;;;${SANDBOX_SID})(A;OICI;FA;;;WD)`);
    setDacl(target, "D:AI(A;;FA;;;WD)");
    const [row] = await readWindowsDenyAcls([target], SANDBOX_SID);
    expect(row?.denyMask).toBe(0);
  });

  it("reads explicit target and parent protection", async () => {
    setDacl(parent, `D:P(D;OICI;0x40;;;${SANDBOX_SID})(A;OICI;FA;;;WD)`);
    setDacl(target, `D:P(D;;FA;;;${SANDBOX_SID})(A;;FA;;;WD)`);
    const [row] = await readWindowsDenyAcls([target], SANDBOX_SID);
    expect(row).toEqual({ denyMask: WINDOWS_READ_DENY_MASK, inheritableMask: 0, parentMask: 0x40, directory: false });
  });

  it.each(["IO", "NP"])("does not count %s as inheritable object protection", flags => {
    setDacl(parent, `D:P(D;OICI${flags};FA;;;${SANDBOX_SID})(A;OICI;FA;;;WD)`);
    const [row] = readWindowsDenyAcls([parent], SANDBOX_SID);
    expect(row?.inheritableMask).toBe(0);
    if (flags === "IO") expect(row?.denyMask).toBe(0);
  });

  it("reads directory inheritance and missing rows in one native response", () => {
    setDacl(parent, `D:P(D;OICI;FA;;;${SANDBOX_SID})(A;OICI;FA;;;WD)`);
    expect(readWindowsDenyAcls([parent, join(parent, "absent")], SANDBOX_SID)).toEqual([
      { denyMask: WINDOWS_READ_DENY_MASK, inheritableMask: WINDOWS_READ_DENY_MASK, parentMask: 0, directory: true },
      { denyMask: 0, inheritableMask: 0, parentMask: 0, directory: false },
    ]);
  });

  it("does not use inherited parent protection as explicit delete-child proof", () => {
    setDacl(container, `D:P(D;OICI;FA;;;${SANDBOX_SID})(A;OICI;FA;;;WD)`);
    setDacl(parent, "D:AI(A;;FA;;;WD)");
    setDacl(target, `D:P(D;;FA;;;${SANDBOX_SID})(A;;FA;;;WD)`);
    const [row] = readWindowsDenyAcls([target], SANDBOX_SID);
    expect(row?.denyMask).toBe(WINDOWS_READ_DENY_MASK);
    expect(row?.parentMask).toBe(0);
  });

  it("refuses a reparse target and a reparse ancestor", () => {
    const link = join(container, "link");
    symlinkSync(parent, link, "junction");
    expect(() => readWindowsDenyAcls([link], SANDBOX_SID)).toThrow(/verification/);
    expect(() => readWindowsDenyAcls([join(link, "secret")], SANDBOX_SID)).toThrow(/verification/);
  });
});
