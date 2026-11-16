import { useState, useEffect, useMemo, useRef, useId } from "react";
import { ChevronDown, ChevronRight, FilePlus2, FilePenLine } from "lucide-react";
import type { FileEditDiffData, FileEditHunk } from "../utils/file-diff.js";
import { editDiffView } from "../utils/file-diff.js";
import type { FileDiffHunk, FileDiffView } from "../../../shared/line-diff.js";
import { getApi } from "../api-client.js";
import { useTranslation } from "../../../i18n/react.js";
import { errorMessage } from "../../../shared/error-message.js";
import type { TurnReviewHunk } from "../../../shared/turn-change-review.js";
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
}

export function FileEditDiff({ data, review }: { data: FileEditDiffData; review?: FileEditDiffReview }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(true);
  const contentId = useId();
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
        <span className="min-w-0 truncate text-left">
          <span className="font-medium">{verb}</span>
          <span className="opacity-60">(</span>
          <span className="font-mono">{data.path}</span>
          <span className="opacity-60">)</span>
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-2 text-tiny text-muted-foreground">
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
      className="overflow-hidden rounded border border-border bg-background"
      data-testid="file-edit-diff"
      data-tool={data.tool}
      data-new-file={data.isNewFile ? "true" : "false"}
      data-truncated={data.truncated || view.truncated ? "true" : "false"}
      data-added={totals.added}
      data-removed={totals.removed}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full min-w-0 items-center gap-2 border-b border-border bg-muted/(--opacity-muted) px-3 py-1.5 text-dense text-foreground/(--opacity-near) hover:bg-muted/(--opacity-half)"
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
      {open && (
        <div id={contentId} className="font-mono text-xs leading-[1.55]">
          <FileDiffRows view={view} numbered={data.view !== undefined} />
          {totals.added === 0 && totals.removed === 0 && (
            <div className="px-3 py-2 text-tiny text-muted-foreground" data-testid="file-diff-empty">
              {t(view.lineEndingsOnly ? "fileEditDiff.lineEndingsOnly" : "fileEditDiff.noChanges")}
            </div>
          )}
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
    return (
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
    );
  }
}

/** The rows of a line diff: context, removed and added lines, with real line numbers when the whole file was compared. */
function FileDiffRows({ view, numbered }: { view: FileDiffView; numbered: boolean }) {
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

/** Split content into lines (no trailing newline artifact). */
function sidecarLines(text: string): string[] {
  if (text === "") return [];
  const ls = text.split("\n");
  if (ls[ls.length - 1] === "") ls.pop();
  return ls;
}

type SidecarDiffHunk =
  | { type: "context"; line: string }
  | { type: "removed"; line: string }
  | { type: "added"; line: string };

/** Minimal Myers-style unified diff — for display only. Produces `removed` / `added` / `context` hunks. Context window: 3
 * lines around each changed line. */
function buildDiffHunks(before: string, after: string): SidecarDiffHunk[] {
  const bLines = sidecarLines(before);
  const aLines = sidecarLines(after);

  const m = bLines.length;
  const n = aLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (bLines[i] === aLines[j]) {
        dp[i][j] = 1 + dp[i + 1][j + 1];
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  const raw: SidecarDiffHunk[] = [];
  let i = 0;
  let j = 0;
  while (i < m || j < n) {
    if (i < m && j < n && bLines[i] === aLines[j]) {
      raw.push({ type: "context", line: bLines[i] });
      i++;
      j++;
    } else if (j < n && (i >= m || dp[i + 1][j] <= dp[i][j + 1])) {
      raw.push({ type: "added", line: aLines[j] });
      j++;
    } else {
      raw.push({ type: "removed", line: bLines[i] });
      i++;
    }
  }

  const CONTEXT_LINES = 3;
  const changed = new Set<number>();
  for (let k = 0; k < raw.length; k++) {
    if (raw[k].type !== "context") changed.add(k);
  }
  const keep = new Set<number>();
  for (const k of changed) {
    for (let d = -CONTEXT_LINES; d <= CONTEXT_LINES; d++) {
      const idx = k + d;
      if (idx >= 0 && idx < raw.length) keep.add(idx);
    }
  }

  const result: SidecarDiffHunk[] = [];
  let lastKept = -1;
  for (let k = 0; k < raw.length; k++) {
    if (!keep.has(k)) continue;
    if (lastKept >= 0 && k > lastKept + 1) {
      result.push({ type: "context", line: "⋯" });
    }
    result.push(raw[k]);
    lastKept = k;
  }
  return result;
}

export interface WriteFileSidecarDiffProps {
  /** Raw JSON string output from WriteFileTool — parsed here for truncated/hasSidecar. */
  resultJson: string;
  /** Active session id for IPC guard. */
  sessionId: string;
  /** tool_use_id for IPC sidecar lookup. */
  toolUseId: string;
  /** Resolved file path (from tool input). */
  filePath?: string;
}

interface WriteDiffResult {
  path?: string;
  bytes?: number;
  truncated?: boolean;
  hasSidecar?: boolean;
}

function parseWriteResult(json: string): WriteDiffResult {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (parsed !== null && typeof parsed === "object") {
      return parsed as WriteDiffResult;
    }
  } catch {
    // malformed — treat as non-truncated
  }
  return {};
}

type SidecarDiffState = "idle" | "loading" | "expanded" | "error";

export function WriteFileSidecarDiff({
  resultJson,
  sessionId,
  toolUseId,
  filePath,
}: WriteFileSidecarDiffProps) {
  const { t } = useTranslation();
  const parsed = parseWriteResult(resultJson);
  const [diffState, setDiffState] = useState<SidecarDiffState>("idle");
  const [diffData, setDiffData] = useState<{ before: string; after: string } | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // If not truncated or no sidecar, render a plain summary.
  if (!parsed.truncated || !parsed.hasSidecar) {
    const path = filePath ?? parsed.path ?? "";
    const bytes = parsed.bytes !== undefined ? `${parsed.bytes.toLocaleString()} bytes` : "";
    return (
      <div className="rounded px-2 py-1 font-mono text-tiny text-muted-foreground bg-muted/(--opacity-muted)">
        {path ? <span className="text-primary/(--opacity-intense)">{path}</span> : null}
        {bytes ? <span className="ml-2 text-muted-foreground/(--opacity-strong)">{bytes}</span> : null}
      </div>
    );
  }

  async function handleExpand() {
    if (diffData) {
      setDiffState("expanded");
      return;
    }
    setDiffState("loading");
    setErrorMsg(null);
    try {
      const result = await getApi().chatGetWriteDiff(sessionId, toolUseId);
      if (!isMountedRef.current) return;
      if (result === null) {
        setErrorMsg(t("fileEditDiff.diffFileLost"));
        setDiffState("error");
      } else {
        setDiffData(result);
        setDiffState("expanded");
      }
    } catch (err) {
      if (!isMountedRef.current) return;
      setErrorMsg(errorMessage(err) || t("fileEditDiff.ipcError"));
      setDiffState("error");
    }
  }

  function handleRetry() {
    setDiffState("idle");
    setErrorMsg(null);
  }

  const path = filePath ?? parsed.path ?? "";
  const bytes = parsed.bytes !== undefined ? `${parsed.bytes.toLocaleString()} bytes` : "";

  if (diffState === "expanded" && diffData) {
    const hunks = buildDiffHunks(diffData.before, diffData.after);
    return (
      <div className="min-w-0 w-full max-w-full rounded-md text-dense">
        <div
          className="flex items-center gap-2 px-3 py-1.5 rounded-t-md border-b"
          style={{ backgroundColor: "hsl(var(--muted) / 0.5)" }}
        >
          <span className="font-medium text-primary/(--opacity-intense) truncate min-w-0">{path}</span>
          {bytes && <span className="shrink-0 text-muted-foreground/(--opacity-strong) text-tiny">{bytes}</span>}
          <button
            type="button"
            className="ml-auto shrink-0 text-tiny text-primary hover:underline"
            onClick={() => setDiffState("idle")}
          >
            {t("fileEditDiff.collapse")}
          </button>
        </div>
        <div
          className="max-h-(--preview-block-max-height-compact) overflow-y-auto font-mono text-tiny leading-[1.5] rounded-b-md px-0 py-1"
          style={{ backgroundColor: "hsl(var(--code-bg))", color: "hsl(var(--code-fg))" }}
        >
          {hunks.length === 0 ? (
            <div className="px-3 py-1 text-muted-foreground/(--opacity-strong) italic">{t("fileEditDiff.noChangesShort")}</div>
          ) : (
            hunks.map((h, i) => (
              <div
                key={i}
                className="flex px-2 py-0"
                style={{
                  backgroundColor:
                    h.type === "added"
                      ? "var(--diff-add)"
                      : h.type === "removed"
                        ? "var(--diff-remove)"
                        : "transparent",
                }}
              >
                <span
                  className="shrink-0 select-none w-4 text-muted-foreground/(--opacity-half)"
                  style={{
                    color:
                      h.type === "added"
                        ? "var(--diff-add-fg)"
                        : h.type === "removed"
                          ? "var(--diff-remove-fg)"
                          : undefined,
                  }}
                >
                  {h.type === "added" ? "+" : h.type === "removed" ? "-" : " "}
                </span>
                <span className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] min-w-0">
                  {h.line}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    );
  }

  if (diffState === "error") {
    return (
      <div className="rounded-md px-3 py-1.5 text-dense text-destructive/(--opacity-intense) bg-destructive/(--opacity-subtle) flex items-center gap-2">
        <span className="truncate min-w-0">{errorMsg}</span>
        <button
          type="button"
          className="shrink-0 text-tiny text-primary hover:underline"
          onClick={handleRetry}
        >
          {t("fileEditDiff.retry")}
        </button>
      </div>
    );
  }

  const isLoading = diffState === "loading";
  return (
    <div
      className="min-w-0 w-full max-w-full rounded-md text-dense"
      style={{ backgroundColor: "hsl(var(--muted) / 0.4)" }}
    >
      <div className="flex items-center gap-2 px-3 py-1.5">
        <span className="font-medium text-primary/(--opacity-intense) truncate min-w-0">{path}</span>
        {bytes && <span className="shrink-0 text-muted-foreground/(--opacity-strong) text-tiny">{bytes}</span>}
        <span className="shrink-0 text-tiny text-warning/(--opacity-intense) ml-1">· {t("fileEditDiff.previewLimit")}</span>
        <button
          type="button"
          disabled={isLoading}
          className="ml-auto shrink-0 text-tiny text-primary hover:underline disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={() => {
            void handleExpand();
          }}
        >
          {isLoading ? t("fileEditDiff.loading") : t("fileEditDiff.viewFullDiff")}
        </button>
      </div>
    </div>
  );
}
