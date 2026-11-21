import { useState, useEffect, useMemo, useId } from "react";
import { ChevronDown, ChevronRight, FilePlus2, FilePenLine, FolderSearch } from "lucide-react";
import type { FileEditDiffData, FileEditHunk } from "../utils/file-diff.js";
import { editDiffView } from "../utils/file-diff.js";
import type { FileDiffHunk, FileDiffView, WriteDiffRecord } from "../../../shared/line-diff.js";
import { getApi } from "../api-client.js";
import { useTranslation } from "../../../i18n/react.js";
import { errorMessage } from "../../../shared/error-message.js";
import type { TurnReviewDecision, TurnReviewHunk } from "../../../shared/turn-change-review.js";
import { TurnDecisionButtons } from "./TurnDecisionButtons.js";
import { PathLabel } from "./PathLabel.js";
import { canShowInFolderView, showInFolderView } from "./files/show-in-folder-view.js";
import type { FileMentionReference } from "../../../shared/file-mention-reference.js";

const REVIEW_PREVIEW_MAX_LINES = 100;
const REVIEW_PREVIEW_MAX_CHARACTERS = 8192;

const VERB_KEY_BY_TOOL: Record<FileEditDiffData["tool"], string> = {
  edit_file: "fileEditDiff.verbEdit",
  multi_edit: "fileEditDiff.verbPatch",
  write_file: "fileEditDiff.verbWrite",
};

export interface FileEditDiffReview {
  hunks: TurnReviewHunk[];
  hunkOffset?: number;
  turnId: string;
  referenceable: boolean;
  onReference?: (reference: FileMentionReference) => void;
  /** Keep or undo one hunk; absent where the review is read-only. */
  onDecide?: (decision: TurnReviewDecision) => void;
  /** False while the file cannot be decided: it changed since the turn, or a decision is still being applied. */
  decidable?: boolean;
}

/** Identifies the tool call whose host-computed diff the card loads. */
export interface FileEditDiffSource {
  sessionId: string;
  toolUseId: string;
}

type StoredDiff =
  | { state: "none" }
  | { state: "loading" }
  | { state: "loaded"; record: WriteDiffRecord }
  | { state: "missing" }
  | { state: "error"; message: string };

/** Load the stored whole-file diff of one tool call; the card renders from the tool input until it arrives. */
function useStoredDiff(wanted: boolean, source: FileEditDiffSource | undefined): { stored: StoredDiff; retry: () => void } {
  const sessionId = wanted ? source?.sessionId : undefined;
  const toolUseId = wanted ? source?.toolUseId : undefined;
  const [stored, setStored] = useState<StoredDiff>({ state: "none" });
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is the retry trigger; it is read by nothing inside the effect.
  useEffect(() => {
    if (sessionId === undefined || toolUseId === undefined) {
      setStored({ state: "none" });
      return;
    }
    let current = true;
    setStored({ state: "loading" });
    getApi().chatGetWriteDiff(sessionId, toolUseId).then(
      (record) => { if (current) setStored(record === null ? { state: "missing" } : { state: "loaded", record }); },
      (error: unknown) => { if (current) setStored({ state: "error", message: errorMessage(error) }); },
    );
    return () => { current = false; };
  }, [sessionId, toolUseId, attempt]);
  return { stored, retry: () => setAttempt(value => value + 1) };
}

