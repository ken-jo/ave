import { useTranslation } from "../../../i18n/react.js";

/** The memory a "Ave 에게 고치기" chat was opened for. UI state only: Ave finds it again with memory_search when the user sends. */
export interface MemoryFixTarget {
  id: string;
  title: string;
  content: string;
}

/** The card above the composer naming the memory to fix, until the request is sent. */
export function MemoryFixCard({ memory, onDismiss }: { memory: MemoryFixTarget; onDismiss: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="mb-2 flex min-w-0 flex-col gap-1 rounded-md border bg-background px-3 py-2 text-xs" data-testid="memory-fix-card">
      <div className="flex min-w-0 items-center gap-2 text-muted-foreground">
        <span className="min-w-0 flex-1 truncate">{t("memorySaveNotice.fixCardLabel")}</span>
        <button
          type="button"
          className="shrink-0 hover:text-foreground"
          aria-label={t("memorySaveNotice.fixCardDismiss")}
          onClick={onDismiss}
        >
          ×
        </button>
      </div>
      <p className="min-w-0 truncate text-sm font-semibold text-foreground">{memory.title}</p>
      <p className="min-w-0 line-clamp-3 whitespace-pre-wrap break-words text-foreground">{memory.content}</p>
      <p className="border-t pt-1 text-muted-foreground">{t("memorySaveNotice.fixCardHint")}</p>
    </div>
  );
}
