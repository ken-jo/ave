/** Each bundle defines every semantic token explicitly; runtime rendering needs no primitive-token chains. */
import type { ThemeSurfaces, ThemeTokens } from "../../../../shared/theme-tokens.js";

export interface ThemeBundle {
  /** Unique stable identifier written to `data-theme-bundle`: a compiled-in `BundleId`, or an installed theme package's name. */
  id: string;
  /** Display name shown in the AppearanceTab card. */
  name: string;
  /** Short description used as accessible tooltip / subtitle. */
  description: string;
  /** Shell color scheme — drives `color-scheme` CSS property. */
  shell: "light" | "dark";
  /** When true this bundle is always displayed; never auto-suggested. */
  highContrast: boolean;
  /** Complete semantic token payload for this bundle (names and value form: `shared/theme-tokens.ts`). */
  tokens: ThemeTokens;
  /** An installed theme's depth ladder. Present only on installed themes: a compiled bundle's surfaces live in its
   * `styles.css` block, and an installed one is applied as inline custom properties instead. */
  surfaces?: ThemeSurfaces;
  /** The theme of the other shell `followSystem` switches to with this one, as an installed theme package declares it.
   * Compiled bundles have none. */
  pair?: string;
}