export function FileEditDiff({ data: toolData, review, source }: { data: FileEditDiffData; review?: FileEditDiffReview; source?: FileEditDiffSource }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(true);
  const [showFailed, setShowFailed] = useState(false);
  const contentId = useId();
  const { stored, retry } = useStoredDiff(review === undefined && toolData.hasSidecar === true, source);
  const data: FileEditDiffData = stored.state === "loaded"
    ? { ...toolData, view: stored.record.view, isNewFile: stored.record.isNewFile }
    : toolData;
  // An overwrite whose earlier content is not available has nothing to compare; say so instead of "no changes".
  const comparable = data.view !== undefined || data.hunks.length > 0;
  if (review) {
    return (
      <div className="min-w-0 space-y-2.5" data-testid="file-edit-diff" data-tool={data.tool}>
        {data.hunks.map((hunk, index) => (
          <ReviewHunk key={review.hunks[index]?.id ?? index} hunk={hunk} reviewHunk={requireReviewHunk(review, index)} review={review}
            path={data.path} hunkNumber={(review.hunkOffset ?? 0) + index + 1} />
        ))}
        {data.hunks.length === 0 && <p className="text-xs text-muted-foreground">{t("fileEditDiff.noChanges")}</p>}
      </div>
    );
  }
  const view = editDiffView(data);
  const totals = { added: view.added, removed: view.removed };
  const verb = t(data.isNewFile ? "fileEditDiff.verbCreate" : VERB_KEY_BY_TOOL[data.tool]);
  const Icon = data.isNewFile ? FilePlus2 : FilePenLine;
  const headerContent = (
    <>
        <Icon className="h-3 w-3 shrink-0 opacity-70" />
        <span className="flex min-w-0 flex-1 items-baseline gap-1.5 text-left">
          <span className="shrink-0 font-medium">{verb}</span>
          {/* The folders give way before the file name, so a narrow card still says which file changed. */}
          <PathLabel path={data.path} />
        </span>
        {/* A card too narrow for one line gives the counts a line of their own, so the file name keeps its room. */}
        <span className="ml-auto flex shrink-0 items-center gap-2 text-tiny text-muted-foreground @max-[22rem]:ml-8 @max-[22rem]:basis-full">
          {totals.added > 0 && (
            <span
              className="rounded bg-success/(--opacity-subtle) px-1 font-semibold text-foreground"
              aria-label={t("fileEditDiff.addedLinesAriaLabel", {
                count: String(totals.added),
              })}
            >
              +{totals.added}
            </span>
          )}
          {totals.removed > 0 && (
            <span
              className="rounded bg-destructive/(--opacity-subtle) px-1 font-semibold text-foreground"
              aria-label={t("fileEditDiff.removedLinesAriaLabel", {
                count: String(totals.removed),
              })}
            >
              −{totals.removed}
            </span>
          )}
          {data.bytes !== undefined && (
            <span data-testid="file-diff-bytes">{t("fileEditDiff.bytes", { count: data.bytes.toLocaleString() })}</span>
          )}
          {(data.truncated || view.truncated) && (
            <span className="text-warning" title={t("fileEditDiff.truncatedTitle")}>
              {t("fileEditDiff.truncatedLabel")}
            </span>
          )}
        </span>
    </>
  );

  return (
    <div
      className="@container overflow-hidden rounded border border-border bg-background"
      data-testid="file-edit-diff"
      data-tool={data.tool}
      data-new-file={data.isNewFile ? "true" : "false"}
      data-truncated={data.truncated || view.truncated ? "true" : "false"}
      data-numbered={data.view !== undefined ? "true" : "false"}
      data-added={totals.added}
      data-removed={totals.removed}
    >
      {/* Two sibling controls: the header folds the card, the button beside it shows the file where it lives. */}
      <div className="flex min-w-0 items-stretch border-b border-border bg-muted/(--opacity-muted)">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex min-w-0 flex-1 items-center gap-x-2 gap-y-1 px-3 py-1.5 text-dense text-foreground/(--opacity-near) hover:bg-muted/(--opacity-half) @max-[22rem]:flex-wrap"
        aria-expanded={open}
        aria-controls={contentId}
      >
        {open ? (
          <ChevronDown className="h-3 w-3 shrink-0 opacity-70" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 opacity-70" />
        )}
            {headerContent}
      </button>
        {canShowInFolderView(data.path) && (
          <button
            type="button"
            data-testid="file-diff-show-in-folder-view"
            title={t("folderView.showInFolderView")}
            aria-label={t("folderView.showInFolderView")}
            onClick={() => {
              setShowFailed(false);
              const failed = (): void => setShowFailed(true);
              void showInFolderView(data.path).then((shown) => { if (!shown) failed(); }, failed);
            }}
            className="flex shrink-0 items-center px-2 text-muted-foreground hover:bg-muted/(--opacity-half) hover:text-foreground"
          >
            <FolderSearch aria-hidden="true" className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {showFailed && (
        <div role="alert" className="border-b border-border px-3 py-1.5 text-tiny text-destructive" data-testid="file-diff-show-failed">
          {t("folderView.showInFolderViewFailed")}
        </div>
      )}
      {open && (
        <div id={contentId} className="font-mono text-xs leading-[1.55]">
          <FileDiffRows view={view} numbered={data.view !== undefined} />
          {stored.state === "error" ? (
            <div className="flex items-center gap-2 px-3 py-2 font-sans text-tiny text-destructive" data-testid="file-diff-load-error">
              <span className="min-w-0 break-words">{t("fileEditDiff.loadFailed", { message: stored.message })}</span>
              <button type="button" className="shrink-0 text-primary hover:underline" onClick={retry}>{t("fileEditDiff.retry")}</button>
            </div>
          ) : !comparable ? (
            <div className="px-3 py-2 font-sans text-tiny text-muted-foreground" data-testid="file-diff-unavailable">
              {t(stored.state === "loading" ? "fileEditDiff.loading" : "fileEditDiff.diffNotStored")}
            </div>
          ) : totals.added === 0 && totals.removed === 0 ? (
            <div className="px-3 py-2 text-tiny text-muted-foreground" data-testid="file-diff-empty">
              {t(view.lineEndingsOnly ? "fileEditDiff.lineEndingsOnly" : "fileEditDiff.noChanges")}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

/** A review lists one host hunk per shown hunk; a missing one is a caller bug, not something to render around. */
function requireReviewHunk(review: FileEditDiffReview, index: number): TurnReviewHunk {
  const hunk = review.hunks[index];
  if (!hunk) throw new Error(`turn review has no hunk at index ${index}`);
  return hunk;
}

function ReviewHunk({
  hunk,
  reviewHunk,
  review,
  path,
  hunkNumber,
}: {
  hunk: FileEditHunk;
  reviewHunk: TurnReviewHunk;
  review: FileEditDiffReview;
  path: string;
  hunkNumber: number;
}) {
  const { t } = useTranslation();
  const preview = useMemo(() => ({
    old: reviewPreview(hunk.oldText), next: reviewPreview(hunk.newText),
    oldCount: countReviewLines(hunk.oldText), newCount: countReviewLines(hunk.newText),
  }), [hunk.oldText, hunk.newText]);
  const oldPreview = preview.old;
  const newPreview = preview.next;
  const removed = oldPreview.lines;
  const added = newPreview.lines;
  let oldLine = reviewHunk.oldStartLine;
  let newLine = reviewHunk.newStartLine;
  {
    const disabled = !review.referenceable || !review.onReference;
    const onDecide = review.onDecide;
    return (
      <div className={reviewHunk.kept ? "min-w-0 opacity-70" : "min-w-0"} data-testid="turn-review-hunk" data-kept={reviewHunk.kept ? "true" : "false"}>
        {onDecide && (
          <div className="mb-1 flex min-w-0 justify-end">
            <TurnDecisionButtons scope="hunk" kept={reviewHunk.kept} disabled={review.decidable !== true}
              keepLabel={t("fileEditDiff.keepHunkAria", { number: hunkNumber, path })} undoLabel={t("fileEditDiff.undoHunkAria", { number: hunkNumber, path })}
              onKeep={() => onDecide({ action: "keep", scope: "hunk", path, hunkId: reviewHunk.id })}
              onUndo={() => onDecide({ action: "undo", scope: "hunk", path, hunkId: reviewHunk.id })} />
          </div>
        )}
        <button type="button" disabled={disabled} data-hunk-id={reviewHunk.id}
          aria-label={t("fileEditDiff.reviewReferenceHunk", { number: hunkNumber, path, start: reviewHunk.startLine, end: reviewHunk.endLine })}
          onClick={() => review.onReference?.({ path, startLine: reviewHunk.startLine, endLine: reviewHunk.endLine,
            turnId: review.turnId, hunkId: reviewHunk.id })}
          className="group block w-full min-w-0 overflow-hidden rounded-[10px] border border-border bg-background text-left outline-none enabled:hover:border-(--file-reference-fg) focus-visible:border-(--file-reference-fg) focus-visible:ring-2 focus-visible:ring-(--file-reference-fg) disabled:cursor-default">
          <span className="flex min-w-0 items-center gap-2 bg-muted/(--opacity-muted) px-2.5 py-1.5 font-mono text-dense text-muted-foreground">
            <span className="min-w-0 flex-1 truncate">@@ -{reviewHunk.oldStartLine},{preview.oldCount} +{reviewHunk.newStartLine},{preview.newCount} @@</span>
            {!disabled && <span className="shrink-0 font-sans font-medium text-(--file-reference-fg) opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 motion-reduce:transition-none">
              {t("fileEditDiff.hunkReferenceCue", { start: reviewHunk.startLine, end: reviewHunk.endLine })}
            </span>}
          </span>
          <span className="block font-mono text-xs leading-5">
            {removed.map((text, index) => <DiffLine key={`r-${index}`} kind="removed" lineNo={oldLine++} text={text} columns />)}
            {added.map((text, index) => <DiffLine key={`a-${index}`} kind="added" lineNo={newLine++} text={text} columns />)}
          </span>
          {(oldPreview.truncated || newPreview.truncated) && (
            <span className="block px-2.5 py-1 font-sans text-dense text-muted-foreground">{t("fileEditDiff.reviewPreviewTruncated")}</span>
          )}
        </button>
      </div>
    );
  }
}

/** The rows of a line diff: context, removed and added lines, with real line numbers when the whole file was compared. */
export function FileDiffRows({ view, numbered }: { view: FileDiffView; numbered: boolean }) {
  const { t } = useTranslation();
  return (
    <>
      {view.hunks.map((hunk, index) => (
        <FileDiffHunkRows key={`${hunk.oldStart}:${hunk.newStart}:${index}`} hunk={hunk} numbered={numbered} separator={index > 0} />
      ))}
      {view.truncated && (
        <p className="px-3 py-1 font-sans text-dense text-warning" data-testid="file-diff-truncated">{t("fileEditDiff.rowsTruncated")}</p>
      )}
    </>
  );
}

function FileDiffHunkRows({ hunk, numbered, separator }: { hunk: FileDiffHunk; numbered: boolean; separator: boolean }) {
  const { t } = useTranslation();
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  return (
    <div data-testid="file-diff-hunk">
      {(numbered || separator) && (
        <div className="border-t border-dashed border-border/(--opacity-strong) bg-muted/(--opacity-light) px-3 py-0.5 text-tiny text-muted-foreground first:border-t-0" data-testid="file-diff-hunk-header">
          {numbered ? `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@` : `@@ ${t("fileEditDiff.nextHunk")}`}
        </div>
      )}
      {hunk.rows.map((row, index) => (
        <DiffLine
          key={index}
          kind={row.kind}
          oldLineNo={numbered && row.kind !== "added" ? oldLine++ : undefined}
          newLineNo={numbered && row.kind !== "removed" ? newLine++ : undefined}
          numbered={numbered}
          text={row.text}
        />
      ))}
    </div>
  );
}

function reviewPreview(text: string): { lines: string[]; truncated: boolean } {
  const excerpt = text.slice(0, REVIEW_PREVIEW_MAX_CHARACTERS);
  const lines = [...excerpt.matchAll(/([^\r\n]*)(?:\r\n|\r|\n)|([^\r\n]+)$/g)].map((line) => line[1] ?? line[2] ?? "");
  return {
    lines: lines.slice(0, REVIEW_PREVIEW_MAX_LINES),
    truncated: excerpt.length < text.length || lines.length > REVIEW_PREVIEW_MAX_LINES,
  };
}

function countReviewLines(text: string): number {
  let count = 0;
  for (const _line of text.matchAll(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g)) count++;
  return count;
}

function DiffLine({
  kind,
  lineNo,
  oldLineNo,
  newLineNo,
  numbered = false,
  text,
  columns = false,
}: {
  kind: "added" | "removed" | "context";
  /** Turn-review hunks number one side per line. */
  lineNo?: number;
  oldLineNo?: number;
  newLineNo?: number;
  /** Tool cards show both line-number columns only when the whole file was compared. */
  numbered?: boolean;
  text: string;
  columns?: boolean;
}) {
  // Status foreground tokens are designed for solid buttons/badges. Reusing
  // them on a translucent diff wash can produce white-on-pastel text in light
  // themes. Keep body text on the normal foreground pair and reserve the
  // status color for the redundant border state cue.
  const colors = kind === "added"
    ? { background: "var(--diff-add)", accent: "var(--diff-add-fg)" }
    : kind === "removed"
      ? { background: "var(--diff-remove)", accent: "var(--diff-remove-fg)" }
      : { background: "transparent", accent: "transparent" };
  const sigil = kind === "added" ? "+" : kind === "removed" ? "−" : " ";
  if (columns) {
    return (
      <span className="flex min-w-0 text-foreground" style={{ backgroundColor: colors.background }} data-diff-kind={kind}>
        <span data-line-column="old" className="w-8 shrink-0 select-none pr-1.5 text-right text-dense text-foreground">{kind === "removed" ? lineNo : ""}</span>
        <span data-line-column="new" className="w-8 shrink-0 select-none pr-1.5 text-right text-dense text-foreground">{kind === "added" ? lineNo : ""}</span>
        <span aria-hidden="true" className="w-4 shrink-0 select-none font-semibold">{sigil}</span>
        <span className="min-w-0 flex-1 whitespace-pre-wrap break-words pr-2.5 [overflow-wrap:anywhere]">{text || " "}</span>
      </span>
    );
  }
  return (
    <div
      className={`flex min-w-0 gap-2 border-l-[3px] px-3 ${kind === "context" ? "text-muted-foreground" : "text-foreground"}`}
      style={{ backgroundColor: colors.background, borderLeftColor: colors.accent }}
      data-diff-kind={kind}
    >
      {numbered && (
        <>
          <span data-line-column="old" className="w-8 shrink-0 select-none text-right text-tiny">{oldLineNo ?? ""}</span>
          <span data-line-column="new" className="w-8 shrink-0 select-none text-right text-tiny">{newLineNo ?? ""}</span>
        </>
      )}
      <span aria-hidden="true" className="w-2 shrink-0 select-none font-semibold">
        {sigil}
      </span>
      <span className="min-w-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
        {text.length > 0 ? text : " "}
      </span>
    </div>
  );
}
