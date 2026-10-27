import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Badge } from "../../../components/ui/badge.js";
import { cn } from "../../../lib/utils.js";
import { useTranslation } from "../../../i18n/react.js";
import type { ObservationBinding, AgentObservationEvent, DocumentObservationStatus } from "../../../shared/agent-observation.js";
import type { ChatPreviewTarget } from "./preview-targets.js";
import { resolveIpcErrorKey } from "../format-ipc-error.js";
import { PreviewContent, resolvePreviewRenderer } from "./preview-renderers.js";
import { PreviewDocumentFooter, PreviewDocumentHeader, PreviewDocumentLiveStrip, previewFormatLabel } from "./preview-document-chrome.js";
import { previewSupportsExternalOpen } from "../../../shared/preview-external-open.js";

type ReadError = NonNullable<Awaited<ReturnType<typeof window.ave.preview.readFile>>["error"]>;
interface ObservedLine { line: number; before: string; after: string; seq: number; ts: number }
type TextState = { phase: "loading" } | { phase: "error"; code: ReadError } | {
  phase: "ok"; path: string; content: string; truncated: boolean; lineCount: number;
  lines: string[]; image?: { dataUrl: string; mimeType: string }; binding?: ObservationBinding;
  changes: ObservedLine[]; seq: number; status?: DocumentObservationStatus;
};

function readErrorKey(code: ReadError): string {
  if (code === "path-not-allowed" || code === "sensitive-path") return resolveIpcErrorKey(code) ?? "chatPreviewRail.fileErrorGeneric";
  switch (code) {
    case "binary-file": return "chatPreviewRail.fileErrorBinary";
    case "too-large": return "chatPreviewRail.fileErrorTooLarge";
    case "not-a-file": return "chatPreviewRail.fileErrorGlob";
    case "read-failed": return "chatPreviewRail.fileErrorNotFound";
    default: return "chatPreviewRail.fileErrorGeneric";
  }
}

