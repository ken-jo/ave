# Windows folder classification

`path-kind.cpp` builds `ave-path-kind.exe`, which prints the current MS-DOS
device mapping of one drive letter and does nothing else:

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
itself local are local. Anything else, a failed call included, is a network
folder, which asks for the `network-folder` confirmation; a wrong guess only
warns. `GetDriveTypeW` is not used: it takes the drive's root path.

Exit codes: `0` the mapping was printed (UTF-8, one line); `1` the call failed,
an unknown drive among them, with the Windows error on stderr; `2` the
argument is not a drive letter and colon.

`src/main/windows-path-kind-launcher.ts` runs it, as
`src/main/windows-job-launcher.ts` runs the job helper. The build uses the
same script as the job helper and downloads nothing:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/build-windows-job.ps1 -Helper path-kind
node scripts/test-windows-path-kind.mjs
```

The test maps `C:` to a local volume, a `subst` drive to its target, and an
unused drive letter to a failure (fail closed). Installer `beforePack` builds
the matching architecture and packages only the executable outside ASAR; a
missing asset fails the classification, which the folder input treats as a
network folder. The Windows CI job runs the test.
