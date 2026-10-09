# Exclusive entry rename

The helper performs one same-volume rename and refuses every existing target,
including an empty directory. Socket carries need this at the filesystem
operation itself: a worker can create an entry after the conflict preflight.

The implementations use `renamex_np` with `RENAME_EXCL`, `renameat2` with
`RENAME_NOREPLACE`, or `MoveFileExW` without replacement or cross-volume copying.
Unsupported filesystems fail closed. Source and destination entries keep their
identity; symlink and junction entries move without traversing their targets.

Exit 0 means the rename succeeded. Exit 1 reports one errno-style code on stderr.
Exit 2 means invalid arguments. The host bounds execution and retries transient
lock failures using the shared retry budget.

Build with `node scripts/build-rename-entry.mjs`. Main builds, development startup,
test preparation and native installer builds invoke it. The installer copies the
target architecture's executable into `rename-entry/<arch>/` outside the archive;
the host resolves it only from its configured resource directory.

`src/lib/__tests__/rename-entry-exclusive.test.ts` runs the actual helper,
including from relocated packaged resources. Socket carry tests cover late
conflicts, inode preservation, links, retry reporting and a live child socket.
