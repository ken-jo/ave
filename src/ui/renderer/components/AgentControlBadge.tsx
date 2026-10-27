import { useState } from "react";
import { Bot, Play, Square } from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import { useTranslation } from "../../../i18n/react.js";

/** Human takeover stays paused until the host confirms an explicit resume. The badge mirrors host state and never grants
 * page authority on its own. */
export function AgentControlBadge({ mode, onPause, onResume }: {
  mode: "agent-active" | "human-paused";
  onPause: () => Promise<{ ok: true } | { ok: false; error: string }>;
  onResume: () => Promise<{ ok: true } | { ok: false; error: string }>;
}) {
  const { t } = useTranslation();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const paused = mode === "human-paused";
  const change = async () => {
    if (pending) return;
    setPending(true);
    setFailed(false);
    try {
      const result = await (paused ? onResume() : onPause());
      if (!result.ok) setFailed(true);
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  };
  return (
    <div
      className="flex min-w-0 flex-1 items-center gap-1 text-[11px]"
      role="status"
      data-testid="agent-browser-control-badge"
      title={t(paused ? "agentBrowser.pausedHint" : "agentBrowser.controllingHint")}
    >
      <Bot className="h-3.5 w-3.5 shrink-0 text-warning" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate font-medium">{t(paused ? "agentBrowser.paused" : "agentBrowser.controlling")}</span>
      {failed && <span role="alert" title={t("agentBrowser.controlFailed")}
        className="min-w-0 truncate text-destructive">{t("agentBrowser.controlFailed")}</span>}
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-6 gap-1 px-2 text-[11px]"
        onClick={() => { void change(); }}
        disabled={pending}
        aria-label={t(paused ? "agentBrowser.resumeLabel" : "agentBrowser.stopLabel")}
        data-testid={paused ? "agent-browser-control-resume" : "agent-browser-control-stop"}
      >
        {paused ? <Play className="h-3 w-3" aria-hidden="true" /> : <Square className="h-3 w-3" aria-hidden="true" />}
        {t(paused ? "agentBrowser.resume" : "agentBrowser.stop")}
      </Button>
    </div>
  );
}
