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
  it.each(["ucrt64", "clangarm64"])("accepts a root holding cmd\\git.exe and a %s toolchain", (prefix) => {
    const root = join(dir, "git");
    mkdirSync(join(root, "cmd"), { recursive: true });
    mkdirSync(join(root, prefix, "libexec", "git-core"), { recursive: true });
    writeFileSync(join(root, "cmd", "git.exe"), "");
    expect(findInstallerGit(root)).toEqual({ path: join(root, "cmd", "git.exe"), root, prefix });
  });

  it("refuses no root, a missing root and a root without the binary", () => {
    expect(findInstallerGit(null)).toBeNull();
    expect(findInstallerGit(join(dir, "absent"))).toBeNull();
    mkdirSync(join(dir, "empty"));
    expect(findInstallerGit(join(dir, "empty"))).toBeNull();
    const noToolchain = join(dir, "no-toolchain");
    mkdirSync(join(noToolchain, "cmd"), { recursive: true });
    writeFileSync(join(noToolchain, "cmd", "git.exe"), "");
    expect(findInstallerGit(noToolchain)).toBeNull();
  });
});

describe("installerRunnerOptions", () => {
  it("uses schannel and the copy's own toolchain tools", () => {
    const root = "C:\\Ave\\git";
    const options = installerRunnerOptions({ path: join(root, "cmd", "git.exe"), root, prefix: "ucrt64" });
    expect(options.installerConfig).toEqual({ "http.sslBackend": "schannel" });
    expect(options.installerEnv).toEqual({ GIT_EXEC_PATH: join(root, "ucrt64", "libexec", "git-core") });
    expect(options.installerPathPrefix?.split(";")).toEqual([join(root, "ucrt64", "bin"), join(root, "usr", "bin")]);
  });
});
