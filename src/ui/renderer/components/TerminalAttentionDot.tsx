import { useTranslation } from "../../../i18n/react.js";

/**
 * A terminal asked for attention (OSC 9 / 777) and has not been seen since.
 *
 * Deliberately not `PendingAnswerDot`: that one means "a card waits for your
 * answer" in the warning tone; this is a shell's notification, drawn in the
 * primary tone so the two never read as the same thing. The message the shell
 * sent is the tooltip.
 */
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
