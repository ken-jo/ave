# Windows parent guard verification

The native parent `FILE_DELETE_CHILD` deny is object-only. A full target deny retains inheritable `FILE_DELETE_CHILD` and existing subtree inheritance. The change must preserve owner and unrelated ACEs, protected DACL state, sibling access, and kernel delete, rename and replacement denial.

Every full deny application refreshes descendant inheritance, including when the root ACEs already match. This repairs permissive ACLs retained by an unprotected subtree moved into the denied directory. Without a full deny, parent guard updates with matching inheritable entries use the local writer and leave unrelated descendants untouched.

The [permission decision tree](../architecture/permission-decision-tree.md) remains authoritative in its original order. Deny selection, independent home anchors and the profile-child Ave home projection are unchanged. `policyHomeAnchors` intentionally includes `userInfo().homedir`: isolating `HOME` and `USERPROFILE` redirects application data without dropping credential protection for the real account profile. The four synthetic anchor regressions cover isolated variables, failed OS home resolution, distinct anchors and equivalent-path deduplication.

Stamps remain transient under the existing state schema, holder lifetime, restore and crash recovery. This scope excludes durable deny ownership, a journal, reconciliation and identity relocation. Retain `NativeDB` and the existing 60-second ACL command ceiling.

## Directory sharing

Local ACL opens request `READ_CONTROL | WRITE_DAC` (`0x00060000`), including the identity-verified directory reopen. A process using the directory as its CWD can hold it without delete sharing, so requesting `DELETE` through `MAXIMUM_ALLOWED` would make the guard fail. Both no-follow opens and their volume/file identity comparison bind the update to the verified object. Required-open errors fail the operation.

The other opens in the patched ACL and identity helpers use security rights plus `FILE_LIST_DIRECTORY` for descendant refresh, `WRITE_OWNER` for protected-store ownership, or zero access for metadata. The remaining `MAXIMUM_ALLOWED` and explicit `DELETE` opens are native test controls. ACE deny masks and `FILE_SHARE_DELETE` describe different permissions from the requested handle access.

Collect profile-parent `fdc` durations after a complete successful stamp and verify restore with the CWD holder still alive. Successful real-host guard timing remains to be measured.

## Directory-form placeholders

A missing deny target with a trailing separator creates a directory. A missing bare target creates a zero-byte file, and placeholder objects remain after restore. A later directory-form input can therefore encounter an existing file at a name reserved by an earlier creation attempt.

The native helper can reuse that file only when its kernel-canonical path exactly matches the existing per-user placeholder ledger and a no-follow handle verifies a zero-byte regular file. The handle pins the current object through application and rollback, with identity checked again at the ACL effect. The legacy ledger records namespace intent; current-object identity comes from the live handle rather than historical creator provenance. Unrecorded files, nonempty files and reparse leaves fail clearly. General partial-stamp exit handling remains strict.

The requested file deny and parent deletion guard protect the occupied name. Sandbox processes cannot truncate, delete, rename or replace the file to create a file or directory there. Restore removes the holder's ACEs and preserves the placeholder and namespace record.

## Peer three-boot procedure

