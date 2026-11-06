# Appearance

Appearance consists of a mode (`system`, `dark`, or `light`), one saved dark scheme, one saved light scheme, UI font preferences, and terminal font preferences. The persisted contract and defaults live in [`appearance-settings.ts`](../../src/shared/appearance-settings.ts).

System mode selects the saved scheme matching `prefers-color-scheme` and updates when the OS changes. Explicit dark or light mode uses that side's saved scheme. Independent selections avoid pair metadata and allow every curated scheme to work in System mode.

## Schemes and rendering

The committed palette data and its licence notices live under [`theme/schemes/`](../../src/ui/renderer/theme/schemes/). Builds do not fetch schemes. Each scheme supplies the terminal background, foreground, cursor, selection, and sixteen ANSI colours.

The theme resolver derives the UI surface ladder with OKLCH mixing. Muted text lightness is adjusted until it reaches at least 4.5:1 contrast against every text-bearing surface. The [scheme tests](../../src/ui/renderer/theme/__tests__/schemes.test.ts) verify page, card, popover, inset, secondary, accent, message, input, code, and depth surfaces. The resolver throws if the permitted text lightness cannot reach the threshold. UI components consume the existing semantic HSL tokens through Tailwind utilities rather than palette literals.

The provider applies the selected scheme and broadcasts updates to other host surfaces. MCP Apps read the applied theme, so their mode and tokens come from the same revision. Plugin webviews retain the existing theme notification and in-memory replay contract; marketplace theme packages are not supported.

## Persistence and first paint

Released schema 2 is migrated once to schema 3: mode becomes System, with `github-dark` and `github-light` as the saved selections. All former bundle selections reset, including package themes. UI font and language preferences are retained; terminal font preferences start at the shared defaults. Obsolete bundle and pairing fields are removed by automatic writeback.

Main normalizes the saved settings synchronously and passes appearance preferences to preload before the document loads. Missing or malformed disk settings use the shared defaults; invalid internal argument payloads throw. Preload reads the OS media query for System mode. Preload and the provider use the same appearance application function, including UI font variables. Initial rendering does not depend on installed content or a plugin theme cache.

Terminal font family, size, and line height are applied to every mounted terminal and preview. Changing them does not recreate a terminal session.

## Verification

Run focused tests with `AVE_TEST_TMP_ROOT=<isolated-directory> AVE_VITEST_MAX_WORKERS=1 bun run test:vitest -- <files>`. The local [appearance UI spec](../../test/e2e/ui/appearance-schemes.spec.ts), run with `bun run test:ui-e2e -- test/e2e/ui/appearance-schemes.spec.ts`, covers mode selection, scheme selection, and settings navigation. Isolated application launches provide first-paint and visual evidence; never use a real user data home for these checks.

See [product vision](../vision/README.md) and [process boundaries](../architecture/architecture.md#process-boundaries) for the surrounding contracts.
