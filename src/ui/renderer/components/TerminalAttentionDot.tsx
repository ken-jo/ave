import { useTranslation } from "../../../i18n/react.js";
import { StatusDot } from "./PendingAnswerDot.js";

/** A terminal's unread notification: the shared status dot in the primary tone (read state, not a waiting answer); the shell
 * message supplies the tooltip. */
export function TerminalAttentionDot({ testId, message }: { testId: string; message: string }) {
  const { t } = useTranslation();
  const label = t("mainPanels.terminalUnread");
  return (
    <StatusDot
      tone="bg-primary"
      label={label}
      title={message ? `${label}: ${message}` : label}
      testId={testId}
      placement="inline"
    />
  );
}
