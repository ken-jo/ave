import { useTranslation } from "../../../i18n/react.js";
import { requestTerminalFileReview, useTerminalFileReviewState } from "../preview/terminal-file-review.js";

export function TerminalFileReviewBadge({ tabId, onOpen }: { tabId: string; onOpen?: () => void }) {
  const { t } = useTranslation();
  const review = useTerminalFileReviewState(tabId);
  if (!review || (!review.pending && !review.refreshFailed)) return null;
  // A failed refresh keeps the last count and says so here, the badge being the review flow's only persistent chrome.
  const failed = review.refreshFailed ? t("terminalFileReview.refreshFailed") : undefined;
  return <button type="button" className="inline-flex shrink-0 items-center gap-1 rounded-full border border-warning/(--opacity-medium) px-1.5 py-0.5 text-xs text-warning" data-testid="terminal-tab-file-review-badge" title={failed} onClick={(event) => {
    event.stopPropagation();
    onOpen?.();
    requestTerminalFileReview(tabId);
  }}>
    <span className="h-2 w-2 rounded-full bg-warning" aria-hidden="true" />
    {t("terminalFileReview.pending", { count: review.pending })}{failed ? " !" : null}
  </button>;
}
