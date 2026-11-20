import { useAppSettingsControls, useSettingsControls, useSettingsEditor } from "../context/SettingsEditorContext.js";
import { useEffect, useRef, useState } from "react";
import { Badge } from "../../../components/ui/badge.js";
import { Button } from "../../../components/ui/button.js";
import { Input } from "../../../components/ui/input.js";
import { Label } from "../../../components/ui/label.js";
import { WEB_PROVIDERS } from "../constants.js";
import type { AppSettings, AveApi } from "../types.js";
import { SettingsPageHeader, SettingsSection } from "../components/PageShell.js";
import { useSettingsPersistence } from "../hooks/use-settings-persistence.js";
import { useTranslation } from "../../../i18n/react.js";
import { ADDRESS_SEARCH_ENGINE_IDS, DEFAULT_ADDRESS_SEARCH_ENGINE, isAddressSearchEngine, type AddressSearchEngine } from "../../../shared/browser-address.js";

/** ─── webView preferredFlow options (relocated from AppearanceTab — it is browsing behavior, so it belongs on the Web /
 * Browsing tab) ─────────── */
type WebViewPreferredFlow = "in-app" | "system-browser";

const WEBVIEW_OPTIONS: ReadonlyArray<{ value: WebViewPreferredFlow; label: string; hint: string }> = [
  { value: "in-app", label: "appearanceTab.webViewInApp", hint: "appearanceTab.webViewInAppHint" },
  { value: "system-browser", label: "appearanceTab.webViewSystemBrowser", hint: "appearanceTab.webViewSystemBrowserHint" },
];

const WEB_CREDENTIAL_PRESENCE_CACHE_KEY = "web.credentialPresence";

