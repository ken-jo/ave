import { describe, expect, it, vi } from "vitest";
// Import the cleanup module so syntax failures surface before packaged smoke linkage.
import { assertNoWindowsProtocolClaim } from "../../scripts/lib/windows-protocol-cleanup.mjs";

const EXECUTABLE = "C:\\build\\win-unpacked\\Ave.exe";

type RunResult = { status: number | null; stdout: string; stderr: string; error?: Error };

function stubRun(result: RunResult) {
  return vi.fn((_command: string, _args: readonly string[], _options: { env: Record<string, string | undefined> }) => result);
}

describe("assertNoWindowsProtocolClaim", () => {
  it("does nothing off Windows", () => {
    const run = stubRun({ status: 0, stdout: "removed\n", stderr: "" });
    expect(() => assertNoWindowsProtocolClaim(EXECUTABLE, { platform: "darwin", run })).not.toThrow();
    expect(run).not.toHaveBeenCalled();
  });

  it("runs the check through PowerShell with the executable as the owner", () => {
    const run = stubRun({ status: 0, stdout: "absent\r\n", stderr: "" });
    assertNoWindowsProtocolClaim(EXECUTABLE, { platform: "win32", run });
    expect(run).toHaveBeenCalledTimes(1);
    const [command, args, options] = run.mock.calls[0]!;
    expect(command).toBe("powershell.exe");
    expect(args).toContain("-NonInteractive");
    expect(args.at(-1)).toContain("Write-Output 'absent'; exit 0");
    expect(args.at(-1)).toContain(")) { Remove-EmptyRegistryKey $path }");
    expect(args.at(-1)?.trimEnd().endsWith("Write-Output 'removed'")).toBe(true);
    expect(options.env.AVE_PROTOCOL_OWNER_EXE).toBe(EXECUTABLE);
  });

  it.each([
    ["absent", "absent\r\n"],
    ["foreign", "foreign\n"],
  ])("passes when the registration is %s", (_name, stdout) => {
    const run = stubRun({ status: 0, stdout, stderr: "" });
    expect(() => assertNoWindowsProtocolClaim(EXECUTABLE, { platform: "win32", run })).not.toThrow();
  });

  it("fails when the launch claimed ave:// for its own executable", () => {
    const run = stubRun({ status: 0, stdout: "removed\r\n", stderr: "" });
    expect(() => assertNoWindowsProtocolClaim(EXECUTABLE, { platform: "win32", run })).toThrow(
      /claimed HKCU ave:\/\/ for its own executable; the claim was removed/u,
    );
  });

  it("fails on an unexpected outcome", () => {
    const run = stubRun({ status: 0, stdout: "", stderr: "" });
    expect(() => assertNoWindowsProtocolClaim(EXECUTABLE, { platform: "win32", run })).toThrow(
      /unexpected outcome/u,
    );
  });

  it("fails when PowerShell exits non-zero or cannot start", () => {
    expect(() =>
      assertNoWindowsProtocolClaim(EXECUTABLE, {
        platform: "win32",
        run: stubRun({ status: 1, stdout: "", stderr: "boom" }),
      }),
    ).toThrow(/failed with status 1: boom/u);
    expect(() =>
      assertNoWindowsProtocolClaim(EXECUTABLE, {
        platform: "win32",
        run: stubRun({ status: null, stdout: "", stderr: "", error: new Error("ENOENT") }),
      }),
    ).toThrow(/failed to start: ENOENT/u);
  });
});
