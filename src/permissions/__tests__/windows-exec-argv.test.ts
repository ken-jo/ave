import { wrapCommandWithSandboxWindows } from "@anthropic-ai/sandbox-runtime/dist/sandbox/windows-sandbox-utils.js";
import { afterEach, expect, it, vi } from "vitest";
import { WINDOWS_COMMAND_LINE_LIMIT, windowsCommandLineLength } from "../../shared/windows-command-line.js";

afterEach(() => vi.unstubAllEnvs());

it("rejects a Windows exec command whose quoted argv exceeds CreateProcessW", () => {
  vi.stubEnv("PATH", "C:\\Windows");
  vi.stubEnv("PATHEXT", undefined);
  const srtWin = { exe: "C:\\broker.exe", prependArgs: ["--dispatch"] };
  const binShell = { exe: "C:\\shell.exe", args: ["/c"] };
  const wrap = (command: string) => wrapCommandWithSandboxWindows({ command, srtWin, binShell });
  const fixed = wrap("echo safe").argv.slice(0, -1);
  const body = `echo ${'\\"'.repeat(2_328)}`;
  const fixedEstimate = fixed.reduce((units, arg) => units + arg.length + 3, 0);
  const command = `${body}${"x".repeat(29_977 - fixedEstimate - 3 - body.length)}`;
  expect(windowsCommandLineLength(srtWin.exe, [...fixed.slice(1), command])).toBe(34_591);
  expect(() => wrap(command)).toThrow(expect.objectContaining({ code: "argv_too_long" }));

  const tail = ` 😀 ${"\\".repeat(17)}`;
  const available = WINDOWS_COMMAND_LINE_LIMIT - windowsCommandLineLength(srtWin.exe, [...fixed.slice(1), `${body}${tail}`]);
  const atLimit = `${body}${"x".repeat(available)}${tail}`;
  expect(windowsCommandLineLength(srtWin.exe, wrap(atLimit).argv.slice(1))).toBe(WINDOWS_COMMAND_LINE_LIMIT);
  expect(() => wrap(`x${atLimit}`)).toThrow(expect.objectContaining({ code: "argv_too_long" }));
});
