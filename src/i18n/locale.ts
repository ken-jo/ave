/**
 * i18n locale definitions — single source of truth for UI languages.
 *
 * Ave ships a global build with English as the default UI language. The
 * built-in locales have complete compiled catalogs; every other language is
 * an installed language package (design §5.2, blueprint 3.3) whose catalog is
 * layered over English, registered here at runtime by the process that loaded
 * it. The registry is open: a locale is any BCP 47 tag a built-in catalog or
 * an installed package provides.
 *
 * This module is intentionally dependency-free so it can be imported from the
 * Electron main process, the renderer, and vitest without pulling in React or
 * Node-only APIs.
 */

/** Locales compiled into the app. */
export const SUPPORTED_LOCALES = ["en", "ko"] as const;

type BuiltInLocale = (typeof SUPPORTED_LOCALES)[number];

/** A UI locale: a built-in one, or the BCP 47 tag of an installed language package. */
export type Locale = string;

/** Default UI locale for the global build. English-first. */
export const DEFAULT_LOCALE = "en" satisfies BuiltInLocale;

/**
 * Locales shown in the default in-app language picker. Every other built-in
 * locale is a marketplace language pack, lazily loaded once installed.
 */
export const DEFAULT_VISIBLE_LOCALES = ["en"] as const satisfies readonly BuiltInLocale[];

export type DefaultVisibleLocale = (typeof DEFAULT_VISIBLE_LOCALES)[number];

const DEFAULT_VISIBLE_LOCALE_SET = new Set<string>(DEFAULT_VISIBLE_LOCALES);

export type MarketplaceEligibleLocale = Exclude<BuiltInLocale, DefaultVisibleLocale>;

export const MARKETPLACE_ELIGIBLE_LOCALES = SUPPORTED_LOCALES.filter(
  (locale): locale is MarketplaceEligibleLocale =>
    !DEFAULT_VISIBLE_LOCALE_SET.has(locale),
);

const MARKETPLACE_ELIGIBLE_LOCALE_SET = new Set<string>(
  MARKETPLACE_ELIGIBLE_LOCALES,
);

interface LocaleInfo {
  /** Shown to users in their own language. */
  nativeName: string;
  /** A stable label for logs and fallback. */
  englishName: string;
}

/** Display metadata of the built-in locales; {@link localeInfo} covers installed ones too. */
export const LOCALE_INFO: Record<BuiltInLocale, LocaleInfo> = {
  en: { nativeName: "English", englishName: "English" },
  ko: { nativeName: "한국어", englishName: "Korean" },
};

const installedLocales = new Map<string, LocaleInfo>();

/** The descriptor schema's `languagePayload.locale` pattern. */
const LOCALE_TAG = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|[0-9]{3}))?$/u;

/** Whether `value` has the form of a language package locale (it may not be installed). */
function isLocaleTag(value: unknown): value is string {
  return typeof value === "string" && LOCALE_TAG.test(value);
}

/**
 * Replace the installed language packages this process knows. English cannot
 * be installed; an installed built-in locale (a newer Korean package) takes
 * the place of the compiled one.
 */
export function registerInstalledLocales(locales: ReadonlyArray<{ locale: string } & LocaleInfo>): void {
  installedLocales.clear();
  for (const { locale, nativeName, englishName } of locales) {
    if (!isLocaleTag(locale) || locale === DEFAULT_LOCALE) throw new Error(`cannot register locale ${locale}`);
    installedLocales.set(locale, { nativeName, englishName });
  }
}

/** Whether `locale` comes from an installed language package. */
export function isInstalledLocale(locale: string): boolean {
  return installedLocales.has(locale);
}

/** Display metadata for a built-in or installed locale. */
export function localeInfo(locale: string): LocaleInfo | undefined {
  return installedLocales.get(locale) ?? (Object.hasOwn(LOCALE_INFO, locale) ? LOCALE_INFO[locale as BuiltInLocale] : undefined);
}

function renderable(locale: string): boolean {
  return (SUPPORTED_LOCALES as readonly string[]).includes(locale) || installedLocales.has(locale);
}

/** Type guard: is `value` a locale this process can render (built in or installed)? */
export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && renderable(value);
}

export function isDefaultVisibleLocale(
  value: unknown,
): value is DefaultVisibleLocale {
  return (
    typeof value === "string" &&
    DEFAULT_VISIBLE_LOCALE_SET.has(value)
  );
}

export function isMarketplaceEligibleLocale(
  value: unknown,
): value is MarketplaceEligibleLocale {
  return (
    typeof value === "string" &&
    MARKETPLACE_ELIGIBLE_LOCALE_SET.has(value)
  );
}

/**
 * Coerce an arbitrary value (settings field, env var, navigator.language, …)
 * into a locale this process can render, falling back to {@link DEFAULT_LOCALE}.
 *
 * An exact match wins (`pt-BR` when that package is installed); otherwise the
 * primary subtag is matched case-insensitively, so a stored `"en-US"` still
 * resolves to `"en"`.
 */
export function normalizeLocale(value: unknown): Locale {
  if (typeof value !== "string") return DEFAULT_LOCALE;
  if (renderable(value)) return value;
  const primary = value.toLowerCase().split(/[-_]/)[0]!;
  return renderable(primary) ? primary : DEFAULT_LOCALE;
}

/**
 * The persisted `appearance.language`: what {@link normalizeLocale} resolves,
 * except that a well-formed tag this process cannot render yet is kept — the
 * content ledger is read after settings, and an installed language must
 * survive the settings load that precedes it. Rendering still goes through
 * {@link normalizeLocale}, so a tag whose package is gone shows English.
 */
export function normalizeLocaleSetting(value: unknown): Locale {
  const resolved = normalizeLocale(value);
  if (resolved !== DEFAULT_LOCALE || value === DEFAULT_LOCALE) return resolved;
  return isLocaleTag(value) && value.split("-")[0] !== DEFAULT_LOCALE ? value : DEFAULT_LOCALE;
}

export function visibleLocalesFor(currentLocales: readonly unknown[] = []): Locale[] {
  const visible: Locale[] = [...DEFAULT_VISIBLE_LOCALES];
  for (const value of [...currentLocales, ...installedLocales.keys()]) {
    const locale = normalizeLocale(value);
    if (visible.includes(locale)) continue;
    visible.push(locale);
  }
  return visible;
}

export function recommendedMarketplaceLocaleForSystem(
  systemLocale: unknown,
  currentLocales: readonly unknown[] = [],
): MarketplaceEligibleLocale | undefined {
  const locale = normalizeLocale(systemLocale);
  if (!isMarketplaceEligibleLocale(locale)) return undefined;
  const current = visibleLocalesFor(currentLocales);
  return current.includes(locale) ? undefined : locale;
}