/** Exact view bindings carry agent changes; ordinary file previews remain passive. */
export function TextDocumentPreview({ target, sessionId }: {
  target: Extract<ChatPreviewTarget, { kind: "file" }>;
  sessionId?: string;
}) {
  const { t } = useTranslation();
  const { startLine, endLine } = target;
  const selected = startLine !== undefined && endLine !== undefined;
  const inlineText = selected ? undefined : target.inlineText;
  const [revision, setRevision] = useState(0);
  const [openFailed, setOpenFailed] = useState(false);
  const [state, setState] = useState<TextState>({ phase: "loading" });
  const generation = useRef(0);
  const acknowledged = useRef("");
  useEffect(() => {
    setOpenFailed(false);
    if (inlineText !== undefined) { setState({ phase: "loading" }); return; }
    let cancelled = false;
    let binding: ObservationBinding | undefined;
    let observedPath = target.path;
    let lastSeq = 0;
    generation.current += 1;
    setState({ phase: "loading" });
    const api = window.ave.preview;
    const release = (value: ObservationBinding): void => {
      void api.acknowledgeObservation({ action: "release", targetId: value.targetId,
        sessionId: value.sessionId, seq: lastSeq }).catch(() => {});
    };
    const handleEvents = (events: AgentObservationEvent[]): void => {
      if (cancelled || !binding || binding.sessionId !== sessionId) return;
      for (const event of events) {
        if (event.actor !== "agent" || event.source !== "document" || event.sessionId !== binding.sessionId
          || event.target.id !== binding.targetId || event.target.path !== observedPath
          || !Number.isSafeInteger(event.seq) || event.seq <= lastSeq) continue;
        lastSeq = event.seq;
        setState((previous) => {
          if (previous.phase !== "ok" || previous.binding?.targetId !== binding?.targetId) return previous;
          if (event.kind === "status") {
            const interrupted = event.after.code !== "live" && event.after.code !== "reconciling";
            return { ...previous, seq: event.seq, status: event.after.code, changes: interrupted ? [] : previous.changes };
          }
          if (event.kind === "snapshot") {
            if (event.after.format !== "text") return { ...previous, seq: event.seq, changes: [], status: "observation-error" };
            const document = event.after;
            return { ...previous, ...document, lineCount: document.totalLines,
              seq: event.seq, status: "live", changes: previous.changes.flatMap((change) => {
                const after = document.lines[change.line - 1];
                return after === undefined ? [] : [{ ...change, after }];
              }) };
          }
          if (event.element.kind !== "line" || event.element.line < 1) return { ...previous, seq: event.seq };
          const change: ObservedLine = { line: event.element.line, before: event.before, after: event.after, seq: event.seq, ts: event.ts };
          return { ...previous, seq: event.seq, status: event.advisory ? "reconciling" : "live",
            changes: [...previous.changes.filter((line) => line.line !== change.line), change] };
        });
      }
    };
    const stop = !selected && sessionId ? api.onAgentObservation(handleEvents) : () => {};
    const options = selected ? { offset: startLine - 1, limit: endLine - startLine + 1,
      ...(target.workspaceRoot ? { workspaceRoot: target.workspaceRoot } : {}) }
      : { ...(target.workspaceRoot ? { workspaceRoot: target.workspaceRoot } : {}), ...(sessionId ? { sessionId } : {}) };
    const read = Object.keys(options).length > 0 ? api.readFile(target.path, options) : api.readFile(target.path);
    void read.then((result) => {
      if (cancelled) { if (result.observation) release(result.observation); return; }
      if (!result.ok) { setState({ phase: "error", code: result.error ?? "read-failed" }); return; }
      observedPath = result.path ?? target.path;
      binding = !selected && result.observation?.sessionId === sessionId ? result.observation : undefined;
      const content = result.document?.content ?? result.content ?? "";
      const lines = result.document?.lines ?? content.split(/\r\n|\r|\n/);
      lastSeq = binding?.seq ?? 0;
      setState({ phase: "ok", path: observedPath, content, lines, lineCount: result.document?.totalLines ?? result.lineCount ?? lines.length,
        truncated: Boolean(result.document?.truncated ?? result.truncated), image: selected ? undefined : result.image,
        binding, seq: lastSeq, changes: [] });
    }).catch(() => { if (!cancelled) setState({ phase: "error", code: "read-failed" }); });
    return () => { cancelled = true; generation.current += 1; stop(); if (binding) release(binding); };
  }, [target.path, target.workspaceRoot, startLine, endLine, selected, inlineText, sessionId, revision]);

  const passiveKind = state.phase === "ok" ? resolvePreviewRenderer({ text: state.content, path: state.path }).kind : undefined;
  const sourceVisible = selected || (state.phase === "ok" && state.binding !== undefined
    && (state.changes.length > 0 || passiveKind === "text"));
  const acknowledgeRendered = useCallback(() => {
    if (state.phase !== "ok" || !state.binding) return;
    const { binding, seq } = state;
    const key = `${binding.targetId}:${seq}`;
    if (acknowledged.current === key) return;
    acknowledged.current = key;
    const current = generation.current;
    void window.ave.preview.acknowledgeObservation({ action: "rendered", targetId: binding.targetId,
      sessionId: binding.sessionId, seq }).then((result) => {
      if (!result.ok && current === generation.current) setState((previous) => previous.phase === "ok"
        ? { ...previous, changes: [], status: "observation-error" } : previous);
    }).catch(() => { if (current === generation.current) setState((previous) => previous.phase === "ok"
      ? { ...previous, changes: [], status: "observation-error" } : previous); });
  }, [state]);
  useLayoutEffect(() => {
    if ((passiveKind === "mermaid" || passiveKind === "markdown") && !sourceVisible) return;
    acknowledgeRendered();
  }, [passiveKind, sourceVisible, acknowledgeRendered]);

  const latest = state.phase === "ok" ? state.changes.at(-1) : undefined;
  const changedLines = state.phase === "ok" ? state.changes.map((change) => change.line) : [];
  const summary = latest ? t("chatPreviewRail.documentObservationLines", { count: changedLines.length,
    first: Math.min(...changedLines), last: Math.max(...changedLines) }) : undefined;
  const copyValue = inlineText ?? (state.phase === "ok" ? state.content : target.path);
  const lines = state.phase === "ok" ? state.lines : [];
  const changes = new Map(state.phase === "ok" ? state.changes.map((change) => [change.line, change]) : []);
  const lineCount = inlineText !== undefined ? inlineText.split(/\r\n|\r|\n/).length
    : state.phase === "ok" && !state.image ? state.lineCount : undefined;
  return <div className="space-y-2" data-testid="chat-side-panel-file-preview">
    <PreviewDocumentHeader path={state.phase === "ok" ? state.path : target.path} workspaceRoot={target.workspaceRoot}
      canOpenExternal={target.canOpenExternal || (inlineText === undefined && !selected && state.phase === "ok" && previewSupportsExternalOpen(state.path))}
      copyValue={copyValue} copyContent onReload={inlineText === undefined ? () => setRevision((current) => current + 1) : undefined}
      onOpenError={() => setOpenFailed(true)}
      refreshing={inlineText === undefined && state.phase === "loading"} />
    <PreviewDocumentLiveStrip status={state.phase === "ok" ? state.status : undefined} summary={summary} ts={latest?.ts}
      error={openFailed ? t("chatPreviewRail.openDefaultAppError") : undefined} />
    {inlineText !== undefined ? <PreviewContent descriptor={{ text: inlineText, path: target.path }} />
      : state.phase === "loading" ? <div className="text-xs text-muted-foreground" data-testid="chat-side-panel-file-loading">{t("chatPreviewRail.filePreviewLoading")}</div>
      : state.phase === "error" ? <div className="text-[11px] text-destructive" data-testid="chat-side-panel-file-error">{t(readErrorKey(state.code))}</div>
      : state.image ? <img src={state.image.dataUrl} alt={target.title} referrerPolicy="no-referrer" className="max-h-(--preview-block-max-height) max-w-full rounded-md object-contain" data-testid="file-preview-image" />
      : sourceVisible ? <pre className="max-h-(--preview-block-max-height) overflow-auto border-t py-2 font-mono text-xs"
        data-testid={selected ? "file-preview-selected-range" : "document-text-lines"}>
        {lines.slice(0, selected ? Math.min(state.lineCount, endLine - startLine + 1) : undefined).map((line, index) => {
          const number = (selected ? startLine : 1) + index;
          const change = changes.get(number);
          const current = change && change.seq === latest?.seq;
          return <span key={number} data-testid={change ? "document-line-change" : `file-preview-line-${number}`}
            data-line={number} data-current={current ? "true" : "false"} data-selected={selected ? "true" : undefined}
            className={cn("relative flex min-h-5 px-2", selected && "bg-accent/(--opacity-subtle)",
              change && "bg-agent/(--opacity-subtle)", current && "ave-observed-current bg-agent/(--opacity-soft)")}>
            <span aria-hidden="true" className="mr-3 min-w-8 shrink-0 select-none text-right text-muted-foreground">{number}</span>
            <span className="whitespace-pre" data-testid={change ? "document-line-value" : undefined}>{(change?.after ?? line) || "\u200b"}</span>
            {current ? <span aria-hidden="true" className="absolute right-0 top-0 rounded-bl bg-agent px-1 font-sans text-[9px] leading-3 text-background">Ave</span> : null}
          </span>;
        })}
      </pre> : <PreviewContent descriptor={{ text: state.content, path: state.path }} onRendered={acknowledgeRendered} />}
    <PreviewDocumentFooter><span>{previewFormatLabel(target.path)}{lineCount !== undefined ? ` · ${t("chatPreviewRail.documentLineCount", { count: lineCount })}` : ""}</span>
      {state.phase === "ok" && state.truncated ? <Badge variant="outline" className="px-1 py-0 text-[10px]" data-testid="chat-side-panel-file-truncated">{t("chatPreviewRail.filePreviewTruncated")}</Badge> : null}
    </PreviewDocumentFooter>
  </div>;
}
