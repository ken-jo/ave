import { useId, useState } from "react";
import { Switch } from "../../../components/ui/switch.js";
import { useTranslation } from "../../../i18n/react.js";
import { SettingsControlActions, useSettingsControls } from "../context/SettingsEditorContext.js";

const SESSION_INDEXING_SETTING = "features.sessionIndexingWithoutContainment";

export function SessionIndexingSection({ enabled, onChange }: {
  enabled: boolean | undefined;
  onChange: (enabled: boolean) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const id = useId();
  const descriptionId = `${id}-description`;
  const label = t("sessionIndexing.switch");
  const save = async (next: boolean) => {
    setSaving(true);
    setSaveFailed(false);
    try {
      await onChange(next);
    } catch (error) {
      setSaveFailed(true);
      throw error;
    } finally {
      setSaving(false);
    }
  };
  useSettingsControls(enabled === undefined ? [] : [{
    id: SESSION_INDEXING_SETTING,
    section: "session-indexing",
    label,
    modified: !enabled,
    disabledReason: saving ? t("settingsContent.saving") : undefined,
    reset: () => save(true),
  }]);
  if (enabled === undefined) return null;
  return (
    <section data-settings-section="session-indexing" tabIndex={-1} aria-labelledby={`${id}-title`} className="space-y-3 rounded-lg border p-4">
      <h2 id={`${id}-title`} className="text-sm font-semibold">{t("sessionIndexing.title")}</h2>
      <div data-setting-id={SESSION_INDEXING_SETTING} className="space-y-1 text-xs">
        <label htmlFor={id} className="flex items-center gap-2">
          <Switch id={id} checked={enabled} disabled={saving} aria-describedby={descriptionId}
            onCheckedChange={next => { void save(next).catch(() => {}); }} />
          {label}
        </label>
        <p id={descriptionId} className="text-muted-foreground">{t("sessionIndexing.description")}</p>
      </div>
      {!enabled && <p role="status" className="text-xs">{t("sessionIndexing.disabled")}</p>}
      {saveFailed && <p role="alert" className="text-xs text-destructive">{t("sessionIndexing.saveFailed")}</p>}
      <SettingsControlActions section="session-indexing" />
    </section>
  );
}