function useWebViewPreferredFlow(api: AveApi, onSaved: () => void) {
  const { t } = useTranslation();
  // Inside the settings view the editor reads and follows the settings document; mounting the tab does not read it again.
  const editor = useSettingsEditor();
  const inEditor = editor !== null;
  const editorSettings = editor?.settings ?? null;
  const [flow, setFlowState] = useState<WebViewPreferredFlow>(editorSettings?.webView.preferredFlow ?? "in-app");
  const [loaded, setLoaded] = useState(editorSettings !== null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const persistence = useSettingsPersistence(onSaved);
  useEffect(() => {
    if (!inEditor || !editorSettings) return;
    setFlowState(editorSettings.webView.preferredFlow);
    setLoaded(true);
    setLoadError(null);
  }, [editorSettings, inEditor]);
  useEffect(() => {
    if (inEditor) return;
    let cancelled = false;
    const applySnapshot = (settings: AppSettings) => {
      if (cancelled) return;
      setFlowState(settings.webView.preferredFlow);
      setLoaded(true);
      setLoadError(null);
    };
    void api.getSettings().then(applySnapshot).catch(() => {
      if (!cancelled) setLoadError(t("webTab.loadFailed"));
    });
    const unsubscribe = api.onSettingsUpdated(applySnapshot);
    return () => { cancelled = true; unsubscribe(); };
  }, [api, inEditor, t]);
  const setFlow = (next: WebViewPreferredFlow) => {
    if (!loaded || persistence.saving || next === flow) return;
    const previous = flow;
    setFlowState(next);
    void persistence.persist(() => api.updateSettings({ webView: { preferredFlow: next } }), {
      rollback: () => setFlowState(previous),
    });
  };
  return { flow, setFlow, loaded, saving: persistence.saving, error: loadError ?? persistence.error };
}

/** The engine browser address-row text goes to when it is not an address. Saved on selection; a failed save restores the stored choice. */
function useAddressSearchEngine(api: AveApi, onSaved: () => void) {
  const editor = useSettingsEditor();
  const inEditor = editor !== null;
  const editorSettings = editor?.settings ?? null;
  const [engine, setEngineState] = useState<AddressSearchEngine>(editorSettings?.webView.addressSearchEngine ?? DEFAULT_ADDRESS_SEARCH_ENGINE);
  const canonical = useRef({ engine, revision: 0 });
  const [loaded, setLoaded] = useState(editorSettings !== null);
  const [loadFailed, setLoadFailed] = useState(false);
  const persistence = useSettingsPersistence(onSaved);
  useEffect(() => {
    if (!editorSettings) return;
    canonical.current = { engine: editorSettings.webView.addressSearchEngine, revision: canonical.current.revision + 1 };
    setEngineState(editorSettings.webView.addressSearchEngine);
    setLoaded(true);
    setLoadFailed(false);
  }, [editorSettings]);
  useEffect(() => {
    if (inEditor) return;
    let cancelled = false;
    const readRevision = canonical.current.revision;
    const applySnapshot = (settings: AppSettings) => {
      const stored = settings.webView?.addressSearchEngine;
      if (cancelled) return;
      const next = isAddressSearchEngine(stored) ? stored : DEFAULT_ADDRESS_SEARCH_ENGINE;
      canonical.current = { engine: next, revision: canonical.current.revision + 1 };
      setEngineState(next);
      setLoaded(true);
      setLoadFailed(false);
    };
    void api.getSettings().then((settings) => {
      if (canonical.current.revision === readRevision) applySnapshot(settings);
    }, () => { if (!cancelled && canonical.current.revision === readRevision) setLoadFailed(true); });
    const unsubscribe = api.onSettingsUpdated(applySnapshot);
    return () => { cancelled = true; unsubscribe(); };
  }, [api, inEditor]);
  const setEngine = (next: AddressSearchEngine) => {
    if (!loaded || persistence.saving || next === engine) return;
    const revision = canonical.current.revision;
    setEngineState(next);
    void persistence.persist(() => api.updateSettings({ webView: { addressSearchEngine: next } }), {
      rollback: () => setEngineState(canonical.current.engine),
    }).then((result) => {
      if (result !== null && canonical.current.revision === revision) canonical.current = { engine: next, revision: revision + 1 };
    });
  };
  return { engine, setEngine, loaded, saving: persistence.saving, failed: loadFailed || persistence.error !== null };
}

export interface WebTabProps {
  api: AveApi;
  webProvider: AppSettings["webSearch"]["provider"];
  setWebProvider: (v: AppSettings["webSearch"]["provider"]) => void;
  hasWebKey: boolean;
  setHasWebKey: (v: boolean) => void;
  webKeyInput: string;
  setWebKeyInput: (v: string) => void;
  onSaved: () => void;
  onSaveKey: () => Promise<boolean>;
  saving: boolean;
  /** Debounced immediate-apply hook — fired when the user picks a provider. */
  onImmediateChange?: () => void;
}

export function WebTab(props: WebTabProps) {
  const { t } = useTranslation();
  useAppSettingsControls(["web-search-engine", "web-view-flow", "web-address-search"]);
  const editor = useSettingsEditor();
  const { api, webProvider, setWebProvider, hasWebKey, setHasWebKey, webKeyInput, setWebKeyInput, onSaved, onSaveKey, saving, onImmediateChange } = props;
  const webInfo = WEB_PROVIDERS.find((p) => p.id === webProvider) ?? WEB_PROVIDERS[0];
  const { flow: webViewFlow, setFlow: setWebViewFlow, loaded: webViewLoaded, saving: webViewSaving, error: webViewError } = useWebViewPreferredFlow(api, onSaved);
  const webViewOption = WEBVIEW_OPTIONS.find((option) => option.value === webViewFlow);
  const keyPersistence = useSettingsPersistence(onSaved);
  const editorCache = editor?.cache;
  const [heldPresence] = useState(() => editorCache?.peek<Readonly<Record<string, boolean>>>(WEB_CREDENTIAL_PRESENCE_CACHE_KEY));
  const [keyPresence, setKeyPresence] = useState<Readonly<Record<string, boolean>>>(heldPresence ?? {});
  const [presenceLoading, setPresenceLoading] = useState(heldPresence === undefined);
  const [presenceError, setPresenceError] = useState<string | undefined>(undefined);
  const presenceKey = JSON.stringify([hasWebKey, webProvider, editor?.reloadEpoch]);
  const presenceKeyRef = useRef(presenceKey);
  presenceKeyRef.current = presenceKey;
  // A mount's first read may take the answer the editor holds for the current settings view; a later one follows a change
  // (a key saved here, a provider switch, a broadcast) and asks the store again.
  const presenceReadsRef = useRef(0);
  useEffect(() => {
    let active = true; let revision = 0;
    const read = async (): Promise<Readonly<Record<string, boolean>>> => Object.fromEntries(await Promise.all(WEB_PROVIDERS.filter((provider) => provider.needsKey).map(async (provider) => { const present = await api.hasWebApiKey(provider.id); if (typeof present !== "boolean") throw new Error("Invalid credential presence response"); return [provider.id, present] as const; })));
    const refresh = async (fresh: boolean) => {
      const request = ++revision; setPresenceLoading(true);
      try {
        const presence = editorCache ? await editorCache.load(WEB_CREDENTIAL_PRESENCE_CACHE_KEY, read, { fresh }) : await read();
        if (active && presenceKeyRef.current === presenceKey && request === revision) { setKeyPresence(presence); setPresenceError(undefined); }
      } catch { if (active && presenceKeyRef.current === presenceKey && request === revision) setPresenceError(t("settingsEditor.secretPresenceFailed")); }
      finally { if (active && presenceKeyRef.current === presenceKey && request === revision) setPresenceLoading(false); }
    };
    const fresh = presenceReadsRef.current++ > 0;
    const held = fresh ? undefined : editorCache?.peek<Readonly<Record<string, boolean>>>(WEB_CREDENTIAL_PRESENCE_CACHE_KEY);
    if (held) { setKeyPresence((current) => current === held ? current : held); setPresenceError(undefined); setPresenceLoading(false); }
    else void refresh(fresh);
    const unsubscribe = api.onSettingsUpdated(() => void refresh(true));
    return () => { active = false; unsubscribe(); };
  }, [api, editorCache, presenceKey, t]);
  useSettingsControls(WEB_PROVIDERS.filter((provider) => provider.needsKey).map((provider) => ({
    id: `webSearch.apiKey.${provider.id}`, section: "web-api-key", label: `${provider.label} · ${t("webTab.apiKeyStaticTitle")}`,
    modified: keyPresence[provider.id] === true, loading: presenceLoading, loadError: presenceError,
    reset: async () => {
      const result = await api.deleteWebApiKey(provider.id); if (result.ok !== true) throw new Error("Web secret reset failed");
      setKeyPresence((current) => ({ ...current, [provider.id]: false }));
      if (provider.id === webProvider) { setHasWebKey(false); setWebKeyInput(""); }
      onSaved();
    },
  })));


  const addressSearch = useAddressSearchEngine(api, onSaved);

  if (!webViewOption) throw new Error("Invalid browsing flow");

  return (
    <div className="space-y-6">
      <SettingsPageHeader
        title={t("webTab.pageTitle")}
        description={t("webTab.pageDescription")}
      />

      <SettingsSection
        data-settings-section="web-search-engine"
        title={t("webTab.searchEngineTitle")}
        description={t("webTab.searchEngineDescription")}
        badge={
          <span className="rounded-full bg-muted px-1.5 py-0.5 text-tiny font-medium uppercase tracking-wide text-muted-foreground">
            {t("webTab.immediateApplyBadge")}
          </span>
        }
      >
        <fieldset aria-label={t("webTab.searchEngineTitle")} className="grid min-w-0 grid-cols-2 gap-2">
          {WEB_PROVIDERS.map((p) => (
            <Button key={p.id} aria-pressed={webProvider === p.id} size="sm" variant={webProvider === p.id ? "default" : "outline"} className="justify-start text-xs" disabled={saving || keyPersistence.saving} onClick={() => { setWebProvider(p.id); onImmediateChange?.(); }}>
              {p.label}
            </Button>
          ))}
        </fieldset>
      </SettingsSection>

      {(
        <SettingsSection
          data-settings-section="web-api-key"
          title={t("webTab.apiKeyStaticTitle")}
        >
          <div className="space-y-2">
            {!webInfo.needsKey && <p className="text-sm text-muted-foreground">{t("webTab.apiKeyNotRequired")}</p>}
            {webInfo.needsKey && !hasWebKey && <p role="status" className="text-sm text-muted-foreground">{t("webTab.missingKeyFallback")}</p>}
            <Label htmlFor="web-api-key-input" className="text-sm font-medium">{t("webTab.apiKeyLabel", { label: webInfo.label })}</Label>
            <div className="flex items-center gap-2">
              {hasWebKey ? <Badge variant="default" className="text-xs">{t("webTab.keySet")}</Badge> : <Badge variant="secondary" className="text-xs">{t("webTab.keyNotSet")}</Badge>}
              {hasWebKey && <Button size="sm" variant="ghost" className="h-7 text-xs text-destructive" disabled={saving || keyPersistence.saving} onClick={() => { void keyPersistence.persist(() => api.deleteWebApiKey(webProvider)).then((result) => { if (result !== null) setHasWebKey(false); }); }}>{t("webTab.deleteButton")}</Button>}
            </div>
            <Input data-setting-id={`webSearch.apiKey.${webProvider}`} data-settings-transient={!webInfo.needsKey ? "not-applicable" : undefined} id="web-api-key-input" disabled={!webInfo.needsKey || saving} aria-label={t("webTab.apiKeyStaticTitle")} type="password" placeholder={hasWebKey ? t("webTab.replaceKeyPlaceholder") : webInfo.placeholder} value={webKeyInput} onChange={(e) => setWebKeyInput(e.target.value)} />
            {webKeyInput.trim() && <Badge variant="secondary">{t("llmTab.unsavedChanges")}</Badge>}
            {keyPersistence.error && <p role="alert" className="text-xs text-destructive">{keyPersistence.error}</p>}
            {webInfo.needsKey && <div className="flex justify-end"><Button size="sm" disabled={saving || keyPersistence.saving || !webKeyInput.trim()} onClick={() => { void onSaveKey(); }} data-testid="web-api-key-save">{t("webTab.saveKey")}</Button></div>}
          </div>
        </SettingsSection>
      )}

      {/* ── 외부 URL 표시 정책 (relocated from Appearance — browsing behavior) ── */}
      <SettingsSection
        data-settings-section="web-view-flow"
        title={t("appearanceTab.webViewSectionTitle")}
        description={t("appearanceTab.webViewSectionDescription")}
        actions={
          <span className="text-dense text-muted-foreground">
            {t("appearanceTab.webViewCurrentLabel")} <span className="text-foreground">{t(webViewOption.label)}</span>
          </span>
        }
      >
        <div
          role="radiogroup"
          data-setting-id="webView.preferredFlow"
          aria-label={t("appearanceTab.webViewRadioGroupLabel")}
          data-testid="webview-preferred-flow"
          className="flex flex-wrap gap-2"
        >
          {WEBVIEW_OPTIONS.map((opt) => {
            const checked = webViewFlow === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                role="radio"
                aria-checked={checked}
                data-value={opt.value}
                title={t(opt.hint)}
                disabled={!webViewLoaded || webViewSaving}
                onClick={() => setWebViewFlow(opt.value)}
                className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                  checked
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border text-muted-foreground hover:bg-muted/(--opacity-half) hover:text-foreground"
                }`}
              >
                {t(opt.label)}
              </button>
            );
          })}
        </div>
        {webViewError && <p role="alert" className="mt-2 text-xs text-destructive">{webViewError}</p>}
      </SettingsSection>

      <SettingsSection
        data-settings-section="web-address-search"
        title={t("webTab.addressSearchTitle")}
        description={t("webTab.addressSearchDescription")}
      >
        <fieldset data-testid="web-address-search-engine" data-setting-id="webView.addressSearchEngine" disabled={!addressSearch.loaded || addressSearch.saving} className="flex flex-wrap gap-2">
          <legend className="sr-only">{t("webTab.addressSearchTitle")}</legend>
          {ADDRESS_SEARCH_ENGINE_IDS.map((id) => {
            const checked = addressSearch.engine === id;
            return (
              <label key={id} data-value={id} data-checked={checked ? "true" : "false"}
                className={`cursor-pointer rounded-full border px-3 py-1 text-xs transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring ${
                  checked
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border text-muted-foreground hover:bg-muted/(--opacity-half) hover:text-foreground"
                }`}
              >
                <input type="radio" name="address-search-engine" value={id} checked={checked} className="sr-only"
                  onChange={() => addressSearch.setEngine(id)} />
                {t(`webTab.addressSearchEngine.${id}`)}
              </label>
            );
          })}
        </fieldset>
        {addressSearch.failed ? <p role="alert" className="mt-2 text-xs text-destructive">{t("webTab.addressSearchSaveFailed")}</p> : null}
      </SettingsSection>
    </div>
  );
}
