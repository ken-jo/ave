/** What the folder view shows for a file Ave cannot preview: its facts and the ways to open it elsewhere (cases 35, 36). */
import { useState } from "react";
import { Check, Copy, ExternalLink } from "lucide-react";
import { Button } from "../../../../components/ui/button.js";
import { useTranslation } from "../../../../i18n/react.js";
import { useCopyFlash } from "../../hooks/use-copy-flash.js";
import { folderEntryIcon, revealKey } from "./FolderColumn.js";
import { FOLDER_KIND_LABEL_KEYS, folderFileKind, pathSegments, type FolderEntry } from "./folder-columns.js";
import { useOpenInDefaultApp } from "./use-open-in-default-app.js";
import { canOpenInDefaultApp } from "../../../../shared/preview-external-open.js";
import { FileInfoCard as PassiveFileInfoCard, type FileInfoReason } from "../../preview/FileInfoCard.js";

export type { FileInfoReason };

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
  return (
    <PassiveFileInfoCard name={entry.name} kindLabel={t(FOLDER_KIND_LABEL_KEYS[kind])}
      icon={<Icon aria-hidden="true" className="h-7 w-7" />} reason={reason} size={entry.size}
      modified={modified ?? t("folderView.infoUnknown")} created={created ?? t("folderView.infoUnknown")} location={location}>
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
    </PassiveFileInfoCard>
  );
}
