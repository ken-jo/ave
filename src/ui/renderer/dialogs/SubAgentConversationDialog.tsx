import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../../../components/ui/dialog.js";
import { useTranslation } from "../../../i18n/react.js";
import type { SessionActivity } from "../../../shared/subagent-events.js";
import type { SessionListRow } from "../../../shared/session-lookup.js";
import { SubAgentTranscriptDetail } from "../components/ChatSidePanel.js";
import type { SubAgentSpawn } from "../subagents/types.js";
import type { AveApi } from "../types.js";

/** The existing read-only child transcript, reachable even after its parent leaves the list. */
export function SubAgentConversationDialog({ api, session, activity, onClose }: {
  api: AveApi;
  session: SessionListRow;
  activity?: SessionActivity;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [spawn, setSpawn] = useState<SubAgentSpawn>(() => ({
    spawnId: session.id, childSessionId: session.id, parentSessionId: session.originSessionId,
    title: session.title, status: "done", entries: [], toolCallCount: 0,
  }));
  useEffect(() => api.onAgentSpawnEvent?.((event) => {
    if (event.childSessionId !== session.id || event.parentSessionId !== session.originSessionId) return;
    setSpawn((current) => ({
      ...current,
      status: event.status ?? (event.type === "error" ? "error" : event.type === "done" ? "done" : "running"),
      entries: event.entries ?? current.entries,
      toolCallCount: event.toolCallCount ?? current.toolCallCount,
    }));
  }), [api, session.id, session.originSessionId]);
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent size="xl" data-testid="subagent-conversation-dialog">
      <DialogHeader>
        <DialogTitle>{session.title}</DialogTitle>
        <DialogDescription>{t("sidebar.subAgentConversation")}</DialogDescription>
      </DialogHeader>
      <SubAgentTranscriptDetail api={api} visible transcriptScope="sidebar" parentSessionId={session.originSessionId} sideChatSessionId={null} spawn={{ ...spawn, status: activity?.attention ? "waiting" : activity?.running ? "running" : spawn.status }} />
    </DialogContent>
  </Dialog>;
}
