import { useId, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useTranslation } from "../../../i18n/react.js";
import { cn } from "../../../lib/utils.js";
import type { WorkspaceChanges } from "../preview/workspace-changes.js";
import { chatSurface } from "./chat-surface.js";
import { TurnDecisionButtons, TurnDecisionError } from "./TurnDecisionButtons.js";
import { FILE_CHANGE_ADDED_CLASS, FILE_CHANGE_REMOVED_CLASS, fileChangeBadgeClass, fileChangeLetter } from "./file-change-style.js";

export function LatestTurnSummary({ changes, onReveal }: { changes: WorkspaceChanges; onReveal: (path: string) => void }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(true);
  const listId = useId();
  if (changes.latestFiles.length === 0) return null;
  const remaining = Math.max(0, changes.latestFiles.length - 5);
  const onDecide = changes.onDecide;
  const reviewed = changes.latestFiles.flatMap((file) => file.review ? [file.review] : []);
  // The turn can be decided as a whole only when every file still holds the turn's own result.
  const turnDecidable = reviewed.length === changes.latestFiles.length && reviewed.every((file) => file.decidable);
  const allKept = (hunks: readonly { kept: boolean }[]) => hunks.length > 0 && hunks.every((hunk) => hunk.kept);
  return <section className={cn(chatSurface(), "mb-2 min-w-0 overflow-hidden text-xs")} data-testid="latest-turn-summary">
    <div className="flex min-w-0 items-center gap-1 px-2 py-1">
      <button type="button" className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 rounded px-1 py-1.5 text-left focus-visible:outline-2 focus-visible:outline-ring"
        aria-expanded={expanded} aria-controls={listId} onClick={() => setExpanded(!expanded)}>
        {expanded ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
        <span className="font-semibold">{t("fileEditDiff.latestTurnCaption")}</span>
        <span className="text-muted-foreground">{t("fileEditDiff.summaryFileCount", { count: changes.latestFiles.length })}</span>
        <span className="shrink-0 font-mono text-dense">
          <span className={FILE_CHANGE_ADDED_CLASS}>+{changes.countsKnown ? changes.added : "—"}</span>{" "}
          <span className={FILE_CHANGE_REMOVED_CLASS}>−{changes.countsKnown ? changes.removed : "—"}</span>
        </span>
      </button>
      {onDecide && <TurnDecisionButtons scope="turn" kept={reviewed.every((file) => allKept(file.hunks))} disabled={!turnDecidable || changes.deciding === true}
        keepLabel={t("fileEditDiff.keepTurnAria")} undoLabel={t("fileEditDiff.undoTurnAria")}
        onKeep={() => onDecide({ action: "keep", scope: "turn" })} onUndo={() => onDecide({ action: "undo", scope: "turn" })} />}
      <button type="button" className="flex shrink-0 items-center gap-0.5 rounded px-2 py-1.5 font-medium text-(--file-reference-fg) hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
        onClick={() => onReveal(changes.latestFiles[0]!.path)}>{t("fileEditDiff.summaryShowMore")}<ChevronRight aria-hidden="true" className="h-3 w-3" /></button>
    </div>
    <TurnDecisionError error={changes.decisionError} />
    {expanded && <div id={listId} className="max-h-[min(12rem,28vh)] overflow-y-auto overscroll-contain pb-1">
      <ul className="px-1.5">
        {changes.latestFiles.slice(0, 5).map((file) => {
          const slash = file.displayPath.lastIndexOf("/");
          const review = file.review;
          return <li key={file.path} className="flex min-w-0 items-center gap-1"><button type="button" onClick={() => onReveal(file.path)}
            className="flex h-[30px] min-w-0 flex-1 items-center gap-2 rounded-lg px-2 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
            data-testid="latest-turn-summary-file" aria-label={t("fileEditDiff.summaryRevealFile", { path: file.displayPath })}>
            <span aria-hidden="true" className={cn("flex size-4 shrink-0 items-center justify-center rounded text-tiny font-semibold", fileChangeBadgeClass(file.operation))}>{fileChangeLetter(file.operation)}</span>
            <span className="min-w-0 flex-1 truncate"><span className="text-muted-foreground">{file.displayPath.slice(0, slash + 1)}</span>{file.displayPath.slice(slash + 1)}</span>
            <span className="shrink-0 font-mono text-dense"><span className={FILE_CHANGE_ADDED_CLASS}>+{file.countsKnown ? file.added : "—"}</span>{" "}<span className={FILE_CHANGE_REMOVED_CLASS}>−{file.countsKnown ? file.removed : "—"}</span></span>
          </button>
          {onDecide && review && <TurnDecisionButtons scope="file" compact kept={allKept(review.hunks)} disabled={!review.decidable || changes.deciding === true}
            keepLabel={t("fileEditDiff.keepFileAria", { path: file.displayPath })} undoLabel={t("fileEditDiff.undoFileAria", { path: file.displayPath })}
            onKeep={() => onDecide({ action: "keep", scope: "file", path: review.path })}
            onUndo={() => onDecide({ action: "undo", scope: "file", path: review.path })} />}
          </li>;
        })}
      </ul>
      {remaining > 0 && <p className="px-3.5 pb-1 pt-0.5 text-dense text-muted-foreground">{t("fileEditDiff.summaryRemaining", { count: remaining })}</p>}
    </div>}
  </section>;
}
