# Windows container prototype measurements

Run these before implementing the [extension migration](../../docs/design/windows-extensions-mxc.md#prototype-gate). Each of the five entry scripts prints **one JSON line** to stdout. They measure prerequisites, not a passing production sandbox. No script installs a package, service, firewall rule or ACL grant. All filesystem writes, compiled helpers, HOME/LOCALAPPDATA/TEMP and retained evidence are under a fresh OS temp directory. The local HTTP proxy refuses every request and makes no upstream connections. Kernel fixtures are ephemeral, uniquely named, and never open live Ave pipes or change the registry.

## Prerequisites and invocation

Use a **standard-user interactive desktop session** on the Windows peer, not an SSH/service session. The supervisor records `sessionId` and refuses session 0. A supported OS version alone is insufficient: each exact request must probe as `base-container` without DACL augmentation. The toolkit never performs host preparation. If the host needs preparation, report that separately; do not grant it implicitly through these probes.

Supply an operator-trusted, separately staged `@microsoft/mxc-sdk` **1.0.1** directory including its installed runtime dependencies, and a trusted Node executable satisfying the SDK native-stream gate (`>=24.21 <25` or `>=26.8`). The supervisor checks the SDK version and the selected architecture's `mxc_ffi.dll` hash against [sdk-pins.json](sdk-pins.json), derived from the published [1.0.1 archive](https://registry.npmjs.org/@microsoft/mxc-sdk/-/mxc-sdk-1.0.1.tgz). Archive SHA-512 base64: `2cP925G5+lQyKzjBVha8uNtVd7XESgDBtgi1yCYYSo9M3xiFyZWtCO4SWPGTk509rdI6nqjyGcZxvEP3t6l8Hg==`.

The scripts do not download or install the SDK. Use a verified extracted/staged SDK with dependencies already present; missing native dependencies produce an error, not an automatic build/download. `koffi` is an operator-trusted bootstrap prerequisite; prototype DLL-search restrictions take effect after its addon loads. This does **not** validate the production requirement to restrict search before any native addon loads. Runtime, SDK and dependency directories are read-only inputs. Run only trusted toolkit files.

From PowerShell in this repository, replace the synthetic paths with absolute paths on the peer:

```powershell
$Driver = 'C:\runtime\node.exe'
$Sdk = 'C:\staged-sdk\node_modules\@microsoft\mxc-sdk'
$Node = 'C:\runtime\node.exe'
$Electron = 'C:\staged-app\electron.exe'
$Bash = 'C:\Program Files\Git\bin\bash.exe'
$GitRoot = 'C:\Program Files\Git'

& $Driver tools/mxc-probes/node-ui.mjs --sdk-root $Sdk --runtime $Node
& $Driver tools/mxc-probes/node-ui.mjs --sdk-root $Sdk --runtime $Electron
& $Driver tools/mxc-probes/loopback.mjs --sdk-root $Sdk --runtime $Electron
& $Driver tools/mxc-probes/stdio-lifetime.mjs --sdk-root $Sdk --runtime $Electron
& $Driver tools/mxc-probes/kernel-objects.mjs --sdk-root $Sdk --runtime $Electron
& $Driver tools/mxc-probes/shell-ui.mjs --sdk-root $Sdk --runtime $Electron --git-bash $Bash --git-root $GitRoot
```

The driver is standalone Node; `--runtime` is the child being measured. Environment is stripped and `ELECTRON_RUN_AS_NODE=1` is set for the child, so an electron.exe path tests its Node mode. Repeat loopback/lifetime/object probes with standalone Node when comparing runtimes. Architecture follows the driver; use an arm64 driver and matching staged SDK/runtime for arm64 evidence. Native PowerShell fixture compilation uses only the source copied into that run's temp directory. Do not point `--runtime` at an installer or an untrusted executable.

Record OS build (`[Environment]::OSVersion.Version`), exact driver/runtime paths and hashes (`Get-FileHash -Algorithm SHA256`), session, architecture and each JSON line in the review evidence. `observation.node` is the driver's bundled version; the `runtime-started` child record identifies the child runtime. The request uses a fresh cwd/HOME/temp, explicit runtime/SystemRoot reads and a temp-only write root. These intentionally generous diagnostic read roots do not certify production filesystem policy.

## What each probe means

| Entry | Measurement | Interpretation |
| --- | --- | --- |
| `node-ui.mjs` | Actual child starts with UI disabled and enabled | Require exit 0 and `runtime-started`; retain failure status such as `0xC0000142`. A failed disabled start is evidence for D3, not permission to retry an admitted holder under another backend. |
| `loopback.mjs` | A listener and client **inside the same container**, under identity-less proxy mode, with both UI settings | Require the exact echo bytes and `connected:true`. Proxy mode can prevent this; that blocks the proposed D1 bridge. A start error is inconclusive about loopback. |
| `stdio-lifetime.mjs` | Long-lived child + grandchild, stdin held open, then SDK `dispose()` | Both process objects are pinned before disposal. Independently observe both signaled; SDK wait rejection does not count. Report pre-cleanup observations even when exact-handle cleanup must terminate survivors. This is not the main-crash/job test. |
| `kernel-objects.mjs` | Unique `ave-mxc-probe-*` pipes, named sections, ALPC ports; benign registry query; host and cross-holder reach | Compare a successful same-user host baseline with container→host, container→peer and host→container. Raw NTSTATUS/HRESULT is evidence, not automatically “denied.” Default-DACL fixture results do not generalize to other objects. Always inconclusive for the full security contract: registry writes, explicit-DACL variants and production control-pipe authentication remain separate tests. |
| `shell-ui.mjs` | System PowerShell 5.1 and explicitly supplied Git Bash, both UI settings | Check the actual `probe-shell-started` marker and exit status. Git Bash is expected to fail under the current policy. Missing Bash is unavailable, never a measured compatibility pass. No user shell profiles or scripts run. |

`kernel-objects.cs` creates its own pipe/section/ALPC fixtures using the process's default DACL and reads only `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\CurrentBuildNumber`. It never enumerates application objects, connects to an existing `\\.\pipe\ave-mxc-*` pipe, creates registry keys or tests a host registry write. ALPC status/timeout or failed host baseline must stay unknown. ALPC signatures follow the [native API declarations](https://github.com/winsiderss/systeminformer/blob/master/phnt/include/ntlpcapi.h); Windows compilation and behavior still require the peer run.

## Verdicts, lifetime and retained temp data

Illustrative successful startup observation (not a result from this checkout):

```json
{"probe":"node-ui","verdict":"measured","details":[{"uiDisabled":true,"exitCode":0,"stdout":"{\"marker\":\"runtime-started\"}\n"},{"uiDisabled":false,"exitCode":0,"stdout":"{\"marker\":\"runtime-started\"}\n"}]}
```

`verdict: "measured"` (exit 0) means observations completed, **not** that every UI/shell combination worked or that confinement passed. Inspect every row's exit code, marker and stderr. `inconclusive`, `unavailable` and `error` exit 2. Native crash, missing dependency, session 0 and timeout cannot become success. SDK/native stdout diagnostics are captured by the outer driver so its public stdout remains one JSON line. Spawn passes one SDK argument and asserts telemetry is absent; no consent or telemetry calls are made.

Budgets are read from [the shared timeout policy](../../src/shared/tool-timeout-policy.ts); an unrecognized policy shape fails closed. SDK child deadlines use that policy. The lifecycle fixture deliberately omits a child deadline to measure disposal, while the independent driver retains an outer deadline. On ordinary completion each process is waited/disposed; exact pinned process handles may terminate **only the fixture child/grandchild** during lifetime cleanup. On a supervisor crash or outer deadline, descendant cleanup is unverified: retain the JSON error, confirm the fixture processes are gone on the peer and do not mark the gate passed. This toolkit does not yet provide the production kill-on-close supervisor job.

Temp directories are created automatically, intentionally retained for review and named in the verdict. `driver.json` records the supervisor PID/path/start time; `events.jsonl` records known SDK fixture PIDs, their commands and child/grandchild readiness before disposal. A crash before a journal entry can leave incomplete identity evidence. Read the journal, then independently compare PID, creation time, executable and command line with `Get-CimInstance Win32_Process`. For a missing entry, query command lines containing the **exact random temp-directory token** to identify only this run’s fixtures; do not infer ownership from an executable name alone. Shell-start commands also contain that token. Supervisor identity is checked against `driver.json`, not a broad process-name search. If identity/death cannot be proven, retain the run as inconclusive and do not automatically terminate an ambiguous PID. After exact fixture identity and termination are confirmed, remove only that exact `ave-mxc-probes-*` directory after confirming its helper/fixture processes have exited. No wildcard process kill, profile cleanup, ACL reset or deletion outside that directory is part of the probes. No production settings, secrets or project files are needed.

D2's identity route needs a separate approved disposable-machine prototype; these probes never create package identity or an administrator firewall rule. Native module-loading hardening, host/supervisor crash, production DLP/listener ownership and registry write-right testing remain release gates. An ordinary service-hosted CI job is not interactive evidence: use the dedicated desktop-session runner specified in the design.

Local, non-native checks:

```sh
node --test tools/mxc-probes/probe-common.test.mjs
node --check tools/mxc-probes/sdk-supervisor.mjs
```
