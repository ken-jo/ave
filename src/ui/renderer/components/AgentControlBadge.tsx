import { Bot, Square } from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import { useTranslation } from "../../../i18n/react.js";

/**
 * "Agent is controlling this tab" — shown above a browser tab the agent
 * opened. Stop cancels the agent's pending actions there and hands the tab to
 * the user for good (main then asks before every further agent action in it).
 */
export function AgentControlBadge({ onStop }: { onStop: () => void }) {
  const { t } = useTranslation();
  return (
    <div
      className="flex shrink-0 items-center gap-2 border-b border-warning/(--opacity-medium) bg-warning/(--opacity-soft) px-3 py-1.5 text-[11px]"
      role="status"
      data-testid="agent-browser-control-badge"
      title={t("agentBrowser.controllingHint")}
    >
      <Bot className="h-3.5 w-3.5 shrink-0 text-warning" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate font-medium">{t("agentBrowser.controlling")}</span>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-6 gap-1 px-2 text-[11px]"
        onClick={onStop}
        aria-label={t("agentBrowser.stopLabel")}
        data-testid="agent-browser-control-stop"
      >
        <Square className="h-3 w-3" aria-hidden="true" />
        {t("agentBrowser.stop")}
      </Button>
    </div>
  );
}
