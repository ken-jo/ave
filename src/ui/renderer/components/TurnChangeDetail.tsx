import { useState } from "react";
import { Link2 } from "lucide-react";
import { useTranslation } from "../../../i18n/react.js";
import type { TurnReviewFile } from "../../../shared/turn-change-review.js";
import type { FileMentionReference } from "../../../shared/file-mention-reference.js";
import { FileEditDiff } from "./FileEditDiff.js";
import { FILE_CHANGE_ADDED_CLASS, FILE_CHANGE_REMOVED_CLASS, fileChangeBadgeClass } from "./file-change-style.js";

const HUNKS_PER_PAGE = 5;

export interface TurnChangeDetailProps {
  file: TurnReviewFile;
  turnId: string;
  onReference?: (reference: FileMentionReference) => void;
  onFileReference?: (path: string) => void;
}

export function TurnChangeDetail({ file, turnId, onReference, onFileReference }: TurnChangeDetailProps) {
  const { t } = useTranslation();
  const [pagination, setPagination] = useState({ path: file.path, turnId, page: 0 });
  const lastPage = Math.max(0, Math.ceil(file.hunks.length / HUNKS_PER_PAGE) - 1);
  const page = pagination.path === file.path && pagination.turnId === turnId ? Math.min(pagination.page, lastPage) : 0;
  const hunkOffset = page * HUNKS_PER_PAGE;
  const hunks = file.hunks.slice(hunkOffset, hunkOffset + HUNKS_PER_PAGE);
  const displayPath = file.path.replace(/\\/g, "/");
  const separator = displayPath.lastIndexOf("/");
  const name = displayPath.slice(separator + 1);
  const directory = separator < 0 ? "" : displayPath.slice(0, separator);
  const operation = file.operation;
  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden" data-testid="turn-change-detail">
      <header className="flex min-w-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2.5">
        <button type="button" disabled={!onFileReference} onClick={() => onFileReference?.(file.path)}
          aria-label={t("fileEditDiff.fileReferenceAria", { path: file.path })}
          className="min-w-0 flex-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <span className="block truncate text-xs font-semibold">{name}</span>
          {directory && <span className="block truncate text-[11px] text-muted-foreground">{directory}</span>}
        </button>
        <span className={`shrink-0 rounded-md px-1.5 py-1 text-[11px] font-medium ${fileChangeBadgeClass(operation)}`}>
          {t(`fileEditDiff.operation.${operation}`)}
        </span>
        <span className="shrink-0 font-mono text-xs" data-testid="turn-change-detail-counts">
          <span className={FILE_CHANGE_ADDED_CLASS}>+{file.countsKnown ? file.added : "—"}</span>{" "}
          <span className={FILE_CHANGE_REMOVED_CLASS}>−{file.countsKnown ? file.removed : "—"}</span>
        </span>
        <button type="button" disabled={!onFileReference} onClick={() => onFileReference?.(file.path)}
          className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-border px-2 text-[11px] hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
          <Link2 aria-hidden="true" className="h-3 w-3" />{t("fileEditDiff.fileReference")}
        </button>
      </header>
      <div className="min-h-0 min-w-0 flex-1 space-y-2.5 overflow-y-auto overscroll-contain px-3 py-3">
        <p className="text-xs text-muted-foreground">{t("fileEditDiff.latestTurnCaption")}</p>
        <FileEditDiff data={{ tool: "edit_file", path: file.path, isNewFile: operation === "create", truncated: false,
          hunks: hunks.map((hunk) => ({ oldText: hunk.oldText, newText: hunk.newText })) }}
          review={{ hunks, hunkOffset, turnId, referenceable: file.referenceable, onReference }} />
        {lastPage > 0 && (
          <nav aria-label={t("fileEditDiff.hunkPages")} className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
            <button type="button" disabled={page === 0} onClick={() => setPagination({ path: file.path, turnId, page: page - 1 })}
              className="rounded-md border border-border px-2 py-1 hover:bg-muted disabled:opacity-50">{t("fileEditDiff.reviewPrevious")}</button>
            <span aria-live="polite" className="text-muted-foreground">{t("fileEditDiff.reviewPageRange", { start: hunkOffset + 1,
              end: Math.min(file.hunks.length, hunkOffset + HUNKS_PER_PAGE), count: file.hunks.length })}</span>
            <button type="button" disabled={page === lastPage} onClick={() => setPagination({ path: file.path, turnId, page: page + 1 })}
              className="rounded-md border border-border px-2 py-1 hover:bg-muted disabled:opacity-50">{t("fileEditDiff.reviewNext")}</button>
          </nav>
        )}
      </div>
    </section>
  );
}
