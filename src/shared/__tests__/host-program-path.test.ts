// windows-native
// Host programs resolve to an absolute path from PATH only; a current directory is never searched.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { canCreateSymlinks } from "../../__tests__/support/symlink-capability.js";
import { windowsAppAliasFixture } from "../../__tests__/support/windows-app-alias-fixture.js";
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
  });

  it.each(["\\Tools\\tool.exe", "/Tools/tool.exe"])("refuses the current-drive-relative command %s", (command) => {
    expect(findHostProgram(command, {}, "win32")).toBeNull();
    expect(() => resolveHostProgram(command, {}, "win32")).toThrow(/Use an absolute path or a program name on PATH/u);
  });

  it.each(["C:\\Tools\\tool.exe", "C:/Tools/tool.exe", "\\\\server\\share\\tool.exe", "//server/share/tool.exe"])("keeps the fully qualified Windows command %s", (command) => {
    expect(resolveHostProgram(command, {}, "win32")).toBe(command);
  });
});

describe("Windows app execution aliases", () => {
  const { local, aliases, short, outsideLocal, outside, program, executable, root, regularFiles, fs } = windowsAppAliasFixture();
  const tools = win32.join("C:\\", "Tools");
  const tool = win32.join(tools, "tool.exe");
  regularFiles.add(tool);
  const find = (env: NodeJS.ProcessEnv, files = fs) => findHostProgram(program, env, "win32", files);

  it("resolves the same trusted account directory through long and short spellings", () => {
    expect(find({ Path: aliases })).toBe(executable);
    const spelled = "c:/users/alice/appdata/local/microsoft/windowsapps/";
    expect(find({ PATH: spelled })).toBe(executable);
    expect(find({ PATH: short })).toBe(executable);
  });

  it("does not accept a child-supplied alias directory", () => {
    expect(find({ LOCALAPPDATA: outsideLocal, Path: outside })).toBeNull();
    expect(find({ LOCALAPPDATA: outsideLocal, Path: aliases })).toBe(executable);
    expect(find({ LOCALAPPDATA: local, Path: win32.join(aliases, "Other") })).toBeNull();
  });

  it("refuses a redirected or replaced alias parent even at the expected spelling", () => {
    const env = { LOCALAPPDATA: local, PATH: aliases };
    expect(find(env, { ...fs, pinWindowsDirectory: () => null })).toBeNull();
    expect(find(env, { ...fs, pinWindowsDirectory: () => ({ ...root, ino: 3n }) })).toBeNull();
  });

  it.runIf(windows && canCreateSymlinks())("refuses a real link that cannot be stat'ed outside WindowsApps", async () => {
    const folder = realpathSync(mkdtempSync(join(tmpdir(), "ave-host-program-link-")));
    try {
      symlinkSync(join(folder, "missing-target.exe"), join(folder, `${program}.exe`), "file");
      expect(findHostProgram(program, { LOCALAPPDATA: local, Path: folder }, "win32")).toBeNull();
    } finally {
      await cleanupTmpDir(folder);
    }
  });

  it("leaves a regular file unaffected", () => {
    expect(findHostProgram("tool", { Path: `${aliases};${tools}` }, "win32", fs)).toBe(tool);
  });
});
