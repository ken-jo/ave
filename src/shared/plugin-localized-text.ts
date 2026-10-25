/** Resolve exact locale, base language, then own text; blank values are absent. Keep resolution identical across processes. */

export type PluginLocalizedText<Field extends string> = Partial<Record<Field, string>>;

export type PluginTextLocales<Field extends string> = Record<string, PluginLocalizedText<Field>>;

/** Normalize tags by trimming, lowercasing, and replacing underscores with hyphens. */
export function normalizePluginLocaleTag(locale: string): string {
  return locale.trim().toLowerCase().replaceAll("_", "-");
}

function present(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function pluginLocaleCandidates<Field extends string>(
  locales: PluginTextLocales<Field> | undefined,
  locale: string,
): PluginLocalizedText<Field>[] {
  if (!locales) return [];
  const exact = normalizePluginLocaleTag(locale);
  const base = exact.split("-")[0];
  const tags = base && base !== exact ? [exact, base] : [exact];
  const out: PluginLocalizedText<Field>[] = [];
  for (const tag of tags) {
    if (Object.hasOwn(locales, tag)) out.push(locales[tag]);
  }
  return out;
}

/** Search all alternative fields within each language before falling back to the next language; localized titles must beat baseline display names. */
export function resolvePluginLocalizedText<Field extends string>(
  own: PluginLocalizedText<Field>,
  locales: PluginTextLocales<Field> | undefined,
  locale: string,
  fields: readonly Field[],
): string | undefined {
  for (const candidate of [...pluginLocaleCandidates(locales, locale), own]) {
    for (const field of fields) {
      const value = present(candidate[field]);
      if (value) return value;
    }
  }
  return undefined;
}
