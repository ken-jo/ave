# Windows deny stamps

The [architecture](../architecture/architecture.md#os-execution-sandbox-and-plugin-workers) defines execution boundaries. The [permission decision tree](../architecture/permission-decision-tree.md) owns approval order. This runbook describes native deny lifetime and verification; it grants no additional access.

## Protection and lifetime

The base read/write deny list is retained in the existing protected native state database under owner `ave`. The principal is the dedicated sandbox account, never the desktop owner or another account. Reconciliation preserves owner and unrelated ACEs, existing inheritance and DACL protection. Read, write and delete protection on each selected target remains unchanged. A directory's full target deny still inherits through its subtree. Its parent delete-child guard is object-only, so that guard does not propagate through unrelated siblings.

| Obligation | Lifetime | Release |
| --- | --- | --- |
| Durable base deny | Across application sessions | Reconcile an owner list without the entry, explicit disable, or uninstall; live obligations still win |
| Live session deny hold | The real host PID's lifetime or explicit release | Reset/exit releases the hold; durable base protection remains |
| Per-command/direct stamp | Its holder's lifetime or explicit release | Existing restore/recovery path; no durable owner is implied |
| Worker or command grant | Its holder's lifetime or explicit release | Existing revoke/recovery path; grants do not outlive their holder |

Each base reconciliation supplies the complete list, including an empty list. The first call applies it; an identical completed list with the same principal and resolved target/parent identities performs no ACL writes. Changed lists apply the delta, but an active session's earlier obligations remain held until that session releases. Identity changes require fresh work. A crash can leave a pending intent; recovery completes it before treating it as completed. Concurrent native operations use the existing initialization lock.

Before adopting older state, close hosts using the previous ACL format. A live or unverifiable older holder causes reconciliation, recovery and teardown to refuse before changing ACLs. Dead older holders can be recovered. Durable no-op decisions require a completed physical-format record for the same principal, identities and deny mask; an older logical state row alone cannot establish completion.

This changes ACL lifetime and parent-guard propagation, not deny target selection, path admission, materialization or permission decisions. Missing-target and machine-root rules still apply. Placeholders remain after release. Existing inheritable parent guards may need one traversal to remove legacy descendant ACEs. Full target deny application and removal still propagate and can remain expensive; persistence does not promise a faster first stamp or eliminate every ACL walk.

## Why an isolated home still protects the account profile

[`policyHomeAnchors`](../../src/shared/policy-home.ts) collects independent valid anchors from the OS home, `HOME`, a profile-variable fallback when OS resolution fails, and `userInfo().homedir`. Equivalent anchors are deduplicated. [`sensitiveDenyHomes`](../../src/permissions/asrt-sandbox.ts) uses that complete set to project sensitive denies. `getPolicyHome` separately selects the configured policy root.

Consequently, setting both `HOME` and `USERPROFILE` to a scratch directory does not remove the account profile returned by `userInfo()`. Denies beneath `C:\Users\example` can be intended even when the application home is elsewhere: moving an environment variable must not expose the original account's credentials or startup files. This is a protection floor, not evidence that the isolated application home was ignored. `AVE_HOME` selects application storage; it does not redefine the account identity.

Tests that must avoid real-profile targets mock both `homedir()` and `userInfo()` before policy construction. Environment isolation alone is insufficient. [`policy-home-anchors.test.ts`](../../src/shared/__tests__/policy-home-anchors.test.ts) uses synthetic strings only and performs no filesystem or ACL operations.

## Release, disable, recovery and uninstall

Set `$helper` to the verified native executable for the installed architecture. For an `x64` development install, from the repository root:

```powershell
$helper = Join-Path $PWD 'node_modules/@anthropic-ai/sandbox-runtime/vendor/srt-win/x64/srt-win.exe'
```

Normal reset and application exit release live holds and grants while leaving the durable base. Explicit sandbox disable first releases live holders, then calls:

```powershell
& $helper acl forget-denies --persistent-owner ave --json
if ($LASTEXITCODE -ne 0) { throw 'Durable deny teardown incomplete' }
```

This removes this owner's durable obligations only. Live holds remain protected. An incomplete removal fails and retains retryable state; do not delete the native database or manually strip the account's ACEs to hide the error.

After an interrupted operation, use:

```powershell
& $helper acl recover --json
if ($LASTEXITCODE -ne 0) { throw 'Deny recovery incomplete' }
```

Recovery completes pending changes and prunes dead transient holders; completed durable denies remain. It is not an implicit disable. Stop all application hosts before intentional teardown so no live holder reintroduces protection. Uninstall uses the native all-owner cleanup before account deletion while its SID is still verifiable:

```powershell
& $helper uninstall
if ($LASTEXITCODE -ne 0) { throw 'Sandbox uninstall incomplete' }
```

Run uninstall only when removing the sandbox installation. Never replace it with account deletion followed by state cleanup; loss of principal identity prevents safe attribution.

Account-removing uninstall refuses live or unverifiable holders before changing machine state. Canceling elevation leaves the deny intent intact. If elevation selects another account, it refuses before any state or machine change; first run the explicit owner teardown above from the original account, then run uninstall independently as the administrator. A former principal is retired only after account absence and holder death are proven. Its recorded allows are removed through a retryable identity-bound journal; conservative old deny ACEs can remain on that absent principal.

## Focused validation

The native source patch stays on the revision recorded in [srt-win-pins.json](../../src/permissions/srt-win-pins.json). The package's carried source diff is `vendor/srt-win/persistent-denies.patch` inside the dependency patch. From the repository root on a Windows build worker, build both target architectures and test the host architecture before packaging:

```powershell
node scripts/build-srt-win.mjs --test-native
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

The native executable's adjacent `build-receipt.json` is checked against `src/permissions/generated/srt-win-build-receipts.json`. These bind source revision and archive hash, native patch hash, toolchain, target and compiled hash. The verified original executable is retained as a build input outside the packaged output. Publication uses an atomic replacement so a package-cache hardlink cannot modify that original. A sidecar receipt alone never establishes a trusted compiled result. Keep the receipts with field evidence. For focused reruns in the patched native source directory, use:

```powershell
cargo test --lib
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
cargo test --test acl_parent_scope
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

The native checks must cover unchanged-list no-write behavior, deltas with live holders, pending recovery, explicit teardown and unrelated-principal preservation, plus parent object-only behavior and legacy cleanup. A successful non-Windows compile cannot establish native ACL behavior.

From the repository root, focused host/profile regressions run with:

```powershell
bun run test:vitest -- run src/shared/__tests__/policy-home-anchors.test.ts src/permissions/__tests__/asrt-windows-initialization.test.ts src/permissions/__tests__/asrt-exit-release.test.ts src/permissions/__tests__/windows-deny-acl.test.ts src/permissions/__tests__/srt-win-integrity.test.ts
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
node scripts/check-srt-win-integrity.cjs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

The `windows-permission-tests` job in [ci.yml](../../.github/workflows/ci.yml) owns native provisioning and the broader Windows permission regressions. Preserve its build-before-use order: integrity verification and native tests must use the patched binary, not a previously installed helper. Record the exact commit, architecture, binary hash, native build receipt and executed test results with Windows evidence. A fixture profile test passing on another platform proves derivation only.

## Field timing with fixture targets

Use an already provisioned patched sandbox on a dedicated Windows test account. The commands below deliberately reconcile the complete `ave` owner set, so close application hosts and use no production owner state. They operate only on a newly created fixture tree. Run from the repository root; select the installed target architecture explicitly if it differs from `x64`.

```powershell
$ErrorActionPreference = 'Stop'
$helper = Join-Path $PWD 'node_modules/@anthropic-ai/sandbox-runtime/vendor/srt-win/x64/srt-win.exe'
$status = & $helper user status | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or !$status.marker_user_sid) { throw 'Sandbox identity unavailable' }
$sandboxSid = $status.marker_user_sid
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('ave-deny-timing-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $fixture | Out-Null
$target = New-Item -ItemType Directory -Path (Join-Path $fixture 'denied')
$extra = New-Item -ItemType Directory -Path (Join-Path $fixture 'extra')
$initial = @{ denyRead = @($target.FullName); denyWrite = @($target.FullName) } | ConvertTo-Json -Compress
$changed = @{ denyRead = @($target.FullName, $extra.FullName); denyWrite = @($target.FullName, $extra.FullName) } | ConvertTo-Json -Compress

function Measure-DenyStamp([string] $label, [string] $payload) {
  $clock = [Diagnostics.Stopwatch]::StartNew()
  $payload | & $helper acl stamp --holder-pid $PID --sandbox-user-sid $sandboxSid --persistent-owner ave
  $result = $LASTEXITCODE
  $clock.Stop()
  [pscustomobject]@{ operation = $label; elapsedMs = $clock.Elapsed.TotalMilliseconds; exitCode = $result } | ConvertTo-Json -Compress
  if ($result -ne 0) { throw ('Stamp failed: ' + $label) }
}

git -C $PWD rev-parse HEAD
Get-FileHash -Algorithm SHA256 -LiteralPath $helper
Measure-DenyStamp 'first' $initial
Measure-DenyStamp 'identical' $initial
Measure-DenyStamp 'add-target' $changed
& $helper acl restore --holder-pid $PID --sandbox-user-sid $sandboxSid --json
if ($LASTEXITCODE -ne 0) { throw 'Fixture live release incomplete' }
& $helper acl recover --json
if ($LASTEXITCODE -ne 0) { throw 'Fixture recovery incomplete' }
$reuseScript = Join-Path $fixture 'reuse.ps1'
@'
param([string] $Helper, [string] $SandboxSid, [string] $Target, [string] $Extra)
$payload = @{ denyRead = @($Target, $Extra); denyWrite = @($Target, $Extra) } | ConvertTo-Json -Compress
$clock = [Diagnostics.Stopwatch]::StartNew()
$payload | & $Helper acl stamp --holder-pid $PID --sandbox-user-sid $SandboxSid --persistent-owner ave
$result = $LASTEXITCODE
$clock.Stop()
[pscustomobject]@{ operation = 'new-holder'; holderPid = $PID; elapsedMs = $clock.Elapsed.TotalMilliseconds; exitCode = $result } | ConvertTo-Json -Compress
exit $result
'@ | Set-Content -LiteralPath $reuseScript
& powershell.exe -NoProfile -File $reuseScript -Helper $helper -SandboxSid $sandboxSid -Target $target.FullName -Extra $extra.FullName
if ($LASTEXITCODE -ne 0) { throw 'Fixture new-holder stamp failed' }
& $helper acl recover --json
if ($LASTEXITCODE -ne 0) { throw 'Fixture new-holder recovery incomplete' }
& $helper acl forget-denies --persistent-owner ave --json
if ($LASTEXITCODE -ne 0) { throw 'Fixture durable release incomplete' }
Remove-Item -LiteralPath $fixture -Recurse
```

Save native stderr with the timing rows. Insert `Get-Acl -LiteralPath <fixture-path> | Format-List Path,Sddl` for the target, parent and an unrelated fixture sibling before first stamp, after repeat/delta, after live release and after durable teardown. This inspects only fixture paths. A stable DACL alone cannot prove zero writes; use the native unchanged-reconciliation test for that claim. The `new-holder` row uses a separate process with the same completed list after releasing the first hold; recovery then prunes that exited holder before explicit durable teardown. Record legacy cleanup separately from a clean first stamp.

For real startup evidence, capture debug stamp rows `{path,parent,kind}` immediately before the native call and measure its wall time separately from application readiness. Record target count, existing descendants, filesystem/volume, architecture, first versus repeated session, failures and recovery/cleanup work. Debug rows contain paths and kinds, never file contents or credentials. A short fixture timing or a responsive application does not establish improvement on a large profile. This runbook contains no measured timing or claimed performance gain.

## Real-host startup rerun

Use the same Windows account and profile that produced the original report. Close all application instances. Build and verify the patched helper with the native command above, then use a fresh application home outside the checkout without changing the real `.ave`:

```powershell
$run = Join-Path $env:PUBLIC ('ave-deny-rerun-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $run | Out-Null
$env:HOME = $run
$env:USERPROFILE = $run
$env:AVE_HOME = Join-Path $run 'state'
$env:AVE_USER_DATA_DIR = Join-Path $run 'user-data'
$env:SRT_DEBUG = '1'
git -C $PWD rev-parse HEAD
Get-FileHash -Algorithm SHA256 -LiteralPath $helper
bun run dev 2>&1 | Tee-Object -FilePath (Join-Path $run 'first.log')
```

Wait for the final `acl stamp exit=... elapsedMs=...` line or preparation failure before closing the app normally and ending the development launcher. Run the same command again with `second.log`, preserving the same home and native state. Save both logs and both native build receipts. Compare stamp elapsed time, target/parent lists, preparation outcome and cleanup time separately from window readiness. Do not delete the state database or run `acl recover` between these two observations: that would measure another scenario. A failed first preparation is evidence to report; do not raise its budget to make it pass.

In another observation, close the app, run `acl recover --json`, then start again with the same home. Recovery must retain completed durable denies. For an explicit disable observation, turn off both confinement scopes, restart and record the cleanup outcome. Re-enable them afterward only when continuing the measurement. Full first-time target propagation and one-time legacy cleanup can still be expensive; report any remaining ceiling failure directly. Existing profile-child boundary projection stays unchanged.
