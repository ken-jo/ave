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
`ino`, in decimal. Every file operand and reply is an evidence token
`<dev>:<id>:<class>:<value>`: the full `FileIdInfo` volume serial in decimal,
the full 128-bit file ID as exactly 32 lowercase hex digits (most significant
first), and evidence for that ID. The host stores IDs as decimal integers and
the evidence as `<class>:<value>` in recovery records. Modification times are
last-write ticks multiplied by 100, in decimal nanoseconds since the system
file-time epoch.

### Evidence classes

| Class | Value | Proves | Does not prove |
| --- | --- | --- | --- |
| `creation` (the only class this helper emits or accepts) | creation ticks ×100, nonzero | The entry is the file that had this ID and creation time when stamped. A file ID reused after deletion gets a new creation time, so ID reuse alone does not match. | A process with `FILE_WRITE_ATTRIBUTES` can set `CreationTime` (`SetFileTime`) on another file that later takes the same ID. Name tunnelling gives a file created under a recently deleted name that name's creation time, so a tunnelled file at a reused ID can match. Volumes without stable file IDs (FAT, exFAT) are refused before any action because their IDs derive from directory position. |
| `birth` (host, POSIX hosts) | `st_birthtime` ns, nonzero | As `creation`, where the file system records birth time. | Set by anyone who can change the file's times on file systems that allow it; absent on file systems without birth time, where the identity stays unresolved. |
| `fingerprint` (host) | `<size>:<mtime-ns>:<head>:<tail>` | The file has these bytes at both ends, this size and this modification time. | The middle of the file, or a rewrite that restores size, ends and mtime. |

Name tunnelling also changes a file's own creation time when it is renamed:
on a volume that tunnels (the system volume by default), a file renamed onto a
name another file left within about 15 seconds takes that file's creation
time. Checking a moved name by ID and creation time therefore refused
replacements and commits that had happened. Every rename now checks the
moved name by the held handle's file ID and volume, and reads the creation
time again from that handle; the copy and rename report it as
`published <token>`, which the host records before it resolves its record.
A record written before the commit rename is recovered with
`--renamed-writer`.

Tokens match exactly: same volume, same ID, same class and same value. A
class the reader does not know, a wildcard, `none`, or an empty value is
unresolved and matches nothing. This helper treats every class other than
`creation` as unresolved, so such a token leaves the entry in place. A
malformed token is a usage error (exit 2). A record written by an older
release whose identities carry no token is kept for inspection and never
trusted to move, restore or remove anything.

The session volume is asserted only by the helper: the host checks that each
announced token's volume equals the one in `destination-id`, but only the
helper's handles bind that serial to the held directories.

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
Disposition uses the file's own handle. A delete-pending entry remains
unresolved until a probe after handle closure observes its absence.
A direct rename to an existing regular target answers `replace`. The host
then uses the journaled copy and publication protocol.

Each mode sends `ready` after checking its directories. One `c` byte
authorizes the action. Other input or EOF stops it. The recovery modes are:

| Mode and operands after `<dir> <dir-dev> <dir-ino>` | Terminal replies |
| --- | --- |
| `--dir-list-records` | `records` with zero or more space-separated `<32 lowercase hex>.cleanup.json` names |
| `--dir-read <name> <max>` | `record <lowercase hex>` or `absent`, with a 1–8192 byte limit. Empty data is `record ` with its space. Over the limit is `failed EFBIG`. |
| `--dir-sweep-record <name> <max>` | Holds the record through its `record <token> <hex>` classification frame. A second authorization removes the entry only if the held record's full stamp and digest still match. Replies `removed`, `kept`, or `absent`. |
| `--dir-write-record <name> <hex>` | `written <token>` after exclusive creation with a protected current-user DACL, write, sync and verification. Maximum 8192 bytes. |
| `--dir-remove-record <name> --expect <token> --length <n> --digest <sha256>` | `removed` after observed absence or `kept` if verification or removal remains incomplete. An already absent entry replies `absent`. |
| `--dir-remove-id <name> --expect <token> [--content <fingerprint>]` | `removed`, `absent`, or `left` with an optional named leftover. |
| `--dir-restore <hidden> <part> --expect <token> --content <fingerprint>` | `restored` after verification and source retirement, `absent` if the source is missing, or `left` with an optional named leftover. |
| `--dir-restore-target <hidden> <target> --expect <token> [--content <fingerprint>] [--writer <token> \| --renamed-writer <token> \| --retire]` | `resolved` after verified rollback or retirement, or `left` if unresolved. The writer must share the old file's volume and differ in ID. `--writer` is the identity published after the commit and matches in full; `--renamed-writer` is the identity recorded before the commit rename and matches the target by file ID and volume alone. `--retire` retries a verified commit recorded by an older release. |

