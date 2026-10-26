# Screenshot capture harness

Automated Playwright-driven capture of the Electron app screens used by the
docs site. The site currently publishes no captures; the keys are kept for its
renewal. Captures the
Electron **host app** screens only — see "Out of scope" below for the rest.

## Why a separate config

This harness lives entirely under `test/screenshots/**` (plus the standalone
runner `scripts/capture-screenshots.mjs`) and does **not** modify the
`config/playwright.config.ts` or the `test/e2e/**` UI E2E suite it sits
next to. It has its own `test/screenshots/playwright.config.ts` so it never
runs as part of `bun run test:ui-e2e` — this is a docs
asset generator, not a regression suite.

It does, however, **import and reuse** helpers from `test/e2e/ui/seeded-electron.ts`
(`buildE2eBaseSettings`, `buildE2eSecrets`, `buildIsolatedElectronEnv`) so the
settings-seeding shape stays in lockstep with the E2E suite instead of
drifting via a second hand-maintained copy.

## Running

```bash
# from the worktree root — builds the app, then runs the full matrix
node scripts/capture-screenshots.mjs

# only re-run one or a few keys (Playwright --grep passthrough)
node scripts/capture-screenshots.mjs --grep chat-app-update

# skip the rebuild step if dist/src/main/main.js is already fresh
node scripts/capture-screenshots.mjs --skip-build
```

Output lands in `test/screenshots/out/<key>.png` (gitignored via
`test/screenshots/.gitignore` — these are generated artifacts, not source).

You can also invoke Playwright directly:

```bash
bunx playwright test --config test/screenshots/playwright.config.ts
bunx playwright test --config test/screenshots/playwright.config.ts --grep chat-app-update
```

## How keys map

`test/screenshots/matrix.ts` exports `scenarios: Record<string, ScenarioEntry>`,
keyed by docs-site screenshot keys. `test/screenshots/capture.spec.ts` generates
one Playwright test per entry (`capture: <key>`), so:

- `bunx playwright test --config test/screenshots/playwright.config.ts --grep chat-plugin-panel`
  re-runs exactly one key (a key with `skip` reports its skip instead).
- Adding a new docs-site key means adding one matrix entry — no spec-file
  editing required.

Each entry is one of:

- **Capturable** — `steps(ctx)` navigates/seeds state, optional `locator`
  scopes the capture to one element (omit for a full-window shot).
- **Skipped** — `skip: "<reason>"`. Surfaces as Playwright's native "skipped"
  status in the report (not silently dropped from the run).

## Window size

Fixed at **1600x1000** (`CAPTURE_VIEWPORT` in `fixtures.ts`). This was *not*
picked to match any single existing screenshot — inspecting the previously
published docs-site captures showed **inconsistent aspect ratios**
per file (e.g. `chat-todo-queue.png` is 1600x830 ≈1.93:1, `chat-plugin-panel.png`
is 484x889 ≈0.54:1) — each existing
asset was clearly cropped to its own target element/region after capture, not
captured at one fixed app window size. 1600x1000 is wide enough to show the
expanded sidebar rail + full chat column without clipping, and gives full
per-key crops (`locator`-scoped captures) plenty of source resolution.

Animations/transitions are globally killed via `page.addStyleTag` in the
`mainWindow` fixture (`transition-duration:0ms`, `animation-duration:0ms`,
`caret-color:transparent`) for deterministic frames.

## Plugins (in-repository fixtures only)

`plugin-seed.ts` installs only the fixture plugins under
`test/fixtures/e2e-plugins` (the same ones the Playwright suite seeds, written by
the shared `seed.ts`), so a capture reads nothing outside this repository: no
sibling plugin checkout, no built bundle from elsewhere, no interpreter from the
operator's own `~/.ave`. A scenario declares its needs with
`plugins: ['<fixture id>']` in `matrix.ts`; an id with no fixture fails the run.
The host loads the plugin as a **local-dev** install (unlocked by `AVE_DEV=1` +
the unpackaged build).

The view fixture (`viewfixture`) has one sidebar view. When the view mounts it
calls the fixture's tool through its bridge and shows the answer, so opening the
panel is also a plugin's first tool call.

- **Reviewer disabled** (`permissions.reviewer.mode: "disabled"` in the
  `AVE_HOME/settings.json`, with the `disabledMigratedAt` marker so it is not
  migrated back to `strict`) whenever a scenario installs plugins, so the
  reviewer's own model call cannot stall a capture. The fixture's tool is a
  write, so its call still raises the "Approve Tool Execution" card under the
  default execution mode: `chat-plugin-panel` sets `executionMode: 'allow'`,
  and `plugin-permission-grant` keeps the reviewer (`keepReviewer: true`)
  because that card IS its capture target.

Navigation to a panel goes through the sidebar rail (`openPluginPanel` in
`matrix.ts`): each rail row carries `data-viewkey="plugin:<id>:<view>"`. In
the default wide viewport the panel opens inline, so it is
screenshottable; the plugin's view renders inside an Electron `<webview>`.

## Capture coverage

### Scenarios with capture steps

Conversational scenarios use the local scripted endpoint in `fixtures.ts`.
It serves fixed responses and records unexpected requests as violations, which
fail the capture. These steps still need a successful local app run before a
new image is published.

| Key | Notes |
|---|---|
| `chat-tool-thinking` | A finished file read and the active work group's thinking status. Raw reasoning stays hidden until the turn settles; the capture keeps the group open so the tool row remains visible. |
| `chat-todo-queue`, `chat-question-card` | A seeded task list and message queue during a scripted response, or a scripted question with fixed choices. |
| `chat-permission-llm-review`, `chat-permission-directory`, `chat-permission-risk` | Scripted tool calls and reviewer replies drive the host's review and approval states. |
| `alert-*` (6 keys) | Host notification cards seeded through the alert IPC channel; action variants also run a scripted conversation. |
| `chat-app-update` | Seeded via the real `ave:update:state` IPC channel (`app.evaluate` → `webContents.send`), matching the shape in `src/shared/update-state.ts`. Captures the `[data-testid="app-update-badge-available"]` element. |
| `chat-plugin-panel` | The view fixture's sidebar panel open inline, showing its mount-time tool result (`executionMode: 'allow'`, so no approval card covers it). |
| `plugin-permission-grant` | The "Approve Tool Execution" host card raised by the view fixture's mount-time tool call (reviewer kept ON via `keepReviewer`). Cropped to `[data-testid="tool-approval-panel"]`. |
| `_smoke-settings-llm` (not a docs key — smoke-only) | Opens the inline settings panel on the model tab and captures the main app window. |

### Out of scope: other plugin repositories' own UI

`meeting-upcoming`, `meeting-minutes` (3 keys) and `local-indexer-*` (7 keys)
depict the meeting and local-indexer plugins' own panels, built from their own
repositories. A fixture cannot honestly stand in for another product's screens,
and this harness reads nothing outside this repository, so the keys are absent
from `scenarios` (listed in `PLUGIN_REPOSITORY_KEYS_OUT_OF_SCOPE`). Their
committed images stay as published; reshooting them belongs to the plugin's own
repository.

## Re-running after theme changes

Run `bun run build` after changing `src/styles.css`, theme bundles, or shared
primitives so captures use the current theme.
Re-run the full matrix (`node scripts/capture-screenshots.mjs`) after any theme
change to refresh the PNGs against the final theme.
