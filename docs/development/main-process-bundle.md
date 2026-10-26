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
| All emitted main-process JavaScript | Entry budget + initial budget + 4,300,000-byte lazy allowance |

`createMainBundleBudgets` in `scripts/lib/main-bundle-budget.mjs` derives the
total ceiling from the two startup budgets and the fixed lazy allowance. With
the current inputs it remains 14,000,000 bytes; changing either startup budget
recalculates total automatically. The allowance preserves the existing total
cap rather than increasing it to accommodate a build.

Initial bytes already include the entry file. The additional entry budget plus
the lazy allowance reserve headroom for deferred chunks and other process
entrypoints outside the initial closure. The 4,300,000-byte allowance is an
additive budget term, not a separate ceiling on measured lazy bytes. Actual
total bytes count each emitted output once. A total failure reports entry,
initial shared, and lazy/other output shares; CI also shows the ceiling formula.

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
raise a limit only with the owner's approval. Size caps follow their content:
never move files or change loading boundaries merely to evade a cap.
