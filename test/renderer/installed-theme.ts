/**
 * Test fixture: an installed theme package as the renderer sees it, and the
 * installed-content view that carries it. An installed theme has surfaces, so
 * ThemeProvider writes its tokens on :root inline — the values a consumer that
 * copies theme colors reads back.
 */
import { moonstoneBundle } from "../../src/ui/renderer/theme/bundles/moonstone.js";
import type { ThemeBundle } from "../../src/ui/renderer/theme/bundles/index.js";
import type { InstalledContentApi, InstalledContentView } from "../../src/shared/installed-content.js";
import { THEME_SURFACE_NAMES } from "../../src/shared/theme-tokens.js";

const SURFACES = Object.fromEntries(THEME_SURFACE_NAMES.map((name) => [name, "210 40% 12%"])) as NonNullable<ThemeBundle["surfaces"]>;

/** An installed theme `id` of `shell`, Moonstone's tokens with `tokens` over them. */
export function installedTheme(
  id: string,
  shell: "light" | "dark",
  tokens: Partial<ThemeBundle["tokens"]> = {},
  pair?: string,
): ThemeBundle {
  return {
    ...moonstoneBundle,
    id,
    name: id,
    shell,
    highContrast: false,
    tokens: { ...moonstoneBundle.tokens, ...tokens },
    surfaces: SURFACES,
    ...(pair ? { pair } : {}),
  };
}

/** The installed-content view holding exactly `themes`. */
export function installedThemeContent(themes: readonly ThemeBundle[]): InstalledContentView {
  return { themes: themes.map((theme) => ({ ...theme, preview: null })), languages: [], fonts: [], routineTemplates: [], broken: [] } as unknown as InstalledContentView;
}

/** A bridge for `applyInstalledContent` when nothing reads a language catalog. */
export const NO_LANGUAGE_BRIDGE = { installed: async () => ({ ok: false, error: "installed-content-unavailable" }), languageMessages: async () => ({ ok: false, error: "language-not-installed" }) } as unknown as InstalledContentApi;
