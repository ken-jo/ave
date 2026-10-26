import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { Terminal } from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "../../../components/ui/popover.js";
import { useTranslation } from "../../../i18n/react.js";
import type { ShellTask, ShellTaskAction } from "../../../shared/shell-tasks.js";
import type { AveApi } from "../types.js";
import type { ComposerHandle } from "./Composer.js";

export function ShellTasksPanel({ api, sessionId, composerRef }: {
  api: Pick<AveApi, "chatListShellTasks" | "chatControlShellTask">;
  sessionId: string;
  composerRef: RefObject<ComposerHandle | null>;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [tasks, setTasks] = useState<ShellTask[]>([]);
  const [error, setError] = useState(false);
  const [working, setWorking] = useState(false);
  const currentSession = useRef(sessionId);
  const inflight = useRef(false);
  const generation = useRef(0);
  currentSession.current = sessionId;

  const refresh = useCallback(async () => {
    const requestedSession = sessionId;
    const request = ++generation.current;
    if (!requestedSession) return;
    try {
      const next = await api.chatListShellTasks(requestedSession);
      if (requestedSession === currentSession.current && request === generation.current) setTasks(next);
    } catch {
      if (requestedSession === currentSession.current) setError(true);
    }
  }, [api, sessionId]);

  const handleAction = useCallback(async (action: ShellTaskAction, shellId?: string) => {
    if (inflight.current || !sessionId) return;
    const requestedSession = sessionId;
    inflight.current = true;
    setWorking(true);
    setError(false);
    setOpen(true);
    try {
      const result = await api.chatControlShellTask(requestedSession, action, shellId);
      if (requestedSession !== currentSession.current) return;
      setError(!result.ok);
      await refresh();
    } catch {
      if (requestedSession === currentSession.current) setError(true);
    } finally {
      inflight.current = false;
      setWorking(false);
    }
  }, [api, refresh, sessionId]);

  useEffect(() => {
    setTasks([]);
    setError(false);
    setOpen(false);
    generation.current += 1;
  }, [sessionId]);

  useEffect(() => {
    if (!open) return;
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 1000);
    return () => clearInterval(timer);
  }, [open, refresh]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing || !event.ctrlKey || event.metaKey || event.altKey || event.shiftKey ||
          event.key.toLowerCase() !== "b" || event.target !== composerRef.current?.textarea()) return;
      event.preventDefault();
      void handleAction("background");
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [composerRef, handleAction]);

  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild>
      <Button variant="ghost" size="sm" className="h-6 gap-1 px-1.5 text-xs" data-testid="shell-tasks-trigger" aria-label={t("shellTasks.title")} title={t("shellTasks.shortcut")}>
        <Terminal className="h-3 w-3" aria-hidden="true" />{t("shellTasks.title")}
      </Button>
    </PopoverTrigger>
    <PopoverContent className="w-96 max-w-[90vw] space-y-3" aria-label={t("shellTasks.title")}>
      <h3 className="text-sm font-semibold">{t("shellTasks.title")}</h3>
      <p className="text-xs text-muted-foreground">{t("shellTasks.shortcut")}</p>
      <p className="text-xs text-muted-foreground">{t("shellTasks.limits")}</p>
      {error && <p role="alert" className="text-xs text-destructive">{t("shellTasks.unavailable")}</p>}
      {tasks.length === 0 && <p role="status" className="text-xs text-muted-foreground">{t("shellTasks.empty")}</p>}
      <ul className="max-h-80 space-y-3 overflow-y-auto" aria-label={t("shellTasks.title")}>
        {tasks.map((task) => <li key={task.shellId} className="space-y-1 rounded border border-border p-2">
          <code className="block whitespace-pre-wrap break-all text-xs">{task.command}</code>
          <p className="text-xs text-muted-foreground" role="status">{t(`shellTasks.${task.status}`)} · {t(task.backgrounded ? "shellTasks.background" : "shellTasks.foreground")}</p>
          {task.canBackground && <Button size="sm" variant="outline" disabled={working} onClick={() => void handleAction("background", task.shellId)}>{t("shellTasks.moveBackground")}</Button>}
          {task.canStop && <Button size="sm" variant="outline" disabled={working} onClick={() => void handleAction("stop", task.shellId)}>{t("shellTasks.stop")}</Button>}
          {task.output && <details><summary className="cursor-pointer text-xs">{t("shellTasks.output")}</summary><pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all text-xs">{task.output}</pre></details>}
          {task.outputTruncated && <p className="text-xs text-muted-foreground">{t("shellTasks.outputPreview")}</p>}
        </li>)}
      </ul>
    </PopoverContent>
  </Popover>;
}
