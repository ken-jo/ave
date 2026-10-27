import { describe, expect, it } from "vitest";
import { modelShellPath } from "../shell-native-path.js";

describe.runIf(process.platform === "win32")("native shell path model", () => {
  it.each([
    [String.raw`C:\..\etc\shadow`, String.raw`C:\etc\shadow`],
    [String.raw`\\host\etc\..\shadow`, String.raw`\\host\etc\shadow`],
    [String.raw`\\host\.ssh\..\config`, String.raw`\\host\.ssh\config`],
    [String.raw`\\?\C:\..\etc\shadow`, String.raw`\\?\C:\etc\shadow`],
    [String.raw`\\?\UNC\host\etc\..\shadow`, String.raw`\\?\UNC\host\etc\shadow`],
  ])("clamps parent components at the native volume root: %s", (path, expected) => {
    expect(modelShellPath(path, { dialect: "native" }).normalizedPath).toBe(expected);
  });

  it.each(["/x/file.txt", String.raw`\x\file.txt`])("anchors only an established execution location: %s", path => {
    expect(modelShellPath(path, { dialect: "powershell", location: "D:/project" }).normalizedPath).toBe(String.raw`D:\x\file.txt`);
    expect(modelShellPath(path, { dialect: "powershell" }).nativePath).toBeUndefined();
    expect(modelShellPath(path, { dialect: "powershell", location: "/project" }).nativePath).toBeUndefined();
  });

  it("does not borrow the cwd drive for a mounted root", () => {
    expect(modelShellPath("/x/file.txt", { dialect: "bash", location: "D:/project" }).nativePath).toBeUndefined();
    expect(modelShellPath("/c/x/file.txt", { dialect: "bash", location: "D:/project" }).normalizedPath).toBe(String.raw`c:\x\file.txt`);
  });

  it("retains a sensitive drive-relative floor without assigning a drive location", () => {
    const path = modelShellPath("C:.ssh/config", { dialect: "native" });
    expect(path.nativePath).toBeUndefined();
    expect(path.floorPaths).toContain("/.ssh/config");
  });

  it("uses the share as the extended network volume root", () => {
    expect(modelShellPath(String.raw`\\?\UNC\host\etc\..\shadow`, { dialect: "native" }).volumeRoot)
      .toBe(String.raw`\\?\UNC\host\etc` + "\\");
  });
});

it.runIf(process.platform !== "win32")("preserves host path semantics", () => {
  expect(modelShellPath("/x/../file.txt", { dialect: "bash", location: "/project" }).normalizedPath).toBe("/file.txt");
});
