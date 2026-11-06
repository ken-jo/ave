import { cn } from "../../../lib/utils.js";
import { useTranslation } from "../../../i18n/react.js";
import { CodePreview, PreviewContent, resolvePreviewRenderer, type PreviewContentDescriptor } from "./preview-renderers.js";

/** Passive content only; readers, observation and actions belong to the caller. */
export function FilePreviewContent({ descriptor, source = false, documentLayout = false, onRendered }: {
  descriptor: PreviewContentDescriptor;
  source?: boolean;
  documentLayout?: boolean;
  onRendered?: () => void;
}) {
  const markdown = resolvePreviewRenderer(descriptor).kind === "markdown";
  const content = markdown && source ? <CodePreview descriptor={descriptor} />
    : markdown && documentLayout ? (
      <div className="prose prose-sm ave-prose max-w-none px-4 py-3" data-testid="folder-markdown-rendered">
        <PreviewContent descriptor={descriptor} onRendered={onRendered} />
      </div>
    ) : <PreviewContent descriptor={descriptor} onRendered={onRendered} />;
  return documentLayout ? (
    <div className="min-h-0 flex-1 overflow-auto [&_.markdown-body]:max-h-none [&_.markdown-body]:border-0 [&_pre]:max-h-none">{content}</div>
  ) : content;
}

export function MarkdownPreviewToggle({ source, onSourceChange }: {
  source: boolean;
  onSourceChange: (source: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <div role="group" aria-label={t("folderView.markdownMode")} className="flex rounded-md border p-0.5">
      {([false, true] as const).map((value) => (
        <button key={String(value)} type="button" aria-pressed={source === value} data-testid={`folder-markdown-${value ? "source" : "view"}`}
          onClick={() => onSourceChange(value)}
          className={cn("rounded px-2 py-0.5 text-[11px]", source === value ? "bg-muted font-medium" : "text-muted-foreground")}>
          {t(value ? "folderView.markdownSource" : "folderView.markdownView")}
        </button>
      ))}
    </div>
  );
}
