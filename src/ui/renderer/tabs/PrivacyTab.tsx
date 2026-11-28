import { useAppSettingsControls } from "../context/SettingsEditorContext.js";
import { Switch } from "../../../components/ui/switch.js";
import { useTranslation } from "../../../i18n/react.js";

interface PrivacyTabProps {
  piiRedactEnabled: boolean;
  onToggle: () => void;
}

export function PrivacyTab({ piiRedactEnabled, onToggle }: PrivacyTabProps) {
  useAppSettingsControls(["chat-privacy"]);
  const { t } = useTranslation();
  return (
    <div className="space-y-4">
      {/* ── Toggle section ── */}
      <div className="rounded-lg border bg-background shadow-sm">
        {/* section header bar */}
        <div className="rounded-t-lg border-b bg-muted/(--opacity-medium) px-3 py-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {t("privacyTab.piiRedactTitle")}
          </p>
        </div>
        <div className="p-3 space-y-3">
          <p className="text-dense text-muted-foreground">
            {t("privacyTab.piiRedactDescription")}
          </p>
          <div className="flex items-center gap-3 rounded-lg border bg-background px-3 py-3 shadow-sm focus-within:ring-2 focus-within:ring-ring">
            <Switch
              data-setting-id="privacy.piiRedactEnabled"
              checked={piiRedactEnabled}
              aria-labelledby="pii-redact-toggle-label"
              className="shrink-0"
              onCheckedChange={onToggle}
            />
            <div className="space-y-0.5">
              <p id="pii-redact-toggle-label" className="text-sm font-semibold leading-snug text-foreground">
                {t("privacyTab.piiRedactToggleLabel")}
              </p>
              <p className="text-dense text-muted-foreground">
                {t("privacyTab.piiRedactToggleDescription")}
              </p>
            </div>
          </div>
        </div>
      </div>

    </div>
  );
}
