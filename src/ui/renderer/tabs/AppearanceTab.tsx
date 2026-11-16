/** Configure the shared interface and terminal appearance. */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { requirePersistedResult } from "../hooks/use-settings-persistence.js";
import type { AppSettings } from "../types.js";
import { Button } from "../../../components/ui/button.js";
import { ZoomControls } from "../components/ZoomControls.js";
import { HOST_FONT_STACK } from "../../../shared/host-font-stack.js";
import { useTheme } from "../theme/index.js";
import { SCHEMES } from "../theme/index.js";
import { DEFAULT_APPEARANCE, DEFAULT_GLASS_TINT, GLASS_TINT_MAX, GLASS_TINT_MIN, isTerminalFontSize, isTerminalLineHeight } from "../../../shared/appearance-settings.js";
import { getApi } from "../api-client.js";
import { TerminalBehaviorFields } from "./TerminalBehaviorFields.js";
import { useNotifySaved } from "../context/SavedToastContext.js";
import { SettingsPageHeader, SettingsSection } from "../components/PageShell.js";
import {
  localeInfo,
  visibleLocalesFor,
} from "../../../i18n/index.js";
import { useInstalledContent } from "../installed-content.js";
import { useTranslation } from "../../../i18n/react.js";
import { FONT_SIZE_SCALE_DEFAULT, isValidFontFamilyOverride, type FontSizeScale } from "../../../shared/appearance-font.js";

function handleRadioGroupKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
  const directions = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 } as const;
  if (!(event.key in directions) && event.key !== "Home" && event.key !== "End") return;
  const radios = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="radio"]:not(:disabled)'));
  const current = radios.indexOf(event.target as HTMLButtonElement);
  if (current < 0 || radios.length === 0) return;
  event.preventDefault();
  const next = event.key === "Home" ? 0 : event.key === "End" ? radios.length - 1
    : (current + directions[event.key as keyof typeof directions] + radios.length) % radios.length;
  radios[next]!.focus();
  radios[next]!.click();
}

/* ─── Font family + size presets ─────────────────────────────────────────── */

type FontSizeOption = { value: FontSizeScale; label: string };
const FONT_SIZE_OPTIONS: ReadonlyArray<FontSizeOption> = [
  { value: 0.75, label: "appearanceTab.fontSizeSmall" },
  { value: 0.875, label: "appearanceTab.fontSizeNormal" },
  { value: 1, label: "appearanceTab.fontSizeLarge" },
  { value: 1.125, label: "appearanceTab.fontSizeXLarge" },
];

type FontFamilyPreset = { value: string; label: string; stack: string };
const FONT_FAMILY_PRESETS: ReadonlyArray<FontFamilyPreset> = [
  { value: "system", label: "appearanceTab.fontFamilySystem", stack: "" /* unset → HOST_FONT_STACK */ },
  {
    value: "pretendard",
    label: "Pretendard",
    stack: "Pretendard, system-ui, -apple-system, \"Segoe UI\", \"Apple SD Gothic Neo\", \"Noto Sans KR\", \"Malgun Gothic\", sans-serif",
  },
  {
    value: "noto-sans-kr",
    label: "Noto Sans KR",
    stack: "\"Noto Sans KR\", \"Apple SD Gothic Neo\", \"Malgun Gothic\", system-ui, sans-serif",
  },
  {
    value: "spoqa-han-sans",
    label: "Spoqa Han Sans Neo",
    stack: "\"Spoqa Han Sans Neo\", \"Apple SD Gothic Neo\", \"Noto Sans KR\", \"Malgun Gothic\", system-ui, sans-serif",
  },
  {
    value: "apple-sd-gothic",
    label: "Apple SD Gothic Neo",
    stack: "\"Apple SD Gothic Neo\", \"Noto Sans KR\", \"Malgun Gothic\", system-ui, sans-serif",
  },
  {
    value: "ibm-plex",
    label: "IBM Plex Sans",
    stack: "\"IBM Plex Sans KR\", \"IBM Plex Sans\", system-ui, -apple-system, sans-serif",
  },
  {
    value: "jetbrains-mono",
    label: "JetBrains Mono",
    stack: "\"JetBrains Mono\", \"Fira Code\", \"Cascadia Code\", ui-monospace, SFMono-Regular, \"SF Mono\", Menlo, Consolas, monospace",
  },
  {
    value: "fira-code",
    label: "Fira Code",
    stack: "\"Fira Code\", \"JetBrains Mono\", \"Cascadia Code\", ui-monospace, SFMono-Regular, \"SF Mono\", Menlo, Consolas, monospace",
  },
];

