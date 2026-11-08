import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { AveApi } from "../types.js";
import { DEFAULT_APPEARANCE, isGlassTint, type AppearanceSettings, type AppearanceMode } from "../../../shared/appearance-settings.js";
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
  const appearanceRef = useRef(appearance);
  appearanceRef.current = appearance;
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
        setAppearance(settings.appearance);
      }
    });
    void api.getSettings().then((settings) => {
      if (!cancelled && !touchedRef.current) setAppearance(settings.appearance);
    }).catch((error: unknown) => console.error("Appearance settings could not be loaded", error));
    return () => { cancelled = true; unsubscribe(); };
  }, [api]);

  // One projection per applied theme feeds both the plugin broadcast and the in-window app panels.
  const hostTokens = useMemo(() => schemeToHostTokens(applied.theme), [applied]);
  useEffect(() => {
    if (!api) return;
    void api.notifyPluginTheme({ bundleId: applied.theme.id, shell: applied.theme.shell, tokens: hostTokens })
      .catch((error: unknown) => console.error("Theme notification failed", error));
  }, [api, applied, hostTokens]);

  const update = useCallback((patch: Partial<AppearanceSettings>, persist = true) => {
    touchedRef.current = true;
    const next = { ...appearanceRef.current, ...patch };
    // Validate mode/selection at the same boundary that resolves the document.
    resolveAppearanceScheme(next, prefersDark);
    appearanceRef.current = next;
    setAppearance(next);
    if (persist && api) void api.updateSettings({ appearance: patch }).catch((error: unknown) => console.error("Appearance settings could not be saved", error));
  }, [api, prefersDark]);
  const setMode = useCallback((mode: AppearanceMode) => update({ mode }), [update]);
  const setScheme = useCallback((shell: ResolvedShell, id: string) => {
    if (requireScheme(id).shell !== shell) throw new Error(`Color scheme does not match mode: ${id}`);
    update(shell === "dark" ? { darkScheme: id as AppearanceSettings["darkScheme"] } : { lightScheme: id as AppearanceSettings["lightScheme"] });
  }, [update]);
  const setGlassTint = useCallback((tint: number, persist: boolean) => {
    if (!isGlassTint(tint)) throw new Error(`Invalid glass tint: ${tint}`);
    update({ glassTint: tint }, persist);
  }, [update]);
  const value = useMemo<ThemeContextValue>(() => ({
    appearance, mode: appearance.mode, darkScheme: appearance.darkScheme, lightScheme: appearance.lightScheme,
    setMode, setScheme, setGlassTint, resolved: scheme.shell, scheme, appliedTheme: applied.theme, appliedRevision: applied.revision,
  }), [appearance, setMode, setScheme, setGlassTint, scheme, applied]);
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
