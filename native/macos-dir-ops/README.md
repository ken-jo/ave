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
ave-dir-ops --dir-rename <from> <dev> <ino> <name> <to> <dev> <ino> <target> --expect <token>
ave-dir-ops --dir-copy   <from> <dev> <ino> <name> <to> <dev> <ino> <target> <part> <hidden>
ave-dir-ops --dir-remove <dir> <dev> <ino> <name> --expect <token>
ave-dir-ops --dir-stamp  <dir> <dev> <ino> <name>
ave-dir-ops --dir-sweep  <dir> <dev> <ino> [--keep-records]
ave-dir-ops --dir-list-records <dir> <dir-dev> <dir-ino>
ave-dir-ops --dir-read <dir> <dir-dev> <dir-ino> <name> <max>
ave-dir-ops --dir-write-record <dir> <dir-dev> <dir-ino> <name> <hex>
ave-dir-ops --dir-remove-record <dir> <dir-dev> <dir-ino> <name> --expect <token> --length <n> --digest <sha256>
ave-dir-ops --dir-remove-id <dir> <dir-dev> <dir-ino> <name> --expect <token> [--content <fingerprint>]
ave-dir-ops --dir-restore <dir> <dir-dev> <dir-ino> <hidden> <part> --expect <token> --content <fingerprint>
ave-dir-ops --dir-restore-target <dir> <dir-dev> <dir-ino> <hidden> <target> --expect <token> [--content <fingerprint>] [--writer <token> | --renamed-writer <token> | --retire]
ave-dir-ops --dir-sweep-record <dir> <dir-dev> <dir-ino> <name> <max>
```

The operands and options are the ones `native/windows-path-kind/README.md`
lists for the Windows helper. Options follow the positional operands in any
order; a repeated, unknown or valueless option, more than one of `--writer`,
`--renamed-writer` and `--retire`, or a malformed token or fingerprint is a
usage error (exit 2).

Every file operand and every identity a frame carries is an evidence token
`<dev>:<ino>:<class>:<value>`, with the device and inode in decimal. This
helper emits and accepts only `birth`: the file's birth time in nanoseconds,
nonzero. A token of any other class (`none:-` among them) is unresolved and
matches nothing, so it leaves the entry in place. A file without a birth time
has no token this helper can name: `--dir-stamp` answers `refused source` for
it, and a frame about it carries `none:-`, which the host refuses. A rename on
macOS keeps the birth time (APFS and HFS+ do not tunnel names), so
`--renamed-writer` is matched in full, exactly as `--writer` is; the Windows
helper matches it by file ID and volume alone.

Names are single path components. `rename` moves the ordinary file `name` to
a vacant `target` exclusively, only while `name` is still the file `--expect`
names (`refused source`, exit 3, otherwise). After the move it reads the moved
file's identity from the descriptor that moved it and writes
`published <token>` before `committed`. It answers `replace` for an existing
ordinary file and `cross-volume` across volumes. Both outcomes use the journaled copy
protocol. `copy` creates `part` exclusively, never through a
link, copies `name` into it, syncs it and renames it to `target`; that rename
is the commit point. Cross-volume publication requires a vacant target and
support for exclusive rename. `remove` removes the staged file only while it
is still the file `--expect` names; another entry there is `refused source`
(exit 3) and stays. `stamp` answers `stamp <token>` for the regular file at
the name, `absent`, or `refused source` for another kind of entry. `sweep`
cleans the files and links directly in the held directory, each only while it
still has the stamp the listing read for it (a changed entry is kept and not
counted). All three preserve recovery record names.

`copy` checks the destination volume before it opens the source or an
existing target, and before `ready`. It reads the held destination
directory's volume capabilities (`fgetattrlist` with `ATTR_VOL_CAPABILITIES`
and `ATTR_VOL_ATTRIBUTES`), which the file system reports without anything
being created. A volume that does not report exclusive rename
(`VOL_CAP_INT_RENAME_EXCL`), persistent file ids
(`VOL_CAP_FMT_PERSISTENTOBJECTIDS`) or creation times (`ATTR_CMN_CRTIME`) is
`refused volume` (exit 3): the commit and the move-aside of an old target
need exclusive rename, and every token needs a lasting inode and birth time.
exFAT and FAT report neither of the first two. A volume whose capabilities
cannot be read is `refused volume-unknown`. These are the frames the
Windows helper uses for volumes without file-ID opens.

The recovery modes use the same `ready` handshake. Values identifying files
are separate from the required identity of the directory. All names are
single components.

- `list-records` returns `records` followed by space-separated names of the
  form `<32 lowercase hex digits>.cleanup.json`.
- `read` opens a record once without following links, checks that it is
  regular, and returns `record <lowercase hex>` or `absent`. The decimal
  byte limit is between 1 and 8192. A larger record is refused with
  `failed EFBIG`. An empty record is represented by `record ` with a space.
- `write-record` creates a private record exclusively, writes at most 8192
  bytes of payload, syncs and verifies it before answering
  `written <token>`.
- `sweep-record` emits `record <token> <hex>` from its held
  descriptor. A second authorization retires the entry only while the full
  stamp and digest match the classified content.
- `remove-record` checks the expected full stamp, length and SHA-256. An
  unresolved `--expect` token is a usage error.
  It replies `removed` after observed absence, `absent` if already absent,
  or `kept` if verification or retirement remains incomplete.
- `remove-id` opens the named file without following links, verifies its
  device and inode and the optional fingerprint, and then moves it
  exclusively to a fresh hidden name. It verifies the resulting entry
  against the opened file before unlinking. It answers `removed`, `absent`,
  or `left`. If it moves an entry that it cannot put back or remove, it
  answers with the named leftover format below.
- `restore` opens the hidden source without following links and verifies the
  file identity and fingerprint on that descriptor. It copies from that
  descriptor to an exclusive new part, syncs it, and verifies the part name
  against its still-open descriptor. It retires the source using the same
  rule as `remove-id`. It answers `restored` only after both steps,
  `absent` when the source is missing, or `left` when the part is occupied,
  verification fails or cleanup cannot finish.
- `restore-target` answers `resolved` after verified rollback or retirement,
  or `left` if unresolved. The writer must share the old file's device and
  differ in inode. `--retire` retries a verified commit recorded by an older
  release.

A fingerprint is one ASCII token `<size>:<mtime-ns>:<head>:<tail>`.
Size and modification time are decimal. The two digests are lowercase
64-digit SHA-256 hashes of the first and last 64 KiB, truncated to the size
of the file when shorter. Empty files hash two empty spans.

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
  ordinary file, or `target` holds something other than an ordinary file;
  `refused volume|volume-unknown` from `copy` as above.
  Exit `4`: `failed <errno name>`. Exit `2`: the arguments are wrong.
- After creating the part exclusively and before reporting progress or
  `copied`, the copy writes `writing <token>` once. The identity comes
  from the writing descriptor. The host never
  samples the part name for ownership. A failed exclusive open has no
  `writing` line and may answer `failed EEXIST`.
- Volume, source and target refusals before work starts precede `ready`. After
  `copied` on an authorized commit, a target refusal uses `refused target
  left` with the stopped-copy suffix rules, `refused target removed` when
  cleanup removed the part or found it absent, or `refused target changed`
  if rollback could not move the mismatched target back exclusively.
- A stopped copy moves the part aside, verifies against the writing
  descriptor, and unlinks only at a fresh exclusively obtained name of
  the form `.<32 hex digits>.removing`. A volume without exclusive rename
  may isolate the entry under a fresh name using plain rename. It keeps
  that entry for recovery. A copy-back writes an exclusive new part and
  verifies the part name against the target descriptor before trying to
  retire the isolated source. An incomplete copy-back is left in place.
- A cancelled, failed or refused copy can add ` left` when a file remains.
  A named leftover adds
  ` <hidden> <own-token> <verdict> <snapshot>` after `left`.
  The own identity comes from the writing descriptor. A verdict is
  `mismatch` when ownership was unverified, or `remove-failed` when the
  verified file could not be removed. The snapshot is
  `<token>/<fingerprint>` from the hidden descriptor, or
  `-` if it could not be obtained. The suffix ` part-left` additionally
  reports an incomplete or unverified copy-back at the part name.
  `remove-id` and `restore` may also return the named `left` outcome
  when they isolate a file under a new hidden name.
- Before `ready`, the helper holds any existing ordinary target and emits
  `target-id <token>`. For a replacement, the helper reads
  the final stamp from the writing descriptor after syncing and announces
  `copy-id <token>` before `copied`. The host refuses a `copy-id` that
  differs from `writing`.
  After authorization at `copied` it verifies the part, moves any
  old target to the supplied hidden name exclusively and verifies it against its descriptor.
  The helper commits the part with an exclusive rename and verifies the
  new target against the writing descriptor. It then writes
  `published <token>`, read from that descriptor, before retiring the old
  target. The host records it before it resolves its write-ahead record, and
  takes nothing after it but `target-retired` or a `target-left` with
  `remove-failed`, then `committed`.
  A mismatched commit is rolled back exclusively if possible. If commit
  fails, the helper restores the old target exclusively.
- A failed restore or retirement of the old target sends
  `target-left left <hidden> <own-token> <verdict> <snapshot>`
  before the terminal copy reply. The old identity comes from its held
  descriptor. The verdict is `mismatch` for a failed restore and
  `remove-failed` for retirement after a verified commit. A verified restore
  or retirement emits `target-restored` or `target-retired` before the
  terminal reply. The host keeps the write-ahead record when the outcome
  is unavailable.

  I1. The host touches part, hidden and record entries only through held
  directory operations.

  I2. The part's identity comes only from the writing handle.

  I3. Destructive cleanup requires exclusive isolation and handle
  verification. If that proof is unavailable, cleanup leaves and records
  the entry.

  I4. A displaced original moves only by identity-preserving rename.
  Startup uses the separate target recovery operation for its record.
  Copy-back applies only to copy-part recovery.

  I5. Before authorizing isolation, the host syncs a record containing the
  hidden name, the original and writer identities, and the copy session.
  Startup reads target records first. A target matching the writer confirms
  commit and any remaining hidden original is retired by identity. An absent
  hidden entry and a target matching the original confirm rollback. A vacant
  target permits exclusive restoration of the verified hidden original.
  Other observations keep the record and are logged. The recorded part is
  removed by identity before the record is removed. Failed or unconfirmed
  retirement keeps the record for the next startup.

  I6. The copy session binds the old target identity captured before ready
  and the writing identity from the part handle. A target leftover must
  match the authorized original and hidden name on the held destination volume.
  A named copy-part leftover must carry the writing identity.

  Accepted residual.

  (a) the gap between the final fd verify and the unlink of a random hidden name; (b) anything after a verified restore or commit (the user's own act). Nothing else.

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

After a helper exits without a trustworthy outcome, the host can retry the
part only with the identity from `writing`. If exit is unconfirmed, it
records that identity, waits for exit before retrying, and can also retry at
startup. Without `writing`, the host leaves the part alone. For a named
leftover, it records the snapshot supplied by the helper. Startup retries
removal or restoration through the held-folder operations. A changed
snapshot or occupied part leaves the hidden entry and logs both names.


`scripts/build-macos-dir-ops.mjs` builds it with the installed command-line
tools, for the app's minimum macOS, with warnings as errors; `bun run build`,
`test:prepare` and the hook tiers that run Vitest directly rebuild it when a
source changed, and installer `beforePack` builds it for the packaged
architecture, which `build.mac.extraResources` ships as
`Contents/Resources/macos-dir-ops/<arch>/ave-dir-ops`. `--test-builds` adds
variants that inject one fault each: writes that take part of what they are
given or nothing, a helper that never says `ready`, and one that copies slowly,
ignores every request to stop and never answers after `copied`. The test
builds also include variants that report a reused file identity or substitute
an entry during restore, plain rename or publication, and one that cannot read
its destination's volume capabilities. Only
`src/main/browser/__tests__/browser-download-staging.test.ts` runs them. A
missing or broken helper refuses every download with the staging notice; there
is no fallback to path operations.