function presetForStack(stack: string | undefined, options: ReadonlyArray<{ value: string; stack: string }>): string {
  if (!stack || stack === "system") return "system";
  const hit = options.find((p) => p.stack === stack);
  return hit ? hit.value : "custom";
}

function useFontPreferences() {
  const [family, setFamilyState] = useState<string>("system");
  const [sizeScale, setSizeScaleState] = useState<FontSizeScale>(FONT_SIZE_SCALE_DEFAULT);
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [reload, setReload] = useState(0);
  const reloadEpoch = 0;
  const loadKeyRef = useRef(`${reloadEpoch}:${reload}`);
  loadKeyRef.current = `${reloadEpoch}:${reload}`;
  const authoritativeRef = useRef<{ family: string; sizeScale: FontSizeScale }>({ family: "system", sizeScale: FONT_SIZE_SCALE_DEFAULT });
  const valuesRef = useRef(authoritativeRef.current);
  const revisionsRef = useRef({ family: 0, sizeScale: 0 });
  const authoritativeRevisionRef = useRef(0);
  const notifySaved = useNotifySaved();

  useEffect(() => {
    let active = true;
    const loadKey = `${reloadEpoch}:${reload}`;
    let receivedUpdate = false;
    setLoaded(false);
    setLoadFailed(false);
    const apply = (settings: AppSettings) => {
      if (!active || loadKeyRef.current !== loadKey) return;
      const font = settings.appearance.font;
      const value = { family: font?.family ?? "system", sizeScale: font?.sizeScale ?? FONT_SIZE_SCALE_DEFAULT };
      authoritativeRef.current = value;
      valuesRef.current = value;
      authoritativeRevisionRef.current++;
      setFamilyState(value.family);
      setSizeScaleState(value.sizeScale);
      setLoaded(true);
      setLoadFailed(false);
      setSaveFailed(false);
    };
    const api = getApi();
    const unsubscribe = api.onSettingsUpdated((settings) => { receivedUpdate = true; apply(settings); });
    void api.getSettings().then((settings) => { if (!receivedUpdate) apply(settings); }).catch(() => {
      if (active && loadKeyRef.current === loadKey && !receivedUpdate) setLoadFailed(true);
    });
    return () => { active = false; unsubscribe(); };
  }, [reload, reloadEpoch]);

  const save = async (patch: { family: string } | { sizeScale: FontSizeScale }) => {
    if (!loaded) return;
    const key = "family" in patch ? "family" : "sizeScale";
    const nextValue = "family" in patch ? patch.family : patch.sizeScale;
    if (valuesRef.current[key] === nextValue) return;
    const revision = ++revisionsRef.current[key];
    const authoritativeRevision = authoritativeRevisionRef.current;
    valuesRef.current = { ...valuesRef.current, ...patch };
    setFamilyState(valuesRef.current.family);
    setSizeScaleState(valuesRef.current.sizeScale);
    setSaveFailed(false);
    try {
      const result = requirePersistedResult(await getApi().updateSettings({ appearance: { font: patch } }));
      const actual = result.appearance.font;
      if (revision === revisionsRef.current[key] && authoritativeRevision === authoritativeRevisionRef.current) {
        const value = key === "family" ? { family: actual?.family ?? "system" } : { sizeScale: actual?.sizeScale ?? FONT_SIZE_SCALE_DEFAULT };
        authoritativeRef.current = { ...authoritativeRef.current, ...value };
        valuesRef.current = { ...valuesRef.current, ...value };
        setFamilyState(valuesRef.current.family);
        setSizeScaleState(valuesRef.current.sizeScale);
      }
      const actualValue = key === "family" ? actual?.family ?? "system" : actual?.sizeScale ?? FONT_SIZE_SCALE_DEFAULT;
      if (revision === revisionsRef.current[key] && valuesRef.current[key] === actualValue) notifySaved();
    } catch {
      if (revision !== revisionsRef.current[key]) return;
      const restored = key === "family" ? { family: authoritativeRef.current.family } : { sizeScale: authoritativeRef.current.sizeScale };
      valuesRef.current = { ...valuesRef.current, ...restored };
      setFamilyState(valuesRef.current.family);
      setSizeScaleState(valuesRef.current.sizeScale);
      setSaveFailed(true);
    }
  };
  return { family, sizeScale, loaded, loadFailed, saveFailed, retry: () => setReload((epoch) => epoch + 1),
    setFamily: (next: string) => { void save({ family: next || "system" }); },
    setSizeScale: (next: FontSizeScale) => { void save({ sizeScale: next }); },
  };
}

