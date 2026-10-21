import { describe, expect, it } from "vitest";
import { resolveManualShell } from "../manual-shell.js";

describe("native manual interpreter", () => {
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
});
