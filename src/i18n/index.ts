/**
 * i18n barrel — process-agnostic surface (no React).
 *
 * Import from here in main-process and shared code:
 *   `import { t, setLocale } from "../i18n/index.js";`
 * Renderer React code additionally imports `./react.js` for the provider/hook.
 */
export {
  DEFAULT_VISIBLE_LOCALES,
  DEFAULT_LOCALE,
  LOCALE_INFO,
  MARKETPLACE_ELIGIBLE_LOCALES,
  SUPPORTED_LOCALES,
  isDefaultVisibleLocale,
  isInstalledLocale,
  isLocale,
  isMarketplaceEligibleLocale,
  localeInfo,
  normalizeLocale,
  normalizeLocaleSetting,
  registerInstalledLocales,
  recommendedMarketplaceLocaleForSystem,
  visibleLocalesFor,
  type Locale,
} from "./locale.js";
export { getLocale, onLocaleChange, setLocale, t } from "./runtime.js";
export { interpolate, translate, type TranslationVars } from "./translate.js";
export {
  isLocaleMessagesLoaded,
  loadAllLocaleMessages,
  loadLocaleMessages,
  setInstalledCatalogLoader,
  tryLoadLocaleMessages,
  type MessageKey,
  type Messages,
} from "./messages/index.js";
