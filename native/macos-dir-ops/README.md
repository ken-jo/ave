# Held directory operations

`dir-ops.c` builds `ave-dir-ops`, the macOS helper that puts a browser
download where the user chose and removes staged files. Node has no
`openat`/`renameat`/`unlinkat`, and macOS has no path that names an open
directory, so the host cannot do these steps itself without naming files by a
path that could be swapped after it was checked. `native/windows-path-kind`
implements the same modes in `ave-path-kind.exe` (`dir-ops.h`); Linux does
them in process through `/proc/self/fd`
(`src/main/browser/browser-download-files.ts`).

Each mode opens its directories with `O_DIRECTORY | O_NOFOLLOW`, checks that
each is a directory whose device and inode are the ones given (the identity
the host verified or bound), and from then on names every file relative to
those descriptors. A directory moved, or replaced by a link, after that check
changes nothing the mode does: it still acts in the directory it checked.

## Modes

```text
ave-dir-ops --dir-rename <from> <dev> <ino> <name> <to> <dev> <ino> <target>
ave-dir-ops --dir-copy   <from> <dev> <ino> <name> <to> <dev> <ino> <target> <part>
ave-dir-ops --dir-remove <dir> <dev> <ino> <name>
ave-dir-ops --dir-sweep  <dir> <dev> <ino>
```

Names are single path components. `rename` moves the ordinary file `name` to
`target`, replacing an ordinary file there; across volumes it moves nothing
and answers `cross-volume`. `copy` creates `part` exclusively, never through a
link, copies `name` into it, syncs it and renames it to `target`; that rename
is the commit point. `remove` unlinks a file or link. `sweep` removes every
file and link directly in the directory and nothing else.

## Protocol

The helper writes one line per step to stdout and reads its answers from
stdin.

- `ready`: the directories are held and checked, and nothing has changed yet.
  `copied`: the copy is complete and synced under `part`, before the commit.
  At each, one `c` byte proceeds; any other byte, or the end of input, stops
  the mode, removing anything it made.
- While a copy writes, the caller writes nothing: input that arrives, or the
  end of input, stops the copy and removes `part`. After each 1 MiB chunk the
  copy writes `progress <bytes copied>`, and it syncs `part` every 16 MiB, so
  the final sync before `copied` stays short.
- The last line is the outcome. Exit `0`: `committed`, `cancelled`,
  `cross-volume`, `removed`, `absent` or `swept <n>`. Exit `3`: `refused
  from|to|source|target`, when a directory is not the checked one (gone,
  unreadable, a link, or another directory at its path), the source is not an
  ordinary file, or `target` holds something other than an ordinary file.
  Exit `4`: `failed <errno name>`. Exit `2`: the arguments are wrong.
- A copy that stops after creating `part` (cancelled, failed, or refused
  `target` at the commit) removes it only as the file it wrote, never by its
  name alone. It keeps a descriptor of its own on the file it writes,
  renames `part` exclusively (`RENAME_EXCL`) to a fresh hidden name in the
  same folder, `.<32 hex digits>.removing`, checks there that the entry has
  the device and inode that descriptor has, and only then removes it under
  that name. A file found there that is not the one written goes back to
  `part` exclusively, or stays under the hidden name when `part` is taken
  again. A volume without an exclusive rename (exFAT, FAT: `ENOTSUP` or
  `EINVAL`) is checked that the hidden name is free and renamed to it
  plainly. There the file is removed only when its device and inode and its
  content both match: the same size, and the same first and last 64 KiB read
  through a new `O_NOFOLLOW` descriptor and through the copy's own. A file
  that does not match is put back by copying it to a new file created
  exclusively at `part`, synced before the hidden name is removed, or stays
  under the hidden name when `part` is taken or the copy fails. The identity
  is read through the descriptor at the cleanup, not when the file is
  created: exFAT gives a new file its lasting inode only once it is
  written. When the file is not removed (it is
  not the one written, it cannot be moved aside, or its removal fails), the
  outcome ends with ` left`, or ` left <hidden name>` when a file stays under
  that name: `cancelled left` (exit `0`), `failed <errno name> left` (exit
  `4`), `refused target left` (exit `3`). The host reports such a copy's
  temporary file as left and does not record it for the next start. Only
  `--dir-copy` answers this way; `native/windows-path-kind` removes `part`
  through the handle it wrote it with and never does.
