import { useEffect, useState, type ReactNode } from "react";
import { Check, Copy, ExternalLink, File, FileCode, FileImage, FileText, Presentation, RefreshCw, Sheet } from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import { cn } from "../../../lib/utils.js";
import { useTranslation } from "../../../i18n/react.js";
import type { DocumentObservationStatus } from "../../../shared/agent-observation.js";
import { formatRelativeSessionTime } from "../../../shared/format-time.js";
import { useCopyFlash } from "../hooks/use-copy-flash.js";

function pathParts(path: string, workspaceRoot?: string): { name: string; parent: string } {
  const normalized = path.replace(/\\/g, "/");
  const root = workspaceRoot?.replace(/\\/g, "/").replace(/\/$/, "");
  const relative = root && normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : normalized;
  const parts = relative.split("/").filter(Boolean);
  const name = parts.pop() ?? path;
  const parent = parts.length > 3 ? `…/${parts.slice(-2).join("/")}/` : parts.length ? `${parts.join("/")}/` : "";
  return { name, parent };
}

function fileExtension(path: string): string {
  const { name } = pathParts(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function previewFormatLabel(path: string): string {
  const extension = fileExtension(path);
  const labels: Record<string, string> = {
    xlsx: "Excel", xls: "Excel", ods: "ODS", csv: "CSV", tsv: "TSV", pdf: "PDF", pptx: "PowerPoint",
    ts: "TypeScript", tsx: "TypeScript", js: "JavaScript", jsx: "JavaScript", md: "Markdown", json: "JSON",
    css: "CSS", html: "HTML", txt: "Text", py: "Python", rs: "Rust", go: "Go", yaml: "YAML", yml: "YAML",
  };
  return labels[extension] ?? (extension ? extension.toUpperCase() : "Text");
}

function documentIcon(path: string) {
  const extension = fileExtension(path);
  if (["xlsx", "xls", "ods", "csv", "tsv"].includes(extension ?? "")) return Sheet;
  if (extension === "pptx") return Presentation;
  if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(extension ?? "")) return FileImage;
  if (["ts", "tsx", "js", "jsx", "css", "html", "json", "py", "rs", "go"].includes(extension ?? "")) return FileCode;
  return extension ? FileText : File;
}

/** Shared single-line chrome for passive file and document viewers. */
export function PreviewDocumentHeader({ path, workspaceRoot, copyValue = path, copyContent = false,
  canOpenExternal = true, onReload, onOpenError, refreshing = false }: {
  path: string;
  workspaceRoot?: string;
  copyValue?: string;
  copyContent?: boolean;
  canOpenExternal?: boolean;
  onReload?: () => void;
  onOpenError?: () => void;
  refreshing?: boolean;
}) {
  const { t } = useTranslation();
  const { copied, copy } = useCopyFlash();
  const { name, parent } = pathParts(path, workspaceRoot);
  const Icon = documentIcon(path);
  const copyLabel = copied ? t("chatPreviewRail.copied")
    : t(copyContent ? "chatPreviewRail.copy" : "chatPreviewRail.copyPath");
  const handleOpenExternal = async (): Promise<void> => {
    try {
      const result = await window.ave.attach.openExternal(path);
      if (!result.ok) onOpenError?.();
    } catch { onOpenError?.(); }
  };
  return (
    <div className="flex min-w-0 shrink-0 items-center gap-2 py-1" data-testid="document-preview-header">
      <Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <h3 className="max-w-[45%] shrink truncate text-[13px] font-semibold" title={name}>{name}</h3>
      <span title={path} className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground" data-testid="preview-document-path">{parent}</span>
      <div className="ml-auto flex shrink-0 items-center gap-0.5">
        {canOpenExternal ? <Button type="button" size="icon-xs" variant="ghost"
          aria-label={t("chatPreviewRail.openDefaultApp")} title={t("chatPreviewRail.openDefaultApp")}
          onClick={() => void handleOpenExternal()}><ExternalLink aria-hidden="true" className="h-3.5 w-3.5" /></Button> : null}
        <Button type="button" size="icon-xs" variant="ghost" aria-label={copyLabel} title={copyLabel} onClick={() => copy(copyValue)}>
          {copied ? <Check aria-hidden="true" className="h-3.5 w-3.5" /> : <Copy aria-hidden="true" className="h-3.5 w-3.5" />}
        </Button>
        {onReload ? <Button type="button" size="icon-xs" variant="ghost" disabled={refreshing}
          aria-label={t("chatPreviewRail.tableReload")} title={t("chatPreviewRail.tableReload")} onClick={onReload}>
          <RefreshCw aria-hidden="true" className={cn("h-3.5 w-3.5", refreshing && "motion-safe:animate-spin")} />
        </Button> : null}
      </div>
    </div>
  );
}

const OBSERVATION_STATUS_KEYS: Record<DocumentObservationStatus, string> = {
  live: "chatPreviewRail.documentObservationLive",
  reconciling: "chatPreviewRail.documentObservationReconciling",
  "reload-required": "chatPreviewRail.documentObservationReloadRequired",
  "engine-unavailable": "chatPreviewRail.documentObservationFallback",
  "observation-error": "chatPreviewRail.documentObservationError",
  "resync-required": "chatPreviewRail.documentObservationResync",
};

function ObservationRecency({ ts }: { ts: number }) {
  const { t } = useTranslation();
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((tick) => tick + 1), 30_000);
    return () => clearInterval(timer);
  }, [ts]);
  return <time dateTime={new Date(ts).toISOString()} title={new Date(ts).toLocaleTimeString()}
    className="ml-auto shrink-0 text-[10px]">{formatRelativeSessionTime(ts, t)}</time>;
}

/** Only authenticated observation state gives a document its agent activity strip. */
export function PreviewDocumentLiveStrip({ status, summary, ts, error }: {
  status?: DocumentObservationStatus;
  summary?: string;
  ts?: number;
  error?: string;
}) {
  const { t } = useTranslation();
  if (!status && !error) return null;
  const interrupted = error !== undefined || status === "reload-required" || status === "resync-required" || status === "observation-error";
  return (
    <div role={interrupted ? "alert" : "status"} data-testid="document-preview-live-strip"
      className={cn("flex min-w-0 shrink-0 items-center gap-2 rounded-md bg-agent/(--opacity-subtle) px-2.5 py-1.5 text-[11px] text-agent",
        interrupted && "bg-destructive/(--opacity-subtle) text-destructive")}>
      {status && !error ? <span aria-hidden="true" className={cn("h-1.5 w-1.5 shrink-0 rounded-full bg-current", status === "reconciling" && "motion-safe:animate-pulse")} /> : null}
      <span data-testid="document-observation-status" className={cn("min-w-0", !interrupted && "shrink-0 font-medium")}>{error ?? t(OBSERVATION_STATUS_KEYS[status!])}</span>
      {!interrupted && summary ? <span className="min-w-0 truncate font-mono" title={summary} data-testid="document-observation-summary">{summary}</span> : null}
      {!interrupted && ts ? <ObservationRecency ts={ts} /> : null}
    </div>
  );
}

export function PreviewDocumentFooter({ children }: { children: ReactNode }) {
  return <div className="flex shrink-0 flex-wrap items-center gap-x-1.5 gap-y-1 border-t pt-1.5 text-[11px] text-muted-foreground"
    data-testid="document-preview-footer">{children}</div>;
}
