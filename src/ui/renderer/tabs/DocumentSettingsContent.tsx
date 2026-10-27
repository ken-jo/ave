import { useEffect, useState } from "react";
import { Label } from "../../../components/ui/label.js";
import { RadioGroup, RadioGroupItem } from "../../../components/ui/radio-group.js";
import { isDocumentOpenMode, type DocumentOpenMode } from "../../../shared/document-settings.js";
import { useTranslation } from "../../../i18n/react.js";
import { getApi } from "../api-client.js";
import { SettingsSection } from "../components/PageShell.js";
import { useNotifySaved } from "../context/SavedToastContext.js";
import { DocumentEngineInstallContent } from "../components/DocumentEngineInstallContent.js";

const OPEN_MODE_OPTIONS: readonly { value: DocumentOpenMode; label: string; hint: string }[] = [
  { value: "direct", label: "documentSettings.direct", hint: "documentSettings.directHint" },
  { value: "link", label: "documentSettings.link", hint: "documentSettings.linkHint" },
];

export function DocumentSettingsContent() {
  const { t } = useTranslation();
  const notifySaved = useNotifySaved();
  const [openMode, setOpenMode] = useState<DocumentOpenMode>("direct");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    const api = getApi();
    let receivedUpdate = false;
    const apply = (settings: Awaited<ReturnType<typeof api.getSettings>>) => {
      if (active && isDocumentOpenMode(settings.documents?.openMode)) {
        setOpenMode(settings.documents.openMode);
        setLoaded(true);
        setFailed(false);
      } else if (active) {
        setFailed(true);
      }
    };
    const unsubscribe = api.onSettingsUpdated((settings) => { receivedUpdate = true; apply(settings); });
    void api.getSettings().then((settings) => { if (!receivedUpdate) apply(settings); }).catch(() => { if (active && !receivedUpdate) setFailed(true); });
    return () => { active = false; unsubscribe(); };
  }, []);

  const handleModeChange = async (next: DocumentOpenMode) => {
    if (next === openMode) return;
    setSaving(true);
    setFailed(false);
    try {
      const result = await getApi().updateSettings({ documents: { openMode: next } });
      if ("ok" in result && result.ok === false) throw new Error("Document preference was not saved");
      if (!("documents" in result) || !isDocumentOpenMode(result.documents.openMode)) {
        throw new Error("Document preference response is invalid");
      }
      setOpenMode(result.documents.openMode);
      notifySaved();
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsSection data-settings-section="chat-documents" title={t("documentSettings.title")} description={t("documentSettings.description")}>
      <DocumentEngineInstallContent />
      <RadioGroup
        value={openMode}
        onValueChange={(value) => { if (isDocumentOpenMode(value)) void handleModeChange(value); }}
        disabled={!loaded || saving}
        aria-label={t("documentSettings.title")}
        data-testid="document-open-mode"
        className="space-y-2"
      >
        {OPEN_MODE_OPTIONS.map((option) => (
          <Label key={option.value} htmlFor={`document-open-${option.value}`} className="flex items-start gap-3 rounded-md border border-border px-3 py-2">
            <RadioGroupItem id={`document-open-${option.value}`} value={option.value} data-value={option.value} />
            <span className="space-y-1">
              <span className="block text-sm font-medium">{t(option.label)}</span>
              <span className="block text-xs text-muted-foreground">{t(option.hint)}</span>
            </span>
          </Label>
        ))}
      </RadioGroup>
      {failed && <p role="alert" className="mt-2 text-sm text-destructive">{t("documentSettings.saveFailed")}</p>}
    </SettingsSection>
  );
}