/** Theme and locale owners return a checked persistence outcome. */
function useAppearanceChoicePersistence() {
  const { t } = useTranslation();
  const notifySaved = useNotifySaved();
  const [error, setError] = useState<string | null>(null);
  const revisionRef = useRef(0);
  const save = async (operation: () => Promise<{ ok: boolean }>) => {
    const revision = ++revisionRef.current;
    setError(null);
    try {
      const result = await operation();
      if (revision !== revisionRef.current) return;
      if (!result.ok) { setError(t("useSettingsOrchestration.saveFailed")); return; }
      notifySaved();
    } catch {
      if (revision === revisionRef.current) setError(t("useSettingsOrchestration.saveFailed"));
    }
  };
  return { error, save };
}

/** Keep raw font input while typing; trim only on blur/Enter, and map empty input to system. */
function FontFamilyCustomInput({
  initial,
  onCommit,
  label,
}: {
  initial: string;
  onCommit: (value: string) => void;
  label?: string;
}) {
  const { t } = useTranslation();
  const [raw, setRaw] = useState(initial);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // `escapingRef` blocks the `onBlur=commit()` call that fires synchronously
  // when an Escape handler calls `inputElement.blur()`. Without this flag,
  // React 18+ batches `setRaw(initial)`, then `blur()` runs `onBlur` with
  // the still-typed `raw` closure → commit("user typed text") → the very
  // bug Escape was meant to cancel.
  const escapingRef = useRef(false);
  // Re-sync when upstream changes (preset click, cross-window broadcast, …).
  // Guard against overwriting in-progress typing — if the input is currently
  // focused, the user is editing and we must not stomp their text with a
  // sibling-window broadcast.
  useEffect(() => {
    if (document.activeElement === inputRef.current) return;
    setRaw(initial);
  }, [initial]);

  // Dedupe against `initial.trim()` so a self-echo from cross-window broadcast (the user committed "Foo" here, the broadcast
  // arrived, parent re-rendered with `initial = "Foo"`, an unfocused blur is a no-op anyway) stays silent.
  const commit = () => {
    const value = raw.trim();
    if (value === initial.trim()) return;
    if (value && !isValidFontFamilyOverride(value)) return;
    onCommit(value);
  };

  return (
    <details className="text-dense text-muted-foreground">
      <summary className="cursor-pointer select-none">{t("appearanceTab.fontFamilyCustomSummary")}</summary>
      <input
        ref={inputRef}
        type="text"
        value={raw}
        placeholder={t("appearanceTab.fontFamilyCustomPlaceholder")}
        maxLength={256}
        aria-invalid={raw.trim() !== "" && !isValidFontFamilyOverride(raw.trim())}
        onChange={(e) => setRaw(e.target.value)}
        onBlur={() => {
          // Escape sets this flag and then calls blur(); skip the cascaded commit so the typed-but-cancelled value never reaches
          // onCommit.
          if (escapingRef.current) { escapingRef.current = false; return; }
          commit();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            escapingRef.current = true;
            setRaw(initial);
            (e.target as HTMLInputElement).blur();
          }
        }}
        className="mt-2 w-full rounded border border-input bg-background px-2 py-1 font-mono text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        aria-label={label ?? t("appearanceTab.fontFamilyCustomAriaLabel")}
      />
      <p className="mt-1 text-tiny">
        {t("appearanceTab.fontFamilyCustomHint")}
      </p>
    </details>
  );
}

