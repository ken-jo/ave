import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import { useTranslation } from "../../../i18n/react.js";
import { MARKDOWN_REMARK_PLUGINS } from "../utils/markdown-plugins.js";
import { wrapRenderHtmlInlineFrameDocument } from "../../../shared/render-html-preview.js";
import { previewDocumentFormatOf, type PreviewDocumentFormat } from "../../../shared/preview-document.js";
import { previewPageFormatOf, type PreviewPageFormat } from "../../../shared/preview-page-document.js";

/**
 * Progressive file/text viewer registry (§6.10.6). A descriptor (text + an
 * optional path/mime hint) resolves to the first matching renderer; `text` is
 * the always-true fallback. New renderers are added by pushing to REGISTRY —
 * the PreviewBody call site never changes.
 *
 * Security posture:
 *  - markdown uses react-markdown v10 (raw HTML is inert text without
 *    rehype-raw, which is DELIBERATELY not added; unsafe URL protocols are
 *    stripped by react-markdown's defaultUrlTransform). Links are rendered
 *    non-navigating so a preview can never hijack the renderer window.
 *  - mermaid renders in the parent (securityLevel:'strict' -> DOMPurify) to a
 *    static SVG, then displays it inside the CSP-locked, script-less,
 *    sandbox="" inline-frame shell (no network, no scripts). mermaid itself is
 *    a local webpack chunk (lazy import) — no external CDN.
 */
export interface PreviewContentDescriptor {
  text: string;
  path?: string;
  mimeType?: string;
  filename?: string;
}

export type PreviewRenderKind = "text" | "markdown" | "mermaid";

/**
 * How a file target is previewed. Table documents (csv/tsv/xlsx/xls/ods) are
 * parsed in a child and shown as a grid. Page documents have a separate page
 * view; other files use the text renderer registry. Classifiers are shared
 * with the host reader.
 */
export type FilePreviewRoute =
  | { kind: "table"; format: PreviewDocumentFormat }
  | { kind: "page"; format: PreviewPageFormat }
  | { kind: "text" };

export function resolveFilePreviewRoute(path: string): FilePreviewRoute {
  const format = previewDocumentFormatOf(path);
  if (format) return { kind: "table", format };
  const pageFormat = previewPageFormatOf(path);
  return pageFormat ? { kind: "page", format: pageFormat } : { kind: "text" };
}

export interface PreviewRenderer {
  kind: PreviewRenderKind;
  match: (descriptor: PreviewContentDescriptor) => boolean;
  Component: ComponentType<{ descriptor: PreviewContentDescriptor; onRendered?: () => void }>;
}

function extensionOf(descriptor: PreviewContentDescriptor): string {
  const source = descriptor.path ?? descriptor.filename ?? "";
  const base = source.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : "";
}

function TextRenderer({ descriptor }: { descriptor: PreviewContentDescriptor }) {
  return (
    <pre className="max-h-(--preview-block-max-height) overflow-auto whitespace-pre-wrap rounded-md border bg-muted/(--opacity-muted) p-3 font-mono text-[11px] leading-relaxed text-foreground [overflow-wrap:anywhere]">
      {descriptor.text}
    </pre>
  );
}

let mermaidIdCounter = 0;
let mermaidModule: Promise<typeof import("mermaid")> | undefined;
// mermaid.initialize mutates a module-global config; calling it on every render
// is redundant work. Run it exactly once per loaded mermaid module.
let mermaidInitialized = false;

interface DiagramReadiness { ready(): void; dispose(): void }

