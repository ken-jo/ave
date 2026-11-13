# Native end-to-end tests

Build once with `bun run build`, then run `bun run test:ui-e2e`.
The default command selects the `background` project on every platform.
It excludes `@os-focus` tests and never deliberately activates a native window.

The runtime requires both `AVE_E2E=1` and `NODE_ENV=test` to enable inactive
windows and document focus emulation in unpackaged apps. Packaged apps ignore
this policy. Each standalone test app installs the same policy before readiness.
On macOS the launcher clones a temporary test-only runtime bundle with
`LSUIElement=true`, preventing activation before the main entrypoint runs.
The entrypoint then sets the `prohibited` activation policy. An accessory app
is not enough: when another app quits or deactivates, macOS can hand
activation to an accessory app whose window is ordered front, and the owner's
keystrokes would then land in a test window. In this test runtime, prohibited
apps remain inactive while their windows render and take emulated page input.
Each worker reuses its copy and removes it at exit. The installed runtime and
packaged executables are untouched; foreground fixtures use the original runtime.
Keyboard input goes through the page input channel; embedded guest pointer input
must target the guest directly instead of relying on native host focus routing.

The documented [activation-policy contract](https://www.electronjs.org/docs/latest/api/app#appsetactivationpolicypolicy-macos)
defines `prohibited` as removing the Dock and disallowing window creation and
activation. Window rendering here is runtime-specific behavior beyond that
documented contract. Background rendering and emulated page input do not establish
coverage for native message boxes, native menus or the menu bar, Dock integration,
or OS drag-and-drop. Tests exercising these surfaces must carry `@os-focus` and
use foreground fixture mode. Current dialog and menu tests intercept native
presentation; drag/drop tests use page input or synthetic events. The fixture's
Dock activation is already limited to its `@os-focus` foreground select tests.

Tests whose subject requires native OS focus carry `@os-focus`. Their
`os-focus` project exists only when `AVE_E2E_OS_FOCUS=1` is set, so any direct
`playwright test --config config/playwright.config.ts` invocation without that
flag, with or without `--project`, runs background tests only. Run them only on
a disposable desktop or by explicit local opt-in (the script sets the flag):

```sh
bun run test:ui-e2e:os-focus
# Linux with a virtual display:
xvfb-run -a bun run test:ui-e2e:os-focus
```

The `Native OS focus` workflow runs this project on a hosted Linux virtual
display nightly and on manual dispatch. It preserves native select/navigation
and popup focus coverage separately from the default suite.

## Manual full background sweep

The registered workflow also accepts an explicit background sweep. This manual
selection skips its native-focus job and builds the app once for 32 independent
background shards on the existing Linux runner. These background jobs are not
part of required CI and never run on a push, pull request or schedule:

```sh
gh workflow run e2e-os-focus.yml --repo ken-jo/ave --ref <branch> -f background-sweep=true
```

Each shard retains the default single worker and within-file ordering, with
retries disabled. Its test step has a ten-minute budget and its job a twelve-minute
budget; actual duration and completeness must be checked from the first run.
One shard failing does not cancel the others. Browser binaries use a fixed
workspace cache path so the isolated HOME does not hide them. Build artifacts
include both the app and generated native icons.

Artifacts are named `background-ui-shard-<number>`. They include `spec-results.json`
once collection starts, failure traces when available, and `wall-seconds.txt`
when the test shell exits. Missing output indicates incomplete setup, execution
or upload, rather than a successful empty shard. The report records its shard, commit,
project, retry policy and selected cases, then atomically saves every case start
and result grouped by spec. `pending` and `running` are incomplete cases, never
skips or passes. Real skips retain their annotations, while runner errors stay
separate from test failures. A live runner can upload the last saved snapshot
after the test process is interrupted; recovery requires the upload step to run.
Use `complete` and the per-case states to distinguish a finished run from a
snapshot with pending or running cases.

## Shared application lifetime

The native browser action and capture specs and the workspace find/preview cases
use [the worker fixture](ui/shared-electron.ts). Each adapter owns one process per
worker and `launchKey`. A common worker pool retains separate apps for each
adapter and key, so compatible specs share the worker's runtime bundle. Include
every process-level option in that key when adding variants, including scale
factor, fixture mode and environment overrides.
The remaining specs retain their existing launch lifetime.

Before reuse, the adapter destroys prior windows and guests, releases browser
registrations and upload state, clears browser partition storage and cache, and
recreates its fixture baseline. It verifies window and guest counts, visibility,
focus, zoom, scroll, page state, cookies and web storage before handing the app to
the test. These standalone apps have no application settings or conversation
store. A full application adapter must restore both stores before opting in.

A crashed process or failed reset triggers one fresh launch and a visible
`app-relaunched` annotation with the failure reason. The replacement must pass
the same clean-state assertion or the test fails before its body runs. Cleanup
errors propagate. The worker closes owned processes serially on completion.

Tests carrying `isolated-app` retain dedicated launches for process-wide
instrumentation, native focus, window lifecycle or conversation/clipboard state.
First-run, restart, crash, keychain and packaged-mode tests must retain dedicated
launches when extending this fixture to another family.

Check repeated execution and shuffled intra-file ordering with the converted
specs and `--repeat-each=2 --fully-parallel --workers=1 --shuffle 534`. Confirm
the `shared-app-pid` annotations show reuse within each worker. Keep the project
`background` and the output directory inside the checkout.

Background mode is the default, and background runs may execute in parallel.
Keep every `--output` directory inside the checkout.

Run `@os-focus` cases only with `AVE_E2E_OS_FOCUS=1`. Their tagged foreground
fixtures present native windows. Rerun a focus-only failure alone before
reporting it as a regression.

The native select specs also run on an unlocked developer Mac. Selection uses
the closed control's keyboard typeahead on macOS: arrow keys open a system-owned
popup that the page input channel cannot drive. The action still verifies the
requested option and final value, and rejects navigation during selection.

When validating desktop non-interference on macOS, sample the app that
receives key events before, throughout, and after a default run, recording
timestamps and read failures. Use a separate sampler at roughly 250 ms
intervals; actual observations can be farther apart because the query itself
takes time:

```sh
osascript -l JavaScript -e 'ObjC.import("AppKit"); const f = $.NSWorkspace.sharedWorkspace.frontmostApplication; JSON.stringify({name: ObjC.unwrap(f.localizedName), pid: Number(f.processIdentifier), policy: Number(f.activationPolicy)})'
```

Do not use System Events' `frontmost` process for this: it never reports an
accessory app, even one that has been activated and is receiving the owner's
keystrokes. No sample should name a test app process. Sampling has gaps and is evidence of the
observed interval, not proof of every foreground transition. The background
keyboard spec independently checks document focus, focus-visible, native window
non-focus, rejection of synthetic key events and acceptance of page keyboard
input by the real permission mutation gate.
