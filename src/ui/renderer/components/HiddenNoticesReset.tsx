import { Button } from "../../../components/ui/button.js";
import { useTranslation } from "../../../i18n/react.js";
import { clearSuppressedNotices, useHasSuppressedNotices } from "../hooks/status-bar/notice-suppression.js";

/** Undo "Don't show again": the one place a silenced notice kind can be brought back. */
export function HiddenNoticesReset() {
  const { t } = useTranslation();
  const hidden = useHasSuppressedNotices();
  return (
    <div className="space-y-1.5">
      <p className="text-xs text-muted-foreground">{t("notices.showHiddenHint")}</p>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={!hidden}
        data-testid="show-hidden-notices"
        onClick={clearSuppressedNotices}
      >
        {t("notices.showHiddenAgain")}
      </Button>
    </div>
  );
}
