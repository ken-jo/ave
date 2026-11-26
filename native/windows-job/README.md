# Windows background process ownership

`launcher.cpp` owns an unnamed kill-on-close Job Object. The command joins the
job atomically during creation, receives ordinary stdout/stderr pipes and NUL
stdin, and inherits the caller's prepared environment and working directory.
The helper's stdin is a private owner-lifetime pipe. Closing it or terminating
the helper kills the job. The job handle is non-inheritable. Root command exit also closes the job and returns the
root exit code. Descendants cannot opt out of job inheritance through the job's
breakaway flags. This is lifecycle ownership, not an OS security sandbox.
Guest Linux processes are outside this Windows job. The Bash tool rejects
background mode unless discovery positively identifies a native interpreter.
WSL-backed and unknown interpreters are refused before starting the command;
distribution-wide termination would also affect unrelated work.

CI test steps use `--receipt <absolute path>` through
`.github/scripts/run-in-job.mjs`, which first registers the step's manifest id
and job-root identity in that receipt. The launcher opens the existing receipt
for append before the command starts and refuses a missing one. When the root
command exits or the owner closes stdin, it terminates the job and waits up to
5 seconds for the job to report zero active processes. Only then does it append
`0`. A job query failure or survivor exits 125 with no verdict appended, and
job-root cleanup refuses the root.

`--hold` ties the command to a working-directory hold helper
(`ave-path-kind.exe --hold`). The launcher's fourth standard handle is the
channel to that helper and its fifth takes the verdict; without both it exits
125 and starts nothing. It names itself to the helper (`AVH2` and its process
id), signals the event the helper duplicated into it, and starts the command
only after the helper has placed the launcher in the helper's kill-on-close
job, so the command and everything it starts are born inside it. The command
gets a NUL stdin; the launcher's own stdin is the owner's stop request. When
the root exits or the owner closes stdin, the launcher terminates its own job
(nested in the hold job), proves it empty and asks the helper to recheck the
held directory (`AVHQ`). It then writes exactly one record on the verdict
handle and exits:

| Record | Exit | Meaning |
| --- | --- | --- |
| `AVJ1 ok <code> <0\|1>` | the command's code (130 after a stop request) | job proven empty and directory confirmed; the flag says whether processes other than console hosts were stopped |
| `AVJ1 lost` | 125 | the hold was refused, or the directory no longer stands |
| `AVJ1 unconfirmed` | 125 | the job was not proven empty, or the recheck got no answer |

Admission and teardown each have a 10-second deadline, which ends the run with
`lost` and `unconfirmed` respectively whatever is stalled. The exit code alone
is not the signal: the host accepts only the exact record with its matching
exit code and treats everything else as unconfirmed. Neither job allows
breakaway.

Call `spawnWindowsJobProcess` with an absolute executable path already selected
by the shell resolver. Keep its stdin open until disposal; never expose that pipe
as command input. The helper forwards the original command-line tail without
re-quoting. Internal launch failures print a diagnostic and exit 125; owner EOF
exits 130. A command can itself return those codes, so use the diagnostic to
identify launcher failures rather than interpreting the code alone.

For local Windows development, run `bun run build:windows-job` before executing
background commands. Building requires installed C++ build tools and a Windows
SDK; the build script downloads nothing. `-Arch arm64` supports the corresponding
installed cross tools. Installer `beforePack` always rebuilds the matching
architecture and packages only its executable outside ASAR. Missing assets fail
clearly at launch. No process-tree fallback is available. Windows 10 or newer is required for atomic
job assignment; unsupported APIs fail the launch. If root exit and owner EOF are
both observed, root exit takes precedence. Returned PID and process events belong
to the helper, and `kill()` terminates the entire job.

Native verification from the repository root:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/build-windows-job.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/build-windows-job.ps1 -FailureFixture
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/build-windows-job.ps1 -QueryFailureFixture
node scripts/test-windows-job.mjs
```

The failure fixture is a separate executable compiled with an invalid job handle;
the query failure fixture cannot query its job after termination. Neither is packaged. Tests launch only owned synthetic processes, check their
actual OS lifetime after disposal, and exercise the installed Bash executable.
The gate also builds twice from a path containing Unicode, spaces, and literal
percent signs, compares binary hashes, and executes that output. Test cleanup
waits for owned process handles to close before removing fixtures. The Windows
CI job runs this gate. Performance output reports median command
latency and helper working set as observations, without a machine-specific budget.
