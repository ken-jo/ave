/** Render the saved language from the first paint and follow settings broadcasts across windows; without a preload bridge, render
 * children using the default English locale. */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  DEFAULT_LOCALE,
  normalizeLocale,
  tryLoadLocaleMessages,
  type Locale,
} from "../../../i18n/index.js";
import { I18nProvider } from "../../../i18n/react.js";
import { getApi } from "../api-client.js";
import { ensureInstalledContent } from "../installed-content.js";
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
 * boot, and the provider's hydration below still applies an installed-package language once it registers.
 */
export async function resolveBootLocale(api: Pick<AveApi, "getSettings">): Promise<Locale> {
  const locale = normalizeLocale((await api.getSettings()).appearance?.language);
  return (await tryLoadLocaleMessages(locale)) ? locale : DEFAULT_LOCALE;
}

export function I18nSettingsProvider({ children, initialLocale = DEFAULT_LOCALE }: { children: ReactNode; initialLocale?: Locale }) {
  const api = useMemo(() => tryGetApi(), []);
  const [locale, setLocaleState] = useState<Locale>(initialLocale);
  const mountedRef = useRef(true);
  const localeRequestRef = useRef(0);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const applyLocale = useCallback(async (next: Locale) => {
    const requestId = ++localeRequestRef.current;
    const loaded = await tryLoadLocaleMessages(next);
    if (!mountedRef.current || requestId !== localeRequestRef.current) return;
    if (!loaded) return;
    setLocaleState(next);
  }, []);

  // Hydrate from persisted settings on mount.
  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    const requestAtStart = localeRequestRef.current;
    void (async () => {
      try {
        // Installed languages register first, so a selected one resolves to itself.
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
          .updateSettings({ appearance: { schemaVersion: 2, language: next } })
          .catch(() => { /* ignore — local state already reflects the choice */ });
      }
    },
    [api, applyLocale],
  );

  return (
    <I18nProvider locale={locale} setLocale={setLocale}>
      {children}
    </I18nProvider>
  );
}
