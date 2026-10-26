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

## Deny DACL evidence

`ave-path-kind.exe --deny-acls <SID> <absolute-path>...` returns a JSON array
of `{denyMask, inheritableMask, parentMask, directory}` rows. The permission
layer calls it synchronously so obligation capture, read, stamp, verification,
grant and publication cannot interleave with another event-loop task.

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
