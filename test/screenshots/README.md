# Screenshot capture harness

Automated Playwright-driven capture of the Electron app screens used by the
docs site (`former-site.invalid/lib/screenshots.ts`, 71 keys total). Captures the
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
keyed by the exact same string keys as `shots` in
`former-site.invalid/lib/screenshots.ts`. `test/screenshots/capture.spec.ts` generates
one Playwright test per entry (`capture: <key>`), so:

- `bunx playwright test --config test/screenshots/playwright.config.ts --grep local-indexer-home`
  re-runs (or, today, skip-reports) exactly one key.
- Adding a new docs-site key means adding one matrix entry — no spec-file
  editing required.

Each entry is one of:

- **Capturable** — `steps(ctx)` navigates/seeds state, optional `locator`
  scopes the capture to one element (omit for a full-window shot).
- **Skipped** — `skip: "<reason>"`. Surfaces as Playwright's native "skipped"
  status in the report (not silently dropped from the run).

## Window size

Fixed at **1600x1000** (`CAPTURE_VIEWPORT` in `fixtures.ts`). This was *not*
picked to match any single existing screenshot — inspecting a sample of
`former-site.invalid/public/screenshots/*.png` showed **inconsistent aspect ratios**
per file (e.g. `chat-todo-queue.png` is 1600x830 ≈1.93:1, `chat-plugin-panel.png`
is 484x889 ≈0.54:1, `ah-dashboard.png` is 1130x325 ≈3.48:1) — each existing
asset was clearly cropped to its own target element/region after capture, not
captured at one fixed app window size. 1600x1000 is wide enough to show the
expanded work-mode rail + full chat column without clipping, and gives full
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
**work mode** (the harness default) the panel opens inline, so it is
screenshottable; the plugin's view renders inside an Electron `<webview>`.

## Skip list

### App screens the harness cannot seed (marked `skip` in matrix.ts)

| Key(s) | Reason |
|---|---|
| `chat-todo-queue`, `chat-tool-thinking`, `chat-permission-llm-review`, `chat-permission-directory`, `chat-permission-risk`, `chat-question-card` | Require an **in-flight LLM turn** (tool calls, reviewer deferrals, thinking-token streaming, ask-user cards). No deterministic mock-provider turn exists in this repo today — would need a scripted fake-provider fixture. |
| `meeting-record`, `meeting-record-stt`, `meeting-outlook-mail*` (2 keys) | Need live audio, a completed STT recording or Outlook OAuth. |
| `outlook-login-trigger`, `outlook-login-window`, `outlook-login-after`, `outlook-logout` | Every reachable state is past the live Microsoft OAuth window. |
| `vega-helper-*` (6 keys) | **Host-rendered notification cards** emitted when a detector fires on a real external signal; nothing in the harness can fire one. |
| `agent-hub-my-work`, `agent-hub-team-board` | **No agent-hub plugin bundle exists**; nothing to install. |

### Capturable today

| Key | Notes |
|---|---|
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

### Out of scope: web/server keys

`ah-dashboard`/`ah-workboard`/`ah-worklog`/`ah-inbox`/
`ah-report`/`ah-subscription` (Agent Hub **server** dashboard — distinct from
the `agent-hub-my-work`/`agent-hub-team-board` **plugin** panel keys, which
render inside this Electron app), and `ep-*` (internal ORION portal) are
**web/server screens** rendered by a separate Next.js app, not the Electron
host. They are intentionally absent from `matrix.ts`'s `scenarios` map
entirely (listed separately in `WEB_SERVER_KEYS_OUT_OF_SCOPE` for
completeness) — this harness has no way to launch or seed that app, and doing
so was explicitly out of scope for this task.

## Re-running after theme changes

This branch (`feat/ui-depth-tokens`) changes `src/styles.css` / theme bundles /
shadcn primitives. This harness does not touch any of those files — it just
needs `bun run build` run first so the current theme is compiled into the
bundle before capture (the plugin-panel captures show the moonstone default).
Re-run the full matrix (`node scripts/capture-screenshots.mjs`) after any theme
change to refresh the PNGs against the final theme.
