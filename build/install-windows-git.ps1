# Ave NSIS customInstall: download the official MinGit release, check it against the pinned size and sha256, and place it at <InstallDir>\git,
# where src/marketplace/git/installer-git.ts finds it. Fail-closed: an unverified download is deleted and nothing is placed. The installer logs the
# exit code and continues; the app then uses a system git or says none is usable.
#   0 placed   2 download failed   3 size or sha256 mismatch   4 extract or layout failed   5 unsupported architecture
param(
  [Parameter(Mandatory)][string]$InstallDir,
  [Parameter(Mandatory)][string]$DownloadDir
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# Windows PowerShell's own modules only; a PowerShell 7 PSModulePath must not supply these cmdlets.
$env:PSModulePath = Join-Path $PSHOME 'Modules'

# Update together from the release notes' SHA-256 table (Prefix is the archive's toolchain directory, read from the zip itself): https://github.com/git-for-windows/git/releases/tag/v2.56.0.windows.4
$Tag = 'v2.56.0.windows.4'
$Assets = @{
  AMD64 = @{ Name = 'MinGit-2.56.0.4-64-bit.zip'; Size = 39846926; Sha256 = 'e3bf78351fe777fba47ddee5950082f8a98bb0f02604fdc7ba3ee2cb68ffa877'; Prefix = 'ucrt64' }
  ARM64 = @{ Name = 'MinGit-2.56.0.4-arm64.zip'; Size = 37980967; Sha256 = '70f7649f78088c1db1d2f3571ca46a04d5bef06e4e9d56d8ed7f9829e8c6c4db'; Prefix = 'clangarm64' }
}

$arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
$asset = $Assets[$arch]
if (-not $asset) { Write-Output "Ave git: no pinned MinGit for $arch"; exit 5 }

$url = "https://github.com/git-for-windows/git/releases/download/$Tag/$($asset.Name)"
$zip = Join-Path $DownloadDir $asset.Name
$target = Join-Path $InstallDir 'git'
$staging = Join-Path $InstallDir 'git.partial'

function Remove-Tree([string]$Path) {
  if (Test-Path -LiteralPath $Path) { Remove-Item -LiteralPath $Path -Recurse -Force }
}

function Save-AuthenticatedRelease([Uri]$Uri, [string]$Path, [string]$Token) {
  for ($redirects = 0; $redirects -le 10; $redirects++) {
    if ($Uri.Scheme -ne 'https') { throw 'Release download requires HTTPS' }
    $request = [Net.WebRequest]::Create($Uri)
    $request.AllowAutoRedirect = $false
    $request.Timeout = 600000
    $request.ReadWriteTimeout = 600000
    if ($Uri.DnsSafeHost -in @('github.com', 'api.github.com')) {
      $request.Headers['Authorization'] = "Bearer $Token"
    }
    $response = $request.GetResponse()
    try {
      $status = [int]$response.StatusCode
      if ($status -in @(301, 302, 303, 307, 308)) {
        if ($redirects -eq 10) { throw 'Too many release download redirects' }
        $location = $response.Headers['Location']
        if (-not $location) { throw 'Release redirect has no location' }
        $Uri = [Uri]::new($Uri, $location)
        continue
      }
      if ($status -ne 200) { throw "Release download returned HTTP $status" }
      $output = [IO.File]::Create($Path)
      try { $response.GetResponseStream().CopyTo($output) } finally { $output.Dispose() }
      return
    } finally { $response.Dispose() }
  }
}

try {
  Remove-Tree $target
  Remove-Tree $staging

  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $token = if ($env:GITHUB_TOKEN) { $env:GITHUB_TOKEN } else { $env:GH_TOKEN }
    if ($token) {
      Save-AuthenticatedRelease -Uri $url -Path $zip -Token $token
    } else {
      Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing -TimeoutSec 600
    }
  } catch {
    Write-Output "Ave git: download of $url failed: $($_.Exception.Message)"
    exit 2
  }

  $size = (Get-Item -LiteralPath $zip).Length
  $digest = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($size -ne $asset.Size -or $digest -ne $asset.Sha256) {
    Write-Output "Ave git: $($asset.Name) is $size bytes with sha256 $digest, expected $($asset.Size) bytes with $($asset.Sha256)"
    exit 3
  }

  try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory($zip, $staging)
    foreach ($file in 'cmd\git.exe', "$($asset.Prefix)\bin\git-remote-https.exe", "$($asset.Prefix)\libexec\git-core") {
      if (-not (Test-Path -LiteralPath (Join-Path $staging $file))) { throw "$file is missing from the archive" }
    }
    Rename-Item -LiteralPath $staging -NewName 'git'
  } catch {
    Remove-Tree $staging
    Write-Output "Ave git: placing $($asset.Name) failed: $($_.Exception.Message)"
    exit 4
  }

  Write-Output "Ave git: MinGit $Tag placed at $target"
  exit 0
} finally {
  if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
}
