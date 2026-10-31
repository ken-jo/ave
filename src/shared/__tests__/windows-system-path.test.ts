import { readFileSync } from "node:fs";
import { resolve, win32 } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { win32SystemBinary, windowsProgramFilesRoots, windowsSystemRoot } from "../windows-system-path.js";
import { readWindowsDirectoryDacls } from "../ave-home.js";
import { resolveManualShell } from "../../main/terminal/manual-shell.js";
import { sanitizedAcpSubscriptionEnvironment } from "../../main/acp-subscription-runtime-client.js";
import { sanitizedCodexConversationEnvironment } from "../../main/codex-conversation-runtime.js";
import { grantAsrtWindowsBackendAcl } from "../../permissions/asrt-windows-support.js";
import { startWindowsAclGrantHolder } from "../../permissions/windows-acl-grant-holder.js";
import { powerShellMxcCommandLine } from "../../permissions/mxc-windows.js";
import { claimPrivateOwnership, _resetWindowsAclHostForTest } from "../../main/codex-executable-location.js";
import * as pathKindLauncher from "../../main/windows-path-kind-launcher.js";
import { prepareSrtWinExecutable } from "../../permissions/srt-win-integrity.js";
import { getVendoredSrtWinExePath } from "../../permissions/asrt-sandbox.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  _resetWindowsAclHostForTest();
});

