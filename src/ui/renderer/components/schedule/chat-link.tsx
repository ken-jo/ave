// Which chat a schedule item enters: the project's chats as choices, shared by 스케줄 추가 and the item's popover.
import { useEffect, useState } from "react";
import { t } from "../../../../i18n/runtime.js";
import { NativeSelect, NativeSelectOption } from "../../../../components/ui/native-select.js";
import type { AveApi } from "../../types.js";

export interface ChatChoice {
  id: string;
  title: string;
}

/** The project's main chats, newest first as the host lists them. Empty until loaded, and empty on a failed read. */
export function useProjectChats(api: AveApi, projectRoot: string | undefined): readonly ChatChoice[] {
  const [chats, setChats] = useState<readonly ChatChoice[]>([]);
  useEffect(() => {
    let cancelled = false;
    void api.chatSessions({ kind: "main", ...(projectRoot ? { projectRoot } : {}) })
      .then((result) => { if (!cancelled) setChats(result.sessions.map(({ id, title }) => ({ id, title }))); })
      .catch(() => { if (!cancelled) setChats([]); });
    return () => { cancelled = true; };
  }, [api, projectRoot]);
  return chats;
}

/** The chat's title, or 대화 없음 for a chat that is not among the project's chats any more. */
export function chatTitle(chats: readonly ChatChoice[], id: string): string {
  return chats.find((chat) => chat.id === id)?.title || t("schedulePanel.chatLinkMissing");
}

export function ChatLinkField({ value, onChange, chats, disabled }: {
  value: string;
  onChange: (sessionId: string) => void;
  chats: readonly ChatChoice[];
  disabled?: boolean;
}) {
  const listed = value === "" || chats.some((chat) => chat.id === value);
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-muted-foreground">{t("schedulePanel.chatLinkLabel")}</span>
      <NativeSelect className="w-full" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} data-testid="schedule-chat-link">
        <NativeSelectOption value="">{t("schedulePanel.chatLinkNone")}</NativeSelectOption>
        {!listed && <NativeSelectOption value={value}>{t("schedulePanel.chatLinkMissing")}</NativeSelectOption>}
        {chats.map((chat) => <NativeSelectOption key={chat.id} value={chat.id}>{chat.title}</NativeSelectOption>)}
      </NativeSelect>
    </label>
  );
}
