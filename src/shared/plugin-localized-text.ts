/**
 * Per-locale resolution of the display text a plugin manifest declares.
 *
 * A manifest object that carries user-visible text (a `ui[]` entry, a
 * `configSchema` property, the `auth` block) may add a `locales` map keyed by
 * a normalized lower-case BCP-47 tag. Each entry overrides some of that
 * object's own text fields for that language. The object's own fields stay the
 * baseline: they are what a host renders for a language the map does not name,
 * and what a host that predates the map renders at all.
 *
 * Resolution for one field, against the app's current UI language:
 *
 *   1. the exact tag (`pt-br`),
 *   2. its base language (`pt`),
 *   3. the object's own field.
 *
 * A value that is blank once trimmed counts as absent at every step — an
 * all-whitespace label would render as an invisible entry. The manifest schema
 * already refuses blank localized values; the trim here guards the object's
 * own fields, which the schema leaves unconstrained.
 *
 * Pure — no DOM / Electron / node deps — so main, the renderer and the plugin
 * shell resolve the same text from the same manifest.
 */

/** Text overrides for one language; every field is optional. */
export type PluginLocalizedText<Field extends string> = Partial<Record<Field, string>>;

/** `locales` as a manifest declares it: normalized tag → overrides. */
export type PluginTextLocales<Field extends string> = Record<string, PluginLocalizedText<Field>>;

/**
 * The UI language as a manifest `locales` key: trimmed, lower-case, `_` read
 * as `-`. The same normalization onboarding copy resolves with.
 */
export function normalizePluginLocaleTag(locale: string): string {
  return locale.trim().toLowerCase().replaceAll("_", "-");
}

function present(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * The `locales` entries to consult for `locale`, most specific first: the
 * exact tag, then its base language when that differs. Entries the map does
 * not declare are left out.
 */
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

/**
 * Resolve `fields` in order, language by language: every field of the exact
 * tag, then every field of the base language, then every own field. The first
 * present value wins; `undefined` when none is.
 *
 * Several fields are passed when they are alternatives for one label (a
 * `displayName` that falls back to a `title`) — a localized `title` must win
 * over an own `displayName` in another language, or an English UI would show
 * the Korean short name ahead of the English title the plugin also declared.
 */
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
