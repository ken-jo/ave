// The user's editor command: how it is split, filled in, resolved and started, and that its setting is out of an agent's reach.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { isEditorCommandSetting, splitEditorCommand } from "../../shared/editor-command.js";
import { buildEditorArgv, editorEnvironment, launchEditor, resolveEditorProgram } from "../editor-command.js";
import { canonicalizePathForMatch, caseFoldForMatch, isSensitivePath } from "../../permissions/sensitive-paths.js";

describe("splitEditorCommand", () => {
  it("splits on blanks, keeps quoted blanks in one word, and leaves backslashes alone", () => {
    expect(splitEditorCommand("edit --goto {file}:{line}")).toEqual(["edit", "--goto", "{file}:{line}"]);
    expect(splitEditorCommand(`"/Applications/My Editor.app/bin/edit"   -w '{file}'`)).toEqual(["/Applications/My Editor.app/bin/edit", "-w", "{file}"]);
    expect(splitEditorCommand(String.raw`"C:\Program Files\Editor\edit.exe" /open {file}`)).toEqual([String.raw`C:\Program Files\Editor\edit.exe`, "/open", "{file}"]);
    expect(splitEditorCommand(`edit ""`)).toEqual(["edit", ""]);
    expect(splitEditorCommand("  ")).toEqual([]);
  });

  it("refuses an unterminated quote, in the splitter and in the setting", () => {
    expect(splitEditorCommand(`edit "{file}`)).toBeNull();
    expect(isEditorCommandSetting(`edit "{file}`)).toBe(false);
    expect(isEditorCommandSetting("edit {file}")).toBe(true);
    expect(isEditorCommandSetting("")).toBe(true);
    expect(isEditorCommandSetting("edit\n{file}")).toBe(false);
  });
});

describe("buildEditorArgv", () => {
  const file = `/p/my project/it's "quoted" $(touch x); rm -rf ~.ts`;

  it("puts the file and the line in as whole arguments, whatever the path contains", () => {
    expect(buildEditorArgv("edit --goto {file}:{line}", { file, line: 12 })).toEqual({ ok: true, program: "edit", args: ["--goto", `${file}:12`] });
    expect(buildEditorArgv("ed +{line} {file}", { file, line: 3 })).toEqual({ ok: true, program: "ed", args: ["+3", file] });
  });

  it("appends the file when the command does not name it, and does not expand a placeholder the path itself contains", () => {
    expect(buildEditorArgv("open-editor -w", { file, line: 1 })).toEqual({ ok: true, program: "open-editor", args: ["-w", file] });
    expect(buildEditorArgv("edit {file}", { file: "/p/{line}.txt", line: 9 })).toEqual({ ok: true, program: "edit", args: ["/p/{line}.txt"] });
  });

  it("answers not-configured for an empty command and invalid-command for one it will not start", () => {
    expect(buildEditorArgv("   ", { file, line: 1 })).toEqual({ ok: false, error: "not-configured" });
    expect(buildEditorArgv(`edit "{file}`, { file, line: 1 })).toEqual({ ok: false, error: "invalid-command" });
    expect(buildEditorArgv("{file}", { file, line: 1 })).toEqual({ ok: false, error: "invalid-command" });
    // A relative program would resolve against the app's working folder.
    expect(buildEditorArgv("./edit {file}", { file, line: 1 })).toEqual({ ok: false, error: "invalid-command" });
    expect(buildEditorArgv("bin/edit {file}", { file, line: 1 })).toEqual({ ok: false, error: "invalid-command" });
  });
});

describe("resolveEditorProgram and launchEditor", () => {
  let base: string;
  beforeAll(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "ave-editor-command-")));
    mkdirSync(join(base, "bin"));
    writeFileSync(join(base, "bin", "edit"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(base, "bin", "edit"), 0o755);
    writeFileSync(join(base, "bin", "notes"), "not a program\n");
    chmodSync(join(base, "bin", "notes"), 0o644);
  });
  afterAll(async () => { await cleanupTmpDir(base); });

  it("uses an absolute path as written and finds a bare name in the absolute folders of PATH only", async ({ skip }) => {
    if (process.platform === "win32") skip("execute bits and extension-less programs are POSIX here");
    expect(await resolveEditorProgram("/opt/editor/bin/edit", { PATH: "" })).toBe("/opt/editor/bin/edit");
    const path = ["", ".", "bin", join(base, "bin")].join(delimiter);
    expect(await resolveEditorProgram("edit", { PATH: path })).toBe(join(base, "bin", "edit"));
    // A file without the execute bit is not a program; a name with a folder in it is never looked up.
    expect(await resolveEditorProgram("notes", { PATH: path })).toBeNull();
    expect(await resolveEditorProgram("bin/edit", { PATH: base })).toBeNull();
    expect(await resolveEditorProgram("edit", { PATH: ["", ".", "bin"].join(delimiter) })).toBeNull();
    expect(await resolveEditorProgram("edit", {})).toBeNull();
  });

  it("tries the program's .exe and .com names on Windows and never a script launcher", async () => {
    writeFileSync(join(base, "bin", "win.exe"), "");
    writeFileSync(join(base, "bin", "tool.cmd"), "");
    expect(await resolveEditorProgram("win", { Path: join(base, "bin") }, "win32")).toBe(join(base, "bin", "win.exe"));
    expect(await resolveEditorProgram("tool", { Path: join(base, "bin") }, "win32")).toBeNull();
  });

  it("starts a real program, and reports a program that does not exist instead of throwing", async () => {
    // A program that ends at once: the launcher hands the child no runtime variables, so this test's own runtime would
    // start as an app and stay.
    const quick: [string, string[]] = process.platform === "win32" ? ["cmd.exe", ["/d", "/c", "exit 0"]] : [join(base, "bin", "edit"), []];
    expect(await launchEditor(...quick)).toBe(true);
    expect(await launchEditor(join(base, "bin", "no-such-editor"), ["x"])).toBe(false);
    expect(await launchEditor("no-such-editor-anywhere-on-path", ["x"])).toBe(false);
    // A path that runs through a file, and a file that is not a program, fail in ways the OS reports differently.
    expect(await launchEditor(join(base, "bin", "edit", "x"), ["x"])).toBe(false);
    expect(await launchEditor(join(base, "bin", "notes"), ["x"])).toBe(false);
  });

  it("gives the editor the environment without the app's own and the runtime's variables", () => {
    expect(editorEnvironment({ PATH: "/usr/bin", HOME: "/home/alex", AVE_HOME: "/x", AVE_E2E: "1", ELECTRON_RUN_AS_NODE: "1", LANG: "ko_KR.UTF-8" }))
      .toEqual({ PATH: "/usr/bin", HOME: "/home/alex", LANG: "ko_KR.UTF-8" });
  });
});

describe("the editor command's trust boundary", () => {
  it("keeps the settings file that stores it on the sensitive write and read floor at the default profile locations", () => {
    for (const path of [
      "/Users/alex/Library/Application Support/Ave/ave-settings.json",
      "/home/alex/.config/Ave/ave-settings.json",
    ]) {
      const key = caseFoldForMatch(canonicalizePathForMatch(path));
      expect(isSensitivePath(key, "write"), path).not.toBeNull();
      expect(isSensitivePath(key, "read"), path).not.toBeNull();
    }
  });
});
