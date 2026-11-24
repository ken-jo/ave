// windows-native
// Host programs resolve to an absolute path from PATH only; a current directory is never searched.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { canCreateSymlinks } from "../../__tests__/support/symlink-capability.js";
import { findHostProgram, HostProgramNotFoundError, resolveHostProgram } from "../host-program-path.js";

const windows = process.platform === "win32";

describe("resolveHostProgram", () => {
  let base: string;
  let bin: string;
  let planted: string;
  beforeAll(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "ave-host-program-")));
    bin = join(base, "bin");
    planted = join(base, "planted");
    mkdirSync(bin);
    mkdirSync(planted);
    for (const directory of [bin, planted]) {
      for (const name of windows ? ["tool.exe", "only.cmd"] : ["tool"]) {
        writeFileSync(join(directory, name), windows ? "" : "#!/bin/sh\nexit 0\n");
        if (!windows) chmodSync(join(directory, name), 0o755);
      }
    }
    if (!windows) {
      writeFileSync(join(bin, "plain"), "not a program\n");
      chmodSync(join(bin, "plain"), 0o644);
    }
  });
  afterAll(async () => { await cleanupTmpDir(base); });

  const separator = windows ? ";" : ":";
  const expected = () => join(bin, windows ? "tool.exe" : "tool");

  it("keeps an absolute program as written", () => {
    const absolute = windows ? "C:\\Tools\\missing.exe" : "/opt/tools/missing";
    expect(resolveHostProgram(absolute, { PATH: "" })).toBe(absolute);
  });

  it("finds a bare name in the fully qualified PATH folders and nowhere else", () => {
    expect(resolveHostProgram("tool", { PATH: bin })).toBe(expected());
    expect(findHostProgram("tool", { PATH: "" })).toBeNull();
    expect(findHostProgram("tool", {})).toBeNull();
  });

  it("skips empty, '.' and relative PATH entries even when the current directory holds the program", () => {
    const previous = process.cwd();
    process.chdir(planted);
    try {
      expect(findHostProgram("tool", { PATH: ["", ".", "planted", `.${windows ? "\\" : "/"}planted`].join(separator) })).toBeNull();
      expect(resolveHostProgram("tool", { PATH: ["", ".", bin].join(separator) })).toBe(expected());
    } finally {
      process.chdir(previous);
    }
  });

  it("refuses a relative path instead of joining it to a directory", () => {
    expect(() => resolveHostProgram("bin/tool", { PATH: base })).toThrow(/Use an absolute path or a program name on PATH/u);
    expect(() => resolveHostProgram("./tool", { PATH: bin })).toThrow(HostProgramNotFoundError);
  });

  it("refuses a missing program with a not-found error, never the bare name", () => {
    expect(() => resolveHostProgram("missing-program", { PATH: bin })).toThrow(/was not found on PATH/u);
  });

  it.runIf(!windows)("needs the execute bit on POSIX", () => {
    expect(findHostProgram("plain", { PATH: bin })).toBeNull();
  });

  it.runIf(windows)("reads Path in any spelling, tries .com and .exe, and never a script launcher", () => {
    expect(resolveHostProgram("tool", { Path: `"${bin}"` })).toBe(expected());
    expect(resolveHostProgram("tool.exe", { Path: bin })).toBe(expected());
    expect(findHostProgram("only", { Path: bin })).toBeNull();
    expect(() => resolveHostProgram("C:tool", { Path: bin })).toThrow(/Use an absolute path or a program name on PATH/u);
    expect(resolveHostProgram("\\Tools\\tool.exe", { Path: bin })).toBe("\\Tools\\tool.exe");
  });
});

describe("Windows app execution aliases", () => {
  const local = win32.join("C:\\", "Users", "alice", "AppData", "Local");
  const aliases = win32.join(local, "Microsoft", "WindowsApps");
  const tools = win32.join("C:\\", "Tools");
  const regular = new Set([win32.join(tools, "tool.exe")]);
  // An alias is a link whose target this account cannot stat; a regular file stats as a file.
  const fs = {
    statSync: (path: string) => {
      if (!regular.has(path)) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      return { isFile: () => true };
    },
    lstatSync: (path: string) => ({ isSymbolicLink: () => path.endsWith("python3.exe") }),
    accessSync: () => undefined,
  };
  const find = (program: string, env: NodeJS.ProcessEnv) => findHostProgram(program, env, "win32", fs);

  it("accepts an alias in the account's WindowsApps folder, however PATH spells it", () => {
    expect(find("python3", { LOCALAPPDATA: local, Path: aliases })).toBe(win32.join(aliases, "python3.exe"));
    const spelled = "c:/users/alice/appdata/local/microsoft/windowsapps/";
    expect(find("python3", { localappdata: local, PATH: spelled })).toBe(win32.join(spelled, "python3.exe"));
  });

  it("refuses the same link shape in any other PATH folder", () => {
    expect(find("python3", { LOCALAPPDATA: local, Path: tools })).toBeNull();
    expect(find("python3", { LOCALAPPDATA: local, Path: win32.join(aliases, "Other") })).toBeNull();
    expect(find("python3", { LOCALAPPDATA: win32.join("AppData", "Local"), Path: aliases })).toBeNull();
    expect(find("python3", { Path: aliases })).toBeNull();
  });

  it.runIf(windows && canCreateSymlinks())("refuses a real link that cannot be stat'ed outside WindowsApps", async () => {
    const folder = realpathSync(mkdtempSync(join(tmpdir(), "ave-host-program-link-")));
    try {
      symlinkSync(join(folder, "missing-target.exe"), join(folder, "python3.exe"), "file");
      expect(findHostProgram("python3", { LOCALAPPDATA: local, Path: folder }, "win32")).toBeNull();
    } finally {
      await cleanupTmpDir(folder);
    }
  });

  it("leaves a regular file unaffected", () => {
    expect(find("tool", { LOCALAPPDATA: local, Path: `${aliases};${tools}` })).toBe(win32.join(tools, "tool.exe"));
  });
});
