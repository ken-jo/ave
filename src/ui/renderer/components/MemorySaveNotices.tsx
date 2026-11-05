import { useCallback, useEffect, useRef, useState } from "react";
import type { AveApi } from "../types.js";
import type { MemorySaveNoticeResult, MemorySaveSkipReason } from "../../../shared/memory-save-result.js";
import { useTranslation } from "../../../i18n/react.js";

/** How many notices one conversation shows at once; older ones give way. */
const MAX_VISIBLE_NOTICES = 3;

type NoticeState =
  | { kind: "saved"; result: Extract<MemorySaveNoticeResult, { status: "saved" }> }
  | { kind: "undone"; op: "created" | "updated" | "deleted"; title: string }
  /** "changed": the memory moved on since; "expired": the undo is no longer held (after a restart, or too many saves since). */
  | { kind: "not-undone"; why: "changed" | "expired"; title: string }
  | { kind: "skipped"; reason: MemorySaveSkipReason };

export interface MemoryNotice {
  key: number;
  /** The conversation row this notice sits under; one without it follows the last row. */
  anchorMessageId?: string;
  state: NoticeState;
  busy?: boolean;
  detailOpen?: boolean;
}

export interface MemorySaveNoticesController {
  notices: MemoryNotice[];
  undo: (key: number) => Promise<void>;
  dismiss: (key: number) => void;
  toggleDetail: (key: number) => void;
}

type SkipGroup = "secret" | "instruction" | "nothing" | "too-large" | "failed";

function skipGroup(reason: MemorySaveSkipReason): SkipGroup {
  if (reason === "sensitive-input" || reason === "credential" || reason === "authorization-key") return "secret";
  if (reason === "unsafe-text" || reason === "external-context") return "instruction";
  if (reason === "reviewer-skip") return "nothing";
  if (reason === "input-too-large") return "too-large";
  return "failed";
}

/** This conversation's live memory notices; switching conversations clears them, as notices are live only. */
export function useMemorySaveNotices(
  api: Pick<AveApi, "onMemorySaveResult" | "memoryUndo">,
  sessionId: string,
): MemorySaveNoticesController {
  const [notices, setNotices] = useState<MemoryNotice[]>([]);
  const noticesRef = useRef(notices);
  noticesRef.current = notices;
  const nextKey = useRef(0);

  useEffect(() => {
    setNotices([]);
    return api.onMemorySaveResult((event) => {
      if (event.sessionId !== sessionId) return;
      const state: NoticeState = event.result.status === "saved"
        ? { kind: "saved", result: event.result }
        : { kind: "skipped", reason: event.result.reason };
      const key = nextKey.current++;
      const notice: MemoryNotice = { key, state, ...(event.anchorMessageId ? { anchorMessageId: event.anchorMessageId } : {}) };
      setNotices((current) => [...current, notice].slice(-MAX_VISIBLE_NOTICES));
    });
  }, [api, sessionId]);

  const replace = useCallback((key: number, update: (notice: MemoryNotice) => MemoryNotice) => {
    setNotices((current) => current.map((notice) => (notice.key === key ? update(notice) : notice)));
  }, []);

  const dismiss = useCallback((key: number) => {
    setNotices((current) => current.filter((notice) => notice.key !== key));
  }, []);

  const toggleDetail = useCallback((key: number) => {
    replace(key, (notice) => ({ ...notice, detailOpen: notice.detailOpen !== true }));
  }, [replace]);

  const undo = useCallback(async (key: number) => {
    const notice = noticesRef.current.find((n) => n.key === key);
    if (!notice || notice.state.kind !== "saved" || !notice.state.result.undoToken) return;
    const token = notice.state.result.undoToken;
    const { title } = notice.state.result.entry;
    replace(key, (n) => ({ ...n, busy: true }));
    try {
      const answer = await api.memoryUndo(token);
      replace(key, (n) => ({
        key: n.key,
        ...(n.anchorMessageId ? { anchorMessageId: n.anchorMessageId } : {}),
        state: answer.ok
          ? { kind: "undone", op: answer.undone, title }
          : { kind: "not-undone", why: answer.error === "changed" ? "changed" : "expired", title },
      }));
    } catch {
      // The host keeps the token when an undo throws, so the same button can try again.
      replace(key, (n) => ({ ...n, busy: false }));
    }
  }, [api, replace]);

  return { notices, undo, dismiss, toggleDetail };
}

