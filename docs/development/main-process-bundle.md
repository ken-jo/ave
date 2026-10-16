# Main-Process Bundle Budget

Ave keeps the Electron main-process entry small enough to create the bootstrap
window before loading the full host-service graph. The legacy build emitted one
10,828,547-byte ESM file, so every launch parsed all boot, provider, plugin, and
locale code before `createWindow()` could run.

The current build uses esbuild ESM splitting. `src/main.ts` creates the window,
starts `import("./boot.js")`, and prepares the corporate CA concurrently. Boot
failures are observed immediately; after CA readiness updates the splash, startup
awaits the boot result. This changes loading order, not the ordered service
construction inside `bootstrap()`.

## Enforced Budgets

`bun run build:main` derives the static import closure from esbuild's metafile
and fails closed when any limit is exceeded:

| Measurement | Limit |
| --- | ---: |
| Entry file | 1,700,000 bytes |
| Initial static closure | 8,000,000 bytes |
| All emitted main-process JavaScript | 14,000,000 bytes |

These limits are tripwires, not a ratchet. They sit far above the measurement so
that ordinary features never move them; they catch a bundling mistake, such as an
undone boot split or a dependency bundled twice. The build also fails if the async
boundary disappears or a limit is missing or not a positive integer; those
structural checks are exact.

The build prints the measurement on every run, and CI writes the measurement,
each limit and its headroom to the job summary. The source does not record
measurements.

The initial measurement follows only `import-statement` edges. Dynamic imports
remain outside that closure until runtime requests them. Total bytes still
include every emitted chunk, so moving code behind an async edge cannot hide
overall bundle growth.

## Packaging Contract

One-shot builds remove the prior `dist/src/main/chunks` directory before
emitting content-hashed chunks. They also write
`dist/src/main/bundle-manifest.json`, which lists every expected file and byte
count. The packaged footprint gate requires the manifest, every listed chunk,
matching packaged byte counts, and no stale unlisted main-process chunks.

Do not hand-edit the generated manifest. When a limit fails, first look for
startup code that belongs behind a dynamic import or a dependency bundled twice;
raise a limit only with the owner's approval.
