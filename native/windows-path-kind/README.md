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
Relative paths, device namespace paths and alternate streams are refused.

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
