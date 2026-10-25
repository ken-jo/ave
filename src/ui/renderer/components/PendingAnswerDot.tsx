import { useTranslation } from "../../../i18n/react.js";

/** pendingAnswers decides attention ownership; this component only draws the shared warning dot. */
export function PendingAnswerDot({ testId, inline = false }: { testId: string; inline?: boolean }) {
  const { t } = useTranslation();
  return (
    <span
      role="img"
      aria-label={t("pendingAnswerDot.label")}
      title={t("pendingAnswerDot.label")}
      data-testid={testId}
      className={[
        "block h-[9px] w-[9px] shrink-0 rounded-full bg-warning ring-2 ring-card",
        inline ? "" : "pointer-events-none absolute right-0.5 top-0.5",
      ].join(" ")}
    />
  );
}