/* ─── Language picker ────────────────────────────────────────────────────── */

/**
 * Language selector. Reads/writes the active UI locale through the i18n
 * context (which persists to `settings.appearance.language` and broadcasts the
 * change to every window). Option labels use each locale's native name so they
 * are recognizable regardless of the current language.
 */
function LanguageSection() {
  const { locale, setLocale, t, persistenceError: localeError } = useTranslation();
  const { error, save } = useAppearanceChoicePersistence();
  const visibleLocales = visibleLocalesFor();
  return (
    <SettingsSection
      data-settings-section="appearance-language"
      title={t("settings.appearance.language.title")}
      description={t("settings.appearance.language.description")}
    >
      {(localeError ?? error) !== null && <p role="alert" className="text-sm text-destructive">{localeError ?? error}</p>}
      <div role="radiogroup" onKeyDown={handleRadioGroupKeyDown} aria-label={t("settings.appearance.language.title")} className="flex flex-wrap gap-2">
        {visibleLocales.map((code) => {
          const selected = locale === code;
          return (
            <button
              key={code}
              type="button"
              role="radio"
              aria-checked={selected}
              data-testid={`language-option-${code}`}
              onClick={() => {
                if (!selected) {
                  void save(() => setLocale(code));
                }
              }}
              className={`rounded-md border px-3 py-2 text-sm transition-colors ${
                selected
                  ? "border-primary bg-primary/(--opacity-subtle) text-foreground"
                  : "border-border text-muted-foreground hover:bg-muted"
              }`}
            >
              <span>{localeInfo(code)?.nativeName ?? code}</span>
            </button>
          );
        })}
      </div>
    </SettingsSection>
  );
}

