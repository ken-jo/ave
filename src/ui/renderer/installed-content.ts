/** Load installed content before resolving persisted theme/language ids so valid installed selections do not fall back to
 * defaults. */
import { useSyncExternalStore } from "react";
import { DEFAULT_LOCALE, getLocale, isLocaleMessagesLoaded, registerInstalledLocales, setInstalledCatalogLoader, tryLoadLocaleMessages } from "../../i18n/index.js";
import {
  fontAlias,
  isContentAssetUrl,
  type InstalledContentApi,
  type InstalledContentView,
  type InstalledFontView,
} from "../../shared/installed-content.js";
import type { GitMarketplaceApi } from "../../shared/git-marketplace.js";
import { setInstalledThemeBundles, type ThemeBundle } from "./theme/bundles/index.js";

const EMPTY: InstalledContentView = Object.freeze({ themes: [], languages: [], fonts: [], routineTemplates: [], broken: [] }) as unknown as InstalledContentView;
const FONT_STYLE_ID = "ave-installed-fonts";

let current: InstalledContentView = EMPTY;
let pending: Promise<void> | null = null;
let offCatalogChanged: (() => void) | null = null;
let offPromptsUpdated: (() => void) | null = null;
const listeners = new Set<() => void>();

function themeBundle(view: InstalledContentView["themes"][number]): ThemeBundle {
  return {
    id: view.id,
    name: view.name,
    description: view.description,
    shell: view.shell,
    highContrast: view.highContrast,
    tokens: view.tokens,
    surfaces: view.surfaces,
    ...(view.pair ? { pair: view.pair } : {}),
  };
}

const cssString = (value: string) => `"${value.replace(/["\\]/gu, "\\$&")}"`;

/** `@font-face` rules for the installed fonts; only `ave-content://font/` URLs are written. */
export function fontFaceCss(fonts: readonly InstalledFontView[]): string {
  const rules: string[] = [];
  for (const font of fonts) {
    for (const face of font.faces) {
      if (!isContentAssetUrl(face.url, "font")) continue;
      rules.push(
        `@font-face { font-family: ${cssString(fontAlias(font.name))}; src: url(${cssString(face.url)}) format(${cssString(face.format)}); ` +
        `font-weight: ${face.weight}; font-style: ${face.style}; font-display: swap; }`,
      );
    }
  }
  return rules.join("\n");
}

function applyFonts(fonts: readonly InstalledFontView[]): void {
  if (typeof document === "undefined") return;
  let style = document.getElementById(FONT_STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = FONT_STYLE_ID;
    document.head.appendChild(style);
  }
  style.textContent = fontFaceCss(fonts);
}

/** Apply `view` to the theme, locale and font registries and tell subscribers. */
export function applyInstalledContent(view: InstalledContentView, api: InstalledContentApi): void {
  setInstalledThemeBundles(view.themes.map(themeBundle));
  registerInstalledLocales(view.languages);
  setInstalledCatalogLoader(async (locale) => {
    const result = await api.languageMessages(locale);
    if (!result.ok) throw new Error(`${locale}: ${result.error}`);
    return result.messages;
  });
  applyFonts(view.fonts);
  current = view;
  const notify = () => { for (const listener of listeners) listener(); };
  // A new loader drops the package-backed catalog of the language on screen; nothing else reloads it, so the window would
  // fall back to English on the next render.
  const active = getLocale();
  if (active !== DEFAULT_LOCALE && !isLocaleMessagesLoaded(active)) void tryLoadLocaleMessages(active).finally(notify);
  else notify();
}

/** Load the installed content once for this window. Later calls return the same promise; a bridge that is absent or answers
 * with an error leaves nothing installed, and the built-in themes and languages still apply. */
export function ensureInstalledContent(
  api: { installedContent?: InstalledContentApi; gitMarketplace?: Pick<GitMarketplaceApi, "onCatalogChanged">; onPersonaPromptsUpdated?: (handler: () => void) => () => void } | null | undefined,
): Promise<void> {
  if (pending) return pending;
  const bridge = api?.installedContent;
  if (!bridge) return Promise.resolve();
  const read = () =>
    bridge.installed().then((result) => {
      if (result.ok) applyInstalledContent(result.content, bridge);
    });
  pending = read();
  // A package installed or removed in the marketplace changes what this window lists.
  offCatalogChanged = api?.gitMarketplace?.onCatalogChanged(() => void read()) ?? null;
  offPromptsUpdated = api?.onPersonaPromptsUpdated?.(() => void read()) ?? null;
  return pending;
}

export function useInstalledContent(): InstalledContentView {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
    () => current,
  );
}

/** @internal test-only reset. */
export function resetInstalledContentForTests(): void {
  current = EMPTY;
  pending = null;
  offCatalogChanged?.();
  offCatalogChanged = null;
  offPromptsUpdated?.();
  offPromptsUpdated = null;
  setInstalledThemeBundles([]);
  registerInstalledLocales([]);
  setInstalledCatalogLoader(null);
  if (typeof document !== "undefined") document.getElementById(FONT_STYLE_ID)?.remove();
}
