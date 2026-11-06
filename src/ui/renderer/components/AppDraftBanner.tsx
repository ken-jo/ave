import { Button } from "../../../components/ui/button.js";
import { useTranslation } from "../../../i18n/react.js";
import { chatSurface } from "./chat-surface.js";

export interface AppDraftBannerProps {
  appName: string;
  text: string;
  onReplace: () => void;
  onDismiss: () => void;
}

/** Suggestions remain beside the composer until the user chooses; arrival never moves keyboard focus. */
export function AppDraftBanner({ appName, text, onReplace, onDismiss }: AppDraftBannerProps) {
  const { t } = useTranslation();
  return (
    <div className={`${chatSurface({ edge: "quiet", elevation: "flat" })} mb-2 min-w-0 px-3 py-2`} data-testid="app-draft-banner">
      <div role="status" aria-live="polite" aria-atomic="true">
        <p className="text-xs font-medium">{t("app.replaceAppDraftTitle", { appName })}</p>
        <p className="mt-1 line-clamp-3 whitespace-pre-wrap break-words text-sm text-muted-foreground">{text}</p>
      </div>
      <div className="mt-2 flex gap-2">
        <Button type="button" size="sm" variant="outline" onClick={onReplace}>{t("app.replaceAppDraft")}</Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDismiss}>{t("app.dismissAppDraft")}</Button>
      </div>
    </div>
  );
}
