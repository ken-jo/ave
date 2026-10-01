import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { AppSettings, AveApi } from "../types.js";
import {
  BUNDLES,
  DEFAULT_BUNDLE_ID,
  findBundle,
  systemPairOf,
} from "./bundles/index.js";
import { isThemeId } from "../../../shared/theme-bundles.js";
import { ensureInstalledContent, useInstalledContent } from "../installed-content.js";
import type { ThemeBundle } from "./bundles/index.js";
import { applyBundleToDocument, resolveSystemPair } from "./resolve-theme.js";
import { bundleToPluginTokens } from "./plugin-token-map.js";
export { bundleToPluginTokens };
import type { ThemeContextValue, UnvalidatedBundleId, ResolvedShell } from "./types.js";
import type { InitialThemePrime } from "../../../shared/initial-theme.js";

const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * `window.__aveInitialTheme` is set by `src/preload.ts` when the main
 * process passes `--ave-initial-theme=...` via `webPreferences.additional
 * Arguments` (see `architecture.md` §6.7.1 "race window = 0"). The preload
 * also paints documentElement tokens for the same payload before React
 * mounts, so reading bundleId here lets ThemeProvider's first render agree
 * with what's already on screen — eliminating the async hydrate race that
 * could flash the default tokens before settings loaded.
 *
 * Type imported from `src/shared/initial-theme.ts` (single SoT shared with
 * `main.ts` + `preload.ts`).
 */
declare global {
  interface Window {
    __aveInitialTheme?: Readonly<InitialThemePrime> | null;
  }
}

function readGlobalInitialBundleId(): UnvalidatedBundleId | undefined {
  if (typeof window === "undefined") return undefined;
  const initial = window.__aveInitialTheme;
  if (!initial || typeof initial !== "object") return undefined;
  const id = initial.bundleId;
  if (typeof id !== "string") return undefined;
  return isThemeId(id) ? (id as UnvalidatedBundleId) : undefined;
}

/**
 * Extract `{ bundleId, followSystem }` from an `AppSettings` payload. Used
 * both by the initial settings hydrate and by the `SETTINGS.updated`
 * cross-window broadcast handler so the two paths share one normalizer.
 */
