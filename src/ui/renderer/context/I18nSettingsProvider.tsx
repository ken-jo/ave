import { requirePersistedResult } from "../hooks/use-settings-persistence.js";
import type { AppearancePersistenceResult } from "../../../shared/appearance-settings.js";
/** Render the saved language from the first paint and follow settings broadcasts across windows; without a preload bridge, render
 * children using the default English locale. */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  DEFAULT_LOCALE,
  isLocale,
  t,
  normalizeLocale,
  tryLoadLocaleMessages,
  type Locale,
} from "../../../i18n/index.js";
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
 * boot; hydration starts installed-content loading without delaying locale selection.
 */
export async function resolveBootLocale(api: Pick<AveApi, "getSettings">): Promise<Locale> {
  // An unreadable snapshot is an internal failure: the boot-failure panel names it rather than mounting a guessed language.
  const settings = await api.getSettings().catch((cause: unknown) => { throw new BootSettingsUnavailableError(cause); });
  const locale = normalizeLocale(settings.appearance?.language);
  return (await tryLoadLocaleMessages(locale)) ? locale : DEFAULT_LOCALE;
}

export function I18nSettingsProvider({ children, initialLocale = DEFAULT_LOCALE }: { children: ReactNode; initialLocale?: Locale }) {
  const api = useMemo(() => tryGetApi(), []);
  const [locale, setActiveLocale] = useState<Locale>(initialLocale);
  const mountedRef = useRef(true);
  const localeRequestRef = useRef(0);
  const writeRevisionRef = useRef(0);
  const broadcastRevisionRef = useRef(0);
  const authoritativeLocaleRef = useRef(initialLocale);
  const [persistenceError, setPersistenceError] = useState<string | null>(null);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const applyLocale = useCallback(async (next: Locale) => {
    const requestId = ++localeRequestRef.current;
    const loaded = await tryLoadLocaleMessages(next);
    if (!mountedRef.current || requestId !== localeRequestRef.current) return false;
    if (!loaded) { setPersistenceError(t("useSettingsOrchestration.saveFailed")); return false; }
    setActiveLocale(next);
    return true;
  }, []);

  // Hydrate from persisted settings on mount.
  useEffect(() => {
    if (!api) return;
    void ensureInstalledContent(api).catch(() => { /* ignore — the window renders without installed content */ });
    let cancelled = false;
    const requestAtStart = localeRequestRef.current;
    void (async () => {
      try {
        const settings = await api.getSettings();
        if (cancelled || !mountedRef.current) return;
        if (localeRequestRef.current !== requestAtStart) return;
        authoritativeLocaleRef.current = normalizeLocale(settings.appearance?.language);
        await applyLocale(authoritativeLocaleRef.current);
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
      broadcastRevisionRef.current++;
      authoritativeLocaleRef.current = normalizeLocale(settings.appearance?.language);
      void applyLocale(authoritativeLocaleRef.current);
    });
  }, [api, applyLocale]);

  const setLocale = useCallback(async (next: Locale): Promise<AppearancePersistenceResult> => {
    const revision = ++writeRevisionRef.current;
    const broadcastAtStart = broadcastRevisionRef.current;
    try {
      if (!await tryLoadLocaleMessages(next)) throw new Error("Language messages unavailable");
      if (!mountedRef.current || writeRevisionRef.current !== revision) return { ok: false };
      if (!api) throw new Error("Settings bridge unavailable");
      const saved = requirePersistedResult(await api.updateSettings({ appearance: { schemaVersion: 3, language: next } }));
      if (!isLocale(saved.appearance.language)) throw new Error("Invalid saved language");
      if (!mountedRef.current || writeRevisionRef.current !== revision) return { ok: false };
      if (broadcastRevisionRef.current === broadcastAtStart) authoritativeLocaleRef.current = saved.appearance.language;
      if (!await applyLocale(authoritativeLocaleRef.current)) return { ok: false };
      setPersistenceError(null);
      return { ok: true };
    } catch {
      if (mountedRef.current && writeRevisionRef.current === revision) setPersistenceError(t("useSettingsOrchestration.saveFailed"));
      return { ok: false };
    }
  }, [api, applyLocale]);

  return (
    <I18nProvider locale={locale} setLocale={setLocale} persistenceError={persistenceError}>
      {children}
    </I18nProvider>
  );
}
