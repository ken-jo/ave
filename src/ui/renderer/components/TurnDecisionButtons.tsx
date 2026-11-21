import { Check, Undo2 } from "lucide-react";
import { useTranslation } from "../../../i18n/react.js";
import type { TurnReviewError } from "../../../shared/turn-change-review.js";

/**
 * Keep and Undo for one hunk, one file or the whole turn.
 * Both are the person's own action on their files, so pressing one acts at once: there is no confirmation step.
 */
export function TurnDecisionButtons({ scope, kept, disabled, keepLabel, undoLabel, onKeep, onUndo, compact = false }: {
  scope: "hunk" | "file" | "turn";
  /** Every change in this scope is already kept: the Keep button gives way to a "Kept" mark. */
  kept: boolean;
  disabled: boolean;
  /** Accessible names that say which change the button acts on. */
  keepLabel: string;
  undoLabel: string;
  onKeep: () => void;
  onUndo: () => void;
  /** Icon-only buttons for rows that have no room for words. */
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const button = "inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-border px-1.5 text-dense hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-50";
  return (
    <span className="inline-flex shrink-0 items-center gap-1" data-testid="turn-decision" data-scope={scope} data-kept={kept ? "true" : "false"}>
      {kept ? (
        <span className="inline-flex h-6 items-center gap-1 px-1 text-dense text-muted-foreground" data-testid="turn-decision-kept">
          <Check aria-hidden="true" className="h-3 w-3" />{compact ? <span className="sr-only">{t("fileEditDiff.kept")}</span> : t("fileEditDiff.kept")}
        </span>
      ) : (
        <button type="button" className={button} disabled={disabled} aria-label={keepLabel} title={keepLabel} onClick={onKeep} data-testid="turn-decision-keep">
          <Check aria-hidden="true" className="h-3 w-3" />{compact ? null : t(scope === "turn" ? "fileEditDiff.keepAll" : "fileEditDiff.keep")}
        </button>
      )}
      <button type="button" className={button} disabled={disabled} aria-label={undoLabel} title={undoLabel} onClick={onUndo} data-testid="turn-decision-undo">
        <Undo2 aria-hidden="true" className="h-3 w-3" />{compact ? null : t(scope === "turn" ? "fileEditDiff.undoAll" : "fileEditDiff.undo")}
      </button>
    </span>
  );
}

const DECISION_ERROR_KEY: Partial<Record<TurnReviewError, string>> = {
  "turn-review-stale": "fileEditDiff.reviewStale",
  "turn-review-unavailable": "fileEditDiff.reviewUnavailable",
  "turn-review-write-denied": "fileEditDiff.decisionDenied",
  "turn-review-partial": "fileEditDiff.decisionPartial",
  "turn-review-applied": "fileEditDiff.decisionApplied",
  "streaming-active": "fileEditDiff.decisionBusy",
};

/** Why a keep or undo was refused, in the person's language; nothing when the last decision went through. */
export function TurnDecisionError({ error }: { error: TurnReviewError | null | undefined }) {
  const { t } = useTranslation();
  if (!error) return null;
  return (
    <p role="alert" className="px-3 py-1.5 text-dense text-destructive" data-testid="turn-decision-error" data-error={error}>
      {t(DECISION_ERROR_KEY[error] ?? "fileEditDiff.decisionFailed")}
    </p>
  );
}
