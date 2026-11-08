import { useCallback, useMemo, useState } from "react";
import { Play } from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import { NativeSelect, NativeSelectOption } from "../../../components/ui/native-select.js";
import {
  ACCESSIBILITY_SIGNAL_IDS,
  ACCESSIBILITY_SIGNAL_MODES,
  ACCESSIBILITY_SIGNAL_SETTING_KEYS,
  isAccessibilitySignalMode,
  resolveAccessibilitySignalModes,
  type AccessibilitySignalId,
  type AccessibilitySignalSettings,
  type AccessibilitySignalMode,
} from "../../../shared/accessibility-signals.js";
import { useTranslation } from "../../../i18n/react.js";
import { getApi } from "../api-client.js";
import { getAccessibilitySignalEngine } from "../accessibility-signal-engine.js";
import { SettingsSection } from "../components/PageShell.js";
import { useNotifySaved } from "../context/SavedToastContext.js";
import { useSettingsSnapshot } from "../hooks/use-settings-snapshot.js";
import { isIpcErrorResult, type AppSettings } from "../types.js";

const SIGNAL_LABEL_KEYS: Record<AccessibilitySignalId, { label: string; hint: string }> = {
  turnFinished: { label: "accessibilitySignals.turnFinished", hint: "accessibilitySignals.turnFinishedHint" },
  approvalNeeded: { label: "accessibilitySignals.approvalNeeded", hint: "accessibilitySignals.approvalNeededHint" },
  turnFailed: { label: "accessibilitySignals.turnFailed", hint: "accessibilitySignals.turnFailedHint" },
};

const MODE_LABEL_KEYS: Record<AccessibilitySignalMode, string> = {
  off: "accessibilitySignals.modeOff",
  unfocused: "accessibilitySignals.modeUnfocused",
  on: "accessibilitySignals.modeOn",
};

/** Settings → Chat → Sound signals: one mode and one preview per signal. Self-loading like the documents section, and saved
 * per change; the window's signal engine follows the same settings broadcast. */
export function AccessibilitySignalsSettings() {
  const { t } = useTranslation();
  const notifySaved = useNotifySaved();
  const api = useMemo(() => getApi(), []);
  const [modes, setModes] = useState<Record<AccessibilitySignalId, AccessibilitySignalMode> | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [playFailed, setPlayFailed] = useState<AccessibilitySignalId | null>(null);

  const applySnapshot = useCallback((settings: AppSettings) => {
    setModes(resolveAccessibilitySignalModes(settings.system));
  }, []);
  useSettingsSnapshot(api, applySnapshot);

  const handleModeChange = async (id: AccessibilitySignalId, next: AccessibilitySignalMode) => {
    setSaving(true);
    setSaveFailed(false);
    try {
      const patch: AccessibilitySignalSettings = { [ACCESSIBILITY_SIGNAL_SETTING_KEYS[id]]: next };
      const result = await api.updateSettings({ system: patch });
      if (isIpcErrorResult(result)) throw new Error("Accessibility signal mode was not saved");
      setModes(resolveAccessibilitySignalModes(result.system));
      notifySaved();
    } catch {
      setSaveFailed(true);
    } finally {
      setSaving(false);
    }
  };

  const handlePreview = (id: AccessibilitySignalId) => {
    setPlayFailed(null);
    getAccessibilitySignalEngine().preview(id).catch(() => setPlayFailed(id));
  };

  return (
    <SettingsSection
      data-settings-section="chat-signals"
      title={t("accessibilitySignals.title")}
      description={t("accessibilitySignals.description")}
    >
      <div className="space-y-2" data-testid="accessibility-signals">
        {ACCESSIBILITY_SIGNAL_IDS.map((id) => {
          const label = t(SIGNAL_LABEL_KEYS[id].label);
          return (
            <div key={id} className="flex flex-wrap items-center gap-3 rounded-md border px-3 py-3" data-testid={`accessibility-signal:${id}`}>
              <div className="min-w-0 flex-1 space-y-0.5">
                <p className="text-sm font-medium">{label}</p>
                <p className="text-dense text-muted-foreground">{t(SIGNAL_LABEL_KEYS[id].hint)}</p>
                {playFailed === id && <p role="alert" className="text-dense text-destructive">{t("accessibilitySignals.playFailed")}</p>}
              </div>
              <NativeSelect
                size="sm"
                value={modes?.[id] ?? ""}
                disabled={modes === null || saving}
                aria-label={t("accessibilitySignals.modeAriaLabel", { signal: label })}
                data-testid={`accessibility-signal-mode:${id}`}
                onChange={(event) => {
                  const next = event.target.value;
                  if (isAccessibilitySignalMode(next)) void handleModeChange(id, next);
                }}
              >
                {ACCESSIBILITY_SIGNAL_MODES.map((mode) => (
                  <NativeSelectOption key={mode} value={mode}>{t(MODE_LABEL_KEYS[mode])}</NativeSelectOption>
                ))}
              </NativeSelect>
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-label={t("accessibilitySignals.playAriaLabel", { signal: label })}
                data-testid={`accessibility-signal-play:${id}`}
                onClick={() => handlePreview(id)}
              >
                <Play className="size-3.5" aria-hidden="true" />
                {t("accessibilitySignals.play")}
              </Button>
            </div>
          );
        })}
        {saveFailed && <p role="alert" className="text-dense text-destructive">{t("accessibilitySignals.saveFailed")}</p>}
      </div>
    </SettingsSection>
  );
}
