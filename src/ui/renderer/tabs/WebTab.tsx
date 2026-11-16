import { useEffect, useState } from "react";
import { Badge } from "../../../components/ui/badge.js";
import { Button } from "../../../components/ui/button.js";
import { Input } from "../../../components/ui/input.js";
import { Label } from "../../../components/ui/label.js";
import { WEB_PROVIDERS } from "../constants.js";
import type { AppSettings, AveApi } from "../types.js";
import { SettingsPageHeader, SettingsSection } from "../components/PageShell.js";
import { useSettingsPersistence } from "../hooks/use-settings-persistence.js";
import { useTranslation } from "../../../i18n/react.js";

/** ─── webView preferredFlow options (relocated from AppearanceTab — it is browsing behavior, so it belongs on the Web /
 * Browsing tab) ─────────── */
type WebViewPreferredFlow = "in-app" | "system-browser";

const WEBVIEW_OPTIONS: ReadonlyArray<{ value: WebViewPreferredFlow; label: string; hint: string }> = [
  { value: "in-app", label: "appearanceTab.webViewInApp", hint: "appearanceTab.webViewInAppHint" },
  { value: "system-browser", label: "appearanceTab.webViewSystemBrowser", hint: "appearanceTab.webViewSystemBrowserHint" },
];

function useWebViewPreferredFlow(api: AveApi, onSaved: () => void) {
  const { t } = useTranslation();
  const [flow, setFlowState] = useState<WebViewPreferredFlow>("in-app");
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const persistence = useSettingsPersistence(onSaved);
  useEffect(() => {
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
  }, [api, t]);
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
  const { api, webProvider, setWebProvider, hasWebKey, setHasWebKey, webKeyInput, setWebKeyInput, onSaved, onSaveKey, saving, onImmediateChange } = props;
  const webInfo = WEB_PROVIDERS.find((p) => p.id === webProvider) ?? WEB_PROVIDERS[0];
  const { flow: webViewFlow, setFlow: setWebViewFlow, loaded: webViewLoaded, saving: webViewSaving, error: webViewError } = useWebViewPreferredFlow(api, onSaved);
  const keyPersistence = useSettingsPersistence(onSaved);

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
            <Button key={p.id} aria-pressed={webProvider === p.id} size="sm" variant={webProvider === p.id ? "default" : "outline"} className="justify-start text-xs" onClick={() => { setWebProvider(p.id); onImmediateChange?.(); }}>
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
            <Input id="web-api-key-input" disabled={!webInfo.needsKey || saving} aria-label={t("webTab.apiKeyStaticTitle")} type="password" placeholder={hasWebKey ? t("webTab.replaceKeyPlaceholder") : webInfo.placeholder} value={webKeyInput} onChange={(e) => setWebKeyInput(e.target.value)} />
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
            {t("appearanceTab.webViewCurrentLabel")} <span className="text-foreground">{t(WEBVIEW_OPTIONS.find((option) => option.value === webViewFlow)!.label)}</span>
          </span>
        }
      >
        <div
          role="radiogroup"
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
    </div>
  );
}
