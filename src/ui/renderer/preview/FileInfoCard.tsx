import type { ReactNode } from "react";
import { Info } from "lucide-react";
import { cn } from "../../../lib/utils.js";
import { useTranslation } from "../../../i18n/react.js";
import { formatBytes } from "../../../lib/turn-summary-format.js";

export type FileInfoReason = "unsupported" | "too-large" | "binary-file";

/** File facts supplied by the caller; absent metadata is never inferred. */
export function FileInfoCard({ name, kindLabel, icon, reason, size, modified, created, location, children }: {
  name: string;
  kindLabel?: string;
  icon?: ReactNode;
  reason?: FileInfoReason;
  size?: number;
  modified?: string;
  created?: string;
  location?: string;
  children?: ReactNode;
}) {
  const { t, locale } = useTranslation();
  const facts: Array<[string, string]> = [];
  if (size !== undefined) facts.push([t("folderView.infoSize"), t("folderView.infoSizeValue", { size: formatBytes(size), bytes: size.toLocaleString(locale) })]);
  if (modified !== undefined) facts.push([t("folderView.infoModified"), modified]);
  if (created !== undefined) facts.push([t("folderView.infoCreated"), created]);
  if (location !== undefined) facts.push([t("folderView.infoLocation"), location]);
  return (
    <div className="flex min-h-0 flex-1 items-start justify-center overflow-auto p-6" data-testid="file-info">
      <div className="w-full max-w-sm rounded-xl border bg-card p-5 text-card-foreground">
        <div className="flex flex-col items-center gap-1 text-center">
          {icon ? <span className="mb-2 flex h-14 w-14 items-center justify-center rounded-xl bg-muted">
            {icon}
          </span> : null}
          <div className="max-w-full truncate text-base font-semibold" title={name}>{name}</div>
          {kindLabel ? <div className="text-xs text-muted-foreground">{kindLabel}</div> : null}
        </div>
        {reason ? <div role="note" data-testid="file-info-reason" data-reason={reason}
          className={cn("mt-4 flex gap-2 rounded-lg border px-3 py-2 text-xs leading-5",
            reason === "unsupported" ? "bg-muted/(--opacity-muted)" : "border-warning/(--opacity-medium) bg-warning/(--opacity-subtle) text-warning")}>
          <Info aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{reason === "too-large" ? size === undefined ? t("chatPreviewRail.fileErrorTooLarge") : t("folderView.reasonTooLarge", { size: formatBytes(size) })
            : reason === "binary-file" ? t("folderView.reasonBinary") : t("folderView.reasonUnsupported")}</span>
        </div> : null}
        <dl className="mt-4 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-xs">
          {facts.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className={cn("min-w-0 [overflow-wrap:anywhere]", label === t("folderView.infoLocation") && "font-mono")}>{value}</dd>
            </div>
          ))}
        </dl>
        {children}
      </div>
    </div>
  );
}
