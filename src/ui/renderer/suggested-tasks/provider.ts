/** Suggestion providers compose behind one async interface so empty-state UI stays independent of the source. */
import type { Locale } from "../../../i18n/locale.js";
import type { TranslateFn } from "../../../i18n/translate.js";

/** Icons a task may ask for. A closed set so a provider cannot make the UI load arbitrary assets; anything else renders the
 * generic icon. */
const SUGGESTED_TASK_ICONS = ["globe", "terminal", "file", "search", "sparkles"] as const;
export type SuggestedTaskIcon = (typeof SUGGESTED_TASK_ICONS)[number];

export interface SuggestedTask {
  /** Stable within its provider; used as the React key and for de-duplication. */
  id: string;
  /** Short card label, already localized. */
  title: string;
  /** Text placed in the composer when the card is chosen. */
  prompt: string;
  /** Which provider produced it (e.g. `"static"`); display/diagnostics only. */
  source: string;
  icon?: SuggestedTaskIcon;
}

interface SuggestedTasksRequest {
  locale: Locale;
  /** Renderer translator for providers that localize in-process. */
  t: TranslateFn;
  /** Aborted when the request is superseded (locale change, unmount). */
  signal: AbortSignal;
}

export interface SuggestedTasksProvider {
  /** Identifies the provider in `SuggestedTask.source` and diagnostics. */
  readonly id: string;
  list(request: SuggestedTasksRequest): Promise<readonly SuggestedTask[]>;
}

/** Spell out starter-task translation keys so catalog gates can discover them. */
const STATIC_TASKS: ReadonlyArray<{ id: string; icon: SuggestedTaskIcon; titleKey: string; promptKey: string }> = [
  { id: "web-research", icon: "globe", titleKey: "suggestedTasks.webResearchTitle", promptKey: "suggestedTasks.webResearchPrompt" },
  { id: "web-summarize-page", icon: "search", titleKey: "suggestedTasks.webSummarizePageTitle", promptKey: "suggestedTasks.webSummarizePagePrompt" },
  { id: "terminal-project-status", icon: "terminal", titleKey: "suggestedTasks.terminalProjectStatusTitle", promptKey: "suggestedTasks.terminalProjectStatusPrompt" },
  { id: "terminal-run-tests", icon: "terminal", titleKey: "suggestedTasks.terminalRunTestsTitle", promptKey: "suggestedTasks.terminalRunTestsPrompt" },
  { id: "files-explain-project", icon: "file", titleKey: "suggestedTasks.filesExplainProjectTitle", promptKey: "suggestedTasks.filesExplainProjectPrompt" },
  { id: "files-find-todos", icon: "search", titleKey: "suggestedTasks.filesFindTodosTitle", promptKey: "suggestedTasks.filesFindTodosPrompt" },
];

export const staticSuggestedTasksProvider: SuggestedTasksProvider = {
  id: "static",
  async list({ t }) {
    return STATIC_TASKS.map(({ id, icon, titleKey, promptKey }) => ({
      id,
      icon,
      source: "static",
      title: t(titleKey),
      prompt: t(promptKey),
    }));
  },
};

/**
 * Combine providers in priority order. Results are concatenated with the first
 * occurrence of an `id` winning, so a richer provider placed first can replace
 * a static card by reusing its id. A provider that fails is skipped; the
 * merged list rejects only when every provider failed, so one broken source
 * never blanks the empty state.
 */
export function mergeSuggestedTasksProviders(
  providers: readonly SuggestedTasksProvider[],
  limit = 6,
): SuggestedTasksProvider {
  return {
    id: providers.map((p) => p.id).join("+"),
    async list(request) {
      const settled = await Promise.allSettled(providers.map((p) => p.list(request)));
      const failures = settled.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      if (providers.length > 0 && failures.length === providers.length) {
        throw failures[0]?.reason ?? new Error("all suggested-task providers failed");
      }
      const seen = new Set<string>();
      const out: SuggestedTask[] = [];
      for (const result of settled) {
        if (result.status !== "fulfilled") continue;
        for (const task of result.value) {
          if (seen.has(task.id)) continue;
          seen.add(task.id);
          out.push(task);
          if (out.length >= limit) return out;
        }
      }
      return out;
    },
  };
}
