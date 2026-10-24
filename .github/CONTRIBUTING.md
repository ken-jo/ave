# Contributing to Ave

Thanks for your interest. Ave is an Electron-based personal AI assistant
desktop app. Contributions of all sizes are welcome — bug reports, small
fixes, new plugins, architecture proposals.

## Language

Contributions are welcome in any language. Issues, pull request descriptions,
review comments, design notes, and questions do not need to be written in
English or Korean to be accepted.

Use the language that lets you explain the problem clearly. Maintainers may add
short translations or ask follow-up questions when shared context is needed, but
language should not be a barrier to participation.

## Development setup

```bash
# Prerequisites: Node.js >= 22.12 and bun (https://bun.sh)
git clone https://github.com/ken-jo/ave.git
cd ave
bun install            # uv binary fetch + protocol/hook install (no native rebuild)
bun run build          # TypeScript + esbuild renderer + Tailwind
bun run start          # build + Electron launch
```

Standalone Node.js is required even though `bun` is the script runner —
Electron's embedded Node is not on `PATH`, and the `postinstall` +
`scripts/run-electron.mjs` invoke the system `node` binary directly.

## Testing

```bash
bun run test:vitest -- run path/to/affected.test.ts  # targeted tests while iterating
bun run test:ui-e2e path/to/flow.spec.ts # changed UI flow only
```

The Vitest wrapper runs through Electron's Node mode so tests and the desktop
runtime use the same native-module ABI. Do not rebuild `better-sqlite3` for
standalone Node in place; that would replace the binary used by Electron.
Direct `bunx vitest` and `bun test` invocations fail fast by design; use the
canonical wrapper command above for both full and targeted tests.

Use the smallest affected checks while iterating. The pre-push hook logs the
tier it picked and why. A source change on a branch push takes the fast tier:
typecheck, the duplicate-helper scan, the lock suites whose trigger paths
changed, the changed test files, the recorded readers of a changed test-read
document, and `vitest related` for the changed modules, narrowed to direct
importers when a shared module reaches over 150 test files. Each source module
must have related test files; empty discovery selects full checks and a
zero-test run fails closed. A new sub-branch is measured from the closest live
tip of the default or an `integration/*` branch. The full `bun run test` and
`bun run build` run once before merge on the merged tree. The hook keeps the full gate for pushes to `integration/*`,
non-fast-forward pushes, deleted modules, documentation consumed by runtime,
tests, build, or workflows without a recorded reader set, declaration files, generated catalogs, runtime
entries, non-module assets, mode changes, and global inputs (`package.json`, `bun.lock`,
compiler, Vitest and build configs, Vitest setup files, `scripts/`,
`.github/`), including earlier commits in the push; `AVE_PREPUSH_FULL=1`
forces it. Documentation prose with no such
consumer skips those expensive gates after diff and policy checks. Eligible
test-only pushes run typecheck and targeted Vitest in the hook. Register
documents read by native or non-Node processes, or through `openAsBlob`, in
`scripts/hooks/documentation-references.json`; the read guard cannot see them.
CI's `build-and-test` always runs typecheck and the build. A category merge
(a pull request from `integration/*` into `main`) runs the full suite, as the
multi-stage flow requires. Every non-PR event also runs the full suite.
Pull requests whose base is `integration/*` always run the best traced selection
(`bun run test:ci`, `scripts/run-ci-suite.mjs`): changed tests, every test
`vitest related` reaches from changed modules when discovery works, tests that
name a changed path in a string literal, triggered lock suites, and the nonempty
must-run set in `config/ci-must-run-tests.json` (security, permissions, sandbox,
contract, IPC, naming, and tests that run repository code out of process).
They never fall back to the whole suite, even for global inputs, message
catalogs, deleted or renamed modules, declarations or entry points, computed
imports, modules no test reaches, failed discovery, or more than 600 selected
files. The reason records uncertainty; failed discovery keeps the other sources
and the must-run set. Whole-suite checking waits for the category merge.
An integration-base PR must have a readable merge-commit diff. A missing merge
commit or an unparseable diff fails CI with the cause before selecting tests:
without the changed paths, changed tests and lock-suite triggers cannot be selected.
PRs into other bases, including non-integration branches into `main`, keep the
untrusted-selection fallback to full. Local pre-push policy is unchanged. Coverage is
periodic: instrumentation and the global thresholds (`check:test-coverage`)
run only on the nightly schedule and a manual dispatch. Every other run, full
or affected, skips coverage. A change that lowers coverage turns the next
nightly run on `main` red. Do not duplicate
the trio around a successful push. If a check fails, fix it and rerun
only the failed or invalidated checks before pushing again. No CI workflow and no release
gate runs Playwright. The suite (`bun run test:ui-e2e`) is local and self-contained:
it seeds only fixture plugins from `test/fixtures` and reads nothing outside this
repository. UI changes require the targeted local flow check above. Never
bypass hooks with `--no-verify` or a hook-skip environment variable.

