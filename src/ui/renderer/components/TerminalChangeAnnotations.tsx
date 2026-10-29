import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { TerminalApi, TerminalSessionInfo } from "../../../shared/terminal-session.js";
import type { TerminalExecutionWarning, TerminalFileReviewSnapshot } from "../../../shared/terminal-file-review.js";
import { useTranslation } from "../../../i18n/react.js";
import type { TerminalAnnotationSlot, TerminalBlockAnchors } from "./terminal-block-anchors.js";
import { observeTerminalFileReview, publishTerminalFileReview, publishTerminalFileReviewFailure, requestTerminalFileReview } from "../preview/terminal-file-review.js";

const REVIEW_REFRESH_MS = 1500;
const ANNOTATION_NAMED_FILES = 2;
const ANNOTATION_ACTION_CLASS = "shrink-0 text-warning hover:underline focus-visible:outline focus-visible:outline-1 focus-visible:outline-ring";
const NO_ANCHORS = { subscribe: () => () => {}, version: () => 0 };

/** Paths inside the terminal's physical cwd read as the user typed them (`Makefile`, `scripts/build.sh`). */
function terminalReviewDisplayPath(path: string, cwd: string): string {
  if (!cwd) return path;
  for (const separator of ["/", "\\"]) {
    const prefix = cwd.endsWith(separator) ? cwd : `${cwd}${separator}`;
    if (path.startsWith(prefix)) return path.slice(prefix.length);
  }
  return path;
}

/** Names in an annotation: two, then `+N`. */
function annotationFiles(names: readonly string[]): string {
  return names.slice(0, ANNOTATION_NAMED_FILES).join(", ") + (names.length > ANNOTATION_NAMED_FILES ? ` +${names.length - ANNOTATION_NAMED_FILES}` : "");
}

/** Terminal columns a string takes: East Asian wide and fullwidth characters take two. */
function textColumns(text: string): number {
  let columns = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    columns += (code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3)
      || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xff60)
      || (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x1f300 && code <= 0x1faff) ? 2 : 1;
  }
  return columns;
}

/**
 * The block an annotation offers [view changes] on: the latest command that used an agent-changed file. Earlier
 * matches stay as dim history, and a later command that used none leaves the button where it is.
 */
function actionableBlockId(warnings: readonly TerminalExecutionWarning[]): number | null {
  return warnings.reduce<number | null>((latest, warning) => warning.files.length > 0 && (latest === null || warning.blockId > latest) ? warning.blockId : latest, null);
}

/**
 * Changed-file evidence is advisory and read-only; nothing here writes to a shell or records a decision. Each
 * positively matched command gets a one-row annotation drawn as an xterm decoration on its own command row, after
 * the command text like a trailing shell comment: it scrolls with its block and never takes rows. When the row has
 * too few free columns for the sentence, the annotation shrinks to its warning and button, then to the warning alone.
 * Its button opens this terminal's changes view on the first file; the badge opens the same view. Polling also feeds
 * that view and the badge through the review store.
 */
export function TerminalChangeAnnotations({ terminalApi, session, revision, anchors }: {
  terminalApi: TerminalApi;
  session: TerminalSessionInfo;
  revision: number;
  /** Where block annotations render; null until the terminal is open. */
  anchors: TerminalBlockAnchors | null;
}) {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<TerminalFileReviewSnapshot>({ cwd: "", latestBlockId: null, files: [], warnings: [] });
  const refreshRef = useRef<() => void>(() => {});
  const host = session.lane === "manual" && session.substrate === "host";
  // Re-render when a command row gains or loses its marker (scrollback trim, `clear`).
  const subscribeAnchors = useCallback((listener: () => void) => (anchors ?? NO_ANCHORS).subscribe(listener), [anchors]);
  useSyncExternalStore(subscribeAnchors, () => (anchors ?? NO_ANCHORS).version());

  useEffect(() => {
    if (!host) return;
    const releaseObserver = observeTerminalFileReview(terminalApi, session);
    let cancelled = false;
    let running = false;
    let queued = false;
    const refresh = () => {
      if (cancelled) return;
      if (running) { queued = true; return; }
      running = true;
      void terminalApi.listFileReviews(session).then((result) => {
        if (cancelled) return;
        if (!result.ok) { publishTerminalFileReviewFailure(session.tabId); return; }
        setSnapshot(result.snapshot);
        publishTerminalFileReview(session.tabId, result.snapshot);
      }).catch(() => { if (!cancelled) publishTerminalFileReviewFailure(session.tabId); }).finally(() => {
        running = false;
        if (!cancelled && queued) { queued = false; refresh(); }
      });
    };
    refreshRef.current = refresh;
    refresh();
    const timer = setInterval(refresh, REVIEW_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
      releaseObserver();
      if (refreshRef.current === refresh) refreshRef.current = () => {};
    };
  }, [terminalApi, session.tabId, session.lane, session.terminalSessionId, host]);

  useEffect(() => { refreshRef.current(); }, [revision]);

  if (!host || !anchors) return null;
  const actionableId = actionableBlockId(snapshot.warnings);
  return <>{snapshot.warnings.flatMap((warning) => {
    // Only a concrete match is a warning; anything else never reaches the terminal, even if a snapshot carried it.
    if (warning.files.length === 0) return [];
    const slot = anchors.attach(warning.blockId);
    if (!slot) return [];
    const names = warning.files.map((path) => terminalReviewDisplayPath(path, snapshot.cwd));
    return [createPortal(
      <TerminalChangeAnnotation slot={slot} names={names} command={warning.command} actionable={warning.blockId === actionableId}
        sentence={t("terminalFileReview.annotation", { files: annotationFiles(names) })} viewLabel={t("terminalFileReview.viewChanges")}
        onView={() => requestTerminalFileReview(session.tabId, warning.files[0]!)} />,
      slot.container,
      `terminal-file-warning-${warning.blockId}`,
    )];
  })}</>;
}

function TerminalChangeAnnotation({ slot, names, command, actionable, sentence, viewLabel, onView }: {
  slot: TerminalAnnotationSlot;
  names: readonly string[];
  command: string;
  actionable: boolean;
  sentence: string;
  viewLabel: string;
  onView: () => void;
}) {
  const button = `[${viewLabel}]`;
  // `# ⚠ <sentence> [view]`, then `⚠ [view]`, then a lone `⚠`: whatever fits in the free columns, never more.
  const full = textColumns(`# ⚠ ${sentence}`) + (actionable ? 1 + textColumns(button) : 0);
  const compact = textColumns("⚠") + (actionable ? 1 + textColumns(button) : 0);
  const form = slot.columns >= full ? "full" : slot.columns >= compact ? "compact" : "glyph";
  const glyph = <span className={actionable ? "text-warning" : undefined}>⚠</span>;
  return (
    <div className={`flex h-full min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap font-mono text-[11px] leading-none ${actionable ? "text-muted-foreground" : "text-muted-foreground/(--opacity-strong)"}`}
      title={`${sentence}\n$ ${command}\n${names.join("\n")}`}
      data-testid="terminal-file-warning" data-active={actionable ? "true" : "false"} data-form={form}>
      {form === "full" ? <span className="min-w-0 truncate"># {glyph} {sentence}</span> : null}
      {form === "compact" || (form === "glyph" && !actionable) ? glyph : null}
      {actionable && form !== "glyph" ? <button type="button" className={ANNOTATION_ACTION_CLASS} onClick={onView}>{button}</button> : null}
      {actionable && form === "glyph" ? <button type="button" className={ANNOTATION_ACTION_CLASS} aria-label={viewLabel} onClick={onView}>⚠</button> : null}
    </div>
  );
}
