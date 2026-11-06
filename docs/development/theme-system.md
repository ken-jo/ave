# Appearance

Appearance consists of a mode (`system`, `dark`, or `light`), one saved dark scheme, one saved light scheme, UI font preferences, and terminal font preferences. The persisted contract and defaults live in [`appearance-settings.ts`](../../src/shared/appearance-settings.ts).

System mode selects the saved scheme matching `prefers-color-scheme` and updates when the OS changes. Explicit dark or light mode uses that side's saved scheme. Independent selections avoid pair metadata and allow every curated scheme to work in System mode.

## Schemes and rendering

The committed palette data lives under [`theme/schemes/`](../../src/ui/renderer/theme/schemes/). Attribution and licences ship from [`resources/licenses/appearance`](../../resources/licenses/appearance/) through the packaged resources inventory. Builds do not fetch schemes. Each scheme supplies the terminal background, foreground, cursor, selection, and sixteen ANSI colours.

The theme resolver derives the UI surface ladder with OKLCH mixing. Text and line lightness are adjusted without changing the palette hue: muted and body-size status text reach 4.5:1, while `ui-line` reaches 3:1 on every text-bearing surface, and selection and diff text reach 4.5:1. The [scheme tests](../../src/ui/renderer/theme/__tests__/schemes.test.ts) verify page, card, popover, inset, secondary, accent, message, input, code, and depth surfaces. The resolver throws if the permitted text lightness cannot reach the threshold. UI components consume the existing semantic HSL tokens through Tailwind utilities rather than palette literals.

The provider applies the selected scheme and publishes `host.theme.changed` to plugin webviews and the floating dock. MCP Apps read `appliedTheme` and `appliedRevision`, so their mode and tokens are copied only after that theme has been written to the document. Plugin webviews retain the complete host token notification and in-memory replay contract. Static typography, shape, spacing and motion values come from [`design-tokens.ts`](../../src/ui/renderer/theme/design-tokens.ts). [`host-theme-tokens.ts`](../../src/ui/renderer/theme/host-theme-tokens.ts) projects every declared host token; [`mcp-app-host-context.ts`](../../src/ui/renderer/components/mcp-app-host-context.ts) projects the standard embedded-app style variables, including the configured terminal font family for monospace text. Marketplace theme packages are retired: ledger records (including their consent fingerprints), update history and recorded default installs are rewritten once without theme entries. Only the retired ledger entries’ exact `.installs` directories are deleted; other installed content is retained. External catalogs skip retired theme entries; other invalid entries retain their normal validation failures.

## Persistence and first paint

Released schema 2 is migrated once to schema 3 with `github-dark` and `github-light` as the saved selections. The built-in `moonstone` and `gallery` bundles migrate to Light mode; package themes migrate to System mode. UI font and language preferences are retained; terminal font preferences start at the shared defaults. Obsolete bundle and pairing fields are removed by automatic writeback. Unknown schema versions and invalid current mode or scheme fields produce a field-named warning and reset only that field, retaining valid siblings.

At every app-renderer preload start, including reload, one synchronous IPC request reads main’s current in-memory appearance. Before services start, main reads and normalizes saved settings instead. Only an owned app window’s main frame at an allowed renderer or splash URL may use this channel. Link-window shells use their separate titlebar tokens and explicitly skip the appearance request; their window-control bridge still loads. Missing or malformed disk settings use the shared defaults; invalid internal responses throw. Preload reads the OS media query for System mode. Preload and the provider use the same appearance application function, including UI font variables. Initial rendering does not depend on installed content or a plugin theme cache.

Terminal font family, size, and line height are applied to every mounted terminal and preview. Changing them does not recreate a terminal session.

## Verification

Run focused tests with `AVE_TEST_TMP_ROOT=<isolated-directory> AVE_VITEST_MAX_WORKERS=1 bun run test:vitest -- <files>`. The local [appearance UI spec](../../test/e2e/ui/appearance-schemes.spec.ts), run with `bun run test:ui-e2e -- test/e2e/ui/appearance-schemes.spec.ts`, covers mode selection, scheme selection, and settings navigation. Isolated application launches provide first-paint and visual evidence; never use a real user data home for these checks.

See [product vision](../vision/README.md) and [process boundaries](../architecture/architecture.md#process-boundaries) for the surrounding contracts.
