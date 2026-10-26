import { chatSurface } from "./chat-surface.js";
import { useTranslation } from "../../../i18n/react.js";
import { Button } from "../../../components/ui/button.js";

/** Offer to pick up a turn the previous app run never finished (see `interruptedTurnOffer`). Shown above the composer; the
 * turn only continues when the user presses Continue — reopening a session never runs anything. */
export function InterruptedTurnBanner({
  offer,
  onContinue,
}: {
  offer: "resume" | "rerun" | null;
  onContinue: () => void;
}) {
  const { t } = useTranslation();
  if (!offer) return null;
  return (
    <div
      className={`${chatSurface()} mx-3 mb-2 flex min-w-0 items-center gap-2 px-3 py-2 text-xs text-foreground`}
      data-testid="interrupted-turn-banner"
      data-offer={offer}
      role="status"
    >
      <span>
        {offer === "resume"
          ? t("chatView.interruptedTurnResumeNotice")
          : t("chatView.interruptedTurnUnansweredNotice")}
      </span>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        className="ml-auto h-6 px-2 text-xs"
        onClick={onContinue}
        data-testid="interrupted-turn-continue"
      >
        {t("chatView.interruptedTurnContinue")}
      </Button>
    </div>
  );
}