Run on a disposable Windows test host with the [Windows source prerequisites](../guides/windows-setup.md#1-prerequisites), plus `rustup`, `cargo`, `tar.exe` and the C++ compiler/linker and SDK for both native targets. The build selects the toolchain in `src/permissions/srt-win-pins.json`; this procedure requires Bun 1.4.4. Close all prior Ave hosts and development watchers before starting. Use the same Windows account and one unchanged isolated `HOME`, `USERPROFILE`, `AVE_HOME` and `AVE_USER_DATA_DIR` for installation, build and all three boots. Do not delete `NativeDB`, reset ACLs, change the sandbox account, reinstall or recreate the isolated directories between boots. Quit each boot normally before the next so holder measurements do not overlap.

Start PowerShell in the repository root with Bun 1.4.4 first on `PATH`. Establish isolation **before** dependency installation or any build:

```powershell
$ErrorActionPreference = 'Stop'
$Repo = (Get-Location).Path
$Repo = (git -C $Repo rev-parse --show-toplevel).Trim()
if ((bun --version).Trim() -ne '1.4.4') { throw 'Bun 1.4.4 required' }
$RunRoot = Join-Path $env:TEMP ('ave-parent-guard-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$env:HOME = Join-Path $RunRoot 'home'
$env:USERPROFILE = $env:HOME
$env:AVE_HOME = Join-Path $env:HOME 'ave'
$env:AVE_USER_DATA_DIR = Join-Path $env:HOME 'user-data'
$env:AVE_SANDBOX_ENABLED = '1'
$env:AVE_PLUGIN_WORKER_CONFINEMENT = '1'
$env:SRT_DEBUG = '1'
$env:AVE_DEBUG = '1'
New-Item -ItemType Directory -Force $RunRoot, $env:HOME, $env:AVE_HOME, $env:AVE_USER_DATA_DIR | Out-Null
@{
  account = (whoami)
  commit = (git -C $Repo rev-parse HEAD).Trim()
  bun = (bun --version).Trim()
  HOME = $env:HOME
  USERPROFILE = $env:USERPROFILE
  AVE_HOME = $env:AVE_HOME
  AVE_USER_DATA_DIR = $env:AVE_USER_DATA_DIR
} | ConvertTo-Json | Set-Content (Join-Path $RunRoot 'environment.json')
Start-Transcript -Path (Join-Path $RunRoot 'setup.log')

bun install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed' }
$pins = Get-Content 'src/permissions/srt-win-pins.json' -Raw | ConvertFrom-Json
$sourceArchive = Join-Path $RunRoot 'source.tar.gz'
Invoke-WebRequest -Uri $pins.source.url -OutFile $sourceArchive
if ((Get-FileHash $sourceArchive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $pins.source.sha256) {
  throw 'Native source archive integrity mismatch'
}
node scripts/build-srt-win.mjs --source-archive $sourceArchive --test-native
if ($LASTEXITCODE -ne 0) { throw 'Native build or tests failed' }
node scripts/check-srt-win-integrity.cjs
if ($LASTEXITCODE -ne 0) { throw 'Helper integrity check failed' }
```

Keep the installation, native build/test and integrity output with the run. The native build defaults to x64 and arm64; `--test-native` executes native tests for the host architecture and proves the parent inheritance regression against pristine source before testing the patch. Compilation of the other architecture does not prove execution there.

Record the helper hashes and trusted build receipts before boot 1:

```powershell
$Vendor = node -e "const p=require('node:path'); console.log(p.join(p.dirname(require.resolve('@anthropic-ai/sandbox-runtime/package.json')),'vendor','srt-win'))"
Get-FileHash (Join-Path $Vendor 'x64/srt-win.exe'), (Join-Path $Vendor 'arm64/srt-win.exe') -Algorithm SHA256 |
  ConvertTo-Json | Set-Content (Join-Path $RunRoot 'helper-hashes.json')
Copy-Item 'src/permissions/generated/srt-win-build-receipts.json' (Join-Path $RunRoot 'trusted-build-receipts.json')
foreach ($arch in @('x64', 'arm64')) {
  Copy-Item (Join-Path $Vendor "$arch/build-receipt.json") (Join-Path $RunRoot "$arch-build-receipt.json")
}
Stop-Transcript
```

The central receipts compiled into the application supply trust. Retained vendor sidecars are evidence to compare with them; copying or editing a sidecar never authorizes a binary. Keep the verified source archive and the build's source, patch, target and binary digests with these receipts.

For each boot, launch the same checkout without changing the environment. This helper writes separate stdout, stderr and an explicitly human-observed app-ready measurement. Its stopwatch starts before `bun run dev`, so this measurement includes development preparation and human response time; it is not a native ACL duration.

```powershell
function Get-BootProcessTree([int] $RootPid) {
  $processes = Get-CimInstance Win32_Process
  $ids = @($RootPid)
  do {
    $children = @($processes | Where-Object { $_.ParentProcessId -in $ids -and $_.ProcessId -notin $ids })
    $ids += @($children | Select-Object -ExpandProperty ProcessId)
  } while ($children.Count -gt 0)
  $processes | Where-Object { $_.ProcessId -in $ids } | ForEach-Object {
    @{ ProcessId = $_.ProcessId; CreatedAt = $_.CreationDate.ToUniversalTime().ToString('o') }
  }
}

function Start-MeasuredBoot([int] $Number) {
  $prefix = Join-Path $RunRoot "boot-$Number"
  $startedAt = [DateTime]::UtcNow.ToString('o')
  $timer = [Diagnostics.Stopwatch]::StartNew()
  $dev = Start-Process -FilePath (Get-Command bun).Source -ArgumentList @('run', 'dev') `
    -WorkingDirectory $Repo -PassThru `
    -RedirectStandardOutput "$prefix.stdout.log" -RedirectStandardError "$prefix.stderr.log"
  $observation = Read-Host 'Press Enter when the main window is visible and accepts input; if unavailable, type failed'
  $timer.Stop()
  $settingsPath = Join-Path $env:AVE_USER_DATA_DIR 'ave-settings.json'
  $features = if (Test-Path $settingsPath) {
    (Get-Content $settingsPath -Raw | ConvertFrom-Json).features |
      Select-Object osToolSandbox, pluginWorkerConfinement
  } else { $null }
  @{
    boot = $Number
    startedAt = $startedAt
    appReadyObservedMs = if ($observation -eq 'failed') { $null } else { $timer.Elapsed.TotalMilliseconds }
    observation = $observation
    launcherPid = $dev.Id
    storedSandboxFeatures = $features
    AVE_SANDBOX_ENABLED = $env:AVE_SANDBOX_ENABLED
    AVE_PLUGIN_WORKER_CONFINEMENT = $env:AVE_PLUGIN_WORKER_CONFINEMENT
  } | ConvertTo-Json | Set-Content "$prefix.app-ready.json"
  ConvertTo-Json -InputObject @(Get-BootProcessTree $dev.Id) | Set-Content "$prefix.processes.json"
  $dev
}

$boot = Start-MeasuredBoot 1
```

Inspect Settings → Permissions and retain the active backend display with each boot's stored-feature/environment snapshot. Confirm the current logs contain `boot: ASRT OS tool sandbox initialized` and the `boot: Windows sandbox` record with `extensions: srt-win`; record the shell backend independently. Capture any unavailable warning, preparation failure or timeout. Requested flags, stored settings and an app window alone do not prove activation.

Preserve all ACL failures; do not raise the ceiling or exclude slow targets to make a boot pass. Immediately before quitting, take another tree snapshot, replacing `1` with the current boot number:

```powershell
ConvertTo-Json -InputObject @(Get-BootProcessTree $boot.Id) |
  Set-Content (Join-Path $RunRoot 'boot-1.pre-shutdown-processes.json')
```

Quit Ave normally, then stop only this run's development watcher with `taskkill /PID $boot.Id /T` if it is still running. Check the observed processes after shutdown, matching creation time as well as PID:

```powershell
$known = @((Get-Content (Join-Path $RunRoot 'boot-1.processes.json') -Raw | ConvertFrom-Json)) +
  @((Get-Content (Join-Path $RunRoot 'boot-1.pre-shutdown-processes.json') -Raw | ConvertFrom-Json))
$current = Get-CimInstance Win32_Process
$remaining = @($current | Where-Object {
  $processId = $_.ProcessId
  $createdAt = $_.CreationDate.ToUniversalTime().ToString('o')
  @($known | Where-Object { $_.ProcessId -eq $processId -and $_.CreatedAt -eq $createdAt }).Count -gt 0
})
ConvertTo-Json -InputObject @($remaining | Select-Object ProcessId, Name, CreationDate) |
  Set-Content (Join-Path $RunRoot 'boot-1.remaining-processes.json')
if ($remaining.Count -gt 0) { throw 'Previous boot processes still running' }
```

These snapshots cover observed descendants. They cannot prove cleanup of an already detached or unobserved child; record that limit rather than claiming complete process cleanup.

Run these separately, applying the same inspection and shutdown after each:

```powershell
$boot = Start-MeasuredBoot 2
# Inspect boot 2, quit normally, stop its watcher, confirm exit.
$boot = Start-MeasuredBoot 3
# Inspect boot 3, quit normally, stop its watcher, confirm exit.
```

Record the exit result and sandbox activation evidence separately for `boot-1`, `boot-2` and `boot-3`. Keep each boot's raw logs even when it fails. Do not combine records from another host, account, helper build or isolated home into this sequence.

Retain `Windows sandbox ACL recovery: pruned ... dead holder(s), revoked ... orphan ACE(s)` and any `sandbox runtime reset: Windows ACE rows dropped without release` warning. Zero recovery counts after normal shutdown are expected; nonzero counts require investigation. Normal quits do not exercise crash recovery, and absence of a reset warning alone does not prove complete restoration. Report restoration as unverified when no positive receipt exists; leave crash/recovery validation to the native regression gate.

## Timing evidence

With `SRT_DEBUG=1`, preserve the host's planned target list, native per-operation JSON records and host bulk completion record. Each native record has `{path,parent,kind,elapsedMs}`; `kind` is `denyRead`, `denyWrite`, `fdc` or `delete`. A full target deny and its parent `fdc` guard are separate records, even when several targets share a parent. Retain duplicates and operation order.

Native `elapsedMs` times the individual `ensure_ace` call, including that call's SQL and ACL work. It excludes the bulk command's initial database lock, recovery and path canonicalization. A parent `fdc` record measures its own call; it is not folded into the target's duration. The host's `acl stamp exit=... elapsedMs=...` is the whole invocation and must remain separate from these records and from app-ready time. Never divide the bulk time by the target count or treat it as per-target timing. Missing native records or incomplete operations are evidence gaps, not zero-duration operations.

For each of the three boots, report the slowest individual operations with their exact paths, parents and kinds; total command duration and exit status; independently observed app-ready time; sandbox activation or refusal; and restore/recovery outcomes. Compare equal path/kind operations only after verifying the same helper hashes and unchanged environment. Retain the original logs alongside any extracted table.

## Evidence limits

No real-host startup improvement has been measured yet. Native unit or kernel-operation results do not establish a faster application boot. Three successful sandbox-on boots with this procedure remain required measurement evidence. Arm64 execution and a full installer smoke remain separate gaps until run and recorded on their applicable hosts. A successful x64 native test or cross-build does not close either gap.
