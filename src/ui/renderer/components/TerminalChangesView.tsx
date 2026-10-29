/**
 * A terminal's 변경 파일 view: the agent-changed files its commands used, in the chat's own change UI (the workspace
 * file tree, `TurnChangeDetail` and `FileEditDiff`). Everything shown comes from main's evidence snapshot, whose reviews
 * are read only from the files the agent's writes left; the view never reads a file itself.
 */
import { useMemo } from "react";
import { useTranslation } from "../../../i18n/react.js";
import type { TerminalFileReviewSnapshot } from "../../../shared/terminal-file-review.js";
import type { AveApi } from "../types.js";
import type { ChatPreviewTarget, WorkspaceFileItem } from "../preview/preview-targets.js";
import { deriveWorkspaceChanges, type FileWorkspaceReveal, type WorkspaceChanges } from "../preview/workspace-changes.js";
import { useTerminalFileReviewState } from "../preview/terminal-file-review.js";
import { FileBrowserWorkspace } from "./ChatSidePanelWorkspaces.js";

const NO_TARGETS = new Map<string, ChatPreviewTarget>();
const ignoreSelection = () => {};

/** The snapshot's files as the workspace view's session files and changes. */
function terminalWorkspaceChanges(tabId: string, snapshot: TerminalFileReviewSnapshot | null): { files: WorkspaceFileItem[]; changes: WorkspaceChanges } {
  const reviewed = snapshot?.files ?? [];
  const files = reviewed.map((file): WorkspaceFileItem => ({
    id: `terminal-change:${file.path}`, path: file.path, label: file.path.slice(file.path.lastIndexOf("/") + 1),
    detail: file.lastUsed?.command ?? "", sourceLabel: "terminal", operation: file.review?.operation ?? "modify", canOpenExternal: false,
  }));
  const reviews = reviewed.flatMap((file) => file.review ? [file.review] : []);
  const changes = deriveWorkspaceChanges({
    files, targets: [], ...(snapshot?.cwd ? { workspaceRoot: snapshot.cwd } : {}),
    review: reviews.length > 0 ? { sessionId: tabId, turnId: `terminal:${tabId}`, ...(snapshot?.cwd ? { workspaceRoot: snapshot.cwd } : {}), files: reviews } : null,
  });
  return { files, changes };
}

export function TerminalChangesView({ api, tabId, visible }: { api: AveApi; tabId: string; visible: boolean }) {
  const { t } = useTranslation();
  const state = useTerminalFileReviewState(tabId);
  const snapshot = state?.snapshot ?? null;
  const { files, changes } = useMemo(() => terminalWorkspaceChanges(tabId, snapshot), [tabId, snapshot]);
  const reveal = state?.reveal ?? null;
  const firstPath = snapshot?.files[0]?.path ?? null;
  const revealRequest = useMemo<FileWorkspaceReveal | null>(() => {
    const path = reveal?.path ?? firstPath;
    return reveal && path ? { token: reveal.token, path } : null;
  }, [reveal, firstPath]);
  const latest = snapshot?.warnings.reduce<{ blockId: number; command: string } | null>(
    (found, warning) => !found || warning.blockId > found.blockId ? warning : found, null) ?? null;
  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden" data-testid="terminal-changes-view">
      <p className="shrink-0 truncate border-b border-border px-3 py-1.5 text-[11px] text-muted-foreground" data-testid="terminal-changes-caption">
        {latest ? t("terminalFileReview.viewCaption", { command: latest.command }) : t("terminalFileReview.viewCaptionNone")}
        {state?.refreshFailed ? ` · ${t("terminalFileReview.refreshFailed")}` : null}
      </p>
      <div className="min-h-0 flex-1">
        <FileBrowserWorkspace
          api={api}
          sessionId={`terminal:${tabId}`}
          visible={visible}
          files={files}
          changes={changes}
          targetById={NO_TARGETS}
          selectedId={null}
          onSelect={ignoreSelection}
          revealRequest={revealRequest}
          defaultFilter="changed"
          emptyDetail={t("terminalFileReview.diffUnavailable")}
        />
      </div>
      <p className="shrink-0 border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground" data-testid="terminal-changes-advisory">{t("terminalFileReview.advisory")}</p>
    </div>
  );
}
