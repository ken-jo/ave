# Builds the Windows job launcher and its optional failure fixtures.
param([string]$Arch = "x64", [switch]$FailureFixture, [switch]$QueryFailureFixture, [switch]$PolicyReaderFixture, [switch]$ToolchainIdentity)
$ErrorActionPreference = "Stop"
if ($Arch -notin @("x64", "arm64")) { throw "Unsupported job launcher architecture: $Arch" }
if (@($FailureFixture, $QueryFailureFixture, $PolicyReaderFixture).Where({ $_ }).Count -gt 1) { throw "Build one fixture at a time" }
$root = Split-Path $PSScriptRoot -Parent
$out = Join-Path $root "resources/windows-job/$Arch"
$vswhere = "${env:ProgramFiles(x86)}/Microsoft Visual Studio/Installer/vswhere.exe"
if (!(Test-Path $vswhere)) { throw "Windows job launcher requires the C++ build tools" }
$installation = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (!$installation) { throw "Windows job launcher requires the C++ build tools" }
$devcmd = Join-Path $installation "Common7/Tools/VsDevCmd.bat"
$source = Join-Path $root "native/windows-job/launcher.cpp"
$name = if ($FailureFixture) { "ave-job-failure.exe" } elseif ($QueryFailureFixture) { "ave-job-query-failure.exe" } elseif ($PolicyReaderFixture) { "ave-job-policy-reader-test.exe" } else { "ave-job.exe" }
$object = "launcher.obj"
# Import the compiler environment without passing checkout paths through cmd.
# UTF-16 preserves environment values containing non-ASCII user/profile paths.
$setup = New-Object System.Diagnostics.ProcessStartInfo
$setup.FileName = $env:ComSpec
$setup.Arguments = '/d /u /s /c ""%AVE_JOB_VSDEVCMD%" -no_logo -arch=' + $Arch + ' -host_arch=x64 >nul && set"'
$setup.EnvironmentVariables["AVE_JOB_VSDEVCMD"] = $devcmd
$setup.WorkingDirectory = $installation
$setup.UseShellExecute = $false
$setup.RedirectStandardOutput = $true
$setup.StandardOutputEncoding = [System.Text.Encoding]::Unicode
$setupProcess = [System.Diagnostics.Process]::Start($setup)
$environmentText = $setupProcess.StandardOutput.ReadToEnd()
$setupProcess.WaitForExit()
$setupExitCode = $setupProcess.ExitCode
$setupProcess.Dispose()
if ($setupExitCode -ne 0) { throw "C++ compiler environment setup failed ($setupExitCode)" }
foreach ($line in ($environmentText -split "`r?`n")) {
    $separator = $line.IndexOf('=')
    if ($separator -gt 0) {
        [Environment]::SetEnvironmentVariable($line.Substring(0, $separator), $line.Substring($separator + 1), "Process")
    }
}
if ($ToolchainIdentity) {
    if (!$env:VCToolsVersion -or !$env:WindowsSDKVersion) { throw "Missing C++ toolchain identity" }
    @{ msvc = $env:VCToolsVersion; sdk = $env:WindowsSDKVersion; ucrt = $env:UCRTVersion } | ConvertTo-Json -Compress
    return
}
New-Item -ItemType Directory -Force $out | Out-Null
$compilerArgs = @("/nologo", "/std:c++17", "/O2", "/MT", "/W4", "/WX", "/EHsc")
if ($FailureFixture) { $compilerArgs += "/DAVE_TEST_INVALID_JOB" }
if ($QueryFailureFixture) { $compilerArgs += "/DAVE_TEST_UNQUERYABLE_JOB" }
if ($PolicyReaderFixture) { $compilerArgs += "/DAVE_TEST_POLICY_READER" }
$compilerArgs += @($source, "/Fo:$out/$object", "/Fe:$out/$name", "/link", "/INCREMENTAL:NO", "/Brepro")
# Direct argument passing preserves Unicode, spaces, and literal percent signs.
& cl.exe @compilerArgs
if ($LASTEXITCODE -ne 0) { throw "Windows job helper build failed ($LASTEXITCODE)" }
Remove-Item -LiteralPath (Join-Path $out $object) -ErrorAction SilentlyContinue
