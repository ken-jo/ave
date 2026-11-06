/** Render the saved language from the first paint and follow settings broadcasts across windows; without a preload bridge, render
 * children using the default English locale. */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  DEFAULT_LOCALE,
  normalizeLocale,
  tryLoadLocaleMessages,
  type Locale,
} from "../../../i18n/index.js";
import { messages, type Messages } from "../../../i18n/messages/index.js";
import { I18nProvider } from "../../../i18n/react.js";
import { getApi } from "../api-client.js";
import { ensureInstalledContent } from "../installed-content.js";
import { BootSettingsUnavailableError } from "../model-catalog-bootstrap.js";
import type { AveApi } from "../types.js";

/** `getApi()` throws when the preload bridge is absent; degrade gracefully. */
function tryGetApi(): AveApi | null {
  try {
    return getApi();
  } catch {
    return null;
  }
}

/**
 * The locale the first render uses: the saved `appearance.language` (seeded from the system language on a fresh install), with
 * its compiled catalog already loaded, so the first paint is not English for a user who chose another language. `renderer.tsx`
 * awaits this beside the model catalog before mounting. It does not wait for installed content: that load can take seconds at
 * boot; hydration loads the other installed content independently of locale selection.
 */
export async function resolveBootLocale(api: Pick<AveApi, "getSettings">): Promise<Locale> {
  // An unreadable snapshot is an internal failure: the boot-failure panel names it rather than mounting a guessed language.
  const settings = await api.getSettings().catch((cause: unknown) => { throw new BootSettingsUnavailableError(cause); });
  const locale = normalizeLocale(settings.appearance?.language);
  return (await tryLoadLocaleMessages(locale)) ? locale : DEFAULT_LOCALE;
}

export function I18nSettingsProvider({ children, initialLocale = DEFAULT_LOCALE }: { children: ReactNode; initialLocale?: Locale }) {
  const api = useMemo(() => tryGetApi(), []);
  // Re-applying the same locale and compiled catalog preserves the translation callback.
  const [active, setActive] = useState<{ locale: Locale; revision: number }>({ locale: initialLocale, revision: 0 });
  const appliedRef = useRef<{ locale: Locale; catalog: Messages | undefined }>({ locale: initialLocale, catalog: messages[initialLocale] });
  const mountedRef = useRef(true);
  const localeRequestRef = useRef(0);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const commitLocale = useCallback((next: Locale) => {
    const catalog = messages[next];
    const applied = appliedRef.current;
    if (applied.locale === next && applied.catalog === catalog) return;
    appliedRef.current = { locale: next, catalog };
    setActive((previous) => ({ locale: next, revision: previous.revision + 1 }));
  }, []);

  const applyLocale = useCallback(async (next: Locale) => {
    const requestId = ++localeRequestRef.current;
    const loaded = await tryLoadLocaleMessages(next);
    if (!mountedRef.current || requestId !== localeRequestRef.current) return;
    if (!loaded) return;
    commitLocale(next);
  }, [commitLocale]);

  // Hydrate from persisted settings on mount.
  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    const requestAtStart = localeRequestRef.current;
    void (async () => {
      try {
        // Hydrate other installed content alongside the saved settings.
        const [settings] = await Promise.all([api.getSettings(), ensureInstalledContent(api)]);
        if (cancelled || !mountedRef.current) return;
        if (localeRequestRef.current !== requestAtStart) return;
        await applyLocale(normalizeLocale(settings.appearance?.language));
      } catch {
        /* ignore — render continues at the English default */
      }
    })();
    return () => { cancelled = true; };
  }, [api, applyLocale]);

  // Cross-window sync: a language change in the settings window broadcasts to every renderer so the main window re-localizes
  // without a restart.
  useEffect(() => {
    if (!api?.onSettingsUpdated) return;
    return api.onSettingsUpdated((settings) => {
      if (!mountedRef.current) return;
      void applyLocale(normalizeLocale(settings.appearance?.language));
    });
  }, [api, applyLocale]);

  const setLocale = useCallback(
    (next: Locale) => {
      void applyLocale(next);
      if (api) {
        void api
          .updateSettings({ appearance: { schemaVersion: 3, language: next } })
          .catch(() => { /* ignore — local state already reflects the choice */ });
      }
    },
    [api, applyLocale],
  );

  return (
    <I18nProvider locale={active.locale} revision={active.revision} setLocale={setLocale}>
      {children}
    </I18nProvider>
  );
}
