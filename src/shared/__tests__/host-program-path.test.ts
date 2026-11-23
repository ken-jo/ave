// Host programs resolve to an absolute path from PATH only; a current directory is never searched.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
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
    expect(() => resolveHostProgram("bin/tool", { PATH: base })).toThrow(/bare name or an absolute path/u);
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
    expect(() => resolveHostProgram("C:tool", { Path: bin })).toThrow(/bare name or an absolute path/u);
    expect(() => resolveHostProgram("\\tool", { Path: bin })).toThrow(/bare name or an absolute path/u);
  });
});
