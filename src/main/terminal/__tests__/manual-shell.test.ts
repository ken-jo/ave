import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeLinksUnder } from "../../../__tests__/support/tmp-dir-teardown.js";
import { isLaunchableFile, resolveManualShell } from "../manual-shell.js";

const directories: string[] = [];
function fixture(...files: string[]): (path: string) => boolean {
  const directory = mkdtempSync(join(tmpdir(), "manual-shell-"));
  directories.push(directory);
  for (const file of files) {
    const path = join(directory, ...file.split("/"));
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "");
  }
  return (path) => {
    const relative = win32.relative("C:\\fixtures", path);
    if (relative.startsWith("..") || win32.isAbsolute(relative)) return false;
    return statSync(join(directory, ...relative.split("\\")), { throwIfNoEntry: false })?.isFile() === true;
  };
}
afterEach(() => {
  for (const directory of directories.splice(0)) {
    removeLinksUnder(directory);
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("native manual interpreter", () => {
  it("rejects a Store app execution alias when stat throws EACCES", () => {
    expect(isLaunchableFile("C:\\fixtures\\alias\\pwsh.exe", () => {
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    })).toBe(false);
  });

  it("rejects any stat error, missing file or directory and accepts a file", () => {
    for (const code of ["ELOOP", "EPERM", "EINVAL"]) {
      expect(isLaunchableFile("C:\\fixtures\\pwsh.exe", () => { throw Object.assign(new Error(code), { code }); })).toBe(false);
    }
    expect(isLaunchableFile("C:\\fixtures\\pwsh.exe", () => undefined)).toBe(false);
    expect(isLaunchableFile("C:\\fixtures\\pwsh.exe", () => ({ isFile: () => false }))).toBe(false);
    expect(isLaunchableFile("C:\\fixtures\\pwsh.exe", () => ({ isFile: () => true }))).toBe(true);
  });

  it("follows a directory junction named pwsh.exe and accepts a real file", () => {
    const directory = mkdtempSync(join(tmpdir(), "manual-shell-"));
    directories.push(directory);
    const target = join(directory, "directory");
    mkdirSync(target);
    const link = join(directory, "pwsh.exe");
    symlinkSync(target, link, "junction");
    const file = join(directory, "file.exe");
    writeFileSync(file, "");
    expect(isLaunchableFile(link)).toBe(false);
    expect(isLaunchableFile(file)).toBe(true);
  });

  it("continues past an inaccessible alias to a file or either cmd fallback", () => {
    const aliasDir = "C:\\fixtures\\alias";
    const realDir = "C:\\fixtures\\real";
    const isFile = (path: string): boolean => isLaunchableFile(path, () => {
      if (path === win32.join(aliasDir, "pwsh.exe")) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      return path === win32.join(realDir, "pwsh.exe") ? { isFile: () => true } : undefined;
    });
    const env = { PATH: `${aliasDir};${realDir}`, COMSPEC: "C:\\Windows\\System32\\cmd.exe", SystemRoot: "D:\\Windows" };
    expect(resolveManualShell("win32", env, isFile)).toEqual({ command: win32.join(realDir, "pwsh.exe"), args: [] });
    expect(resolveManualShell("win32", { ...env, PATH: aliasDir }, isFile)).toEqual({ command: env.COMSPEC, args: [] });
    expect(resolveManualShell("win32", { PATH: aliasDir, SystemRoot: env.SystemRoot }, isFile))
      .toEqual({ command: "D:\\Windows\\System32\\cmd.exe", args: [] });
  });

  it("never probes host files outside the synthetic fixture root", () => {
    const isFile = fixture("valid/pwsh.exe");
    for (const path of ["C:\\outside\\pwsh.exe", "D:\\fixtures\\pwsh.exe", "C:\\fixtures-other\\pwsh.exe"]) expect(isFile(path)).toBe(false);
  });

  it("uses the selected POSIX login shell and refuses invalid explicit selection", () => {
    expect(resolveManualShell("darwin", { SHELL: "/bin/zsh" })).toEqual({ command: "/bin/zsh", args: ["-l", "-i"] });
    expect(resolveManualShell("linux", {})).toEqual({ command: "/bin/bash", args: ["-l", "-i"] });
    expect(() => resolveManualShell("linux", { SHELL: "bash" })).toThrow("absolute");
  });
  it("uses native Windows argv and a pinned system interpreter when none was selected", () => {
    expect(resolveManualShell("win32", { COMSPEC: "C:\\Windows\\System32\\cmd.exe" })).toEqual({ command: "C:\\Windows\\System32\\cmd.exe", args: [] });
    expect(resolveManualShell("win32", { SystemRoot: "D:\\Windows" })).toEqual({ command: "D:\\Windows\\System32\\cmd.exe", args: [] });
    for (const COMSPEC of ["cmd.exe", "C:\\shell.cmd", ""]) expect(() => resolveManualShell("win32", { COMSPEC })).toThrow();
  });

  it("prefers the first PATH file over later entries and the standard installation", () => {
    const isFile = fixture("first/pwsh.exe", "second/pwsh.exe", "programs/PowerShell/7/pwsh.exe");
    expect(resolveManualShell("win32", {
      Path: "C:\\fixtures\\first;C:\\fixtures\\second", ProgramFiles: "C:\\fixtures\\programs", COMSPEC: "cmd.exe",
    }, isFile)).toEqual({ command: "C:\\fixtures\\first\\pwsh.exe", args: [] });
    expect(resolveManualShell("win32", { PATH: "C:\\fixtures\\second;C:\\fixtures\\first" }, isFile))
      .toEqual({ command: "C:\\fixtures\\second\\pwsh.exe", args: [] });
  });

  it("uses the standard installation when PATH has no file", () => {
    const isFile = fixture("programs/PowerShell/7/pwsh.exe");
    expect(resolveManualShell("win32", { PATH: "C:\\fixtures\\missing", ProgramFiles: "C:\\fixtures\\programs" }, isFile))
      .toEqual({ command: "C:\\fixtures\\programs\\PowerShell\\7\\pwsh.exe", args: [] });
  });

  it("accepts one surrounding quote pair on absolute PATH entries", () => {
    const isFile = fixture("Program Files/example/pwsh.exe");
    const checked: string[] = [];
    const launch = resolveManualShell("win32", {
      PATH: '"relative";"C:relative";"\\\\server\\share";""C:\\fixtures\\invalid"";"C:\\fixtures\\Program Files\\example";C:\\fixtures\\later',
    }, (path) => { checked.push(path); return isFile(path); });
    expect(checked).toEqual(["C:\\fixtures\\Program Files\\example\\pwsh.exe"]);
    expect(launch).toEqual({ command: checked[0], args: [] });
  });

  it("prefers exact PATH over duplicate keys and otherwise uses the first matching key", () => {
    const isFile = fixture("first/pwsh.exe", "second/pwsh.exe");
    expect(resolveManualShell("win32", { Path: "C:\\fixtures\\first", PATH: "C:\\fixtures\\second" }, isFile).command)
      .toBe("C:\\fixtures\\second\\pwsh.exe");
    expect(resolveManualShell("win32", { Path: "C:\\fixtures\\first", path: "C:\\fixtures\\second" }, isFile).command)
      .toBe("C:\\fixtures\\first\\pwsh.exe");
    expect(resolveManualShell("win32", { Path: "C:\\fixtures\\first", PATH: undefined, SystemRoot: "D:\\Windows" }, isFile).command)
      .toBe("D:\\Windows\\System32\\cmd.exe");
  });

  it("accepts a lowercase programfiles key", () => {
    const isFile = fixture("programs/PowerShell/7/pwsh.exe");
    expect(resolveManualShell("win32", { programfiles: "C:\\fixtures\\programs" }, isFile).command)
      .toBe("C:\\fixtures\\programs\\PowerShell\\7\\pwsh.exe");
  });

  it("continues past a missing executable and a directory named pwsh.exe", () => {
    const isFile = fixture("directory/pwsh.exe/child", "valid/pwsh.exe");
    expect(resolveManualShell("win32", { PATH: "C:\\fixtures\\missing;C:\\fixtures\\directory;C:\\fixtures\\valid" }, isFile))
      .toEqual({ command: "C:\\fixtures\\valid\\pwsh.exe", args: [] });
  });

  it("ignores empty, relative, current-drive-rooted, UNC and device entries without probing them", () => {
    const isFile = fixture("valid/pwsh.exe");
    const checked: string[] = [];
    const launch = resolveManualShell("win32", { PATH: ";.;relative;C:relative;\\rooted;\\\\server\\share;//server/share;\\\\?\\C:\\shell;\\\\.\\C:\\shell;;C:\\fixtures\\valid" }, (path) => {
      checked.push(path);
      return isFile(path);
    });
    expect(checked).toEqual(["C:\\fixtures\\valid\\pwsh.exe"]);
    expect(launch).toEqual({ command: checked[0], args: [] });
  });

  it("keeps both cmd fallbacks when fixture installations are empty", () => {
    const isFile = fixture();
    const env = { PATH: "C:\\fixtures\\empty", ProgramFiles: "C:\\fixtures\\programs", SystemRoot: "D:\\Windows" };
    expect(resolveManualShell("win32", { ...env, COMSPEC: "C:\\Windows\\System32\\cmd.exe" }, isFile))
      .toEqual({ command: "C:\\Windows\\System32\\cmd.exe", args: [] });
    expect(resolveManualShell("win32", env, isFile)).toEqual({ command: "D:\\Windows\\System32\\cmd.exe", args: [] });
  });

  it("never probes absent or nonabsolute installation roots", () => {
    for (const ProgramFiles of [undefined, "", "programs", "C:programs", "\\programs", "\\\\server\\share", "//server/share", "\\\\?\\C:\\programs", "\\\\.\\C:\\programs"]) {
      const checked: string[] = [];
      expect(resolveManualShell("win32", { ProgramFiles, COMSPEC: "C:\\Windows\\System32\\cmd.exe" }, (path) => {
        checked.push(path);
        return false;
      }).command).toBe("C:\\Windows\\System32\\cmd.exe");
      expect(checked).toEqual([]);
    }
  });
});