For every update that pushes a commit, check out that exact commit before
pushing and keep the tracked working tree and index clean. The hook checks
this before and after validation, and refuses a different commit with
checkout instructions. Push different commits separately. Deletion-only
updates skip code checks because they push no commit tree.
An annotated tag is pushed by checking out its commit
(`git checkout --detach <tag>^{commit}`) and pushing the tag; the hook
validates the peeled commit. A tag that does not peel to a commit is refused.
A complete checkout with no
assume-unchanged or skip-worktree index flags is required for validation.

## Architecture

Read `docs/architecture/architecture.md` (v4 Final) before making non-trivial
changes. The host app is plugin-agnostic — all plugin integration flows
through the `HostApi` interface declared in `src/plugins/types.ts`. Adding
plugin-specific code to the host is not accepted.

Key sections:
- §4.2 — Boot sequence (8 steps)
- §4.5 — Conversation query loop (11-step message lifecycle)
- §5 — Memory system (`~/.ave/` file-based)
- §6 — Core engines (keyword, route, tool registry, permissions)
- §9 — Plugin system (manifest, UI slots, MCP protocol)

Plugin development guide: `docs/guides/plugin-development.md`.

## Branch + PR conventions

- Branch from `main`. Branch names: `feat/<scope>`, `fix/<scope>`,
  `chore/<scope>`, `docs/<scope>`.
- One logical change per PR. Merge with `gh pr merge --merge`; do not squash.
- PR description should explain *why* (motivation) more than *what*
  (the diff already shows what).
- All PRs go through automated CI (typecheck + vitest + lint).
- UI changes require a Playwright e2e check before merge.

## Code style

- TypeScript strict mode. No `any` unless explicitly justified.
- Prefer named exports. No default exports for app code.
- No comments explaining *what* the code does; comments only for *why*
  (hidden constraint, subtle invariant, workaround for a specific
  upstream issue). Well-named identifiers self-document the what.
- Follow the surrounding file's import order and style. The codebase has
  no formal linter rule for ordering — match the neighbors.

## Reporting bugs

Open an issue with:
- Ave version (`Help → About`)
- OS + version (macOS / Windows / Linux)
- Steps to reproduce
- Expected vs actual behavior
- Logs from `~/.ave/audit/` if relevant (redact sensitive data)

## Security vulnerabilities

Do **not** open a public issue for security-sensitive reports. See
[SECURITY.md](./SECURITY.md) for the private disclosure channel.

## Code of conduct

By participating, you agree to abide by the
[Contributor Covenant Code of Conduct](./CODE_OF_CONDUCT.md).

## License

Ave is proprietary software (Copyright (c) 2026 Ken Jo, all rights reserved).
See [LICENSE](../LICENSE); no license is granted without the copyright
holder's written permission.
