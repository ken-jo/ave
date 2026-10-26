# Exact file identity

File identity checks use `dev` and `ino` from stats requested with
`{ bigint: true }`. A file identifier can exceed the exact integer range of a
number. Converting an already rounded number to bigint cannot recover it.
`src/lib/file-identity.ts` owns identity comparison and stable decimal cache keys;
comparison returns false for numeric identifiers and key creation throws.
Metadata arithmetic uses bigint or an explicit conversion after a size bound.
Stability checks retain nanosecond timestamps.

Matching device and inode values identifies the object observed at that moment.
Callers retain their own type, ownership, content and post-read checks. Identity
alone does not prove unchanged bytes or remove races before a later path operation.

JSON records store device and inode identifiers as decimal strings. Existing
folder-source state and audit checkpoint validators reject numeric identifiers.
A legacy numeric record has unknown identity: it cannot establish sameness or
restore authority. Re-verify the resource and issue a fresh record through its
owning workflow; do not migrate a rounded number by stringifying it. No automatic
legacy-record migration or authority restoration is added.

The source-wide identity review also covers the already exact bigint reads in
`audit/hmac-chain.ts`, `audit/permission-audit-proof.ts`,
`audit/rationale-audit-adapter.ts`, `marketplace/sources/folder-fs.ts`,
`marketplace/sources/folder-tree.ts`, `marketplace/net/source-input.ts`,
`marketplace/sources/registry.ts` and `marketplace/sources/sync.ts` under `src/`.
Their persisted identity components are decimal strings where applicable.
