/**
 * The model catalog refresh switch — `llm.modelCatalogRefresh` (design
 * `model-capability-catalog.md` §7).
 *
 * On by default: once a day the host fetches the public models.dev document,
 * the source of each model's context window, output limit and list price, and
 * caches it for the next launch. Off keeps the last cached copy or the
 * snapshot this build ships. The section says when something other than this
 * switch is deciding — a `AVE_MODEL_CATALOG` pin or the managed policy file
 * — and which catalog the app is running on now, so the switch never claims
 * an effect the running app does not have.
 */
import { useCallback, useEffect, useState } from "react";
import { Switch } from "../../../components/ui/switch.js";
import { SettingsSection } from "../components/PageShell.js";
import { EnvForcedNotice, useEnvForcedSettings } from "../components/EnvForcedNotice.js";
import { useTranslation } from "../../../i18n/react.js";
import { getApi } from "../api-client.js";
import type { AppSettings } from "../types.js";
import { useSettingsSnapshot } from "../hooks/use-settings-snapshot.js";

const SETTINGS_PATH = "llm.modelCatalogRefresh";

interface CatalogInForce {
  fetchedAt: string;
  sha256: string;
  policyOff: boolean;
}

export function ModelCatalogRefreshSection() {
  const { t } = useTranslation();
  const api = getApi();
  const envForcedPaths = useEnvForcedSettings(api);
  const envForced = envForcedPaths.includes(SETTINGS_PATH);

  const [loaded, setLoaded] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [inForce, setInForce] = useState<CatalogInForce | null>(null);

  const applySnapshot = useCallback((s: AppSettings) => {
    setEnabled(s.llm?.modelCatalogRefresh !== "off");
    setLoaded(true);
  }, []);
  useSettingsSnapshot(api, applySnapshot);

  useEffect(() => {
    let alive = true;
    void api.getModelCatalog().then((result) => {
      if (!alive || !result.ok) return;
      setInForce({
        fetchedAt: result.catalog.provenance.fetchedAt,
        sha256: result.catalog.sha256,
        policyOff: result.refreshPolicy === "off",
      });
    });
    return () => { alive = false; };
  }, [api]);

  const policyOff = inForce?.policyOff === true;
  const toggle = useCallback((checked: boolean) => {
    setEnabled(checked);
    void api.updateSettings({ llm: { modelCatalogRefresh: checked ? "auto" : "off" } });
  }, [api]);

  return (
    <SettingsSection
      data-settings-section="llm-model-catalog"
      title={t("llmTab.modelCatalogTitle")}
      description={t("llmTab.modelCatalogDesc")}
    >
      <div className="flex items-center justify-between gap-4">
        <span className="text-sm font-medium">{t("llmTab.modelCatalogRefresh")}</span>
        <Switch
          checked={enabled}
          disabled={!loaded || envForced || policyOff}
          aria-label={t("llmTab.modelCatalogRefresh")}
          data-testid="llm-model-catalog-refresh"
          onCheckedChange={toggle}
        />
      </div>
      <p className="mt-1 text-xs text-muted-foreground" data-testid="llm-model-catalog-help">
        {t("llmTab.modelCatalogHelp")}
      </p>
      <EnvForcedNotice
        settingsPath={SETTINGS_PATH}
        forcedPaths={envForcedPaths}
        messageKey="llmTab.modelCatalogEnvForced"
        testId="llm-model-catalog-forced"
        className="mt-1"
      />
      {policyOff && (
        <p className="mt-1 text-xs text-muted-foreground" data-testid="llm-model-catalog-policy">
          {t("llmTab.modelCatalogPolicyOff")}
        </p>
      )}
      {inForce && (
        <p className="mt-2 text-xs text-muted-foreground" data-testid="llm-model-catalog-in-force">
          {t("llmTab.modelCatalogInForce", { date: inForce.fetchedAt.slice(0, 10), sha: inForce.sha256.slice(0, 12) })}
        </p>
      )}
    </SettingsSection>
  );
}