- A `failed <errno name>` answer may have one stderr diagnostic,
  `Windows error <decimal code>` followed by LF or CRLF. The two pipes can
  deliver in either order, including fragmented writes. The diagnostic is
  accepted only with a failed answer. Normal exit must have status `4`;
  the confirmed-kill rule below retains a validated answer after termination.
  Diagnostics are validated at pipe closure or the existing termination
  ceiling and never renew liveness. Any other stderr accompanying an outcome
  is invalid.

## When the helper stops answering

The host uses `browserDownloadHelperStallMs` in
`src/shared/tool-timeout-policy.ts` as its liveness bound. Steps must arrive
in mode order within that bound; only advancing progress while an authorized
copy is copying renews it. A stop or terminal outcome fixes the deadline to
exit. Any stdout byte after the terminal outcome is a protocol violation, including
an incomplete line. A violation or expired deadline triggers termination.
The host requests termination and confirms exit within `processTreeKillMs` or
`windowsProcessTreeKillMs`, counted from the kill request even if that request
does not finish. No later step is authorized. A valid outcome printed before
a confirmed kill is retained only when the protocol stayed valid.

The boot sweep uses the same asynchronous lifecycle. Initialization awaits it
before bootstrap, and downloads stay refused if termination is unconfirmed;
no normal staging runs beside a possibly live sweep. Unexpected installer
errors permit startup to continue only after the download-refusal handler is
registered. An incomplete policy install fails through the normal startup
error handler.

A copy killed or answering invalidly after `ready` may leave `part` in the
chosen folder. The next start sweeps only the
staging folder, so the host removes `part` itself, at once, but only as the
file the helper wrote: it keeps the identity `part` had while the helper
wrote it (taken at its first `progress` line or at `copied`), renames `part`
to a fresh hidden name in the same folder, checks that identity there, and
only then removes it under that name with a new `--dir-remove` run, which
holds the chosen folder anew and checks it is the bound one. A file put at
`part`'s name meanwhile is not touched. A file found not to be the one
written, or one that removal fails on, is put back at `part`'s name if that
is still free (a hard link, which never replaces), or left under the hidden
name, and logged. A folder without hard links (FAT, exFAT), where a rename
gives the file another id, is found by a link probe; only a definitive answer
(a link seen through, or a refusal that says the file system has no hard
links) is kept for the volume, and any other failure answers for that
cleanup alone. There `part` is known by its content instead (size, last
change, and digests of its first and last 64 KiB, read through an open
descriptor), checked again at the hidden name, and put back as a new file
created exclusively at its name, which fails rather than replacing a file put
there; the hidden name is removed only once the copy holds the same bytes. A
file left where it can still be found, under either name, is recorded for the
next start with the name it has and how it is known, and recorded again when
the next start leaves it. A `part` never seen
while it was written has no identity and is left, as is one whose rename
still fails once a brief lock was waited out. A copy the helper reports failed
has its `part` cleaned the same way. So does the Linux copy, which the host
runs itself, when it is cancelled or fails: it takes `part`'s identity
through the handle it creates it with. The download is reported as
failed, and the log records whether `part` was removed. It also remains,
logged as possibly left, when the app quits during a copy: shutdown kills the
helper with every other owned process and starts no new one, so nothing
removes `part`. When the killed helper was not seen to exit, a
removal could race it, so none starts then: the host records the folder, the
name and the identity in the staging folder, and does the above once the
helper is seen to end, or at the next start before the sweep. A run killed after `copied`, or a rename killed after
`ready`, may have reached the chosen path; the log says so instead of claiming
the file was not saved.

`scripts/build-macos-dir-ops.mjs` builds it with the installed command-line
tools, for the app's minimum macOS, with warnings as errors; `bun run build`,
`test:prepare` and the hook tiers that run Vitest directly rebuild it when a
source changed, and installer `beforePack` builds it for the packaged
architecture, which `build.mac.extraResources` ships as
`Contents/Resources/macos-dir-ops/<arch>/ave-dir-ops`. `--test-builds` adds
variants that inject one fault each: writes that take part of what they are
given or nothing, a helper that never says `ready`, and one that copies slowly,
ignores every request to stop and never answers after `copied`. Only
`src/main/browser/__tests__/browser-download-staging.test.ts` runs them. A
missing or broken helper refuses every download with the staging notice; there
is no fallback to path operations.
