import { cn } from "../../../lib/utils.js";
import { useTranslation } from "../../../i18n/react.js";
import { CodePreview, PreviewContent, resolvePreviewRenderer, type PreviewContentDescriptor } from "./preview-renderers.js";

/** Passive content only; readers, observation and actions belong to the caller. Markdown source mode renders no
 * PreviewContent and so never calls `onRendered`: an observed document must pass `source` false. */
export function FilePreviewContent({ descriptor, source = false, prose = false, onRendered }: {
  descriptor: PreviewContentDescriptor;
  source?: boolean;
  /** Rendered Markdown in the reading typography chat answers use, so headings, lists and tables look like a document. */
  prose?: boolean;
  onRendered?: () => void;
}) {
  const markdown = resolvePreviewRenderer(descriptor).kind === "markdown";
  if (markdown && source) return <CodePreview descriptor={descriptor} />;
  return markdown && prose ? (
    <div className="prose prose-sm ave-prose max-w-none px-4 py-3" data-testid="markdown-rendered">
      <PreviewContent descriptor={descriptor} onRendered={onRendered} />
    </div>
  ) : <PreviewContent descriptor={descriptor} onRendered={onRendered} />;
}

export function MarkdownPreviewToggle({ source, onSourceChange }: {
  source: boolean;
  onSourceChange: (source: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <div role="group" aria-label={t("folderView.markdownMode")} className="flex rounded-md border p-0.5">
      {([false, true] as const).map((value) => (
        <button key={String(value)} type="button" aria-pressed={source === value} data-testid={`markdown-mode-${value ? "source" : "view"}`}
          onClick={() => onSourceChange(value)}
          className={cn("rounded px-2 py-0.5 text-[11px]", source === value ? "bg-muted font-medium" : "text-muted-foreground")}>
          {t(value ? "folderView.markdownSource" : "folderView.markdownView")}
        </button>
      ))}
    </div>
  );
}
