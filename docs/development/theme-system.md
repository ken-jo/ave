# Theme System

Status: Current. Source of truth: `src/styles.css` (tokens),
`src/shared/theme-tokens.ts` (token names and contrast rules),
`src/shared/theme-bundles.ts` (compiled bundle ids), and
`src/ui/renderer/theme/` (provider, registry, plugin token map).

Components never hard-code reusable colors, focus rings, motion timings, or
elevation. They consume semantic tokens through Tailwind utilities, and a theme
is a remapping of those tokens. Switching themes requires no component change.
Visual direction lives in [DESIGN.md](../DESIGN.md).

## Token tiers

The header comment in `src/styles.css` names three tiers:

| Tier | Example | Where |
|---|---|---|
| A. Primitives | `--p-blue-500`, `--p-slate-900` | `:root` in `@layer base`. Raw HSL triples, reference palette only. |
| B. Semantic | `--background`, `--foreground`, `--primary`, `--muted-foreground`, `--border`, `--ring`, `--destructive`, `--warning`, `--success`, `--info`, `--input-bar-*`, `--message-user-*` | Every `:root[data-theme-bundle="<id>"]` block. |
| C. Code surface | `--code-bg`, `--code-fg`, `--code-border` | Same bundle blocks; remaps independently of the shell. |

Rules of the pattern:

- Token values are bare HSL triples (`"H S% L%"`, no `hsl()` wrapper) so
  Tailwind's alpha syntax keeps working.
- Each bundle block is self-contained: it defines every semantic token with a
  literal value and does not chain through `var(--p-*)`.
- The `@theme inline` block at the top of `src/styles.css` exposes semantic
  tokens as Tailwind colors (`--color-background: hsl(var(--background))`), so
  `bg-background`, `text-muted-foreground`, `border-border` resolve at run
  time and repaint without a rebuild.
- Components read only Tier B/C tokens via utilities, never `--p-*`.
- A plain `:root` block after the bundle blocks mirrors the default bundle so
  frame 0 paints correctly before the provider sets `data-theme-bundle`.

Non-color tokens shared by every bundle:

- Depth: surface ladder `--surface-sunken`, `--surface`, `--surface-raised`,
  `--surface-overlay`, plus `--border-subtle` / `--border-strong`
  (`bg-surface-*`, `border-border-*`); elevation shadows `shadow-e1` to
  `shadow-e4`, defined per bundle.
- Hairlines and elevation: `--surface-hairline`, `--surface-hairline-strong`,
  `--elevation-raised`, `--elevation-floating`, with utilities
  `.ave-surface-hairline`, `.ave-surface-raised`, `.ave-surface-floating`.
  New floating panels and rails use these instead of raw `shadow-xl`.
- Motion: `--motion-fast`, `--motion-normal` (`--motion-base` aliases it),
  `--motion-slow`, `--motion-layout`, `--motion-ease-out`,
  `--motion-ease-standard`, `--motion-ease-in-out`. Under
  `prefers-reduced-motion: reduce` every duration becomes `1ms` and every
  easing `linear`.
- Opacity scale: `--opacity-faint` (5%) through `--opacity-solid` (95%). Use
  the variable alpha shorthand, for example `bg-warning/(--opacity-soft)`.

## Bundles and installed themes

- Compiled bundles: `BUNDLE_IDS` in `src/shared/theme-bundles.ts`
  (`moonstone`, the default, and `gallery`). Each has a CSS block in
  `src/styles.css` and a `ThemeBundle` module in
  `src/ui/renderer/theme/bundles/`, registered in `bundles/index.ts`.
