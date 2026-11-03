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
import { ensureInstalledContent, subscribeInstalledContent } from "../installed-content.js";
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
 * boot, and the provider's hydration below still applies an installed-package language once it registers.
 */
export async function resolveBootLocale(api: Pick<AveApi, "getSettings">): Promise<Locale> {
  // An unreadable snapshot is an internal failure: the boot-failure panel names it rather than mounting a guessed language.
  const settings = await api.getSettings().catch((cause: unknown) => { throw new BootSettingsUnavailableError(cause); });
  const locale = normalizeLocale(settings.appearance?.language);
  return (await tryLoadLocaleMessages(locale)) ? locale : DEFAULT_LOCALE;
}

export function I18nSettingsProvider({ children, initialLocale = DEFAULT_LOCALE }: { children: ReactNode; initialLocale?: Locale }) {
  const api = useMemo(() => tryGetApi(), []);
  // `revision` counts applied catalogs: re-applying the same locale after an installed package replaced its catalog changes the
  // context value, so consumers re-render with the package's strings.
  const [active, setActive] = useState<{ locale: Locale; revision: number }>({ locale: initialLocale, revision: 0 });
  const renderedLocaleRef = useRef<Locale>(initialLocale);
  const hydratedRef = useRef(false);
  const mountedRef = useRef(true);
  const localeRequestRef = useRef(0);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const applyLocale = useCallback(async (next: Locale) => {
    const requestId = ++localeRequestRef.current;
    const loaded = await tryLoadLocaleMessages(next);
    if (!mountedRef.current || requestId !== localeRequestRef.current) return;
    if (!loaded) return;
    renderedLocaleRef.current = next;
    setActive((previous) => ({ locale: next, revision: previous.revision + 1 }));
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
      } finally {
        hydratedRef.current = true;
      }
    })();
    return () => { cancelled = true; };
  }, [api, applyLocale]);

  // A package installed, updated or removed later replaces the catalog of the language on screen; apply its strings. The boot
  // hydration above applies the first installed set itself.
  useEffect(() => subscribeInstalledContent(() => {
    if (hydratedRef.current) void applyLocale(renderedLocaleRef.current);
  }), [applyLocale]);

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
    <I18nProvider locale={active.locale} revision={active.revision} setLocale={setLocale}>
      {children}
    </I18nProvider>
  );
}