/** A value with every object's keys sorted, so two equal values serialize the same. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]));
}

/** Whether two bundles hold the same values, whatever the order of their keys. */
function sameBundleValues(a: ThemeBundle, b: ThemeBundle): boolean {
  return a === b || JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

function resolveAppearanceSettings(settings: AppSettings): { bundleId: UnvalidatedBundleId; followSystem: boolean } {
  const appearance = settings.appearance as { schemaVersion?: number; bundleId?: string; followSystem?: boolean } | undefined;
  const rawId = (appearance?.schemaVersion === 2 && typeof appearance.bundleId === "string")
    ? appearance.bundleId
    : DEFAULT_BUNDLE_ID;
  return {
    bundleId: isThemeId(rawId) ? rawId : DEFAULT_BUNDLE_ID,
    followSystem: appearance?.followSystem === true,
  };
}


export interface ThemeProviderProps {
  api?: AveApi;
  /** Initial bundle id — lets tests skip async hydrate. */
  initialBundleId?: UnvalidatedBundleId;
  /** Initial followSystem — lets tests skip async hydrate. */
  initialFollowSystem?: boolean;
  children: ReactNode;
}

/**
 * Theme system v2 — single bundle provider.
 *
 * Manages one active ThemeBundle (selected by `bundleId`). On mount, hydrates
 * from `api.getSettings().appearance.bundleId`. On change, writes
 * `data-theme-bundle` on `<html>` and persists via `api.updateSettings`.
 *
 * When the selected theme declares a pair of the other shell, `followSystem`
 * switches between the two with `prefers-color-scheme`.
 */
export function ThemeProvider({
  api,
  initialBundleId,
  initialFollowSystem = false,
  children,
}: ThemeProviderProps) {
  const resolveBundle = useCallback((id: UnvalidatedBundleId): ThemeBundle => {
    return findBundle(id) ?? findBundle(DEFAULT_BUNDLE_ID)!;
  }, []);

  // Resolution order:
  //   (1) explicit `initialBundleId` prop — tests + composition root overrides
  //   (2) `window.__aveInitialTheme` from preload — set by main process
  //       via `webPreferences.additionalArguments` so frame-0 paint already
  //       matches this bundle id (architecture.md §6.7.1)
  //   (3) DEFAULT_BUNDLE_ID — true cold boot, no global, no prop
  const [bundleId, setBundleIdState] = useState<UnvalidatedBundleId>(
    () => initialBundleId ?? readGlobalInitialBundleId() ?? DEFAULT_BUNDLE_ID,
  );
  const [followSystem, setFollowSystemState] = useState<boolean>(initialFollowSystem);
  const [activeBundle, setActiveBundle] = useState<ThemeBundle>(() =>
    resolveBundle(initialBundleId ?? readGlobalInitialBundleId() ?? DEFAULT_BUNDLE_ID)
  );

  // Track mount + user-touched state so late getSettings() doesn't clobber
  // a user toggle that happened in the meantime.
  const userTouchedRef = useRef(false);
  const mountedRef = useRef(true);
  // Set on every mount, not only at creation: StrictMode unmounts and remounts
  // once, and a ref left false would drop the settings hydrate and broadcasts.
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const applySettingsAppearance = useCallback(
    (settings: AppSettings, options: { skipIfUserTouched?: boolean } = {}) => {
      if (options.skipIfUserTouched && userTouchedRef.current) return;
      const next = resolveAppearanceSettings(settings);
      setBundleIdState(next.bundleId);
      setFollowSystemState(next.followSystem);
      // User-configurable font family + size — written as CSS variables on
      // `documentElement` so the body's `font-family: var(--ave-font-family, …)`
      // / `font-size: calc(1rem * var(--ave-font-size-scale, …))` rules pick
      // up the override. `family: "system"` (or unset) removes the override so
      // the default HOST_FONT_STACK / default step apply. See styles.css body.
      if (typeof document === "undefined") return;
      const root = document.documentElement;
      const font = settings.appearance?.font;
      if (font?.family && font.family !== "system") {
        root.style.setProperty("--ave-font-family", font.family);
      } else {
        root.style.removeProperty("--ave-font-family");
      }
      if (typeof font?.sizeScale === "number") {
        root.style.setProperty("--ave-font-size-scale", String(font.sizeScale));
      } else {
        root.style.removeProperty("--ave-font-size-scale");
      }
    },
    [],
  );

  // Hydrate from settings on mount.
  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    void (async () => {
      try {
        const settings = await api.getSettings();
        if (cancelled || userTouchedRef.current || !mountedRef.current) return;
        applySettingsAppearance(settings, { skipIfUserTouched: true });
      } catch {
        /* ignore — boot continues with defaults */
      }
    })();
    return () => { cancelled = true; };
  }, [api, applySettingsAppearance]);

  // Settings can be changed from the separate native settings window. Keep each
  // renderer's provider in sync with the persisted settings broadcast so theme
  // changes are visible without restarting the app.
  useEffect(() => {
    if (!api) return;
    return api.onSettingsUpdated((settings) => {
      if (!mountedRef.current) return;
      applySettingsAppearance(settings);
    });
  }, [api, applySettingsAppearance]);

  // Tick counter — incremented by the OS media query listener below.
  // Must be declared before effectiveBundleId so it is in scope for the dep array.
  const [osTick, setOsTick] = useState(0);
  // Installed themes are module state; a pair is known once they have loaded.
  const installedThemes = useInstalledContent().themes;

  // The selected theme and the pair `followSystem` alternates it with, if any.
  const systemPair = useMemo(() => {
    const bundle = findBundle(bundleId);
    const pair = bundle ? systemPairOf(bundle) : undefined;
    return bundle && pair ? { bundle, pair } : null;
    // installedThemes: a pair installed later becomes available.
  }, [bundleId, installedThemes]);

  // Derive the effective bundle — when followSystem is on and the selected
  // theme has a pair, the one matching the OS scheme applies. osTick is
  // included so any OS scheme change triggers a re-evaluation.
  const effectiveBundleId: UnvalidatedBundleId = useMemo(() => {
    if (followSystem && systemPair) return resolveSystemPair(systemPair.bundle, systemPair.pair);
    return bundleId;
  }, [bundleId, followSystem, systemPair, osTick]);

  useEffect(() => {
    let cancelled = false;
    const cached = findBundle(effectiveBundleId);
    if (cached) setActiveBundle(cached);
    // An installed theme is known only once the installed content has loaded;
    // resolve after it so a selected installed theme is not replaced by the default.
    void ensureInstalledContent(api)
      .then(() => findBundle(effectiveBundleId))
      .then((bundle) => {
        if (cancelled) return;
        if (!bundle) {
          setBundleIdState(DEFAULT_BUNDLE_ID);
          setActiveBundle(resolveBundle(DEFAULT_BUNDLE_ID));
          return;
        }
        setActiveBundle(bundle);
      })
      .catch(() => {
        if (!cancelled) {
          setBundleIdState(DEFAULT_BUNDLE_ID);
          setActiveBundle(resolveBundle(DEFAULT_BUNDLE_ID));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api, effectiveBundleId, resolveBundle]);

  // An installed theme updated in place keeps its id, so the effect above does
  // not run again: take the registry's new bundle for the theme that shows, or
  // its old tokens stay on :root until it is selected again. Removal is not
  // handled here — uninstalling the selected theme resets the setting.
  useEffect(() => {
    const bundle = findBundle(effectiveBundleId);
    if (!bundle) return;
    // A reload rebuilds every bundle object: keep the shown one when nothing in it changed.
    setActiveBundle((shown) => (shown.id === bundle.id && !sameBundleValues(shown, bundle) ? bundle : shown));
  }, [installedThemes, effectiveBundleId]);

  // A theme installed after this window started — the first-boot migration
  // adopting the selected theme's package (design §16.3) — was replaced by the
  // default above; once it arrives, the persisted selection applies again.
  useEffect(() => {
    if (!api || installedThemes.length === 0) return;
    let cancelled = false;
    void api.getSettings().then(
      (settings) => {
        if (!cancelled && mountedRef.current) applySettingsAppearance(settings, { skipIfUserTouched: true });
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [api, installedThemes, applySettingsAppearance]);

  // Apply bundle to DOM on every active bundle change, then tell the consumers
  // that copy theme values: their effects run after this one has written :root.
  // Revision 0 is the first bundle, which this effect writes in the same commit.
  const [applied, setApplied] = useState<{ bundle: ThemeBundle; revision: number }>(() => ({ bundle: activeBundle, revision: 0 }));
  useEffect(() => {
    if (typeof document === "undefined") return;
    if (activeBundle.id !== effectiveBundleId) return;
    applyBundleToDocument(activeBundle);
    setApplied((previous) => ({ bundle: activeBundle, revision: previous.revision + 1 }));
  }, [activeBundle, effectiveBundleId]);

  // Propagate bundle tokens to plugin webviews whenever active bundle changes.
  // Font stack is NOT broadcast — `AveHostThemeEvent` has no `fonts` channel,
  // and the plugin webview body letterform is unified via the static
  // `plugin-ui-shell.html` mirror of `HOST_FONT_STACK` instead. Re-introducing
  // a `fonts.family` payload here would be dead code that plugins cannot use.
  useEffect(() => {
    if (!api) return;
    if (activeBundle.id !== effectiveBundleId) return;
    const tokens = bundleToPluginTokens(activeBundle);
    void api.notifyPluginTheme({
      bundleId: effectiveBundleId,
      shell: activeBundle.shell,
      tokens,
    }).catch((err: unknown) => {
      if (typeof process !== "undefined" && process.env?.AVE_DEV === "1") {
        console.warn("[theme-propagation] notifyPluginTheme failed:", err);
      }
    });
  }, [api, activeBundle, effectiveBundleId]);

  // Live-follow OS preference while followSystem alternates a pair.
  // A tick counter forces effectiveBundleId to re-evaluate on OS scheme change.
  const followsPair = followSystem && systemPair !== null;
  useEffect(() => {
    if (!followsPair) return;
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => setOsTick((n) => n + 1);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [followsPair]);

  const persistAppearance = useCallback(
    (patch: { bundleId?: UnvalidatedBundleId; followSystem?: boolean }) => {
      if (!api) return;
      void api
        .updateSettings({ appearance: { schemaVersion: 2, ...patch } })
        .catch(() => { /* ignore — local state already reflects */ });
    },
    [api],
  );

  const setBundle = useCallback(
    (id: UnvalidatedBundleId) => {
      userTouchedRef.current = true;
      const safeId = isThemeId(id) ? id : DEFAULT_BUNDLE_ID;
      setBundleIdState(safeId);
      /* When the user explicitly picks a theme with a pair while followSystem
       * is on, the pick would otherwise be silently overridden by the OS
       * preference resolution (resolveSystemPair). Treat the explicit pick as
       * "I want this exact bundle" and turn followSystem off so the click is
       * honored. Re-enabling the toggle continues to work normally. */
      const picked = findBundle(safeId);
      const isPairPick = picked !== undefined && systemPairOf(picked) !== undefined;
      if (isPairPick && followSystem) {
        setFollowSystemState(false);
        persistAppearance({ bundleId: safeId, followSystem: false });
      } else {
        persistAppearance({ bundleId: safeId });
      }
    },
    [persistAppearance, followSystem],
  );

  const setFollowSystem = useCallback(
    (next: boolean) => {
      userTouchedRef.current = true;
      setFollowSystemState(next);
      persistAppearance({ followSystem: next });
    },
    [persistAppearance],
  );

  const resolved: ResolvedShell = activeBundle.shell;

  const value = useMemo<ThemeContextValue>(
    () => ({
      bundleId,
      effectiveBundleId,
      setBundle,
      resolved,
      followSystem,
      canFollowSystem: systemPair !== null,
      setFollowSystem,
      appliedRevision: applied.revision,
      appliedBundle: applied.bundle,
    }),
    [bundleId, effectiveBundleId, setBundle, resolved, followSystem, systemPair, setFollowSystem, applied],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/**
 * Read the current theme. Throws if used outside a ThemeProvider — that
 * would mean the App composition root forgot to mount it, which is a bug.
 */
export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error("useTheme() must be used inside <ThemeProvider>");
  }
  return ctx;
}

/**
 * Test/escape hatch — returns null instead of throwing when no provider is
 * mounted. Useful for components that may render in isolated test harnesses
 * (Storybook, snapshot tests) without a full App context.
 */
export function useOptionalTheme(): ThemeContextValue | null {
  return useContext(ThemeContext);
}

/** @internal — exported for the bundle registry */
export { BUNDLES };
