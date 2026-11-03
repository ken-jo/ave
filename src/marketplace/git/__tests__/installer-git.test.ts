import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findInstallerGit, installerGitRoot, installerRunnerOptions } from "../installer-git.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ave-installer-git-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("installerGitRoot", () => {
  it("names <install dir>\\git for a packaged Windows app only", () => {
    expect(installerGitRoot(true, join("C:", "Ave", "Ave.exe"), "win32")).toBe(join("C:", "Ave", "git"));
    expect(installerGitRoot(false, join("C:", "Ave", "electron.exe"), "win32")).toBeNull();
    expect(installerGitRoot(true, "/opt/Ave/ave", "linux")).toBeNull();
    expect(installerGitRoot(true, "/Applications/Ave.app/Contents/MacOS/Ave", "darwin")).toBeNull();
  });
});

describe("findInstallerGit", () => {
  it("accepts a root holding cmd\\git.exe", () => {
    const root = join(dir, "git");
    mkdirSync(join(root, "cmd"), { recursive: true });
    writeFileSync(join(root, "cmd", "git.exe"), "");
    expect(findInstallerGit(root)).toEqual({ path: join(root, "cmd", "git.exe"), root });
  });

  it("refuses no root, a missing root and a root without the binary", () => {
    expect(findInstallerGit(null)).toBeNull();
    expect(findInstallerGit(join(dir, "absent"))).toBeNull();
    mkdirSync(join(dir, "empty"));
    expect(findInstallerGit(join(dir, "empty"))).toBeNull();
  });
});

describe("installerRunnerOptions", () => {
  it("uses schannel and the copy's own tools", () => {
    const options = installerRunnerOptions({ path: "C:\\Ave\\git\\cmd\\git.exe", root: "C:\\Ave\\git" });
    expect(options.installerConfig).toEqual({ "http.sslBackend": "schannel" });
    expect(options.installerEnv).toEqual({ GIT_EXEC_PATH: join("C:\\Ave\\git", "mingw64", "libexec", "git-core") });
    expect(options.installerPathPrefix?.split(";")).toEqual([join("C:\\Ave\\git", "mingw64", "bin"), join("C:\\Ave\\git", "usr", "bin")]);
  });
});