Options follow the positional operands in any order; a repeated, unknown or
valueless option is a usage error. The staged-file modes are:

| Mode and operands | Terminal replies |
| --- | --- |
| `--dir-rename <dir…> <name> <to…> <target> --expect <token>` | `committed` after `published <token>`, `cross-volume`, `replace`, or `refused source` (exit 3) when the source is not the staged file. |
| `--dir-remove <dir…> <name> --expect <token>` | `removed`, `absent`, or `refused source` (exit 3) when the entry is not the staged file. |
| `--dir-stamp <dir…> <name>` | `stamp <token>` of the regular file at the name, `absent`, or `refused source` for another kind of entry. |
| `--dir-sweep <dir…> [--keep-records]` | `swept <n>`. Each entry is removed only if it still has the stamp the listing reported for it. |

The host stamps a completed download once and passes that token to every later
rename and removal of the staged file. A cancelled or interrupted download is
stamped just before its removal.

A fingerprint is `<size>:<mtime-ns>:<head>:<tail>`. The digests are lowercase
SHA-256 of the first and last 64 KiB, each truncated to the file size. The
named leftover is
`left <hidden> <own-token> <mismatch|remove-failed> <snapshot> [part-left]`.
The hidden name is `.<32 lowercase hex>.removing`. The snapshot is
`<token>/<fingerprint>` from the retained file handle, or `-` when
unavailable. `part-left` reports incomplete or unverified copy-back at the
original part name.

`--dir-copy` takes the hidden name after the part name and checks source
and target before `ready`. A destination volume without
`FILE_SUPPORTS_OPEN_BY_FILE_ID` (FAT, exFAT, and network shares that do
not offer it) is `refused volume` before `ready`, and one whose volume
information cannot be read is `refused volume-unknown`. It emits
`destination-id <token>` from the held destination directory and uses the full
volume serial to bind all subsequent file identities. Its exclusive create
can fail with plain `failed EEXIST`. On success it emits `writing <token>`
from the open part handle before progress or `copied`. It reports progress
per 1 MiB chunk and flushes every 16 MiB. It keeps the handle open across
`copied` and checks the part's identity before exclusive rename and the
target's file ID and volume after rename, then emits `published <token>` with
the creation time the committed file has at the target. A post-rename mismatch triggers exclusive
rollback. Commit refusals are `refused target removed` when the part is gone,
`refused target left` with the optional named leftover when it remains, or
`refused target changed` if rollback fails. All use exit 3. Plain copy
refusals precede `ready`. An existing ordinary target is held and identified
before `ready` and announced as `target-id <token>`. For a replacement,
the helper reads the final stamp from the writing handle after syncing and
emits `copy-id <token>` before `copied`. The host refuses a `copy-id` that
differs from `writing` and keeps the first identity for cleanup. After
the second authorization the helper moves it exclusively to the supplied hidden name, verifies it, commits exclusively, then verifies and
retires the old target. If commit fails, it restores the old target exclusively.
A failed restore or retirement sends `target-left left <hidden> <own-token>
<verdict> <snapshot>` before the terminal reply, independent of
the copy part's outcome. It uses `mismatch` for a failed restore and
`remove-failed` for unconfirmed retirement after a verified commit, including
a delete-pending file held open by a reader. The identity is
from the old target's handle. A verified restore or retirement emits
`target-restored` or `target-retired` before the terminal reply. The host
keeps the write-ahead record when the outcome is unavailable.

