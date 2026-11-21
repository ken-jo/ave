import { useMemo, useState } from "react";
import { useTranslation } from "../../../../i18n/react.js";
import { revealHiddenCharacters } from "../../../../shared/display-safe-text.js";
import { isRecord } from "../../../../shared/is-record.js";
import type { FileDiffView } from "../../../../shared/line-diff.js";
import type { ApprovalRequest } from "../../types.js";
import { editDiffView, fileEditDiffFromInput } from "../../utils/file-diff.js";
import { FileDiffRows } from "../FileEditDiff.js";

/** Rows shown before "Show all": enough to judge a typical edit without pushing the decision buttons off the card. */
const COLLAPSED_ROWS = 12;

/** The change an edit tool asks to make, or null for every other request. */
function requestedEditView(request: ApprovalRequest): FileDiffView | null {
  if (request.source !== "builtin" || !isRecord(request.args)) return null;
  if (request.toolName !== "edit_file" && request.toolName !== "multi_edit") return null;
  const data = fileEditDiffFromInput(request.toolName, request.args);
  if (!data) return null;
  const view = editDiffView(data);
  // The text is model input shown for a decision: no character in it may be invisible or reorder the line.
  return {
    ...view,
    hunks: view.hunks.map(hunk => ({
      ...hunk,
      rows: hunk.rows.map(row => ({ ...row, text: revealHiddenCharacters(row.text, { lineBreaks: false }) })),
    })),
  };
}

function firstRows(view: FileDiffView, limit: number): FileDiffView {
  let left = limit;
  const hunks = [];
  for (const hunk of view.hunks) {
    if (left <= 0) break;
    hunks.push({ ...hunk, rows: hunk.rows.slice(0, left) });
    left -= hunk.rows.length;
  }
  return { ...view, hunks, truncated: false };
}

/** The requested edit as a line diff, on the approval card itself: the person approves what they can read. */
export function ApprovalEditDiff({ request }: { request: ApprovalRequest }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const view = useMemo(() => requestedEditView(request), [request]);
  if (!view) return null;
  const rowCount = view.hunks.reduce((count, hunk) => count + hunk.rows.length, 0);
  const collapsible = rowCount > COLLAPSED_ROWS;
  return (
    <div
      className="min-w-0 overflow-hidden rounded-md border border-border bg-background"
      data-testid="approval-edit-diff"
      data-added={view.added}
      data-removed={view.removed}
    >
      <div className="flex min-w-0 items-center gap-2 border-b border-border bg-muted/(--opacity-muted) px-3 py-1 text-tiny">
        <span className="min-w-0 flex-1 truncate font-semibold">{t("toolApprovalDialog.rowChange")}</span>
        <span className="shrink-0 rounded bg-success/(--opacity-subtle) px-1 font-semibold">
          <span aria-hidden="true">+{view.added}</span>
          <span className="sr-only">{t("fileEditDiff.addedLinesAriaLabel", { count: String(view.added) })}</span>
        </span>
        <span className="shrink-0 rounded bg-destructive/(--opacity-subtle) px-1 font-semibold">
          <span aria-hidden="true">−{view.removed}</span>
          <span className="sr-only">{t("fileEditDiff.removedLinesAriaLabel", { count: String(view.removed) })}</span>
        </span>
      </div>
      <div className={`font-mono text-xs leading-[1.55] ${expanded ? "max-h-72 overflow-y-auto" : ""}`}>
        <FileDiffRows view={expanded || !collapsible ? view : firstRows(view, COLLAPSED_ROWS)} numbered={false} />
        {view.added === 0 && view.removed === 0 ? (
          <p className="px-3 py-1 font-sans text-tiny text-muted-foreground">
            {t(view.lineEndingsOnly ? "fileEditDiff.lineEndingsOnly" : "fileEditDiff.noChanges")}
          </p>
        ) : null}
      </div>
      {collapsible ? (
        <button
          type="button"
          className="w-full border-t border-border px-3 py-1 text-left text-tiny text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          aria-expanded={expanded}
          data-testid="approval-edit-diff-toggle"
          onClick={() => setExpanded(value => !value)}
        >
          {expanded ? t("toolApprovalDialog.changeShowLess") : t("toolApprovalDialog.changeShowAll", { count: rowCount })}
        </button>
      ) : null}
    </div>
  );
}
