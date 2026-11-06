/**
 * i18n locale definitions — single source of truth for UI languages.
 *
 * Ave exposes every compiled UI locale out of the box and follows the system
 * language on fresh installs, falling back to English. Only compiled catalogs
 * can supply interface messages.
 *
 * This module is intentionally dependency-free so it can be imported from the
 * Electron main process, the renderer, and vitest without pulling in React or
 * Node-only APIs.
 */

/** Locales compiled into the app. */
export const SUPPORTED_LOCALES = ["en", "ko"] as const;

type BuiltInLocale = (typeof SUPPORTED_LOCALES)[number];

/** Internal locale values always name a compiled catalog. */
export type Locale = BuiltInLocale;

/** Fallback UI locale when the requested language is unavailable. */
export const DEFAULT_LOCALE = "en" satisfies BuiltInLocale;

/** Legacy package identities remain valid independently of built-in visibility. */
export const OFFICIAL_PACKAGE_LOCALES = ["ko"] as const satisfies readonly BuiltInLocale[];

export type OfficialPackageLocale = (typeof OFFICIAL_PACKAGE_LOCALES)[number];

const OFFICIAL_PACKAGE_LOCALE_SET = new Set<string>(OFFICIAL_PACKAGE_LOCALES);

interface LocaleInfo {
  /** Shown to users in their own language. */
  nativeName: string;
  /** A stable label for logs and fallback. */
  englishName: string;
}

/** Display metadata of the built-in locales. */
const LOCALE_INFO: Record<BuiltInLocale, LocaleInfo> = {
  en: { nativeName: "English", englishName: "English" },
  ko: { nativeName: "한국어", englishName: "Korean" },
};

/** Display metadata for a compiled locale. */
export function localeInfo(locale: string): LocaleInfo | undefined {
  return Object.hasOwn(LOCALE_INFO, locale) ? LOCALE_INFO[locale as BuiltInLocale] : undefined;
}

/** Type guard: is `value` a compiled locale? */
export function isLocale(value: unknown): value is Locale {
  return isDefaultVisibleLocale(value);
}

export function isDefaultVisibleLocale(
  value: unknown,
): value is BuiltInLocale {
  return (
    typeof value === "string" &&
    (SUPPORTED_LOCALES as readonly string[]).includes(value)
  );
}

export function isOfficialPackageLocale(
  value: unknown,
): value is OfficialPackageLocale {
  return (
    typeof value === "string" &&
    OFFICIAL_PACKAGE_LOCALE_SET.has(value)
  );
}

/**
 * Coerce an arbitrary value (settings field, env var, navigator.language, …)
 * into a locale this process can render, falling back to {@link DEFAULT_LOCALE}.
 *
 * Region tags use their compiled primary language, so a stored `"en-US"`
 * resolves to `"en"`.
 */
export function normalizeLocale(value: unknown): Locale {
  if (typeof value !== "string") return DEFAULT_LOCALE;
  if (isDefaultVisibleLocale(value)) return value;
  const primary = value.toLowerCase().split(/[-_]/)[0]!;
  return isDefaultVisibleLocale(primary) ? primary : DEFAULT_LOCALE;
}

/** Resolve persisted values through the same unsupported-locale fallback. */
export function normalizeLocaleSetting(value: unknown): Locale {
  return normalizeLocale(value);
}

export function visibleLocalesFor(): Locale[] {
  return [...SUPPORTED_LOCALES];
}