A stopped copy can suffix `cancelled` or
`failed <errno>` with the same leftover form. Success, cancellation and
recovery outcomes use exit 0, filesystem failures use exit 4, and usage
errors use exit 2. A failed native call may print its translated Windows
error and captured status in the one stderr diagnostic.

Cleanup verifies the file's stamp on a handle opened without delete sharing,
sets disposition on that handle, closes it, and checks that its name is absent.
A pending part keeps its recorded name and returns `left remove-failed`. Restore
keeps the hidden source until the synced part is verified against its
still-open writing handle. A failed copy-back leaves both entries. If full
file identity or exclusive isolation is unavailable, the helper leaves
existing entries in place. The host retains an existing recovery record or
records the writing identity when available.

I1. The host touches part, hidden and record entries only through held
directory operations.

I2. The part's identity comes only from the writing handle.

I3. Destructive cleanup requires exclusive isolation and handle
verification. If that proof is unavailable, cleanup leaves and records
the entry.

I4. A displaced original moves only by identity-preserving rename. Startup
uses the separate target recovery operation for its record. Copy-back applies
only to copy-part recovery.

I5. Before authorizing isolation, the host syncs a record containing the
hidden name, the original and writer identities, and the copy session.
Startup reads target records first. A target matching the writer confirms
commit and any remaining hidden original is retired by identity. An absent
hidden entry and a target matching the original confirm rollback. A vacant
target permits exclusive restoration of the verified hidden original.
Other observations keep the record and are logged. The recorded part is
removed by identity before the record is removed. The general boot sweep
preserves record names after this recovery pass.

I6. The copy session binds the old target identity captured before ready
and the writing identity from the part handle. A target leftover must
match the authorized original and hidden name on the held destination volume.
A named copy-part leftover must carry the writing identity.

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

## Held working directory

`ave-path-kind.exe --hold <directory> --pipe \\.\pipe\ave-hold-<id>` pins the
directory and every ancestor (traverse access, read and write sharing, no
delete sharing), writes the `--pin` row in binary mode (at most 8 MiB on the
wire, LF included), and keeps the handles until stdin closes. It also owns the
only handle to a kill-on-close job. The handle is not inheritable, and the
helper starts no processes. The pipe admits only the current user and is a
message pipe, so a frame is one write. After the row, the host writes the job
launcher's process id (4 bytes) to stdin; the helper waits at most 30 seconds
for it and accepts it only for a process with the helper's own parent, created
after the helper. It serves one client, and only that live launcher. The
connection and the frame each have a 10-second deadline, and every pipe
operation also ends when the launcher exits; an operation the system does not
cancel ends the helper. The client sends one 8-byte message, `AVH1` and a
process id; a longer or shorter message, or a process that is not the
launcher's own newer child, is refused (`F`, then the pipe closes). Otherwise
the helper assigns that process to the job (nested in any job it already has)
and answers `A`. When that process or the launcher exits, the helper notes
whether anything besides console hosts is still running, terminates the job,
waits up to 5 seconds for it to be empty, rechecks every held handle and
reopens the leaf by name without following links (same file id, not a reparse
point), and answers `R`, or `X` when any of that fails. The launcher has 5
seconds to answer `K` once its own job is proven empty. The helper then writes
one stdout line: `{"outcome":"reaped","stopped":<bool>}` after `R` and `K`, or
after `R` to a launcher that has already exited; `{"outcome":"unconfirmed"}`
when the job was not proven empty or the launcher answered anything but `K`;
else `{"outcome":"lost"}`. The helper's exit closes the job, which stops
everything in it.

Build `-Helper path-kind -HoldFixture` for `ave-path-kind-hold-fixture.exe`,
which is never packaged. It reads the reply limit from
`AVE_TEST_HOLD_REPLY_LIMIT` and, with `AVE_TEST_HOLD_EXIT_BEFORE_REAP` set,
exits after the command instead of answering `R`. With
`AVE_TEST_HOLD_UNCONFIRMED` set it skips the reap and reports the job
unconfirmed. After the launcher id, an
`L` on stdin prints the job's member process ids as one JSON line on stderr.
`--breakaway <executable>` tries to start that executable outside every job and
prints `breakaway refused <error>` (exit 0) or `breakaway allowed` (exit 1).

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
