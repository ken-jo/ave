// Installed theme tokens are written inline on the root for consumers to read back.
import { moonstoneBundle } from "../../src/ui/renderer/theme/bundles/moonstone.js";
import type { ThemeBundle } from "../../src/ui/renderer/theme/bundles/index.js";
import type { InstalledContentApi, InstalledContentView } from "../../src/shared/installed-content.js";
import { THEME_SURFACE_NAMES } from "../../src/shared/theme-tokens.js";

const SURFACES = Object.fromEntries(THEME_SURFACE_NAMES.map((name) => [name, "210 40% 12%"])) as NonNullable<ThemeBundle["surfaces"]>;

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

export function installedThemeContent(themes: readonly ThemeBundle[]): InstalledContentView {
  return { themes: themes.map((theme) => ({ ...theme, preview: null })), languages: [], fonts: [], routineTemplates: [], broken: [] } as unknown as InstalledContentView;
}

export const NO_LANGUAGE_BRIDGE = { installed: async () => ({ ok: false, error: "installed-content-unavailable" }), languageMessages: async () => ({ ok: false, error: "language-not-installed" }) } as unknown as InstalledContentApi;