- Installed themes are marketplace theme packages (`theme.json`). They carry
  the same token names plus the surface ladder, pass the same token and
  contrast checks (`themeTokenProblems`, `THEME_CONTRAST_RULES`), and are
  applied as inline custom properties on `:root` because they have no CSS
  block. They cannot reuse a compiled id. See the
  [marketplace design](../design/multi-source-git-marketplace.md#55-installed-content-in-the-app).
- `ThemeBundle` fields: `id`, `name`, `description`, `shell` (`light` |
  `dark`), `highContrast`, `tokens`, optional `pair` and (installed only)
  `surfaces`.
- `followSystem` is a boolean, not a bundle. When the selected theme declares a
  `pair` of the other shell, the provider follows
  `prefers-color-scheme` live. Picking a paired theme explicitly turns
  `followSystem` off.

## Provider and persistence

```
settings.appearance { schemaVersion: 2, bundleId, followSystem }
        |
ThemeProvider (src/ui/renderer/theme/ThemeProvider.tsx)
        |  applyBundleToDocument (resolve-theme.ts)
<html data-theme-bundle="<id>" data-shell="light|dark" class="ave-bundle-<id>">
        |
:root[data-theme-bundle] block in styles.css (or inline properties for an installed theme)
```

- Frame 0: main serializes the cached theme into the window's
  `--ave-initial-theme=` argument (`initialThemeArgs()` in
  `src/main/main-window.ts`; wire format in `src/shared/initial-theme.ts`,
  16 KiB cap). The preload exposes it as `window.__aveInitialTheme`; the
  provider uses it before settings load. It also carries the user font scale
  and family.
- The provider then reads `api.getSettings()`; a failed read keeps the
  default bundle. An unknown or uninstalled id falls back to the default.
- `setBundle()` applies immediately and persists
  `{ appearance: { schemaVersion: 2, bundleId } }` in the background.
- `useOptionalTheme()` returns `null` without a provider (isolated tests).
- Settings UI: `src/ui/renderer/tabs/AppearanceTab.tsx`, rendered from the
  registry (`visibleBundles()`); no hard-coded option list.

## How plugin UIs receive the host theme

Plugin webviews do not share the host stylesheet. They receive a flat map of
`--ave-*` custom properties.

1. On each applied bundle change the provider calls
   `bundleToPluginTokens(bundle)` (`src/ui/renderer/theme/plugin-token-map.ts`)
   and sends `{ bundleId, shell, tokens }` with `api.notifyPluginTheme`.
   Values are full CSS values (`hsl(...)`, `hsla(...)`, `color-mix(...)`,
   lengths, durations, easings), not bare triples.
2. Main validates the payload (`validateThemePayload` in
   `src/shared/plugin-theme-cache.ts`): the bundle id must be compiled or
   installed, the shell `light` or `dark`, token names must be in
   `AVE_TOKEN_NAMES` (`src/shared/plugin-ui-tokens.ts`), and each value must
   match a strict grammar (color, single `color-mix` of two colors, length,
   weight, duration, `cubic-bezier`). Invalid tokens are dropped. The result is
   cached and broadcast as the `host.theme.changed` event to every registered
   plugin webview and to host-side event subscribers
   (`src/ipc/domains/plugins.ts`).
3. A webview registered later gets the cached payload replayed. The plugin
   preload (`src/plugin-preload.ts`) buffers the latest `host.theme.changed`
   and replays it to any `onEvent` subscriber that attaches afterwards.
4. Before importing the plugin entry, `src/plugin-ui-shell.js` pulls
   `avePlugin.getTheme()` and writes the `--ave-*` tokens inline on
   `documentElement`, so the first plugin paint uses host colors. `getTheme`
   returns `null` only before the host's first broadcast; plugins keep their
   own static fallback CSS for that window.
5. Fonts are not broadcast. `src/plugin-ui-shell.html` mirrors the host font
   stack (`src/shared/host-font-stack.ts`).

A plugin consumes `var(--ave-*)` in its CSS and, for live changes, subscribes
to `host.theme.changed`. Prefer the derived tokens over local mixes:

| Token | Intent | Mix (light / dark / high contrast) |
|---|---|---|
| `--ave-primary-bg-subtle` | Tinted primary surface | primary over card, 14% / 18% / 24% |
| `--ave-primary-bg-strong` | Hover/active of subtle | 28% / 32% / 40% |
| `--ave-danger-bg-subtle`, `--ave-warning-bg-subtle`, `--ave-success-bg-subtle` | Status tints | over transparent, 14% (24% high contrast) |
| `--ave-surface-hover` | Hover highlight | foreground over secondary, 6% / 10% / 14% |
| `--ave-focus-shadow` | Focus ring color | ring over transparent, 62% |

The floating dock and MCP app cards follow the same applied theme through their
own channels; see [Process Boundaries](../architecture/architecture.md#process-boundaries).

## Adding a semantic token

1. Choose a meaning-based name (`info`, not `cyan`), usually a
   background/foreground pair.
2. Add it to `THEME_TOKEN_NAMES` in `src/shared/theme-tokens.ts`. Typecheck then
   requires it in every compiled `ThemeBundle` module, and installed themes
   must supply it.
3. Add a literal triple to every `:root[data-theme-bundle]` block and to the
   pre-hydration `:root` block in `src/styles.css`.
4. Expose it in `@theme inline`: `--color-info: hsl(var(--info));`.
5. If it must reach plugins, add an `--ave-*` name to `AVE_TOKEN_NAMES` and map
   it in `bundleToPluginTokens`.
6. Add a rule to `THEME_CONTRAST_RULES` when it is a text/background pair.

## Adding a compiled bundle

1. Add the id to `BUNDLE_IDS` in `src/shared/theme-bundles.ts`.
2. Add a `ThemeBundle` module in `src/ui/renderer/theme/bundles/` and register
   it in `COMPILED_BUNDLES` in `bundles/index.ts`.
3. Add a full `:root[data-theme-bundle="<id>"]` block in `src/styles.css`,
   including surfaces, shadows, `--radius`, and `color-scheme`.
4. Run the targeted tests below plus typecheck.

Most new themes should ship as an installed theme package instead.

## Component rules

- Surfaces: `bg-background` (page), `bg-card` or the `bg-surface-*` ladder
  (panels), `bg-muted` with an opacity token (inset rows).
- Text: `text-foreground`; secondary `text-muted-foreground`; on brand
  surfaces `text-primary-foreground`.
- Status: `text-destructive`, `text-warning`, `text-success`, `text-info`,
  with opacity-token tints for backgrounds.
- Focus: `ring-ring`, already wired into the primitives.
- Page chrome: `PageShell` and `SettingsSection`
  (`src/ui/renderer/components/PageShell.tsx`), not nested cards.
- Controls: compose the registry primitives in `src/components/ui/` (registry
  config in `components.json`); do not restyle native controls per feature.
- Not allowed: `text-white`/`text-black`, Tailwind palette classes such as
  `bg-slate-800`, hex or `hsl(<number> ...)` literals in styles, `dark:`
  overrides, and raw numeric alpha such as `bg-warning/15`.

## Enforcement

- `scripts/check-color-tokens.mjs` - rejects raw color literals and palette
  gradient classes in renderer source (allow-list for grandfathered files).
- `scripts/check-opacity-tokens.mjs` - rejects raw numeric alpha modifiers.
- `scripts/check-shell-geometry-tokens.mjs` - keeps `src/styles.css` geometry
  tokens equal to `src/shared/shell-geometry.ts`.
  All three run in `bun run build`.
- `src/ui/renderer/theme/bundles/__tests__/bundles.test.ts` - registry, required
  token keys, triple format, shell consistency.
- `src/ui/renderer/theme/bundles/__tests__/contrast.test.ts` - contrast rules
  for every compiled bundle.
- `src/ui/renderer/theme/__tests__/plugin-token-map.test.ts` - plugin token
  derivation.
- `src/ui/renderer/theme/__tests__/ThemeProvider-initial-theme.test.tsx`,
  `src/ui/renderer/__tests__/theme-provider.test.tsx`,
  `src/ui/renderer/__tests__/appearance-tab.test.tsx` - provider and settings UI.

## Related

- [DESIGN.md](../DESIGN.md)
- [Architecture: Process Boundaries](../architecture/architecture.md#process-boundaries)
- [Marketplace: installed content](../design/multi-source-git-marketplace.md#55-installed-content-in-the-app)
- [Plugin tool schema design](../references/plugin-tool-schema-design.md)
- [Product vision](../vision/README.md)
