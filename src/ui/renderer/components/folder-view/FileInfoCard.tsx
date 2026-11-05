/** What the folder view shows for a file Ave cannot preview: its facts and the ways to open it elsewhere (cases 35, 36). */
import { useState } from "react";
import { Check, Copy, ExternalLink, Info } from "lucide-react";
import { Button } from "../../../../components/ui/button.js";
import { cn } from "../../../../lib/utils.js";
import { useTranslation } from "../../../../i18n/react.js";
import { formatBytes } from "../../../../lib/turn-summary-format.js";
import { useCopyFlash } from "../../hooks/use-copy-flash.js";
import { folderEntryIcon, revealKey } from "./FolderColumn.js";
import { FOLDER_KIND_LABEL_KEYS, folderFileKind, pathSegments, type FolderEntry } from "./folder-columns.js";
import { useOpenInDefaultApp } from "./use-open-in-default-app.js";
import { canOpenInDefaultApp } from "../../../../shared/preview-external-open.js";

/** Why there is no preview: an unsupported format, or one of the host reader's refusals. */
export type FileInfoReason = "unsupported" | "too-large" | "binary-file";

export function formatFolderTimestamp(ms: number, locale: string | undefined): string | null {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return new Date(ms).toLocaleString(locale, { year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function FileInfoCard({ projectRoot, entry, reason }: { projectRoot: string; entry: FolderEntry; reason: FileInfoReason }) {
  const { t, locale } = useTranslation();
  const { copied, copy } = useCopyFlash();
  const open = useOpenInDefaultApp(projectRoot);
  const openable = canOpenInDefaultApp(entry.path);
  const [revealFailed, setRevealFailed] = useState(false);
  const Icon = folderEntryIcon(entry);
  const kind = folderFileKind(entry.name);
  const location = pathSegments(projectRoot, entry.path).join("/");
  const modified = formatFolderTimestamp(entry.mtimeMs, locale);
  const created = formatFolderTimestamp(entry.birthtimeMs, locale);
  const mac = /Macintosh|Mac OS X/iu.test(globalThis.navigator?.userAgent ?? "");
  const facts: Array<[string, string]> = [
    [t("folderView.infoSize"), t("folderView.infoSizeValue", { size: formatBytes(entry.size), bytes: entry.size.toLocaleString(locale) })],
    [t("folderView.infoModified"), modified ?? t("folderView.infoUnknown")],
    [t("folderView.infoCreated"), created ?? t("folderView.infoUnknown")],
    [t("folderView.infoLocation"), location],
  ];
  return (
    <div className="flex min-h-0 flex-1 items-start justify-center overflow-auto p-6" data-testid="folder-file-info">
      <div className="w-full max-w-sm rounded-xl border bg-card p-5 text-card-foreground">
        <div className="flex flex-col items-center gap-1 text-center">
          <span className="mb-2 flex h-14 w-14 items-center justify-center rounded-xl bg-muted">
            <Icon aria-hidden="true" className="h-7 w-7" />
          </span>
          <div className="max-w-full truncate text-base font-semibold" title={entry.name}>{entry.name}</div>
          <div className="text-xs text-muted-foreground">{t(FOLDER_KIND_LABEL_KEYS[kind])}</div>
        </div>
        <div role="note" data-testid="folder-file-info-reason" data-reason={reason}
          className={cn("mt-4 flex gap-2 rounded-lg border px-3 py-2 text-xs leading-5",
            reason === "unsupported" ? "bg-muted/(--opacity-muted)" : "border-warning/(--opacity-medium) bg-warning/(--opacity-subtle) text-warning")}>
          <Info aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{reason === "too-large" ? t("folderView.reasonTooLarge", { size: formatBytes(entry.size) })
            : reason === "binary-file" ? t("folderView.reasonBinary") : t("folderView.reasonUnsupported")}</span>
        </div>
        <dl className="mt-4 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-xs">
          {facts.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className={cn("min-w-0 [overflow-wrap:anywhere]", label === t("folderView.infoLocation") && "font-mono")}>{value}</dd>
            </div>
          ))}
        </dl>
        {openable ? (
          <>
            <Button type="button" className="mt-4 w-full" autoFocus data-testid="folder-open-external"
              disabled={open.pending} onClick={() => void open.run(entry.path)}>
              <ExternalLink aria-hidden="true" className="h-4 w-4" />{t("folderView.openExternal")}
            </Button>
            <div className="mt-1 text-center text-[11px] text-muted-foreground">
              {t(mac ? "folderView.openExternalHintMac" : "folderView.openExternalHint")}
            </div>
          </>
        ) : (
          // A type the default app is not given: the file manager and the path are the way out.
          <div className="mt-4 text-center text-[11px] text-muted-foreground" data-testid="folder-open-external-unavailable">
            {t("folderView.openRefusedType")}
          </div>
        )}
        {open.error ? (
          <div role="alert" className="mt-1 text-center text-[11px] text-destructive" data-testid="folder-open-external-error">
            {t(open.error)}
          </div>
        ) : null}
        <div className="mt-3 grid grid-cols-2 gap-2">
          <Button type="button" variant="outline" size="sm" data-testid="folder-reveal" autoFocus={!openable}
            onClick={() => {
              setRevealFailed(false);
              void window.ave.workspace.reveal(entry.path).then((res) => setRevealFailed(!res.ok), () => setRevealFailed(true));
            }}>
            {t(revealKey())}
          </Button>
          <Button type="button" variant="outline" size="sm" data-testid="folder-copy-path" onClick={() => copy(entry.path)}>
            {copied ? <Check aria-hidden="true" className="h-3.5 w-3.5" /> : <Copy aria-hidden="true" className="h-3.5 w-3.5" />}
            {t(copied ? "folderView.copied" : "folderView.copyPath")}
          </Button>
        </div>
        {revealFailed ? <div role="alert" className="mt-1 text-center text-[11px] text-destructive">{t("folderView.revealFailed")}</div> : null}
      </div>
    </div>
  );
}
