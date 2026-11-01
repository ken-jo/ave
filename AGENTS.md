# Ave coding-agent contract

This file is the canonical repository contract for coding agents. Keep it lean:
state durable constraints here and put detailed designs in their owning docs.

## Scope and sources of truth

- Work only in the repository and task scope the user names.
- For non-trivial architecture work, read `docs/architecture/architecture.md`
  and the feature blueprint or design document named by the task.
- A task-specific blueprint and explicit owner decisions override general
  guidance. If the design conflicts with code reality, report the conflict;
  do not silently redesign the feature.
- For host-agent product and UX precedent, start with official documentation
  and current shipped behavior of comparable CLI and desktop coding-agent
  hosts. IDE/workspace products are secondary references: use them for generic
  editor or filesystem conventions, not as the primary model for agent-host
  lifecycle or interaction behavior. For browser and terminal surfaces, the
  agent browsers and agent terminals named in `docs/vision/README.md` are
  primary comparisons too.
- The product goal is stated once, in `docs/vision/README.md`. Link to it
  instead of restating Ave's positioning elsewhere.
- Plugin integration is defined by `src/plugins/types.ts`, manifests, schemas,
  and HostApi self-registration. Do not add plugin-specific host branches.
- Permission behavior follows `docs/architecture/permission-policy-design.md`
  plus `Tool Governance` and `Security And Audit` in
  `docs/architecture/architecture.md`. Release work follows
  `docs/development/release-process.md`.
- `resources/AGENTS.md` is packaged runtime guidance for the in-app assistant.
  It is not the developer or coding-agent contract and does not override this
  file.

## Autonomy and communication

- Inspect, edit, and run relevant non-destructive local validation without
  asking when the requested change clearly authorizes it.
- Ask only when authority is missing for a destructive or irreversible action,
  an external production write, credential use that cannot be recovered, or a
  choice that materially changes scope or product behavior.
- Do not pause for approval between ordinary local edit-test-fix steps.
- Give concise updates only at meaningful boundaries: discovered constraint,
  material implementation result, failed gate, or external blocker.
- Use subagents only for independent, bounded work that can run concurrently.
  Keep shared-file edits under one owner and integrate results in the lead lane.

## Git and workspace safety

- Run repository commands as `git -C <absolute-repo-path> ...`; do not depend on
  accumulated shell `cd` state in this multi-repository workspace.
- Before editing, check `git status --short --branch`.
- Treat an unexpected branch or dirty shared tree as owned by another session.
  Use a fresh clone or isolated worktree and a dedicated branch instead of
  changing, stashing, resetting, or cleaning another session's work.
- Preserve unrelated user changes. Never use destructive reset/checkout to
  clear them.
- Keep text files LF at the blob level.
- Do not bypass hooks with `--no-verify`, hook-skip environment variables, or
  equivalent mechanisms.
- Never push directly to `main`. Deliver changes through a PR and merge with
  `gh pr merge --merge`; squash merge is not allowed.

## External product names

- Do not commit external product or vendor names as explanatory text. This
  covers code comments, JSDoc, module headers, `description` fields, test names
  and `describe`/`it` strings, documentation prose, and **commit messages** —
  messages travel with every clone and are permanent in `git log` and `blame`.
  The tool-attribution trailers (`Co-Authored-By:`, `Claude-Session:`) are the one
  exception; they carry no explanatory text.
- Keep the reason, drop the attribution. A comment that justifies a decision by
  pointing at what another product does states the property that makes the
  decision right instead. If the reasoning cannot survive without the name, it
  was doing citation work rather than explanation: state the property directly.
- A name stays only where the code would be wrong or ambiguous without it: a
  literal the runtime needs, a provider discriminant, a secret-store key, an
  endpoint or package name, or a feature that names what it integrates with
  (`openai-compatible`, `llm.apiKey.anthropic`, `@anthropic-ai/sandbox-runtime`,
  the desktop config importer). A name that identifies something the code talks
  to stays; a name that justifies a decision goes.
- PR bodies and GitHub issues are out of scope: they are not committed, and
  sourcing is genuinely useful there.
- Sweep added lines, not changed files (`git diff origin/main HEAD -U0`, `+`
  lines). Scanning whole files yields a larger, plausible-looking diff that
  breaks provider resolution and secret lookups while appearing to comply.
- Before deleting a document, grep for inbound references
  (`git grep -l "<basename>" -- src/ docs/`). A document referenced by section
  anchor from shipped code is a specification, not a record: its comparison
  section is removable, the document is not.

## Naming

Apply these conventions to hand-written `src/` code. Generated files and vendored
primitives keep their generator or upstream conventions. Follow the framework's
conventions in `web/`; do not rename unrelated code during another task.

