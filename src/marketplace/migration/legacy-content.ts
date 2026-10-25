/** Adopt legacy content through normal install plans while preserving live settings.
 * Skip existing installs and retry failed adoptions at the next boot. */
import type { OfficialPackageLocale } from "../../i18n/locale.js";
import { errorMessage } from "../../shared/error-message.js";
import { isBundleId, isThemeId } from "../../shared/theme-bundles.js";
import { MarketplaceError } from "../errors.js";
import { OFFICIAL_MARKETPLACE } from "../sources/official.js";
import type { PackageKey } from "../sources/policy.js";

const LEGACY_LANGUAGE_PACKAGES: Readonly<Record<OfficialPackageLocale, string>> = { ko: "korean" };

/** Legacy followSystem pairs are migration-only; installed themes declare their own pair. */
const LEGACY_FOLLOW_SYSTEM_PAIR: Readonly<Record<string, string>> = { "violet-light": "violet-dark", "violet-dark": "violet-light" };

/** Include selected themes even when missing from legacy install lists. */
export function legacySelectedThemes(appearance: { bundleId: string; followSystem?: boolean }): string[] {
  const id = appearance.bundleId;
  if (isBundleId(id) || !isThemeId(id)) return [];
  const pair = appearance.followSystem === true && Object.hasOwn(LEGACY_FOLLOW_SYSTEM_PAIR, id) ? LEGACY_FOLLOW_SYSTEM_PAIR[id] : undefined;
  return pair ? [id, pair] : [id];
}

export interface LegacyActivations {
  themes: readonly string[];
  locales: readonly string[];
  providers: readonly string[];
}

export type LegacyContentKind = "theme" | "language" | "provider";

export interface LegacyContentInput {
  activations: LegacyActivations;
  listed(kind: LegacyContentKind, name: string): boolean;
  installed(kind: LegacyContentKind, name: string): Promise<boolean>;
  adopt(kind: LegacyContentKind, name: string): Promise<void>;
  release(provided: { themes: string[]; locales: string[] }): Promise<void>;
  log: { warn(message: string): void };
}

export interface LegacyContentReport {
  adopted: PackageKey[];
  failed: Array<{ key: PackageKey; message: string }>;
}

function languagePackage(locale: string): string | null {
  return Object.hasOwn(LEGACY_LANGUAGE_PACKAGES, locale) ? LEGACY_LANGUAGE_PACKAGES[locale as OfficialPackageLocale] : null;
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
      // Installed entries survive a failed list write; retries find them and drop the legacy ids.
      const message = `dropping it from the legacy list failed: ${errorMessage(error)}`;
      input.log.warn(`legacy content: ${message}`);
      for (const id of provided.themes) report.failed.push({ key: { source: OFFICIAL_MARKETPLACE.id, kind: "theme", name: id }, message });
      for (const locale of provided.locales) report.failed.push({ key: { source: OFFICIAL_MARKETPLACE.id, kind: "language", name: languagePackage(locale)! }, message });
    }
  }
  return report;
}
