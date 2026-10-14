/**
 * Suggested tasks on an empty conversation: a short grid of cards above the
 * composer. Choosing a card FILLS the composer (and focuses it) rather than
 * sending — the same contract as suggested replies (Tab fills, the user sends),
 * and several prompts carry a placeholder such as `[URL]` the user has to
 * replace before the turn makes sense.
 *
 * Renders every state an async provider can be in: loading (skeleton cards),
 * error (a quiet line with a retry), and empty (nothing at all).
 */
import { File, Globe, Search, Sparkles, Terminal, type LucideIcon } from "lucide-react";
import { useTranslation } from "../../../i18n/react.js";
import { Button } from "../../../components/ui/button.js";
import { useSuggestedTasks } from "../suggested-tasks/use-suggested-tasks.js";
import type { SuggestedTask, SuggestedTaskIcon } from "../suggested-tasks/provider.js";

const ICONS: Record<SuggestedTaskIcon, LucideIcon> = {
  globe: Globe,
  terminal: Terminal,
  file: File,
  search: Search,
  sparkles: Sparkles,
};

export interface SuggestedTasksPanelProps {
  onChoose: (task: SuggestedTask) => void;
}

export function SuggestedTasksPanel({ onChoose }: SuggestedTasksPanelProps) {
  const { t } = useTranslation();
  const { state, reload } = useSuggestedTasks(true);

  if (state.status === "ready" && state.tasks.length === 0) return null;

  return (
    <section
      className="flex min-h-[55cqh] w-full min-w-0 flex-col justify-end"
      aria-labelledby="suggested-tasks-heading"
      aria-busy={state.status === "loading"}
      data-testid="suggested-tasks"
      data-state={state.status}
    >
      <h2
        id="suggested-tasks-heading"
        className="mb-2 px-1 text-xs font-medium text-muted-foreground"
      >
        {t("suggestedTasks.heading")}
      </h2>
      {state.status === "error" ? (
        <div className="flex items-center gap-2 px-1 text-xs text-muted-foreground" role="status">
          <span>{t("suggestedTasks.error")}</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={reload}
            data-testid="suggested-tasks-retry"
          >
            {t("suggestedTasks.retry")}
          </Button>
        </div>
      ) : (
        <ul className="grid min-w-0 grid-cols-1 gap-2 @min-[34rem]:grid-cols-2">
          {state.status === "loading"
            ? [0, 1, 2, 3].map((n) => (
                <li
                  key={n}
                  className="h-14 animate-pulse rounded-lg border border-border/(--opacity-light) bg-muted/(--opacity-subtle) motion-reduce:animate-none"
                  aria-hidden="true"
                />
              ))
            : state.tasks.map((task) => {
                const Icon = (task.icon && ICONS[task.icon]) || Sparkles;
                return (
                  <li key={`${task.source}:${task.id}`} className="min-w-0">
                    <button
                      type="button"
                      className="flex h-full w-full min-w-0 items-start gap-2.5 rounded-lg border border-border/(--opacity-medium) bg-background px-3 py-2.5 text-left text-sm transition-colors hover:bg-muted/(--opacity-muted) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => onChoose(task)}
                      title={task.prompt}
                      data-testid="suggested-task"
                      data-task-id={task.id}
                    >
                      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                      <span className="min-w-0 break-words leading-snug">{task.title}</span>
                    </button>
                  </li>
                );
              })}
        </ul>
      )}
      {state.status === "loading" ? <span className="sr-only">{t("suggestedTasks.loading")}</span> : null}
    </section>
  );
}
