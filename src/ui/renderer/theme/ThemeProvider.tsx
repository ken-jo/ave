import { t } from "../../../i18n/runtime.js";
import { requirePersistedResult } from "../hooks/use-settings-persistence.js";
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { AveApi } from "../types.js";
import { DEFAULT_APPEARANCE, isGlassTint, type AppearanceSettings, type AppearanceMode, type AppearancePersistenceResult } from "../../../shared/appearance-settings.js";
import { applyAppearance, resolveAppearanceScheme, resolveTheme } from "./resolve-theme.js";
import { requireScheme } from "./schemes/index.js";
import { schemeToHostTokens } from "./host-theme-tokens.js";
import type { ThemeContextValue, ResolvedShell } from "./types.js";

import { HostAppearanceProvider } from "./HostAppearanceProvider.js";

const ThemeContext = createContext<ThemeContextValue | null>(null);

declare global {
  interface Window { __aveInitialAppearance?: Readonly<AppearanceSettings> | null }
}

export interface ThemeProviderProps {
  api?: Pick<AveApi, "getSettings" | "onSettingsUpdated" | "notifyPluginTheme" | "updateSettings">;
  initialAppearance?: AppearanceSettings;
  children: ReactNode;
}

export function ThemeProvider({ api, initialAppearance, children }: ThemeProviderProps) {
  const [appearance, setAppearance] = useState<AppearanceSettings>(() => initialAppearance ?? window.__aveInitialAppearance ?? DEFAULT_APPEARANCE);
  const [prefersDark, setPrefersDark] = useState(() => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false);
  const touchedRef = useRef(false);
  const [persistenceError, setPersistenceError] = useState<string | null>(null);
  const authoritativeRef = useRef(appearance);
  const broadcastRevisionRef = useRef(0);
  const editRevisionsRef = useRef<Partial<Record<keyof AppearanceSettings, number>>>({});
  const pendingKeysRef = useRef(new Set<keyof AppearanceSettings>());
  const savedRevisionsRef = useRef<Partial<Record<keyof AppearanceSettings, number>>>({});
  const appearanceRef = useRef(appearance);
  appearanceRef.current = appearance;
  const applyAuthoritative = useCallback(() => {
    const next = { ...authoritativeRef.current };
    for (const key of pendingKeysRef.current) Object.assign(next, { [key]: appearanceRef.current[key] });
    appearanceRef.current = next;
    setAppearance(next);
  }, []);
  const scheme = useMemo(() => resolveAppearanceScheme(appearance, prefersDark), [appearance, prefersDark]);
  const [applied, setApplied] = useState(() => ({ theme: resolveTheme(scheme), revision: 0 }));

  useLayoutEffect(() => {
    const theme = applyAppearance(appearance, document, prefersDark);
    setApplied((previous) => ({ theme, revision: previous.revision + 1 }));
  }, [appearance, prefersDark]);

  useEffect(() => {
    const query = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!query) return;
    const handleChange = () => setPrefersDark(query.matches);
    query.addEventListener("change", handleChange);
    return () => query.removeEventListener("change", handleChange);
  }, []);

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    const unsubscribe = api.onSettingsUpdated((settings) => {
      if (!cancelled) {
        touchedRef.current = true;
        broadcastRevisionRef.current++;
        authoritativeRef.current = settings.appearance;
        applyAuthoritative();
      }
    });
    void api.getSettings().then((settings) => {
      if (!cancelled && !touchedRef.current) { authoritativeRef.current = settings.appearance; applyAuthoritative(); }
    }).catch((error: unknown) => console.error("Appearance settings could not be loaded", error));
    return () => { cancelled = true; unsubscribe(); };
  }, [api, applyAuthoritative]);

  // One projection per applied theme feeds both the plugin broadcast and the in-window app panels.
  const hostTokens = useMemo(() => schemeToHostTokens(applied.theme), [applied]);
  useEffect(() => {
    if (!api) return;
    void api.notifyPluginTheme({ bundleId: applied.theme.id, shell: applied.theme.shell, tokens: hostTokens })
      .catch((error: unknown) => console.error("Theme notification failed", error));
  }, [api, applied, hostTokens]);

  const update = useCallback(async (patch: Partial<AppearanceSettings>, persist = true): Promise<AppearancePersistenceResult> => {
    const edits = (Object.keys(patch) as Array<keyof AppearanceSettings>).map((key) => {
      const revision = (editRevisionsRef.current[key] ?? 0) + 1;
      editRevisionsRef.current[key] = revision;
      return { key, revision };
    });
    const broadcastAtStart = broadcastRevisionRef.current;
    try {
      const next = { ...appearanceRef.current, ...patch };
      resolveAppearanceScheme(next, prefersDark);
      touchedRef.current = true;
      for (const { key } of edits) pendingKeysRef.current.add(key);
      appearanceRef.current = next;
      setAppearance(next);
      if (!persist || !api) return { ok: true };
      const saved = requirePersistedResult(await api.updateSettings({ appearance: patch }));
      resolveAppearanceScheme(saved.appearance, prefersDark);
      if (broadcastRevisionRef.current === broadcastAtStart) {
        const authoritative = { ...authoritativeRef.current };
        for (const { key, revision } of edits) {
          if (revision < (savedRevisionsRef.current[key] ?? 0)) continue;
          savedRevisionsRef.current[key] = revision;
          Object.assign(authoritative, { [key]: saved.appearance[key] });
        }
        authoritativeRef.current = authoritative;
      }
      let current = false;
      for (const { key, revision } of edits) {
        if (editRevisionsRef.current[key] === revision) { pendingKeysRef.current.delete(key); current = true; }
      }
      applyAuthoritative();
      if (current) setPersistenceError(null);
      return current ? { ok: true } : { ok: false };
    } catch {
      const rollback: Partial<AppearanceSettings> = {};
      let current = false;
      for (const { key, revision } of edits) {
        if (editRevisionsRef.current[key] !== revision) continue;
        pendingKeysRef.current.delete(key);
        Object.assign(rollback, { [key]: authoritativeRef.current[key] });
        current = true;
      }
      if (current) {
        const next = { ...appearanceRef.current, ...rollback };
        appearanceRef.current = next;
        setAppearance(next);
        setPersistenceError(t("useSettingsOrchestration.saveFailed"));
      }
      return { ok: false };
    }
  }, [api, applyAuthoritative, prefersDark]);
  const setMode = useCallback((mode: AppearanceMode) => update({ mode }), [update]);
  const setScheme = useCallback(async (shell: ResolvedShell, id: string): Promise<AppearancePersistenceResult> => {
    try {
      if (requireScheme(id).shell !== shell) throw new Error("Color scheme does not match mode");
    } catch {
      setPersistenceError(t("useSettingsOrchestration.saveFailed"));
      return { ok: false };
    }
    return update(shell === "dark" ? { darkScheme: id as AppearanceSettings["darkScheme"] } : { lightScheme: id as AppearanceSettings["lightScheme"] });
  }, [update]);
  const setGlassTint = useCallback(async (tint: number, persist: boolean): Promise<AppearancePersistenceResult> => {
    if (!isGlassTint(tint)) { setPersistenceError(t("useSettingsOrchestration.saveFailed")); return { ok: false }; }
    return update({ glassTint: tint }, persist);
  }, [update]);
  const value = useMemo<ThemeContextValue>(() => ({
    appearance, mode: appearance.mode, darkScheme: appearance.darkScheme, lightScheme: appearance.lightScheme,
    setMode, setScheme, setGlassTint, persistenceError, resolved: scheme.shell, scheme, appliedTheme: applied.theme, appliedRevision: applied.revision,
  }), [appearance, setMode, setScheme, setGlassTint, persistenceError, scheme, applied]);
  const hostAppearance = useMemo(() => ({
    shell: applied.theme.shell,
    tokens: hostTokens,
    terminalFontFamily: appearance.terminalFont.family,
  }), [applied, hostTokens, appearance.terminalFont.family]);
  return <ThemeContext.Provider value={value}><HostAppearanceProvider value={hostAppearance}>{children}</HostAppearanceProvider></ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useTheme() must be used inside <ThemeProvider>");
  return context;
}

export function useOptionalTheme(): ThemeContextValue | null { return useContext(ThemeContext); }