export interface MemorySaveNoticeRowsProps {
  notices: MemoryNotice[];
  controller: Pick<MemorySaveNoticesController, "undo" | "dismiss" | "toggleDetail">;
  /** Open the memory panel searching for this title. */
  onOpenMemory: (title: string) => void;
  /** 다시 시도 for a failed /remember, offered only when its command row is known. */
  retry?: { onRetry: () => void; disabled: boolean };
}

const DETAIL_KEYS: Record<Exclude<SkipGroup, "nothing">, string> = {
  secret: "memorySaveNotice.detailSecret",
  instruction: "memorySaveNotice.detailInstruction",
  "too-large": "memorySaveNotice.detailTooLarge",
  failed: "memorySaveNotice.detailFailed",
};

/** One line per memory save, update, delete or refusal, with undo, view, details or retry where each applies. */
export function MemorySaveNoticeRows({ notices, controller, onOpenMemory, retry }: MemorySaveNoticeRowsProps) {
  const { t } = useTranslation();
  if (notices.length === 0) return null;
  const linkClass = "shrink-0 font-medium text-foreground hover:underline disabled:opacity-50";
  return (
    <div className="flex min-w-0 flex-col gap-1" data-testid="memory-save-notices">
      {notices.map((notice) => {
        const { state } = notice;
        const group = state.kind === "skipped" ? skipGroup(state.reason) : null;
        const detailKey = group !== null && group !== "nothing" ? DETAIL_KEYS[group] : null;
        const title = state.kind === "saved" ? state.result.entry.title : state.kind === "not-undone" ? state.title : null;
        return (
          <div
            key={notice.key}
            role="status"
            className="flex min-w-0 flex-col gap-1 rounded-md border bg-background px-3 py-1.5 text-xs text-muted-foreground"
          >
            <div className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 flex-1 truncate">{noticeText(state, t)}</span>
              {state.kind === "saved" && state.result.undoToken ? (
                <button type="button" className={linkClass} disabled={notice.busy === true} onClick={() => void controller.undo(notice.key)}>
                  {t("memorySaveNotice.undo")}
                </button>
              ) : null}
              {title !== null ? (
                <button type="button" className={linkClass} onClick={() => onOpenMemory(title)}>
                  {t("memorySaveNotice.view")}
                </button>
              ) : null}
              {group === "failed" && retry ? (
                <button
                  type="button"
                  className={linkClass}
                  disabled={retry.disabled}
                  title={retry.disabled ? t("memorySaveNotice.retryComposerBusy") : undefined}
                  onClick={retry.onRetry}
                >
                  {t("memorySaveNotice.retry")}
                </button>
              ) : null}
              {detailKey !== null ? (
                <button
                  type="button"
                  className={linkClass}
                  aria-expanded={notice.detailOpen === true}
                  onClick={() => controller.toggleDetail(notice.key)}
                >
                  {t("memorySaveNotice.details")}
                </button>
              ) : null}
              <button
                type="button"
                className="shrink-0 text-muted-foreground hover:text-foreground"
                aria-label={t("memorySaveNotice.dismiss")}
                onClick={() => controller.dismiss(notice.key)}
              >
                ×
              </button>
            </div>
            {detailKey !== null && notice.detailOpen ? (
              <p className="whitespace-pre-wrap break-words">{t(detailKey)}</p>
            ) : null}
          </div>
        );
      })}
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
      if (state.op === "created") return t("memorySaveNotice.undoneSave", { title: state.title });
      if (state.op === "updated") return t("memorySaveNotice.undoneUpdate", { title: state.title });
      return t("memorySaveNotice.undoneDelete", { title: state.title });
    case "not-undone":
      return state.why === "changed" ? t("memorySaveNotice.notUndone") : t("memorySaveNotice.notUndoneExpired");
    case "skipped": {
      const group = skipGroup(state.reason);
      if (group === "secret") return t("memorySaveNotice.skippedSecret");
      if (group === "instruction") return t("memorySaveNotice.skippedInstruction");
      if (group === "nothing") return t("memorySaveNotice.skippedNothing");
      return t("memorySaveNotice.failed");
    }
  }
}