### Casing by kind

- Types, interfaces, classes, components, contexts, schemas, and constructor
  bindings use `PascalCase`. Functions, locals, parameters, and fields use
  `camelCase`.
- Module-level fixed literals and frozen tables use `SCREAMING_SNAKE_CASE`;
  constructed instances, singletons, and functions use `camelCase`. Type-like
  registries may use `PascalCase`.
- Prefer string-literal unions for closed sets; add a runtime table only when
  values must be enumerated.
- Directories and `.ts` modules use kebab-case, except conventional test folders.

### Files

- A `.tsx` file dedicated to one component uses that component's `PascalCase`
  name. Files with multiple components or helpers use kebab-case.
- Prefer named exports in `src/`. Tooling configs and framework contracts may
  require default exports. Do not hand-edit generated files.
- Reuse existing functions before introducing another implementation. Extract a
  module when it creates a real responsibility or test boundary.

### The web workspace

Use lowercase or kebab-case files and preserve framework-required default exports
and route filenames. The identifier conventions still apply.

### Booleans and predicates

Stored state uses adjectives such as `enabled` or `connected`. Derived predicates
use questions such as `isSensitivePath` or `grantCovers`. Name options for what they
enable. If a function performs an action, use a result object when a boolean would
make its meaning ambiguous.

### Async

Use `Async` or `Sync` suffixes only to distinguish actual asynchronous and
synchronous counterparts. Preserve external API spellings. Spell synchronization
as a domain concept clearly rather than implying a synchronous operation.

### Events and handlers

- Callback slots use `on<Event>`; their local handlers use `handle<Event>`.
- Bus events use lowercase `<namespace>.<noun>.<pastTenseVerb>`.
- IPC channels use `ave:<domain>:<action>` with kebab-case segments.
- Name app shells `*Window`, reusable bodies `*Content`, and modals `*Dialog`.
- Plugin IDs use `^[a-z][a-z0-9-]*$`; tool names use
  `^[a-zA-Z_][a-zA-Z0-9_]*$`; event IDs use the separate event convention.

### Errors and audit keys

Error classes end in `Error`; stable IPC error codes use kebab-case. New audit
`type` keys use snake_case. Shipped audit keys are persisted values: changing one
requires a migration decision, not an incidental naming cleanup.

### Test doubles

Shared test support belongs in `src/__tests__/support/` and must not be imported
by production code. Name helpers for what they provide. Test-only production
seams use a leading underscore and the `ForTest` suffix.

Do not name production files or identifiers for being test doubles. Domain words
such as realpath results or compaction stubs are distinct. The naming gate owns its exact allowlist and the documented
`Why <prefix>:` header exception for deliberately shipped simulations; do not
expand an exception to avoid fixing a misleading name.

### Domain labels versus process labels

Names, comments, and shipped documents describe behavior. Domain labels resolvable
from a shipped specification may remain; review-round labels, work-plan coordinates,
PR-derived identifiers, and orphaned version suffixes do not belong there.
Commit messages, PR descriptions, and issues may record process history.

`.github/scripts/naming-gate.sh` and its self-test own automated matching, paths,
and exceptions. Check added lines and renamed paths, including manually checking
areas the gate does not cover. Do not treat excluded paths as permission to add
process metadata. When changing the rule, keep its enforcement and tests aligned.

### Home paths

Prefer derived temporary/home paths in tests; fixed examples use synthetic
accounts. Derive identifiers from the artifact under test when possible.
The naming workflow owns the home-path check. Its coverage is not a substitute
for reviewing public content, including binaries and commit text.

### Known naming divergences

Existing departures are not precedents. Check the current code before proposing a
rename, and coordinate consumers of IPC, serialized values, and exported names.
Keep task-specific inventories in issues rather than in this instruction file.

## Architecture and security invariants

- Keep core logic vendor-neutral through the `GenericMessage` abstraction.
- Preserve the three plugin namespaces without runtime conversion. Their
  shapes are in `Naming` > `Events and handlers`.
- Cross-boundary input is untrusted. Preserve sender/frame/origin checks,
  manifest allow-lists, DLP handling, audit records, and fail-closed defaults.
- Non-user-origin content must not dispatch privileged slash commands.
- Tool execution must pass the active recipient's own permission and approval
  gates; do not introduce fallback paths around them.
