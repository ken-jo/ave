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
staging folder, so the host removes `part` at once with a new `--dir-remove`
run, which holds the chosen folder anew and checks it is the bound one. The
download is reported as failed, and the log records whether `part` was
removed. It remains, logged as possibly left, when the removal is refused or
fails (the chosen folder was moved or replaced, or the helper is broken for
every run), and when the app quits during a copy: shutdown kills the helper
with every other owned process and starts no new one, so nothing removes
`part`. When the killed helper was not seen to exit, a removal could race it,
so none starts then: the host keeps the identity `part` had while the helper
wrote it (taken at its first `progress` line or at `copied`) and records the
folder, the name and that identity in the staging folder. Once the helper is
seen to end, or at the next start before the sweep, `part` is removed with a
new `--dir-remove` run only while the file at that name still has that
identity; anything else there is left and logged. The host checks the
identity just before the run, and the helper does not check it again, so a
file put at that name in between could still be removed. A `part` never seen
while it was written has no identity and is left. A run killed after `copied`, or a rename killed after
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
