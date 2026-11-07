/**
 * Locale catalog registry: English is eager; Korean loads on demand.
 * Each built-in locale has one hand-written catalog, grouped by namespace.
 */
import { en } from "./en.js";
import { DEFAULT_LOCALE, SUPPORTED_LOCALES, type Locale } from "../locale.js";

/**
 * Any translation key. The key space is open (`string`): lookups fall back
 * to English and then to the key itself, so an unknown key is visible.
 */
export type MessageKey = string;

/** A message catalog: every key mapped to a localized string. */
export type Messages = Record<string, string>;

export type MessageRegistry = Partial<Record<Locale, Messages>> & {
  en: Messages;
};

/**
 * Loaded catalogs, keyed by locale. Only English is eager: the global default
 * UI language and fallback catalog must be synchronous. Every other locale is
 * a compiled catalog loaded on demand.
 */
export const messages: MessageRegistry = {
  en,
};

type LazyLocale = Exclude<(typeof SUPPORTED_LOCALES)[number], "en">;

const lazyLocales: readonly LazyLocale[] = SUPPORTED_LOCALES.filter(
  (locale): locale is LazyLocale => locale !== DEFAULT_LOCALE,
);

const localeLoaders: Record<LazyLocale, () => Promise<Messages>> = {
  async ko() {
    const { ko } = await import(/* webpackChunkName: "i18n-ko" */ "./ko.js");
    return ko;
  },
};

const pendingLoads = new Map<Locale, Promise<Messages>>();

export function isLocaleMessagesLoaded(locale: Locale): boolean {
  return messages[locale] !== undefined;
}

export async function loadLocaleMessages(locale: Locale): Promise<Messages> {
  const existing = messages[locale];
  if (existing) return existing;
  const pending = pendingLoads.get(locale);
  if (pending) return pending;
  const loader = Object.hasOwn(localeLoaders, locale) ? localeLoaders[locale as LazyLocale] : undefined;
  if (!loader) throw new Error(`no catalog for locale ${locale}`);
  const next = loader().then((catalog) => {
    messages[locale] = catalog;
    pendingLoads.delete(locale);
    return catalog;
  }, (err) => {
    pendingLoads.delete(locale);
    throw err;
  });
  pendingLoads.set(locale, next);
  return next;
}

export async function tryLoadLocaleMessages(locale: Locale): Promise<boolean> {
  try {
    await loadLocaleMessages(locale);
    return true;
  } catch {
    if (locale !== DEFAULT_LOCALE) {
      await loadLocaleMessages(DEFAULT_LOCALE);
    }
    return false;
  }
}

/** Every built-in catalog (tests and the catalog parity checks). */
export async function loadAllLocaleMessages(): Promise<Record<Locale, Messages>> {
  await Promise.all(SUPPORTED_LOCALES.map((locale) => loadLocaleMessages(locale)));
  return messages as Record<Locale, Messages>;
}

/** @internal Test-only reset for suites that assert lazy initial state. */
export function __resetLazyLocaleMessagesForTest(): void {
  for (const locale of lazyLocales) {
    delete messages[locale];
    pendingLoads.delete(locale);
  }
}

/** @internal Test-only loader override for pending/error-path coverage. */
export function __setLocaleLoaderForTest(
  locale: LazyLocale,
  loader: () => Promise<Messages>,
): () => void {
  const previous = localeLoaders[locale];
  localeLoaders[locale] = loader;
  delete messages[locale];
  pendingLoads.delete(locale);
  return () => {
    localeLoaders[locale] = previous;
    delete messages[locale];
    pendingLoads.delete(locale);
  };
}
