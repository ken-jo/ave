import { useCallback, useEffect, useRef, useState } from "react";
import type { AveApi } from "../types.js";
import type { MemorySaveNoticeResult, MemorySaveSkipReason } from "../../../shared/memory-save-result.js";
import { useTranslation } from "../../../i18n/react.js";

/** How many notices one conversation shows at once; older ones give way. */
const MAX_VISIBLE_NOTICES = 3;

type NoticeState =
  | { kind: "saved"; result: Extract<MemorySaveNoticeResult, { status: "saved" }> }
  | { kind: "undone"; op: "created" | "deleted"; title: string }
  | { kind: "not-undone"; title: string }
  | { kind: "skipped"; reason: MemorySaveSkipReason };

interface Notice {
  key: number;
  state: NoticeState;
  busy?: boolean;
}

export interface MemorySaveNoticeStripProps {
  api: Pick<AveApi, "onMemorySaveResult" | "memoryUndo">;
  /** Only this conversation's notices are shown; switching conversations clears them, as notices are live only. */
  sessionId: string;
  /** Open the memory panel searching for this title. */
  onOpenMemory: (title: string) => void;
}

function skipGroup(reason: MemorySaveSkipReason): "secret" | "instruction" | "failed" {
  if (reason === "sensitive-input" || reason === "credential" || reason === "authorization-key") return "secret";
  if (reason === "unsafe-text" || reason === "external-context") return "instruction";
  return "failed";
}

/** One line per memory save, update, delete or refusal in this conversation, with undo where it applies. */
export function MemorySaveNoticeStrip({ api, sessionId, onOpenMemory }: MemorySaveNoticeStripProps) {
  const { t } = useTranslation();
  const [notices, setNotices] = useState<Notice[]>([]);
  const nextKey = useRef(0);

  useEffect(() => {
    setNotices([]);
    return api.onMemorySaveResult((event) => {
      if (event.sessionId !== sessionId) return;
      const state: NoticeState = event.result.status === "saved"
        ? { kind: "saved", result: event.result }
        : { kind: "skipped", reason: event.result.reason };
      const key = nextKey.current++;
      setNotices((current) => [...current, { key, state }].slice(-MAX_VISIBLE_NOTICES));
    });
  }, [api, sessionId]);

  const replace = useCallback((key: number, update: (notice: Notice) => Notice) => {
    setNotices((current) => current.map((notice) => (notice.key === key ? update(notice) : notice)));
  }, []);

  const dismiss = useCallback((key: number) => {
    setNotices((current) => current.filter((notice) => notice.key !== key));
  }, []);

  const undo = useCallback(async (notice: Notice) => {
    if (notice.state.kind !== "saved" || !notice.state.result.undoToken) return;
    const { title } = notice.state.result.entry;
    replace(notice.key, (n) => ({ ...n, busy: true }));
    try {
      const answer = await api.memoryUndo(notice.state.result.undoToken);
      replace(notice.key, (n) => ({
        key: n.key,
        state: answer.ok ? { kind: "undone", op: answer.undone, title } : { kind: "not-undone", title },
      }));
    } catch {
      replace(notice.key, (n) => ({ key: n.key, state: { kind: "not-undone", title } }));
    }
  }, [api, replace]);

  if (notices.length === 0) return null;
  return (
    <div className="mx-3 mb-2 flex min-w-0 flex-col gap-1" data-testid="memory-save-notices">
      {notices.map((notice) => (
        <div
          key={notice.key}
          role="status"
          className="flex min-w-0 items-center gap-2 rounded-md border bg-background px-3 py-1.5 text-xs text-muted-foreground"
        >
          <span className="min-w-0 flex-1 truncate">{noticeText(notice.state, t)}</span>
          {notice.state.kind === "saved" && notice.state.result.undoToken ? (
            <button
              type="button"
              className="shrink-0 font-medium text-foreground hover:underline disabled:opacity-50"
              disabled={notice.busy === true}
              onClick={() => void undo(notice)}
            >
              {t("memorySaveNotice.undo")}
            </button>
          ) : null}
          {notice.state.kind === "saved" || notice.state.kind === "not-undone" ? (
            <button
              type="button"
              className="shrink-0 font-medium text-foreground hover:underline"
              onClick={() => {
                const state = notice.state;
                onOpenMemory(state.kind === "saved" ? state.result.entry.title : (state as { title: string }).title);
              }}
            >
              {t("memorySaveNotice.view")}
            </button>
          ) : null}
          <button
            type="button"
            className="shrink-0 text-muted-foreground hover:text-foreground"
            aria-label={t("memorySaveNotice.dismiss")}
            onClick={() => dismiss(notice.key)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

function noticeText(state: NoticeState, t: (key: string, params?: Record<string, string>) => string): string {
  switch (state.kind) {
    case "saved":
      return state.result.op === "deleted"
        ? t("memorySaveNotice.deleted", { title: state.result.entry.title })
        : t("memorySaveNotice.saved", { title: state.result.entry.title });
    case "undone":
      return state.op === "created"
        ? t("memorySaveNotice.undoneSave", { title: state.title })
        : t("memorySaveNotice.undoneDelete", { title: state.title });
    case "not-undone":
      return t("memorySaveNotice.notUndone");
    case "skipped": {
      const group = skipGroup(state.reason);
      if (group === "secret") return t("memorySaveNotice.skippedSecret");
      if (group === "instruction") return t("memorySaveNotice.skippedInstruction");
      return t("memorySaveNotice.failed");
    }
  }
}