function MermaidBlock({ code, onRendered, onPending }: { code: string; onRendered?: () => void; onPending?: () => DiagramReadiness }) {
  const { t } = useTranslation();
  const [svgDoc, setSvgDoc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const complete = useRef<(() => void) | undefined>(undefined);
  const rendered = useRef(false);

  useLayoutEffect(() => {
    let disposed = false;
    const receipt = onPending?.();
    complete.current = () => { if (!disposed) { receipt?.ready(); onRendered?.(); } };
    if (rendered.current) complete.current();
    return () => { disposed = true; receipt?.dispose(); };
  }, [onPending, onRendered]);

  useEffect(() => {
    let cancelled = false;
    setSvgDoc(null);
    setFailed(false);
    void (async () => {
      try {
        const mermaid = (await (mermaidModule ??= import(/* webpackChunkName: "mermaid" */ "mermaid"))).default;
        if (!mermaidInitialized) {
          mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
          mermaidInitialized = true;
        }
        const id = `ave-mermaid-${mermaidIdCounter++}`;
        const { svg } = await mermaid.render(id, code);
        if (cancelled) return;
        // No bindFunctions() call — interaction/scripts stay disabled. The SVG
        // is displayed in the script-less, no-network sandboxed inline frame.
        setSvgDoc(wrapRenderHtmlInlineFrameDocument(svg, { allowScripts: false }));
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code]);

  useLayoutEffect(() => { if (failed) { rendered.current = true; complete.current?.(); } }, [failed]);

  if (failed) {
    // Never blank: fall back to the raw fenced source (§6.10.6).
    return (
      <div className="space-y-1" data-testid="chat-side-panel-mermaid-fallback">
        <div className="text-[11px] text-muted-foreground">{t("chatPreviewRail.diagramRenderFailed")}</div>
        <pre className="max-h-(--preview-block-max-height-compact) overflow-auto whitespace-pre-wrap rounded-md border bg-muted/(--opacity-muted) p-3 font-mono text-[11px] leading-relaxed text-foreground [overflow-wrap:anywhere]">
          {code}
        </pre>
      </div>
    );
  }
  if (!svgDoc) {
    return <div className="text-xs text-muted-foreground">{t("chatPreviewRail.diagramRendering")}</div>;
  }
  return (
    <iframe
      data-testid="chat-side-panel-mermaid-frame"
      title="mermaid diagram"
      sandbox=""
      referrerPolicy="no-referrer"
      srcDoc={svgDoc}
      onLoad={() => { rendered.current = true; complete.current?.(); }}
      className="block max-h-(--preview-block-max-height) min-h-40 w-full rounded-md border-0 bg-background"
    />
  );
}

function MarkdownRenderer({ descriptor, onRendered }: { descriptor: PreviewContentDescriptor; onRendered?: () => void }) {
  const onRenderedRef = useRef(onRendered);
  useLayoutEffect(() => { onRenderedRef.current = onRendered; }, [onRendered]);
  const generation = useMemo(() => ({ pending: new Map<symbol, boolean>(), committed: false }), [descriptor.text]);
  const handlePendingDiagram = useCallback((): DiagramReadiness => {
    const id = Symbol();
    generation.pending.set(id, false);
    return {
      ready: () => {
        if (!generation.pending.has(id)) return;
        generation.pending.set(id, true);
        if (generation.committed && [...generation.pending.values()].every(Boolean)) onRenderedRef.current?.();
      },
      dispose: () => { generation.pending.delete(id); },
    };
  }, [generation]);
  useLayoutEffect(() => {
    generation.committed = true;
    if ([...generation.pending.values()].every(Boolean)) onRenderedRef.current?.();
  return () => { generation.committed = false; };
  }, [generation, onRendered]);
  const components = useMemo<Components>(() => ({
          code({ className, children, ...props }) {
            if (className === "language-mermaid") {
              const code = String(children).replace(/\n$/, "");
              return <MermaidBlock key={code} code={code} onPending={handlePendingDiagram} />;
            }
            return (
              <code className={className} {...props}>
                {children}
              </code>
            );
          },
          // A preview surface must never navigate the renderer window itself.
          // Left-click is neutralized here; middle/modifier-click is left to the
          // app's global link handler, which hands the URL to the system browser
          // (a new OS window) rather than navigating this renderer. The href is
          // kept so the destination is visible on hover / copy.
          a({ href, children }) {
            return (
              <a href={href} onClick={(event) => event.preventDefault()} className="underline">
                {children}
              </a>
            );
          },
  }), [handlePendingDiagram]);
  return (
    <div className="markdown-body max-h-(--preview-block-max-height) overflow-auto rounded-md border bg-background p-3 text-sm [overflow-wrap:anywhere]" data-testid="chat-side-panel-markdown">
      <ReactMarkdown
        remarkPlugins={MARKDOWN_REMARK_PLUGINS}
        components={components}
      >
        {descriptor.text}
      </ReactMarkdown>
    </div>
  );
}

const textRenderer: PreviewRenderer = {
  kind: "text",
  match: () => true,
  Component: TextRenderer,
};

const markdownRenderer: PreviewRenderer = {
  kind: "markdown",
  match: (descriptor) => {
    const ext = extensionOf(descriptor);
    return ext === "md" || ext === "markdown" || descriptor.mimeType === "text/markdown";
  },
  Component: MarkdownRenderer,
};

const mermaidRenderer: PreviewRenderer = {
  kind: "mermaid",
  match: (descriptor) => {
    const ext = extensionOf(descriptor);
    return ext === "mmd" || ext === "mermaid";
  },
  Component: ({ descriptor, onRendered }) => <MermaidBlock key={descriptor.text} code={descriptor.text} onRendered={onRendered} />,
};

// Ordered — first match wins; `text` is always last (always-true fallback).
const REGISTRY: readonly PreviewRenderer[] = [mermaidRenderer, markdownRenderer, textRenderer];

export function resolvePreviewRenderer(descriptor: PreviewContentDescriptor): PreviewRenderer {
  return REGISTRY.find((renderer) => renderer.match(descriptor)) ?? textRenderer;
}

/** Render `descriptor` with the resolved renderer. Single PreviewBody call site. */
export function PreviewContent({ descriptor, onRendered }: { descriptor: PreviewContentDescriptor; onRendered?: () => void }) {
  const renderer = resolvePreviewRenderer(descriptor);
  return <renderer.Component descriptor={descriptor} onRendered={onRendered} />;
}
