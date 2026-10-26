/** Show the effective catalog and any environment or managed-policy override so the refresh switch does not imply control
 * it lacks. */
import { useCallback, useEffect, useState } from "react";
import { Switch } from "../../../components/ui/switch.js";
import { SettingsSection } from "../components/PageShell.js";
import { EnvForcedNotice, useEnvForcedSettings } from "../components/EnvForcedNotice.js";
import { useTranslation } from "../../../i18n/react.js";
import { getApi } from "../api-client.js";
import type { AppSettings } from "../types.js";
import { isIpcErrorResult } from "../types.js";
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
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [catalogState, setCatalogState] = useState<"loading" | "ready" | "failed">("loading");
  const [inForce, setInForce] = useState<CatalogInForce | null>(null);

  const applySnapshot = useCallback((s: AppSettings) => {
    setEnabled(s.llm?.modelCatalogRefresh !== "off");
    setLoaded(true);
  }, []);
  useSettingsSnapshot(api, applySnapshot);

  useEffect(() => {
    let alive = true;
    void api.getModelCatalog().then((result) => {
      if (!alive) return;
      if (!result.ok) { setCatalogState("failed"); return; }
      setInForce({
        fetchedAt: result.catalog.provenance.fetchedAt,
        sha256: result.catalog.sha256,
        policyOff: result.refreshPolicy === "off",
      });
      setCatalogState("ready");
    }).catch(() => { if (alive) setCatalogState("failed"); });
    return () => { alive = false; };
  }, [api]);

  const policyOff = inForce?.policyOff === true;
  const toggle = useCallback(async (checked: boolean) => {
    if (saving) return;
    setSaving(true);
    setSaveFailed(false);
    try {
      const result = await api.updateSettings({ llm: { modelCatalogRefresh: checked ? "auto" : "off" } });
      if (isIpcErrorResult(result)) setSaveFailed(true);
      else applySnapshot(result);
    } catch {
      setSaveFailed(true);
    } finally {
      setSaving(false);
    }
  }, [api, applySnapshot, saving]);

  return (
    <SettingsSection
      data-settings-section="llm-model-catalog"
      title={t("llmTab.modelCatalogTitle")}
      description={t("llmTab.modelCatalogDesc")}
    >
      <div className="flex items-center justify-between gap-4">
        <span className="text-sm font-medium">{t("llmTab.modelCatalogRefresh")}</span>
        <Switch
          checked={enabled && !envForced && !policyOff}
          disabled={!loaded || catalogState !== "ready" || saving || envForced || policyOff}
          aria-label={t("llmTab.modelCatalogRefresh")}
          data-testid="llm-model-catalog-refresh"
          onCheckedChange={toggle}
        />
      </div>
      {catalogState === "failed" && (
        <p role="alert" className="mt-1 text-xs text-destructive">
          {t("llmTab.modelCatalogUnavailable")}
        </p>
      )}
      {saveFailed && (
        <p role="alert" className="mt-1 text-xs text-destructive">
          {t("settingsContent.saveErrorMessage", { tab: t("llmTab.pageTitle") })}
        </p>
      )}
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
