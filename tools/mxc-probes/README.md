# Windows container prototype measurements

Run these before implementing the [extension migration](../../docs/design/windows-extensions-mxc.md#prototype-gate). Each of the five entry scripts prints **one JSON line** to stdout. They measure prerequisites, not a passing production sandbox. The toolkit performs no explicit persistent package/service/firewall/ACL installation. Its own file writes, compiled helper paths, HOME/LOCALAPPDATA/TEMP environment values and retained evidence are directed to a fresh OS temp directory. OS/SDK-managed effects are separate: host Windows PowerShell 5.1 compilation may populate StartupProfileData or ModuleAnalysisCache under the real known-folder profile despite environment overrides, and PSEC applies privileged per-container WFP and WinHTTP proxy state. The toolkit does not promise that these managed writes/state changes stay under temp or attempt profile-cache cleanup. The local HTTP proxy refuses every request and makes no upstream connections. Kernel fixtures are ephemeral, uniquely named, and never open live Ave pipes or change the registry.

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

The driver is standalone Node; `--runtime` is the child being measured. Environment is stripped and `ELECTRON_RUN_AS_NODE=1` is set for the child, so an electron.exe path tests its Node mode. Repeat loopback/lifetime/object probes with standalone Node when comparing runtimes. Architecture follows the driver; use an arm64 driver and matching staged SDK/runtime for arm64 evidence. Native PowerShell fixture compilation uses the source copied into that run's temp directory and explicitly references System.dll (including Regex) and System.Core.dll (Pipes/MemoryMappedFiles); the other helper types use implicitly referenced mscorlib. PowerShell's own cache writes are OS/runtime-managed effects, not confined by those output paths. Do not point `--runtime` at an installer or an untrusted executable.

Record OS build (`[Environment]::OSVersion.Version`), exact driver/runtime paths and hashes (`Get-FileHash -Algorithm SHA256`), session, architecture and each JSON line in the review evidence. `observation.node` is the driver's bundled version; the `runtime-started` child record identifies the child runtime. The request uses a fresh cwd/HOME/temp, explicit runtime/SystemRoot reads and a temp-only write root. These intentionally generous diagnostic read roots do not certify production filesystem policy.

## Ancestor-query rerun

The Windows peer's f19e1dc87 run reached Node's main-module realpath with UI enabled but failed at `lstat D:\` before executing the script. The request now retains leaf file read/write grants and adds only their uncovered ancestors under SDK `containment.config.filesystem.enumeratePaths`. This is query/list access, **not** file-content read access or invisible traversal; it can expose names/metadata. Whether fs_enumerate cascades into subdirectories is unverified. With default tmpdir under the real user profile, granting its ancestors may expose sibling names/metadata under that profile and its parents even though HOME is redirected. Prefer a dedicated staging/temp tree and test descendant name reach separately. It requires native PSEC 1.1 enumeration support. The exact list appears in `observation.filesystemPolicy` when all attempted launches use one policy, and in `observation.filesystemPolicies` for every distinct attempted policy (the singular field is null before a launch or for a mixed set). Ordinary rows and the lifetime/kernel peer rows carry their actual `filesystemPolicy`; kernel/shell native commands report `entryVariant:"native-command"`, while runtime file entries report `"script-file"`. Extra Git runtime roots can make shell policies differ. These fields describe requested policy, not effective enumeration scope; `driveRootRead:false` records that no root file-read grant was requested. Runtime/data staging directly at a drive root is refused. Unsupported enumeration produces an inconclusive/error result before spawn; there is no broad drive-root read fallback. See [the design finding](../../docs/design/windows-extensions-mxc.md#ancestor-query-access-for-entry-resolution) and [the pinned schema](https://github.com/microsoft/mxc/blob/fda29ac63bc306b7f97f3b86b4b63d44f7f40cf2/docs/schema.md#L382-L420).

The public SDK supports this narrow form, so no Node-side `--preserve-symlinks-main` or `-e`/stdin workaround is selected. The child and grandchild still execute the same file payload. The ca22a44ab peer rerun started the UI-enabled runtime successfully with the revised policy and identical before/after host DACL snapshots. Same-container loopback was denied (EACCES), disproving D1 option 1 under this proxy policy; child and grandchild were independently confirmed dead after dispose. See [the measured results](../../docs/design/windows-extensions-mxc.md#windows-peer-results-at-ca22a44ab). These are one-host observations, not packaged production acceptance.

From the repository root in the same interactive standard-user session, reuse the peer's absolute `$Electron` and `$Sdk` paths (Electron 45.2.1 is both driver and runtime):

```powershell
$env:ELECTRON_RUN_AS_NODE = '1'
& $Electron tools/mxc-probes/node-ui.mjs --sdk-root $Sdk --runtime $Electron
& $Electron tools/mxc-probes/loopback.mjs --sdk-root $Sdk --runtime $Electron
& $Electron tools/mxc-probes/stdio-lifetime.mjs --sdk-root $Sdk --runtime $Electron
```

D3 is resolved to UI enabled by the [reported results](../../docs/design/windows-extensions-mxc.md#windows-peer-results-at-f19e1dc87). Node-ui and loopback retain both UI rows as controls; judge the revised entry/loopback measurements using the UI-enabled row. Lifetime uses UI enabled. UI-disabled exit `0x80000003` and Bash failures remain expected observations, not an invitation to broaden filesystem grants. Git Bash hooks stay on their independently admitted srt-win/shell-plan route.

## What each probe means

| Entry | Measurement | Interpretation |
| --- | --- | --- |
| `node-ui.mjs` | Actual child starts with UI disabled and enabled | ca22a44ab: UI-enabled exit 0 and `runtime-started` cleared the tested entry-resolution case. Retain UI-disabled failure as a control for the resolved D3 decision; never retry an admitted holder under another backend. |
| `loopback.mjs` | A listener and client **inside the same container**, under identity-less proxy mode, with both UI settings | ca22a44ab: UI-enabled runtime started, then connect failed EACCES; the D1 option 1 bridge is disproven under this policy. Preserve this negative control; D1 now recommends contract-versioned stdio. A start error alone remains inconclusive about loopback. |
| `stdio-lifetime.mjs` | Long-lived child + grandchild, stdin held open, then SDK `dispose()` | Before either process becomes eligible for cleanup termination, query its creation time and full image path through the opened handle: parent must postdate the launch lower bound, grandchild must postdate the parent, and both images must match the resolved runtime path. A fresh nonce over the owned child/grandchild pipes excludes same-runtime PID reuse after launch; the challenge is bounded by the shared I/O budget, and a failure/deadline closes candidates without termination. This assumes the toolkit-owned fixture faithfully forwards the nonce and its own PIDs, not that arbitrary extension output authenticates an OS identity; any mismatch/query/challenge failure closes candidate handles without terminating them and reports inconclusive. Verified process objects are pinned before disposal. Independently observe both signaled; SDK wait rejection does not count. Report pre-cleanup observations even when exact-handle cleanup must terminate survivors. ca22a44ab passed the dispose observation with both processes dead and tracked cleanup verified. This is not the main-crash/job test. |
| `kernel-objects.mjs` | Unique `ave-mxc-probe-*` pipes, named sections, ALPC ports; benign registry query; host and cross-holder reach | Compare a successful same-user host baseline with container→host, container→peer and host→container. Raw NTSTATUS/HRESULT is evidence, not automatically “denied.” Default-DACL fixture results do not generalize to other objects. Always inconclusive for the full security contract: registry writes, explicit-DACL variants and production control-pipe authentication remain separate tests. |
| `shell-ui.mjs` | System PowerShell 5.1 and explicitly supplied Git Bash, both UI settings | Check the actual `probe-shell-started` marker and exit status. Git Bash is expected to fail under the current policy. Missing Bash is unavailable, never a measured compatibility pass. No user shell profiles or scripts run. |

`kernel-objects.cs` creates its own pipe/section/ALPC fixtures using the process's default DACL and reads only `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\CurrentBuildNumber`. It never enumerates application objects, connects to an existing `\\.\pipe\ave-mxc-*` pipe, creates registry keys or tests a host registry write. ALPC status/timeout or failed host baseline must stay unknown. ALPC signatures follow the [native API declarations](https://github.com/winsiderss/systeminformer/blob/master/phnt/include/ntlpcapi.h); Windows compilation and behavior still require the peer run.

## Verdicts, lifetime and retained temp data

Abbreviated UI rows matching the ca22a44ab measured outcome (full metadata omitted here):

```json
{"probe":"node-ui","verdict":"measured","details":[{"uiDisabled":true,"exitHex":"0x80000003","stdout":""},{"uiDisabled":false,"exitCode":0,"stdout":"{\"marker\":\"runtime-started\"}\n"}]}
```

`verdict: "measured"` (exit 0) means observations completed, **not** that every UI/shell combination worked or that confinement passed. Inspect every row's exit code, marker and stderr. `inconclusive`, `unavailable` and `error` exit 2. Native crash, missing dependency, session 0 and timeout (including SDK WaitResult.timedOut) cannot become success. A session-0 prerequisite failure is unavailable; in a verified interactive session, UI-disabled `0xC0000142` remains D3 startup evidence, not an automatic unavailable-host classification. SDK/native stdout diagnostics are captured by the outer driver so its public stdout remains one JSON line. Spawn passes one SDK argument and asserts telemetry is absent; no consent or telemetry calls are made.

Budgets are read from [the shared timeout policy](../../src/shared/tool-timeout-policy.ts); an unrecognized policy shape fails closed. SDK child deadlines use that policy. The lifecycle fixture deliberately omits a child deadline to measure disposal, while the independent driver retains an outer deadline. On ordinary completion each process is waited/disposed; exact pinned process handles may terminate **only the fixture child/grandchild** during lifetime cleanup. On a supervisor crash or outer deadline, descendant cleanup is unverified: retain the JSON error, confirm the fixture processes are gone on the peer and do not mark the gate passed. This toolkit does not yet provide the production kill-on-close supervisor job.

Temp directories are created automatically, intentionally retained for review and named in the verdict. `driver.json` records the supervisor PID/path/start time; `events.jsonl` records known SDK fixture PIDs, their commands and child/grandchild readiness before disposal. A crash before a journal entry can leave incomplete identity evidence. Read the journal, then independently compare PID, creation time, executable and command line with `Get-CimInstance Win32_Process`. For a missing entry, query command lines containing the **exact random temp-directory token** to identify only this run’s fixtures; do not infer ownership from an executable name alone. Shell-start commands also contain that token. Supervisor identity is checked against `driver.json`, not a broad process-name search. If identity/death cannot be proven, retain the run as inconclusive and do not automatically terminate an ambiguous PID. After exact fixture identity and termination are confirmed, remove only that exact `ave-mxc-probes-*` directory after confirming its helper/fixture processes have exited. No wildcard process kill, profile cleanup, ACL reset or deletion outside that directory is part of the probes. No production settings, secrets or project files are needed.

D2's identity route needs a separate approved disposable-machine prototype; these probes never create package identity or an administrator firewall rule. Native module-loading hardening, host/supervisor crash, production DLP/listener ownership and registry write-right testing remain release gates. An ordinary service-hosted CI job is not interactive evidence: use the dedicated desktop-session runner specified in the design.

Local, non-native checks:

```sh
node --test tools/mxc-probes/probe-common.test.mjs tools/mxc-probes/process-lifecycle.test.mjs tools/mxc-probes/filesystem-policy.test.mjs
node --check tools/mxc-probes/sdk-supervisor.mjs
```
