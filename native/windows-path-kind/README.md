# Windows folder classification

`path-kind.cpp` builds `ave-path-kind.exe`. Its drive mode prints the current
MS-DOS device mapping of one drive letter:

```text
ave-path-kind.exe C:   →  \Device\HarddiskVolume3
ave-path-kind.exe Z:   →  \Device\Mup\;LanmanRedirector\;Z:0000000000012345\server\share
ave-path-kind.exe S:   →  \??\C:\work\market        (a subst drive)
```

It calls `QueryDosDeviceW`, which reads the mapping from the object
manager's MS-DOS device namespace for this logon session and opens nothing on
the drive. A network drive's server is therefore never contacted. The
marketplace's folder input (design `multi-source-git-marketplace.md` §18.4.1
stage 2) decides what the mapping means: only `\Device\HarddiskVolume<n>`,
`\Device\CdRom<n>`, `\Device\Floppy<n>` and a `subst` drive whose target is
itself local are local. Anything else, a drive the OS has no mapping for
included, is a network folder, which asks for the `network-folder`
confirmation; a wrong guess only warns. `GetDriveTypeW` is not used: it takes
the drive's root path.

Exit codes: `0` the mapping was printed (UTF-8, one line); `1` the OS has no
mapping for the drive (the call failed, an unknown drive among them), with the
Windows error on stderr; `2` the argument is not a drive letter and colon; `3`
the mapping could not be written. Only `1` is an answer about the drive.