describe("system executable admission", () => {
  it.each([{}, { SystemRoot: "" }, { SystemRoot: "relative" }, { SystemRoot: "C:Windows" }, { windir: "\\Windows" },
    { SystemRoot: "\\\\host\\Windows" }, { SystemRoot: "\\\\?\\C:\\Windows" }, { SystemRoot: "C:\\bad\nroot" }])("refuses unproven roots %j", env => {
    expect(() => windowsSystemRoot(env)).toThrow(/system root/i);
    expect(() => win32SystemBinary("cmd", env)).toThrow(/system root/i);
  });

  it("shares absolute root admission across environment spellings and binaries", () => {
    for (const key of ["SystemRoot", "SYSTEMROOT", "windir", "WINDIR"]) {
      const env = { [key]: "D:/System" };
      expect(windowsSystemRoot(env)).toBe("D:\\System");
      expect(win32SystemBinary("cmd", env)).toBe("D:\\System\\System32\\cmd.exe");
      expect(win32SystemBinary("more.com", env)).toBe("D:\\System\\System32\\more.com");
    }
  });

  it("refuses traversal outside the system directory", () => {
    for (const name of ["../cmd", "C:\\cmd.exe", "cmd:stream"]) {
      expect(() => win32SystemBinary(name, { SystemRoot: "C:\\Windows" })).toThrow(/relative/);
    }
  });

  it("fails closed at executable and child-environment callers without a system root", async () => {
    for (const key of ["SystemRoot", "SYSTEMROOT", "windir", "WINDIR"]) vi.stubEnv(key, undefined);
    expect(() => win32SystemBinary("icacls")).toThrow(/system root/i);
    expect(readWindowsDirectoryDacls(["fixture"])).toEqual([expect.objectContaining({ category: "system-root-missing", error: expect.any(String) })]);
    expect(() => resolveManualShell("win32", {})).toThrow(/system root/i);
    expect(() => sanitizedAcpSubscriptionEnvironment("grok-build", "C:\\fixture\\runtime", {}, "win32")).toThrow(/system root/i);
    expect(() => sanitizedCodexConversationEnvironment("C:\\fixture\\runtime", "C:\\fixture\\sqlite", "C:\\fixture\\tmp", {}, "win32")).toThrow(/system root/i);
    await expect(grantAsrtWindowsBackendAcl()).rejects.toThrow(/system root/i);
    expect(() => startWindowsAclGrantHolder("fixture")).toThrow(/system root/i);
    expect(() => powerShellMxcCommandLine("", "exit 0")).toThrow(/system root/i);
  });

  it("keeps former executable resolvers on the shared fail-closed boundary", () => {
    for (const file of ["main/acp-subscription-runtime-client.ts", "main/codex-conversation-runtime.ts",
      "main/managed-child-processes.ts", "main/terminal/manual-shell.ts", "permissions/asrt-windows-support.ts", "permissions/confined-child.ts",
      "permissions/srt-win-integrity.ts", "permissions/windows-acl-grant-holder.ts", "permissions/mxc-windows.ts", "tools/mxc-shell-launch.ts", "tools/shell-tools.ts", "shared/ave-home.ts",
      "shared/powershell-executable.ts"]) {
      const source = readFileSync(resolve("src", file), "utf8");
      expect(source, file).toContain("windows-system-path.js");
      expect(source, file).not.toMatch(/(?:join\([^\n]*["']System32["']|\\\\System32\\\\)/);
    }
    expect(win32.isAbsolute(win32SystemBinary("cmd", { SystemRoot: "C:\\Windows" }))).toBe(true);
  });

  it("requires OS directory proof for publisher and ACL verifiers instead of environment-selected roots", () => {
    for (const file of ["main/claude-code-authenticity.ts", "main/codex-executable-location.ts"]) {
      const source = readFileSync(resolve("src", file), "utf8");
      expect(source, file).toContain('from "./windows-path-kind-launcher.js"');
      expect(source, file).toContain("queryWindowsSystemDirectory()");
      expect(source, file).not.toContain("windows-system-path.js");
      expect(source, file).not.toMatch(/process\.env\.(?:SystemRoot|WINDIR|windir)/u);
    }
  });

  it("prefers the 64-bit Program Files root then the 32-bit root and dedupes the shared native root", () => {
    expect(windowsProgramFilesRoots({ ProgramW6432: "C:\\Program Files", ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)" }))
      .toEqual(["C:\\Program Files", "C:\\Program Files (x86)"]);
  });

  it("accepts any drive and normalizes separators without touching PATH", () => {
    expect(windowsProgramFilesRoots({ ProgramW6432: "D:/Tools", "ProgramFiles(x86)": "D:/Tools (x86)" }))
      .toEqual(["D:\\Tools", "D:\\Tools (x86)"]);
  });

  it("skips malformed Program Files roots and never throws", () => {
    expect(windowsProgramFilesRoots({ ProgramW6432: "relative", ProgramFiles: "C:Program Files", "ProgramFiles(x86)": "C:\\good (x86)" }))
      .toEqual(["C:\\good (x86)"]);
  });

  it("derives the conventional roots from the system drive when no Program Files variable is set", () => {
    expect(windowsProgramFilesRoots({ SystemDrive: "D:" })).toEqual(["D:\\Program Files", "D:\\Program Files (x86)"]);
    expect(windowsProgramFilesRoots({ SystemRoot: "E:\\Windows" })).toEqual(["E:\\Program Files", "E:\\Program Files (x86)"]);
  });

  it("returns nothing when neither Program Files nor a system drive can be resolved", () => {
    expect(windowsProgramFilesRoots({})).toEqual([]);
  });

  it.runIf(process.platform === "win32")("refuses private-helper effects without OS directory proof and legacy readers without a system root", async () => {
    for (const key of ["SystemRoot", "SYSTEMROOT", "windir", "WINDIR"]) vi.stubEnv(key, undefined);
    _resetWindowsAclHostForTest();
    vi.spyOn(pathKindLauncher, "queryWindowsSystemDirectory").mockRejectedValue(new Error("OS directory proof unavailable"));
    await expect(claimPrivateOwnership([resolve("resources")])).rejects.toThrow("OS directory proof unavailable");
    expect(() => prepareSrtWinExecutable(getVendoredSrtWinExePath())).toThrow(expect.objectContaining({
      cause: expect.objectContaining({ message: expect.stringMatching(/system root/i) }),
    }));
  });
});
