/**
 * The content half of the first-boot migration (design §16.3): the theme,
 * language and provider activations the server marketplace made through
 * settings become ledger entries installed from the official source.
 *
 *   - themes: `marketplace.installedThemeBundleIds` and the selected theme
 *     ({@link legacySelectedThemes}), the package of that id;
 *   - languages: `marketplace.installedLanguagePacks`, the package
 *     {@link LEGACY_LANGUAGE_PACKAGES} names for the locale;
 *   - providers: `installedProviderIds` (the built-in vendors it unlocked)
 *     and each `installedProviderPresets` provider id, the package of that name.
 *
 * Each goes through the normal plan in adopt mode: the package files and the
 * ledger entry are written, and the settings that already describe the
 * activation stay as they are, so a provider keeps its model, address and key.
 * A theme or language the ledger now provides is then dropped from its legacy
 * list. Provider settings are the live state either way and are not dropped.
 *
 * A package already installed, from any source, is not installed again, and
 * one another installed package conflicts with (a second package for one
 * locale) is left to that package. An activation the official snapshot does
 * not list stays in settings and is logged. An install that fails is
 * reported, so the migration runs again at the next boot.
 */
import type { MarketplaceEligibleLocale } from "../../i18n/locale.js";
import { errorMessage } from "../../shared/error-message.js";
import { isBundleId, isThemeId } from "../../shared/theme-bundles.js";
import { MarketplaceError } from "../errors.js";
import { OFFICIAL_MARKETPLACE } from "../sources/official.js";
import type { PackageKey } from "../sources/policy.js";

/** The official language package for each locale the server marketplace could unlock. */
const LEGACY_LANGUAGE_PACKAGES: Readonly<Record<MarketplaceEligibleLocale, string>> = { ko: "korean" };

/**
 * The two themes the old `followSystem` alternated. Knowing them here is
 * migration-only: an installed theme declares its own `pair` from now on.
 */
const LEGACY_FOLLOW_SYSTEM_PAIR: Readonly<Record<string, string>> = { "violet-light": "violet-dark", "violet-dark": "violet-light" };

/**
 * Themes the saved appearance selects that are now packages. Before the
 * switch the selected theme rendered whether or not the legacy list named it
 * (a theme picked before the picker narrowed, or the id a v1 appearance
 * migrates to), and `followSystem` alternated the violet pair.
 */
export function legacySelectedThemes(appearance: { bundleId: string; followSystem?: boolean }): string[] {
  const id = appearance.bundleId;
  if (isBundleId(id) || !isThemeId(id)) return [];
  const pair = appearance.followSystem === true && Object.hasOwn(LEGACY_FOLLOW_SYSTEM_PAIR, id) ? LEGACY_FOLLOW_SYSTEM_PAIR[id] : undefined;
  return pair ? [id, pair] : [id];
}

/** The activations the settings hold from the server marketplace. */
export interface LegacyActivations {
  themes: readonly string[];
  locales: readonly string[];
  providers: readonly string[];
}

export type LegacyContentKind = "theme" | "language" | "provider";

export interface LegacyContentInput {
  activations: LegacyActivations;
  /** Whether the official snapshot lists this package. */
  listed(kind: LegacyContentKind, name: string): boolean;
  /** Whether a package of this kind and name is installed, from any source. */
  installed(kind: LegacyContentKind, name: string): Promise<boolean>;
  /** Install the official package in adopt mode. */
  adopt(kind: LegacyContentKind, name: string): Promise<void>;
  /** Drop these from the legacy settings lists: installed packages provide them now. */
  release(provided: { themes: string[]; locales: string[] }): Promise<void>;
  log: { warn(message: string): void };
}

export interface LegacyContentReport {
  adopted: PackageKey[];
  /** Installs that failed this time; the migration runs again for them. */
  failed: Array<{ key: PackageKey; message: string }>;
}

function languagePackage(locale: string): string | null {
  return Object.hasOwn(LEGACY_LANGUAGE_PACKAGES, locale) ? LEGACY_LANGUAGE_PACKAGES[locale as MarketplaceEligibleLocale] : null;
}

export async function migrateLegacyContent(input: LegacyContentInput): Promise<LegacyContentReport> {
  const report: LegacyContentReport = { adopted: [], failed: [] };
  const provided = { themes: [] as string[], locales: [] as string[] };
  const items: Array<{ kind: LegacyContentKind; name: string; provide?: () => void }> = [];
  for (const id of new Set(input.activations.themes)) items.push({ kind: "theme", name: id, provide: () => provided.themes.push(id) });
  for (const locale of input.activations.locales) {
    const name = languagePackage(locale);
    if (name === null) input.log.warn(`legacy language ${locale} has no official package; left in settings`);
    else items.push({ kind: "language", name, provide: () => provided.locales.push(locale) });
  }
  for (const id of new Set(input.activations.providers)) items.push({ kind: "provider", name: id });

  for (const item of items) {
    const key: PackageKey = { source: OFFICIAL_MARKETPLACE.id, kind: item.kind, name: item.name };
    try {
      if (!(await input.installed(item.kind, item.name))) {
        if (!input.listed(item.kind, item.name)) {
          input.log.warn(`legacy ${item.kind} ${item.name} is not listed by the official source; left in settings`);
          continue;
        }
        await input.adopt(item.kind, item.name);
        report.adopted.push(key);
      }
      item.provide?.();
    } catch (error) {
      if (error instanceof MarketplaceError && error.code === "PACKAGE_ID_CONFLICT") {
        input.log.warn(`legacy ${item.kind} ${item.name} is provided by another installed package: ${error.message}`);
        item.provide?.();
        continue;
      }
      input.log.warn(`legacy ${item.kind} ${item.name} not migrated this time: ${errorMessage(error)}`);
      report.failed.push({ key, message: errorMessage(error) });
    }
  }
  if (provided.themes.length > 0 || provided.locales.length > 0) {
    try {
      await input.release(provided);
    } catch (error) {
      // The packages are installed; the next run finds them and drops the ids again.
      const message = `dropping it from the legacy list failed: ${errorMessage(error)}`;
      input.log.warn(`legacy content: ${message}`);
      for (const id of provided.themes) report.failed.push({ key: { source: OFFICIAL_MARKETPLACE.id, kind: "theme", name: id }, message });
      for (const locale of provided.locales) report.failed.push({ key: { source: OFFICIAL_MARKETPLACE.id, kind: "language", name: languagePackage(locale)! }, message });
    }
  }
  return report;
}
