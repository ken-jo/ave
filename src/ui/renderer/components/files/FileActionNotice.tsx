/** What the last file action could not do, shown next to the list or the file. "No editor command is set" also offers the
 * way to the setting, so the explanation and its fix stay together. */
import { Button } from "../../../../components/ui/button.js";
import { useTranslation } from "../../../../i18n/react.js";
import { requestSettingsSection } from "../../utils/app-shell-requests.js";
import { EDITOR_COMMAND_SETTINGS_PATH, EDITOR_NOT_CONFIGURED_KEY } from "./open-in-editor.js";

export function FileActionNotice({ messageKey, testId }: { messageKey: string; testId: string }) {
  const { t } = useTranslation();
  return (
    <div role="alert" className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-1 text-dense text-destructive" data-testid={testId}>
      <span className="min-w-0 [overflow-wrap:anywhere]">{t(messageKey)}</span>
      {messageKey === EDITOR_NOT_CONFIGURED_KEY ? (
        <Button type="button" size="sm" variant="outline" className="h-6 px-2 text-dense text-foreground" data-testid="file-action-open-settings"
          onClick={() => requestSettingsSection(EDITOR_COMMAND_SETTINGS_PATH)}>
          {t("folderView.editorOpenSettings")}
        </Button>
      ) : null}
    </div>
  );
}
