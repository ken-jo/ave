# macOS holder label sweep

`src/main.rs` builds `ave-holder-sweep`. Ave starts every macOS extension holder (MCP server, plugin child, worker,
hook, offline host child) through `/usr/bin/sandbox-exec` with a profile that ends in three label lines:

```text
(deny mach-lookup (global-name-prefix "dev.ave.holder."))
(allow mach-lookup (global-name "dev.ave.holder.<inst>.<boot>.<holder>")
                   (global-name "dev.ave.holder.<inst>.<boot>.all")
                   (global-name "dev.ave.holder.<inst>.any"))
```

Nothing registers or looks up these names. The profile is inherited by `fork` and `exec` and cannot be shed, so every
process a holder starts, including one that left its process group with `setsid`, `setpgid` or a double fork, still
answers "allowed" when the kernel is asked whether it may look up the holder's label. The helper asks that question of
every process and ends the ones that answer yes.

```text
ave-holder-sweep sweep <label> <control>   SIGKILL every member; repeat until two passes in a row find none
ave-holder-sweep watch <label> <control>   ignore HUP/INT/TERM/PIPE, read stdin to EOF, then sweep
ave-holder-sweep prove <label> <control>   a stale identity of one member must be refused by the check and the signal
```

- **Membership.** For each pid from `proc_listallpids`, an audit token is built once from the pid and its pid version
  (`PROC_PIDUNIQIDENTIFIERINFO`). The process is a member when `sandbox_check_by_audit_token` allows `mach-lookup` of
  the label and denies it for the control name `dev.ave.holder.ctl`, which no profile allows. An unsandboxed process
  allows both, so the control removes it.
- **Signal.** `proc_signal_with_audittoken` with the same token. The kernel refuses a token whose pid version is stale
  (`ESRCH`), so a recycled pid is never signalled.
- **Exit.** `0` clean or proven; `3` members remained after 50 passes; `4` a member refused the signal; `5` not
  proven; `64` bad arguments (exactly three; names `^dev\.ave\.holder\.[a-z0-9.]{1,96}$`, label ≠ control), nothing
  done; `70` the process list or a query failed. The last line is `result <clean|unclean|refused|failed>
  signalled=<n>` (sweep) or `result <proven|unproven> …` (prove); Ave requires it to agree with the exit code.
- **Interfaces.** `sandbox_check_by_audit_token`, `SANDBOX_CHECK_NO_REPORT`, `proc_signal_with_audittoken` and the pid
  version field are not in the public SDK headers. The MXC SDK's macOS library imports the same calls. Ave proves them
  every app run with the holder boot check (three controls); if it fails, macOS extension starts ask each time.
- **Build.** `node scripts/build-macos-holder-sweep.mjs` with the toolchain pinned in `rust-toolchain.toml`,
  `--locked --offline`, a private `CARGO_HOME`, `--remap-path-prefix`, `MACOSX_DEPLOYMENT_TARGET` from
  `build.mac.minimumSystemVersion`. The crate has no dependencies. `--test-builds` adds `ave-holder-sweep-never-signals`
  (the `fixture` feature), which finds members but signals nothing; it is never packaged.
- **Pin.** `build:main` compiles the helper's Mach-O image digest (`scripts/lib/macho-image-digest.mjs`) into the main
  bundle. The digest leaves out only what signing rewrites and the linker's UUID, so the packaged, signed copy keeps
  it; the before-pack, after-pack and after-sign hooks check that, and Ave checks it at boot before running the helper.
- **Licence.** The Rust standard library is linked statically; its notices ship in `licenses/macos-holder-sweep/`.
