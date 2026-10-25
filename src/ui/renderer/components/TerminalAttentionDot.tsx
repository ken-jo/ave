import { useTranslation } from "../../../i18n/react.js";

/** Use primary tone for unread shell notifications and warning tone for pending answers; the shell message supplies the
 * tooltip. */
export function TerminalAttentionDot({ testId, message }: { testId: string; message: string }) {
  const { t } = useTranslation();
  const label = t("mainPanels.terminalUnread");
  return (
    <span
      role="img"
      aria-label={label}
      title={message ? `${label}: ${message}` : label}
      data-testid={testId}
      className="block h-[9px] w-[9px] shrink-0 rounded-full bg-primary ring-2 ring-card"
    />
  );
}