- New IPC handler errors and main-process throws use concise English messages,
  and renderer code maps an error code to localized user-facing text instead of
  exposing the raw error. The code's spelling is in `Naming` > `Errors and
  audit keys`.
- A new IPC channel is one coherent change: handler, preload bridge, shared
  types, caller, sender guard, and tests move together.
- A shared payload field or enum literal requires a same-PR field-addition
  sweep: update the shared SoT, validators, producers, consumers, fixtures, and
  tests; search for residual inline copies before publishing.
- New persisted state under `~/.ave/<feature>/` uses `openFeatureNamespace`;
  never hand-roll `mkdir` or mode bits outside its `0o700` directory / `0o600`
  file chokepoint.
  Secrets require an encrypted-at-rest store; mode bits alone are not encryption.
- Tool and MCP timeouts come from `src/shared/tool-timeout-policy.ts` and
  `TOOL_TIMEOUT_POLICY`; never hardcode them. Wire `runWithCeiling` cancellation
  through its `AbortController`.
- The OS tool sandbox defaults on for macOS/Linux/Windows,
  per `osToolSandbox` in [settings-defaults.ts](src/data/settings-defaults.ts).
  It has two scopes: `osToolSandbox` confines host shells only (bash, PowerShell,
  the workspace terminal); `pluginWorkerConfinement` confines plugin workers,
  plugin children, plugin hooks and MCP stdio servers, and stays opt-in. Neither
  decides the other: `AVE_SANDBOX_ENABLED=1` forces the shell scope only and
  `AVE_PLUGIN_WORKER_CONFINEMENT=1` the worker scope. A shell spawn path gates on
  `isShellSandboxActive` / `detectShellSandboxCapability`, an extension spawn path
  on `isPluginWorkerConfinementActive`, never the raw `isAsrtSandboxActive`.
  On `darwin`/`linux`, explicit `AVE_SANDBOX_ENABLED=1` or
  `AVE_PLUGIN_WORKER_CONFINEMENT=1` activation failure
  aborts startup; settings activation warns and continues without OS isolation
  when unavailable. Windows always warns and continues when unavailable.
  Keep plugin read relaxation conditional on active filesystem confinement
  and preserve effect-boundary enforcement.
- No Fallback Code: a plugin manifest field updates its host schema and public
  contract in the same PR; a HostApi change updates the host protocol and all
  affected plugin contract copies at an app release tag.
- UI edits start with `grep` before editing. Component-name shapes are in
  `Naming` > `Events and handlers`.
- Private or non-indexed assets use the installed marketplace sources, `gh`, or
  local sources, not WebSearch. After three identical failures, change approach.
- Top-level package imports used by unbundled runtime code (main, preload, CLI,
  or worker) belong in `dependencies`, not `devDependencies`. Renderer/UI-only
  packages bundled into `dist` by webpack/esbuild may remain in
  `devDependencies`.
- Runtime dependency changes update the lockfile and run the relevant
  packaged-app smoke so missing packages cannot reach an installer.

## Cross-Cutting Change Advisory

- Sensitive cross-cutting work identified by `.github/workflows/cluster-detector.yml`
  or task scope is advisory. It never requires an external reviewer, collaborator,
  label, attestation, or additional merge approval.
- The owner chooses proportionate architecture, critique, and security review and
  records material decisions, findings, and residual risk in the PR when useful.
  Parallel review, fixed roles, round counts, and cluster labels are optional,
  never prerequisites for implementation or merge.
  Owner self-review and automated review are valid evidence.
- The detector evaluates only the trusted `main` base of this repository through
  read-only repository and pull-request data access and never checks out or
  executes pull-request content.
  It uses only `contents: read` and `pull-requests: read`; it does not write commit
  statuses, labels, or pull-request metadata.
- Detector process failures (API, checkout, or schema validation) remain failures
  to investigate. A sensitive-area or cluster finding emits a warning and step
  summary only, and never blocks merge.

## Validation: proportional during work, complete once at publish

Use the smallest check that can disprove the current change while iterating:

- Documentation-only changes: Markdown or HTML prose outside the consumed
  document inventory may skip expensive gates; still run diff/path/policy
  checks. Runtime resources, site content, workflows, consumed documents,
  deletes, renames, and mixed changes get the relevant checks.
- Register documents read by native code, non-Node subprocesses, or `openAsBlob`
  in `scripts/hooks/documentation-references.json`; the read guard cannot see
  those accesses. `scripts/run-ci-suite.mjs` owns CI selection; nightly and
  manual runs keep the full-suite backstop.
- Types or isolated logic: affected unit test file(s) and the narrowest useful
  typecheck. Do not run overlapping broad suites after every small edit.
- Cross-module or shared contract: targeted tests for each changed boundary,
  then one relevant integration test where behavior crosses the boundary.
- Renderer or user flow: targeted unit coverage plus the specific Playwright
  spec for the changed flow. Record screenshot/trace evidence when visual
  behavior changes.
- Packaging, permissions, IPC, sandbox, or release paths: add the focused
  security or packaged-app check required by the owning design.

Pre-push picks one tier and logs it with the reason
(`scripts/hooks/run-local-checks.mjs` owns the rules):

- docs-only: documentation prose with no test or build consumer takes the
  static-policy path.
- comment-only and test-only: an eligible test-only push uses the hook's
  targeted Vitest path; a standalone-comment edit runs the typecheck gate.
- fast, the default for a source branch push: the typecheck gate, the
  duplicate-helper scan, the lock suites whose trigger paths changed, the
  changed test files, the recorded readers of a changed test-read document,
  and `vitest related` for the changed modules (narrowed to direct importers
  when a shared module reaches over 150 test files). A message catalog change
  (`src/i18n/messages/` seeds, fragments and barrels) adds
  `check:i18n-catalog`, `check:i18n-barrels`, the `src/i18n/__tests__`
  suites, and the tests and modules that name a changed key's namespace.
  No full `bun run test`, no build. A new sub-branch is measured from the
  closest live tip of the default or an `integration/*` branch, so only its
  own commits count. Fast runs share `AVE_PREPUSH_FAST_SLOTS` (default 4)
  host slots.
- full: `bun run typecheck`, full `bun run test`, `bun run build`, and
  `check:gate-core`, for non-fast-forward updates, the default branch and
  `integration/*` branches, noncanonical paths, consumed documentation
  without a recorded reader set, deletions of modules,
  non-module assets, mode changes, declaration files, message namespaces no
  source file names literally, unresolved message consumers or catalog module
  shapes, runtime entry files, modules with no related test files, and global
  inputs (`package.json`, `bun.lock`, compiler, Vitest
  and build configs, Vitest setup files, the message loader
  `src/i18n/messages/index.ts`, `scripts/`, `.github/`), including earlier
  commits in the push. A full run holds one host-wide lock (in `/tmp`, or
  `AVE_PREPUSH_LOCK_DIR`), so two never run at once; a waiting push names the
  holder's PID and fails after `AVE_PREPUSH_LOCK_TIMEOUT_S` (default 3600).
  `AVE_PREPUSH_FULL=1`
  forces it for one push; `AVE_HOOKS_SKIP=1` still skips the hook.

Every non-deletion ref update must name the checked-out `HEAD`. The tracked
working tree and index must be clean before and after checks; otherwise the
hook refuses and names the commit to check out. Push different commits
separately. Deletion-only updates have no commit tree and skip code checks.
An annotated tag is pushed by checking out its commit
(`git checkout --detach <tag>^{commit}`) and pushing the tag; the hook
validates the peeled commit. A tag that does not peel to a commit is refused.
Clear assume-unchanged and skip-worktree index
flags so every tracked file can be verified in a complete checkout.

CI builds the exact main + PR merged tree before merge, and its test scope
follows `scripts/run-ci-suite.mjs`: a test-only diff (collected tests and
fixture assets only) runs its affected tests and the must-run set, never the
full suite; a non-test-only category merge, a helper, setup, config, script or
workflow change off integration bases, and untrusted selections run it whole. Do not manually duplicate
the full trio around a push. After failure, rerun only failed or invalidated
checks. No CI workflow and no release gate runs Playwright. The suite
(`bun run test:ui-e2e`) is local and seeds only fixture plugins from
`test/fixtures`, so it needs nothing outside this repository; run only
changed-flow specs unless the task requires more.

### CI job composition

Keep repository-hygiene checks after compilation and tests, or in independent
jobs, so stale bookkeeping does not hide product verification. Build-integrity
checks that inspect source or generated bytes remain with their owning build.
The current scripts and `src/__tests__/packaging-discipline-source.test.ts` own
exact command membership and ordering.

Before moving a required check into another job, inspect current branch protection
and preserve its required status. Do not infer protection from historical check
names. Avoid dependency edges that cause hygiene failures to skip product tests.

## Change and PR discipline

- Keep a PR cohesive and reviewable; prefer existing utilities and patterns over
  new abstractions or dependencies.
- Update `../TODO.md` and task documentation only when the change completes,
  discovers, or alters a tracked item. Do not touch them mechanically.
- PR descriptions state motivation, scope, risk, targeted validation, pre-push
  gate result, UI/E2E evidence when applicable, and companion repository PRs.
- Merge only after fresh CI and relevant local verification pass, with material
  findings addressed. Review requests and fixed review loops are not merge gates.
  Inspect current branch protection and unresolved conversations; never use `--admin`.
- Never claim completion without fresh evidence for the changed behavior. State
  any validation gap or remaining risk directly.