export function AppearanceTab() {
  const { t } = useTranslation();
  const { mode, setMode, darkScheme, lightScheme, setScheme, persistenceError: themeError } = useTheme();
  const { family, sizeScale, setFamily, setSizeScale, loaded: fontLoaded, loadFailed: fontLoadFailed, saveFailed: fontSaveFailed, retry: retryFonts } = useFontPreferences();
  const terminal = useTerminalFontPreferences();
  const { appearance } = useTheme();
  const { error: choiceError, save: saveChoice } = useAppearanceChoicePersistence();
  const installedContent = useInstalledContent();
  const fontOptions: ReadonlyArray<{ value: string; text: string; stack: string }> = [
    ...FONT_FAMILY_PRESETS.map((preset) => ({ value: preset.value, text: t(preset.label), stack: preset.stack })),
    ...installedContent.fonts.map((font) => ({ value: `installed-${font.name}`, text: font.family, stack: font.stack })),
  ];
  const activePreset = presetForStack(family, fontOptions);
  const customStack = activePreset === "custom" ? family : "";

  return (
    <div className="space-y-6">
      <SettingsPageHeader
        title={t("appearanceTab.pageTitle")}
        description={t("appearanceTab.pageDescription")}
      />

      {(themeError ?? choiceError) !== null && <p role="alert" className="text-sm text-destructive">{themeError ?? choiceError}</p>}
      {/* ── Language ──────────────────────────────────── */}
      <LanguageSection />

      <SettingsSection
        data-settings-section="appearance-theme"
        title={t("appearanceTab.schemeTitle")}
        description={t("appearanceTab.schemeDescription")}
      >
        <div role="radiogroup" onKeyDown={handleRadioGroupKeyDown} aria-label={t("appearanceTab.mode")} className="flex gap-2">
          {(["system", "dark", "light"] as const).map((value) => (
            <button key={value} type="button" role="radio" aria-checked={mode === value} tabIndex={mode === value ? 0 : -1}
              data-testid={`appearance-mode-${value}`}
              className={`rounded-md border px-4 py-2 text-sm ${mode === value ? "border-primary bg-primary text-primary-foreground" : "border-border"}`}
              onClick={() => { void saveChoice(() => setMode(value)); }}>
              {t(`appearanceTab.mode.${value}`)}
            </button>
          ))}
        </div>
        {(["dark", "light"] as const).filter((shell) => mode === "system" || mode === shell).map((shell) => (
          <div key={shell} className="space-y-2">
            <h3 className="text-sm font-medium">{t(`appearanceTab.scheme.${shell}`)}</h3>
            <div role="radiogroup" onKeyDown={handleRadioGroupKeyDown} aria-label={t(`appearanceTab.scheme.${shell}`)} className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {SCHEMES.filter((scheme) => scheme.shell === shell).map((scheme) => {
                const selected = scheme.id === (shell === "dark" ? darkScheme : lightScheme);
                return <button key={scheme.id} type="button" role="radio" aria-checked={selected} tabIndex={selected ? 0 : -1}
                  data-scheme-id={scheme.id}
                  className={`flex min-w-0 items-center gap-2 rounded-lg border p-2 text-left ${selected ? "border-primary ring-1 ring-primary" : "border-border"}`}
                  onClick={() => { void saveChoice(() => setScheme(shell, scheme.id)); }}>
                  <span aria-hidden="true" className="flex h-12 w-16 shrink-0 flex-col justify-center gap-2 rounded px-2"
                    style={{ background: scheme.terminal.background, color: scheme.terminal.foreground }}>
                    <span className="font-mono text-base leading-none">Aa</span>
                    <span className="flex gap-1">{(["red", "yellow", "green", "cyan", "blue", "magenta"] as const).map((key) =>
                      <span key={key} className="size-1 rounded-full" style={{ background: scheme.terminal[key] }} />)}</span>
                  </span>
                  <span className="min-w-0 text-xs">{scheme.name}</span>
                </button>;
              })}
            </div>
          </div>
        ))}
        <GlassTintControl />
      </SettingsSection>

      <div data-testid="font-chat-preview" className="space-y-3 rounded-md border border-border p-3 text-sm"
        style={{ fontFamily: family === "system" ? HOST_FONT_STACK : family,
          fontSize: `calc(var(--type-size-14) * ${sizeScale / (appearance.font?.sizeScale ?? FONT_SIZE_SCALE_DEFAULT)})` }}>
        <p className="ml-auto w-fit max-w-full rounded-md bg-message-user px-3 py-2 text-message-user-foreground">{t("appearanceTab.previewUser")}</p>
        <p>{t("appearanceTab.previewAssistant")}</p>
        <pre data-testid="terminal-font-preview" className="overflow-x-auto rounded bg-muted p-3 font-mono"
          style={{ fontFamily: terminal.font.family, fontSize: terminal.font.size, lineHeight: terminal.font.lineHeight }}>{"const greeting = 'Hello, Ave';\nconsole.log(greeting);"}</pre>
      </div>
      <SettingsSection
        data-settings-section="appearance-font"
        title={t("appearanceTab.fontSectionTitle")}
        description={t("appearanceTab.fontSectionDescription")}
      >
        {fontLoadFailed && <div role="alert" className="space-y-2 text-sm text-destructive"><p>{t("appearanceTab.fontLoadFailed")}</p><Button type="button" size="sm" variant="outline" onClick={retryFonts}>{t("settingsEditor.retry")}</Button></div>}
        {fontSaveFailed && <p role="alert" className="text-sm text-destructive">{t("appearanceTab.fontSaveFailed")}</p>}
        <fieldset disabled={!fontLoaded} aria-label={t("appearanceTab.fontSectionTitle")} data-testid="appearance-font-controls" className="space-y-4">
        {/* 폰트 패밀리 */}
        <div className="space-y-2" data-setting-row="appearance.font.family">
          <label className="text-dense text-muted-foreground">{t("appearanceTab.fontFamilyLabel")}</label>
          <div
            role="radiogroup"
            onKeyDown={handleRadioGroupKeyDown}
            aria-label={t("appearanceTab.fontFamilyRadioGroupLabel")}
            data-testid="font-family-presets"
            className="flex flex-wrap gap-2"
          >
            {fontOptions.map((opt, index) => {
              const checked = activePreset === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  tabIndex={checked || (activePreset === "custom" && index === 0) ? 0 : -1}
                  data-value={opt.value}
                  style={{ fontFamily: opt.stack || HOST_FONT_STACK }}
                  onClick={() => setFamily(opt.stack)}
                  className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                    checked
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border text-muted-foreground hover:bg-muted/(--opacity-half) hover:text-foreground"
                  }`}
                >
                  {opt.text}
                </button>
              );
            })}
          </div>

          {/* 사용자 stack 직접 입력 — commit on blur / Enter only. */}
          <FontFamilyCustomInput
            initial={customStack}
            onCommit={(value) => setFamily(value)}
          />
        </div>

        {/* 폰트 크기 */}
        <div className="space-y-2" data-setting-row="appearance.font.sizeScale">
          <label className="text-dense text-muted-foreground">{t("appearanceTab.fontSizeLabel")}</label>
          <div
            role="radiogroup"
            onKeyDown={handleRadioGroupKeyDown}
            aria-label={t("appearanceTab.fontSizeRadioGroupLabel")}
            data-testid="font-size-scale"
            className="grid grid-cols-4 overflow-hidden rounded-md border border-border"
          >
            {FONT_SIZE_OPTIONS.map((opt) => {
              const checked = sizeScale === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  tabIndex={checked ? 0 : -1}
                  data-value={String(opt.value)}
                  onClick={() => setSizeScale(opt.value)}
                  className={`min-w-0 border-r border-border px-1 py-2 text-sm last:border-r-0 transition-colors ${
                    checked
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border text-muted-foreground hover:bg-muted/(--opacity-half) hover:text-foreground"
                  }`}
                >
                  <span className="block whitespace-nowrap">{t(opt.label)}</span>
                  <span className="block whitespace-nowrap text-dense">{Math.round(opt.value * 16)}px</span>
                  {opt.value === FONT_SIZE_SCALE_DEFAULT && <span className="block text-dense">{t("appearanceTab.fontSizeDefault")}</span>}
                </button>
              );
            })}
          </div>
        </div>
        </fieldset>
      </SettingsSection>

      <TerminalFontSection {...terminal} />
      <SettingsSection data-settings-section="appearance-zoom" title={t("appearanceTab.zoom")}>
        <ZoomControls />
      </SettingsSection>

    </div>
  );
}

const REDUCED_TRANSPARENCY_QUERY = "(prefers-reduced-transparency: reduce)";

/** The OS reduce-transparency switch, followed live. */
function useReducedTransparency(): boolean {
  const [reduced, setReduced] = useState(() => window.matchMedia?.(REDUCED_TRANSPARENCY_QUERY).matches ?? false);
  useEffect(() => {
    const query = window.matchMedia?.(REDUCED_TRANSPARENCY_QUERY);
    if (!query) return;
    const handleChange = () => setReduced(query.matches);
    query.addEventListener("change", handleChange);
    return () => query.removeEventListener("change", handleChange);
  }, []);
  return reduced;
}

/**
 * How much of the card colour covers the window material (macOS vibrancy, Windows 11 22H2+ Mica). Offered only where main says the OS has
 * a material (`data-glass-capable`): elsewhere the window is opaque and there is nothing to tune. The slider repaints on every step and saves when the drag (or key press) ends. With reduce transparency on — now, or
 * when this window was created, which is when main decides the material (`data-glass`) — it is shown disabled with the reason.
 */
function GlassTintControl() {
  const { t } = useTranslation();
  const { error, save } = useAppearanceChoicePersistence();
  const { appearance, setGlassTint, persistenceError } = useTheme();
  const reducedNow = useReducedTransparency();
  // A previewed value not yet saved. Every way a gesture can end (release, cancel, lost capture, key up, blur) commits it once;
  // the later ones of the same gesture find nothing pending, and a key that moved nothing (Tab) saves nothing.
  const pendingRef = useRef(false);
  if (!document.documentElement.hasAttribute("data-glass-capable")) return null;
  const available = !reducedNow && document.documentElement.hasAttribute("data-glass");
  const tint = appearance.glassTint ?? DEFAULT_GLASS_TINT;
  const commit = (event: { currentTarget: HTMLInputElement }) => {
    if (!pendingRef.current) return;
    pendingRef.current = false;
    const next = Number(event.currentTarget.value);
    void save(() => setGlassTint(next, true));
  };
  return (
    <div className="space-y-2" data-setting-row="appearance.glassTint" data-testid="appearance-glass-tint">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor="appearance-glass-tint-input" className="text-sm font-medium">{t("appearanceTab.glassTintLabel")}</label>
        <span className="font-mono text-dense text-muted-foreground">{tint}%</span>
      </div>
      <input
        id="appearance-glass-tint-input"
        type="range"
        min={GLASS_TINT_MIN}
        max={GLASS_TINT_MAX}
        step={1}
        value={tint}
        disabled={!available}
        aria-describedby="appearance-glass-tint-hint"
        aria-valuetext={`${tint}%`}
        className="w-full accent-primary disabled:opacity-(--opacity-half)"
        onChange={(event) => { pendingRef.current = true; void setGlassTint(Number(event.currentTarget.value), false); }}
        onPointerUp={commit}
        onPointerCancel={commit}
        onLostPointerCapture={commit}
        onKeyUp={commit}
        onBlur={commit}
      />
      <div className="flex justify-between text-dense text-muted-foreground" aria-hidden="true">
        <span>{t("appearanceTab.glassTintMin")}</span>
        <span>{t("appearanceTab.glassTintMax")}</span>
      </div>
      {error !== null && !persistenceError && <p role="alert" className="text-xs text-destructive">{error}</p>}
      <p id="appearance-glass-tint-hint" className="text-xs text-muted-foreground">
        {t(available ? "appearanceTab.glassTintHint" : "appearanceTab.glassTintReducedHint")}
      </p>
    </div>
  );
}

const CODE_FONT_PRESETS: ReadonlyArray<FontFamilyPreset> = [
  { value: "system", label: "appearanceTab.codeFontSystem", stack: DEFAULT_APPEARANCE.terminalFont.family },
  ...["JetBrains Mono", "Fira Code", "D2Coding", "Cascadia Code"].map((family) => ({
    value: family, label: family, stack: `"${family}", ${DEFAULT_APPEARANCE.terminalFont.family}`,
  })),
  { value: "sf-mono", label: "SF Mono / Menlo", stack: '"SF Mono", Menlo, ui-monospace, monospace' },
];

function useTerminalFontPreferences() {
  const notifySaved = useNotifySaved();
  const { appearance } = useTheme();
  const [font, setFont] = useState(appearance.terminalFont);
  const [failed, setFailed] = useState(false);
  const fontRef = useRef(font);
  const authoritativeRef = useRef(appearance.terminalFont);
  const revisionsRef = useRef({ family: 0, size: 0, lineHeight: 0 });
  const authoritativeRevisionRef = useRef(0);
  useEffect(() => {
    authoritativeRevisionRef.current++;
    authoritativeRef.current = appearance.terminalFont;
    fontRef.current = appearance.terminalFont;
    setFont(appearance.terminalFont);
    setFailed(false);
  }, [appearance.terminalFont]);
  const updateFont = async (patch: Partial<typeof font>) => {
    const keys = (Object.keys(patch) as Array<keyof typeof font>).filter((key) => patch[key] !== fontRef.current[key]);
    if (keys.length === 0) return;
    const revisions = { ...revisionsRef.current };
    const authoritativeRevision = authoritativeRevisionRef.current;
    for (const key of keys) revisions[key] = ++revisionsRef.current[key];
    fontRef.current = { ...fontRef.current, ...patch };
    setFont(fontRef.current);
    setFailed(false);
    try {
      const result = requirePersistedResult(await getApi().updateSettings({ appearance: { terminalFont: patch } }));
      const actual = result.appearance.terminalFont;
      const accepted = Object.fromEntries(keys.filter((key) => revisions[key] === revisionsRef.current[key] && authoritativeRevision === authoritativeRevisionRef.current).map((key) => [key, actual[key]]));
      authoritativeRef.current = { ...authoritativeRef.current, ...accepted };
      fontRef.current = { ...fontRef.current, ...accepted };
      setFont(fontRef.current);
      if (keys.every((key) => revisions[key] === revisionsRef.current[key] && fontRef.current[key] === actual[key])) notifySaved();
    } catch {
      const affected = keys.filter((key) => revisions[key] === revisionsRef.current[key]);
      if (affected.length === 0) return;
      const restored = Object.fromEntries(affected.map((key) => [key, authoritativeRef.current[key]]));
      fontRef.current = { ...fontRef.current, ...restored };
      setFont(fontRef.current);
      setFailed(true);
    }
  };
  return { font, failed, updateFont };
}

function TerminalFontSection({ font, failed, updateFont }: ReturnType<typeof useTerminalFontPreferences>) {
  const { t } = useTranslation();
  const activePreset = presetForStack(font.family, CODE_FONT_PRESETS);
  return <SettingsSection data-settings-section="appearance-terminal" title={t("appearanceTab.terminalTitle")}>
    {failed && <p role="alert" className="text-sm text-destructive">{t("appearanceTab.fontSaveFailed")}</p>}
    <div className="space-y-2">
      <label className="text-dense text-muted-foreground">{t("appearanceTab.terminalFamily")}</label>
      <div role="radiogroup" aria-label={t("appearanceTab.terminalFamily")} data-testid="code-font-presets"
        onKeyDown={handleRadioGroupKeyDown} className="flex flex-wrap gap-2">
        {CODE_FONT_PRESETS.map((preset, index) => (
          // biome-ignore lint/a11y/useSemanticElements: Button radios support roving focus and arrow-key selection.
          <button key={preset.value} type="button" role="radio"
          aria-checked={activePreset === preset.value} tabIndex={activePreset === preset.value || (activePreset === "custom" && index === 0) ? 0 : -1}
          style={{ fontFamily: preset.stack }} onClick={() => updateFont({ family: preset.stack })}
          className={activePreset === preset.value ? "rounded-full border border-primary bg-primary px-3 py-1 text-xs transition-colors text-primary-foreground" : "rounded-full border border-border px-3 py-1 text-xs transition-colors text-muted-foreground hover:bg-muted/(--opacity-half) hover:text-foreground"}>
          {t(preset.label)}
        </button>))}
      </div>
      <FontFamilyCustomInput initial={activePreset === "custom" ? font.family : ""}
        label={t("appearanceTab.codeFontCustomAriaLabel")} onCommit={(family) => updateFont({ family: family || DEFAULT_APPEARANCE.terminalFont.family })} />
    </div>
    <div className="flex flex-wrap gap-6">
      <FontMetricStepper label={t("appearanceTab.terminalSize")} value={font.size} step={1} validate={isTerminalFontSize}
        format={(value) => `${String(value)}px`} onChange={(size) => updateFont({ size })} />
      <FontMetricStepper label={t("appearanceTab.terminalLineHeight")} value={font.lineHeight} step={0.1} validate={isTerminalLineHeight}
        format={(value) => value.toFixed(1)} onChange={(lineHeight) => updateFont({ lineHeight })} />
    </div>
    <TerminalBehaviorFields />
  </SettingsSection>;
}

function FontMetricStepper({ label, value, step, validate, format, onChange }: {
  label: string; value: number; step: number; validate: (value: unknown) => boolean;
  format: (value: number) => string; onChange: (value: number) => void;
}) {
  const previous = Math.round((value - step) * 10) / 10;
  const next = Math.round((value + step) * 10) / 10;
  return <fieldset aria-label={label} className="space-y-1">
    <legend className="text-dense text-muted-foreground">{label}</legend>
    <div className="flex items-center gap-2 text-sm">
      <button type="button" aria-label={`${label} −`} disabled={!validate(previous)} onClick={() => onChange(previous)}
        className="rounded border border-input px-2 py-1 disabled:opacity-(--opacity-half)">−</button>
      <span className="min-w-12 text-center tabular-nums">{format(value)}</span>
      <button type="button" aria-label={`${label} +`} disabled={!validate(next)} onClick={() => onChange(next)}
        className="rounded border border-input px-2 py-1 disabled:opacity-(--opacity-half)">+</button>
    </div>
  </fieldset>;
}