`src/main/windows-path-kind-launcher.ts` runs it, as
`src/main/windows-job-launcher.ts` runs the job helper. The build uses the
same script as the job helper and downloads nothing:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/build-windows-job.ps1 -Helper path-kind
node scripts/test-windows-path-kind.mjs
```

The test maps `C:` to a local volume, a `subst` drive to its target, and an
unused drive letter to exit `1` (fail closed). Installer `beforePack` builds
the matching architecture and packages only the executable outside ASAR. A
missing asset, a helper that cannot start, times out, or exits with anything
but `0` or `1`, or output that is not one line fails the folder input with
that cause: a broken install is reported, never guessed as a network folder.
The Windows CI job runs the test.

## Held directory operations

The held modes put a browser download where the user chose, remove staged
files, and manage recovery records. They use the
[held directory protocol](../macos-dir-ops/README.md). The directory arguments
use the legacy volume serial and 64-bit file index Node reports as `dev` and
`ino`, in decimal. File ownership operands and replies use the full
`FileIdInfo` volume serial in decimal and the full 128-bit file ID as exactly
32 lowercase hex digits, most significant digit first. The host stores file
IDs as decimal integers in recovery records. Birth and modification times
are creation and last-write ticks multiplied by 100, in decimal nanoseconds
since the system file-time epoch.

Each held directory is opened component by component from the volume root,
every component through the handle of the one above it (`NtCreateFile` with a
root directory, `FILE_OPEN_REPARSE_POINT`), and a link, junction or mount point
at any component is refused. The handles have traverse access and share read
and write but not delete, so neither the held directory nor any folder above it
can be renamed or removed until the mode ends; attribute-only handles would not
block that. Every file is opened, created exclusively and removed relative to
those handles. Renames submit native `FileRenameInformation` with
`RootDirectory` and a single component. Exclusive operations set
`ReplaceIfExists=FALSE` and hold the source without delete sharing.
Disposition uses the file's own handle.

Each mode sends `ready` after checking its directories. One `c` byte
authorizes the action. Other input or EOF stops it. The recovery modes are:

| Mode and operands after `<dir> <dir-dev> <dir-ino>` | Terminal replies |
| --- | --- |
| `--dir-list-records` | `records` with zero or more space-separated `<32 lowercase hex>.cleanup.json` names |
| `--dir-read <name> <max>` | `record <lowercase hex>` or `absent`, with a 1–8192 byte limit. Empty data is `record ` with its space. Over the limit is `failed EFBIG`. |
| `--dir-write-record <name> <hex>` | `written` after exclusive creation with a protected current-user DACL, write and sync. Maximum 8192 bytes. |
| `--dir-remove-id <name> <file-dev> <file-ino> [<birth-ns>:<fingerprint>]` | `removed`, `absent`, or `left` with an optional named leftover. A birth-only token uses `<birth-ns>:-`. |
| `--dir-restore <hidden> <part> <file-dev> <file-ino> <birth-ns>:<fingerprint>` | `restored` after verification and source retirement, `absent` if the source is missing, or `left` with an optional named leftover. |

A fingerprint is `<size>:<mtime-ns>:<head>:<tail>`. The digests are lowercase
SHA-256 of the first and last 64 KiB, each truncated to the file size. The
named leftover is
`left <hidden> <own-dev> <own-ino> <mismatch|remove-failed> <snapshot> [part-left]`.
The hidden name is `.<32 lowercase hex>.removing`. The snapshot is
`<dev>:<ino>:<birth-ns>:<fingerprint>` from the retained file handle, or `-`
when unavailable. `part-left` reports incomplete or unverified copy-back at
the original part name.

`--dir-copy` checks source and target before `ready`. Its exclusive create
can fail with plain `failed EEXIST`. On success it emits `writing <dev> <ino>`
from the open part handle before progress or `copied`. It reports progress
per 1 MiB chunk and flushes every 16 MiB. It keeps the handle open across
`copied` and checks the part's identity before exclusive rename and the
target's identity after rename. A post-rename mismatch triggers exclusive
rollback. Commit refusals are `refused target removed` when the part is gone,
`refused target left` with the optional named leftover when it remains, or
`refused target changed` if rollback fails. All use exit 3. Plain copy
refusals precede `ready`. An existing ordinary target is held and identified
before `ready`. After the second authorization the helper moves it exclusively
to a fresh hidden name, verifies it, commits exclusively, then verifies and
retires the old target. If commit fails, it restores the old target exclusively.
A failed restore or retirement sends `target-left left <hidden> <own-dev>
<own-ino> <verdict> <snapshot>` before the terminal reply, independent of
the copy part's outcome. It uses `mismatch` for a failed restore and
`remove-failed` for retirement after a verified commit. The identity is
from the old target's handle. The host records the leftover for recovery.

A stopped copy can suffix `cancelled` or
`failed <errno>` with the same leftover form. Success, cancellation and
recovery outcomes use exit 0, filesystem failures use exit 4, and usage
errors use exit 2. A failed native call may print its translated Windows
error and captured status in the one stderr diagnostic.

Cleanup moves a verified file handle exclusively to a fresh hidden name,
checks the hidden entry, and only then sets delete disposition. Restore
keeps the hidden source until the synced part is verified against its
still-open writing handle. A failed copy-back leaves both entries. If full
file identity or exclusive isolation is unavailable, the helper leaves
existing entries in place. The host retains an existing recovery record or
records the writing identity when available.

Accepted residual.

(a) the gap between the final fd verify and the unlink of a random hidden name; (b) anything after a verified restore or commit (the user's own act). Nothing else.

## OS system directory

`ave-path-kind.exe --system-directory` prints the result of
`GetSystemDirectoryW` as one UTF-8 line. This read-only query uses the OS API;
`SystemRoot`, `WINDIR`, and `PATH` cannot select its answer. The publisher
verifier uses this mode to locate the system signature-verification tool before
starting any candidate executable. The helper itself is a packaged host asset,
resolved from the composed host resources, with no command search.

The launcher runs this mode without a shell or inherited environment and applies
the shared global deadline. Missing helpers, query failures, malformed paths and
unexpected diagnostics fail clearly; there is no environment-derived alternative.
Exit `0` means one directory was printed, `2` means invalid arguments, `3` means
output failed, and `4` means the system query failed. Unlike drive mode, exit `1`
is never a directory answer. The native smoke compares the result with the runtime
system-directory API and repeats the query with spoofed system-root variables.

## Path and descriptor facts

`pin.h` owns normalization, component opens and handle lifetime for all path
modes. `dacl.h` owns the one handle-based security-descriptor read, shared
by facts serialization and the compatibility deny scan. Each component is
opened with `BACKUP_SEMANTICS | OPEN_REPARSE_POINT`,
read-attributes/read-control access and read sharing only. Handles remain open
through descriptor and optional content capture. No mode changes descriptors
or manages accounts.

`ave-path-kind.exe --pin <absolute-path>...` prints one JSON array row per
input, in input order. Each row has `exists`, `canonical`, `volumeSerial`,
`fileId`, `volumeSerialNumber`, `fileIndex`, `changeTime`, `attributes`,
`reparseTag`, `reparseTarget`, `directory`, and `ancestors` (root first,
excluding the target). Ancestors have the same component fields.
`changeTime` is `FILE_BASIC_INFO.ChangeTime` read on the pinned handle, as a
hex-64 string, or `null` when the object does not exist. It is captured at pin
time, before any DACL or content read on that handle, so a caller can key a
cache on volume serial, file ID and change time. Some filesystems report 0;
callers must not cache on a zero value. `reparseTarget` is the substitute name
read from the retained link handle, `null` for other objects. Canonical paths use
`GetFinalPathNameByHandleW(FILE_NAME_NORMALIZED | VOLUME_NAME_DOS)` and retain
the extended DOS prefix (`\\?\` or `\\?\UNC\`). They are case-preserving OS
names, not case-folded strings. Identity numbers are hexadecimal strings:
the full 64-bit `FileIdInfo` volume serial and 128-bit little-endian file ID,
plus the legacy 32-bit volume serial and 64-bit file index. On the tested
host Node bigint `dev` equals `volumeSerialNumber`, and `ino` equals
`fileIndex`; the full volume serial is different. The native tests compare
both `lstat` and `fstat` rather than assuming those aliases.

An opened reparse object is reported, including unfamiliar tags. The walk
never opens anything below it. Such unopened descendants have `exists:null`;
a missing component and its descendants have `exists:false`. Unopened and
missing components have null identity/canonical fields and zero attributes
and tag. Only `exists:true` carries observed metadata. Policy belongs to
`admitWindowsReparse` in `src/shared/windows-path-facts.ts`.

`ave-path-kind.exe --dacl [--parent] [--content] <absolute-path>...` adds
descriptor fields directly to each row (or `identity:null` for an
unopened/missing target), token context
`currentUserSid`, `elevated`, and a SID-keyed `principals` table for the two
local sandbox identities when installed. A descriptor contains
`{identity:{volumeSerial,fileId}, owner, group, protected, nullDacl,
aces:[{type,flags,mask,sid,account?}]}`. Resolved account labels are optional
display metadata. ACE order, flags and unsigned raw masks are
preserved; unknown ACE forms have a null SID so evaluators can fail closed.
Ordinary and object allow/deny forms expose their SID. Generic mapping and
trust decisions belong to the caller. The typed wrapper groups those wire
descriptor fields under `dacl` and validates that their identity matches the
pin before returning them.

`--parent` adds the immediate parent's descriptor, captured while both
objects are pinned. `--content` adds `contentHex`, read from the same target
handle with a one-MiB limit; this preserves the policy reader's protection
against concurrent replacement and writes. It reads files only and leaves
content null for reparse/unopened/missing objects. No link is followed.
Invalid options or an empty request return 2. Open/read failures return 4
without partial output; output failures return 3. Missing objects are data.
`--content` requests whose content exceeds 1,048,576 bytes exit with status 5 and write no partial output.
Relative paths, device namespace paths and alternate streams are refused.

`ave-path-kind.exe --dacl --parent --stdin` reads the parent DACL request
from a binary stdin frame. A little-endian u32 payload size precedes a u32
path count and one u32 byte length plus UTF-8 bytes per path. The helper
requires EOF immediately after the frame and validates every length and
UTF-8 operand before opening paths. It accepts up to 2,048 paths and a 1 MiB
payload. NULs, unpaired surrogate encodings, extra operands and incomplete
frames return 2. The 8 MiB JSON reply contains one ordered row per operand
with its exact original spelling in `requestPath`. Exceeding the output
budget returns 4 with no partial reply. The host checks the count and
each echoed operand before using the facts.

Build both facts modes with `scripts/build-windows-job.ps1 -Helper path-kind`
and run `scripts/test-windows-path-kind.mjs` and the shared facts Vitest suite.

## Compatibility deny evidence

`ave-path-kind.exe --deny-acls <SID> <absolute-path>...` returns a JSON array
of `{denyMask, inheritableMask, parentMask, directory}` rows. This compatibility
mode retains its original contract. The permission layer now evaluates the
same leading-deny rules over synchronous `--dacl` facts, so obligation capture,
read, stamp, verification, grant and publication cannot interleave with another
event-loop task.

The helper opens every path component with `OPEN_REPARSE_POINT` and
`BACKUP_SEMANTICS`, refuses reparse points, and holds the handles without write or delete
sharing while reading the target and parent security descriptors using
`GetSecurityInfo`. It never writes descriptors or manages accounts. Missing
targets return zero masks; any other open/read failure returns exit `4` and no
partial response. Invalid SID/request is exit `2`; output failure is exit `3`.

Only leading explicit ordinary deny ACEs count. The scan stops at the first
allow, inherited or unsupported ACE. Inherit-only ACEs do not protect the
object. Directory proof requires both object/container inheritance without
no-propagate. Parent proof uses the parent's own explicit leading deny mask.
Inherited denies after explicit allows cannot prove that access is denied.
Unsupported ACE forms conservatively supply no proof. Concurrent external DACL
changes and protected descendants remain point-in-time limitations.

The existing helper resource resolver, architecture build, installer packaging
and Windows CI build also cover this mode. Run
`src/permissions/__tests__/windows-deny-acl.test.ts` after building the helper;
the tests change DACLs only under per-test containers, with a synthetic SID.
# Policy pipe delivery

`--mxc-policy <pipe> <timeout-ms>` receives a little-endian byte length and
UTF-8 policy on private stdin, creates a first-instance, local-only pipe with
a protected current-user-only descriptor, and writes `ready` on stdout.
Four instances fill the fixed instance limit before readiness, so back-to-back
opens can connect while another instance waits for binding or disconnects.
The caller then sends the launched client's little-endian PID and keeps stdin
open for ownership. The helper retains a process handle and checks each
connection's kernel-reported PID before serving the policy. Rejected clients
receive no bytes and consume no reads. An atomic budget of two accepted
connections accommodates an existence check followed by the policy read.
Owner EOF, deadline or release closes the server. Rebuild the existing helper
after changing its source.
